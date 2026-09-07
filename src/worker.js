/**
 * Cloudflare Worker entry.
 *
 * Scheduling: a self-re-arming Durable Object alarm runs the sync every ~60s
 * (Cloudflare's cron triggers proved unreliable on this account — registered but never fired).
 * The cron `scheduled` handler is kept as a harmless extra in case crons ever wake up.
 *
 * HTTP endpoints (both need ?key=<TRIGGER_KEY>):
 *   /run — run one sync pass now, return the summary as JSON
 *   /arm — (re)start the Durable Object alarm loop
 *
 * Secrets (wrangler secret put): SLACK_BOT_TOKEN, ASANA_TOKEN, TRIGGER_KEY.
 */
import { runSync } from './core.js';

function envConfig(env) {
  return {
    slackToken: env.SLACK_BOT_TOKEN,
    asanaToken: env.ASANA_TOKEN,
    channelIds: env.SLACK_CHANNEL_IDS || 'C09RRCML3QQ',
  };
}

function configured(env) {
  return env.SLACK_BOT_TOKEN && env.ASANA_TOKEN;
}

export class Scheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    await this.state.storage.setAlarm(Date.now() + 5_000);
    return new Response('armed');
  }

  async alarm() {
    // Re-arm first, so one failed sync never kills the loop.
    await this.state.storage.setAlarm(Date.now() + 60_000);
    if (!configured(this.env)) {
      console.error('NOT CONFIGURED: set SLACK_BOT_TOKEN and ASANA_TOKEN with `wrangler secret put`.');
      return;
    }
    try {
      await runSync(envConfig(this.env));
    } catch (e) {
      console.error(`Sync failed (will retry next minute): ${e.message}`);
    }
  }
}

export default {
  // Kept in case Cloudflare's cron scheduler ever starts working; the DO alarm is the real driver.
  async scheduled(controller, env, ctx) {
    if (!configured(env)) return;
    ctx.waitUntil(runSync(envConfig(env)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/run' || url.pathname === '/arm') {
      if (!env.TRIGGER_KEY || url.searchParams.get('key') !== env.TRIGGER_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      if (url.pathname === '/arm') {
        const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName('singleton'));
        await stub.fetch('https://scheduler/arm');
        return new Response('alarm loop armed\n', { status: 200 });
      }
      if (!configured(env)) return new Response('not configured\n', { status: 503 });
      const summary = await runSync(envConfig(env));
      return new Response(JSON.stringify(summary) + '\n', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Ops Triage Bot — nothing to see here.', { status: 200 });
  },
};
