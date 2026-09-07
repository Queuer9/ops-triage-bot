# Ops Triage Bot

Turns `@opsteam` mentions in Slack into tasks on the Asana **Ops Requests** board, and reports progress back to the original Slack thread. Runs as a **Cloudflare Worker, synced every minute by a self-re-arming Durable Object alarm** — no server to maintain. (A GitHub Actions workflow remains as a manually-triggered fallback.)

> Why an alarm and not a cron trigger? Cloudflare cron triggers on this account register fine (dashboard even shows a next-run time) but never execute — confirmed over 30+ minutes of tailing across API- and dashboard-created triggers. A cron trigger is still configured in case it ever wakes up; the Durable Object alarm in `src/worker.js` is the real driver. If the alarm loop ever stops, hit `/arm?key=<TRIGGER_KEY>` to restart it, or `/run?key=<TRIGGER_KEY>` for a one-off sync.

## What it does

1. **Intake** — a message tagging `@opsteam` (or `@Ops Bot`) gets a 👀 reaction and a task in the **📥 Triage** section of [Ops Requests](https://app.asana.com/1/1207757703893119/project/1217818788597298), with a link back to the Slack message. Works for top-level messages and thread replies.
2. **Announce** — once the task has **both an assignee and a due date**, the bot replies once in the Slack thread: *"👀 This has been picked up by @Libby and will be done by Tue 2 Sep. Track it here: …"*
3. **Complete** — when the task is ticked complete in Asana **or dragged to the ✅ Done column**, the bot adds ✅ to the original message and removes its 👀.

It's stateless: the bot's own reactions and its "picked up by" reply are the dedupe markers, so overlapping runs never double-process. It only ingests messages sent within the last 24 h (and never before go-live, 25 Aug 2026).

## Layout

- [`src/core.js`](src/core.js) — all the logic (pure `fetch`, runs anywhere)
- [`src/worker.js`](src/worker.js) — Cloudflare Worker entry (cron, the live deployment)
- [`src/sync.js`](src/sync.js) — Node entry for the GitHub Actions fallback
- [`wrangler.toml`](wrangler.toml) — Worker config (cron schedule, watched channels)

## Deployment (Cloudflare)

One-time, from this folder:

```
npx wrangler login                    # opens browser to authorize
npx wrangler deploy                   # deploys the worker
npx wrangler secret put SLACK_BOT_TOKEN   # paste the xoxb- bot token
npx wrangler secret put ASANA_TOKEN       # paste the Asana Personal Access Token (NOT an OAuth client secret)
npx wrangler secret put TRIGGER_KEY       # any long random string, protects /run and /arm
curl "https://<worker-url>/arm?key=<TRIGGER_KEY>"   # start the minute-by-minute alarm loop
```

After code changes: `npx wrangler deploy`. Live logs: `npx wrangler tail`.

The tokens come from:
- **Slack:** https://api.slack.com/apps → Ops Bot → OAuth & Permissions → Bot User OAuth Token (`xoxb-`). Scopes are defined in [`slack-app-manifest.json`](slack-app-manifest.json). The bot must be `/invite`d to every watched channel.
- **Asana:** https://app.asana.com/0/my-apps → personal access token from an account that can edit the Ops Requests project.

## Configuration

- **Channels watched:** `SLACK_CHANNEL_IDS` in [`wrangler.toml`](wrangler.toml) (comma-separated; default `C09RRCML3QQ` = #ops). Redeploy after changing, and `/invite @Ops Bot` to each channel.
- **Board / usergroup / go-live date:** constants at the top of [`src/core.js`](src/core.js).
- **Cron cadence:** `[triggers] crons` in wrangler.toml.

## GitHub Actions fallback

[`.github/workflows/ops-triage.yml`](.github/workflows/ops-triage.yml) runs the same logic via **Run workflow** (manual dispatch) using the `SLACK_BOT_TOKEN`/`ASANA_TOKEN` repository secrets. Its cron schedule was removed — GitHub throttled it to every ~3 hours in practice, which is why the bot moved to Cloudflare. Don't re-add the schedule while the Worker is live: both running risks racing on the announce step.

## Things worth knowing

- **Skip rule:** a message already carrying any 👀 or ✅ reaction is treated as handled and won't create a task. If a colleague reacts 👀 manually before the bot gets there, that request needs manual entry.
- **Every mention counts:** the bot can't judge intent — any non-bot message containing the mention becomes a task, including passing references. Delete unwanted tasks from Triage; the 👀 stays so it won't be re-ingested.
- **@-mentions in the announce reply** match the Asana assignee's email to Slack (needs the `users:read.email` scope); when no match, the reply falls back to the plain first name.
- **Cloudflare free-tier limits:** 50 subrequests per invocation — fine for normal volume, but if the board grows to many hundreds of tasks, Stage 3's full listing may need a smarter filter.
