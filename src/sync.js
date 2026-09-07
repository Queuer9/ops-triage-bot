#!/usr/bin/env node
/**
 * Node entry (used by the GitHub Actions fallback): runs one sync pass from env vars.
 * The actual logic lives in core.js, shared with the Cloudflare Worker (worker.js).
 */
import { runSync } from './core.js';

// Until both secrets are configured, do nothing (quietly green) rather than fail every run.
if (!process.env.SLACK_BOT_TOKEN || !process.env.ASANA_TOKEN) {
  console.log('NOT CONFIGURED YET: add SLACK_BOT_TOKEN and ASANA_TOKEN as repository secrets (see README). Skipping run.');
  process.exit(0);
}

runSync({
  slackToken: process.env.SLACK_BOT_TOKEN,
  asanaToken: process.env.ASANA_TOKEN,
  channelIds: process.env.SLACK_CHANNEL_IDS || 'C09RRCML3QQ',
}).catch(err => {
  console.error(err);
  process.exit(1);
});
