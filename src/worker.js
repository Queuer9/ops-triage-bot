/**
 * Cloudflare Worker entry: runs the sync on a 1-minute cron trigger (see wrangler.toml).
 * Secrets SLACK_BOT_TOKEN and ASANA_TOKEN are set with `wrangler secret put`.
 */
import { runSync } from './core.js';

export default {
  async scheduled(controller, env, ctx) {
    if (!env.SLACK_BOT_TOKEN || !env.ASANA_TOKEN) {
      console.error('NOT CONFIGURED: set SLACK_BOT_TOKEN and ASANA_TOKEN with `wrangler secret put`.');
      return;
    }
    ctx.waitUntil(runSync({
      slackToken: env.SLACK_BOT_TOKEN,
      asanaToken: env.ASANA_TOKEN,
      channelIds: env.SLACK_CHANNEL_IDS || 'C09RRCML3QQ',
    }));
  },

  // The worker's public URL does nothing on purpose — the cron is the only trigger.
  async fetch() {
    return new Response('Ops Triage Bot — runs on a 1-minute cron. Nothing to see here.', { status: 200 });
  },
};
