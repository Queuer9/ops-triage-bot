#!/usr/bin/env node
/**
 * Ops request triage: Slack @opsteam mentions -> Asana "Ops Requests" board -> Slack updates.
 *
 * Stage 1: new messages mentioning @opsteam get an Asana task in the Triage section + 👀 reaction.
 * Stage 2: once a task has an assignee AND a due date, post one reply in the Slack thread.
 * Stage 3: when a task is completed, add ✅ to the original message and remove the bot's 👀.
 *
 * Stateless by design: the bot's own reactions and a marker phrase in its thread reply
 * ("picked up by") are the dedupe markers, so re-runs and overlapping windows are safe.
 *
 * Env: SLACK_BOT_TOKEN (xoxb-...), ASANA_TOKEN (personal access token).
 * Optional env: SLACK_CHANNEL_IDS (comma-separated, default C09RRCML3QQ = #ops).
 */

// Until both secrets are configured in the repo, do nothing (quietly green) rather than fail every run.
if (!process.env.SLACK_BOT_TOKEN || !process.env.ASANA_TOKEN) {
  console.log('NOT CONFIGURED YET: add SLACK_BOT_TOKEN and ASANA_TOKEN as repository secrets (see README). Skipping run.');
  process.exit(0);
}
const SLACK_TOKEN = required('SLACK_BOT_TOKEN');
const ASANA_TOKEN = required('ASANA_TOKEN');

const CHANNELS = (process.env.SLACK_CHANNEL_IDS || 'C09RRCML3QQ').split(',').map(s => s.trim()).filter(Boolean);
const OPSTEAM_MENTION = 'subteam^S0BN2FK81TR'; // raw form of an @opsteam mention in message text
const ASANA_PROJECT = '1217818788597298';      // "Ops Requests"
const TRIAGE_SECTION = '1217818788622610';     // "📥 Triage"
const GO_LIVE_TS = 1787655600;                 // 25 Aug 2026 ~12:00 BST — never ingest anything older
const LOOKBACK_SECONDS = 24 * 60 * 60;         // scan window; reactions dedupe repeat scans
const ANNOUNCE_MARKER = 'picked up by';        // dedupe marker phrase in the bot's thread reply

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var ${name}`); process.exit(1); }
  return v;
}

async function slackGet(method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error}`);
  return body;
}

async function slackPost(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error}`);
  return body;
}

async function asana(path, { method = 'GET', data } = {}) {
  const res = await fetch(`https://app.asana.com/api/1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${ASANA_TOKEN}`, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify({ data }) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Asana ${method} ${path}: ${res.status} ${JSON.stringify(body.errors || body)}`);
  return body;
}

function botReacted(message, emoji, botUserId) {
  return (message.reactions || []).some(r => r.name === emoji && r.users?.includes(botUserId));
}

function anyReaction(message, emoji) {
  return (message.reactions || []).some(r => r.name === emoji);
}

function parseNotes(notes) {
  const grab = key => (notes.match(new RegExp(`^${key}: (.+)$`, 'm')) || [])[1]?.trim();
  return {
    channel: grab('slack_channel_id'),
    messageTs: grab('slack_message_ts'),
    threadTs: grab('slack_thread_ts'),
  };
}

function formatDue(dueOn) {
  // "2026-09-02" -> "Tue 2 Sep"
  const d = new Date(`${dueOn}T12:00:00Z`);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const month = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${weekday} ${d.getUTCDate()} ${month}`;
}

async function listProjectTasks(params = {}) {
  const tasks = [];
  let offset;
  do {
    const body = await asana(`/projects/${ASANA_PROJECT}/tasks?` + new URLSearchParams({
      limit: '100',
      opt_fields: 'name,notes,completed,assignee.name,due_on,permalink_url',
      ...params,
      ...(offset ? { offset } : {}),
    }).toString());
    tasks.push(...body.data);
    offset = body.next_page?.offset;
  } while (offset);
  return tasks;
}

// ---------- Stage 1: intake ----------

async function collectRecentMessages(channel, oldest) {
  const out = [];
  const history = await slackGet('conversations.history', { channel, oldest: String(oldest), limit: 100 });
  for (const msg of history.messages || []) {
    out.push({ ...msg, channel, thread_ts: msg.thread_ts || msg.ts });
    if (msg.reply_count > 0) {
      const replies = await slackGet('conversations.replies', {
        channel, ts: msg.ts, oldest: String(oldest), limit: 100,
      });
      for (const reply of replies.messages || []) {
        if (reply.ts !== msg.ts) out.push({ ...reply, channel, thread_ts: msg.ts });
      }
    }
  }
  return out;
}

async function stageIntake(botUserId) {
  let created = 0;
  const oldest = Math.max(GO_LIVE_TS, Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS);

  for (const channel of CHANNELS) {
    const messages = await collectRecentMessages(channel, oldest);
    for (const msg of messages) {
      // A request is either an @opsteam usergroup mention or a direct @-mention of this bot
      // (people may tag the bot by mistake since it's named "Ops Team").
      if (!msg.text?.includes(OPSTEAM_MENTION) && !msg.text?.includes(`<@${botUserId}>`)) continue;
      if (parseFloat(msg.ts) < GO_LIVE_TS) continue;
      if (msg.user === botUserId || msg.bot_id) continue;
      if (botReacted(msg, 'eyes', botUserId) || anyReaction(msg, 'eyes') || anyReaction(msg, 'white_check_mark')) continue;

      const permalink = (await slackGet('chat.getPermalink', { channel, message_ts: msg.ts })).permalink;
      let requester = msg.user;
      try {
        const profile = await slackGet('users.info', { user: msg.user });
        requester = profile.user.real_name || profile.user.name;
      } catch { /* fall back to the user id */ }

      const summary = msg.text
        .replace(/<!subteam\^\w+(\|[^>]*)?>/g, '@opsteam')
        .replace(/<@[\w]+(\|[^>]*)?>/g, '@…')
        .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
        .replace(/\s+/g, ' ')
        .trim();
      const firstName = requester.split(' ')[0];
      const name = `${firstName}: ${summary.length > 80 ? summary.slice(0, 77) + '…' : summary}`;

      const notes = [
        `Slack thread: ${permalink}`,
        `slack_channel_id: ${channel}`,
        `slack_message_ts: ${msg.ts}`,
        `slack_thread_ts: ${msg.thread_ts}`,
        `Requested by: ${requester}`,
        '',
        msg.text,
      ].join('\n');

      const task = await asana('/tasks', { method: 'POST', data: { name, notes, projects: [ASANA_PROJECT] } });
      await asana(`/sections/${TRIAGE_SECTION}/addTask`, { method: 'POST', data: { task: task.data.gid } });
      // Reaction added only after the task exists — it is the "ingested" marker.
      await slackPost('reactions.add', { channel, timestamp: msg.ts, name: 'eyes' }).catch(e => {
        if (!String(e).includes('already_reacted')) throw e;
      });
      created++;
      console.log(`Intake: created task ${task.data.gid} for message ${msg.ts} in ${channel}`);
    }
  }
  return created;
}

// ---------- Stage 2: announce owner + due date ----------

async function stageAnnounce(botUserId) {
  let announced = 0;
  const tasks = await listProjectTasks({ completed_since: 'now' }); // incomplete only
  for (const task of tasks) {
    if (!task.assignee || !task.due_on) continue;
    const { channel, threadTs } = parseNotes(task.notes || '');
    if (!channel || !threadTs) continue;

    const replies = await slackGet('conversations.replies', { channel, ts: threadTs, limit: 100 });
    const alreadyAnnounced = (replies.messages || []).some(
      m => (m.user === botUserId || m.bot_id) && m.text?.includes(ANNOUNCE_MARKER)
    );
    if (alreadyAnnounced) continue;

    const firstName = task.assignee.name.split(' ')[0];
    await slackPost('chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: `:eyes: This has been ${ANNOUNCE_MARKER} ${firstName} — due ${formatDue(task.due_on)}. Track it here: ${task.permalink_url}`,
      unfurl_links: false,
    });
    announced++;
    console.log(`Announce: notified thread ${threadTs} for task ${task.gid} (${firstName}, ${task.due_on})`);
  }
  return announced;
}

// ---------- Stage 3: mark completed ----------

async function stageComplete(botUserId) {
  let checked = 0;
  const tasks = await listProjectTasks(); // includes completed
  for (const task of tasks) {
    if (!task.completed) continue;
    const { channel, messageTs } = parseNotes(task.notes || '');
    if (!channel || !messageTs) continue;

    const msg = (await slackGet('reactions.get', { channel, timestamp: messageTs, full: 'true' })).message;
    if (botReacted(msg, 'white_check_mark', botUserId)) continue;

    await slackPost('reactions.add', { channel, timestamp: messageTs, name: 'white_check_mark' }).catch(e => {
      if (!String(e).includes('already_reacted')) throw e;
    });
    await slackPost('reactions.remove', { channel, timestamp: messageTs, name: 'eyes' }).catch(e => {
      if (!String(e).includes('no_reaction')) throw e; // fine if the bot never added 👀
    });
    checked++;
    console.log(`Complete: ✅ added (and 👀 removed) for task ${task.gid} on message ${messageTs}`);
  }
  return checked;
}

// ---------- main ----------

(async () => {
  const botUserId = (await slackGet('auth.test', {})).user_id;
  const created = await stageIntake(botUserId);
  const announced = await stageAnnounce(botUserId);
  const completed = await stageComplete(botUserId);
  console.log(`Done: ${created} task(s) created, ${announced} thread(s) notified, ${completed} request(s) marked complete.`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
