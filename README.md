# Ops Triage Bot

Turns `@opsteam` mentions in Slack into tasks on the Asana **Ops Requests** board, and reports progress back to the original Slack thread. Runs as a GitHub Actions job every 5 minutes — no server to maintain.

## What it does

1. **Intake** — a message tagging `@opsteam` gets a 👀 reaction and a task in the **📥 Triage** section of [Ops Requests](https://app.asana.com/1/1207757703893119/project/1217818788597298), with a link back to the Slack message.
2. **Announce** — once the task has **both an assignee and a due date**, the bot replies once in the Slack thread: *"👀 This has been picked up by Libby — due Tue 2 Sep. Track it here: …"*
3. **Complete** — when the task is marked complete in Asana, the bot adds ✅ to the original message and removes its 👀.

It's stateless: the bot's own reactions and its "picked up by" reply are the dedupe markers, so overlapping runs never double-process. It only ingests messages sent after go-live (25 Aug 2026) and within the last 24 h.

## Setup (one-time, ~20 minutes)

### 1. Create the Slack app
1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest** → pick the Talos workspace.
2. Paste the contents of [`slack-app-manifest.json`](slack-app-manifest.json) and create the app.
3. **Install to Workspace** (Settings → Install App) and copy the **Bot User OAuth Token** (starts `xoxb-`).
4. In Slack, invite the bot to every channel it should watch: in **#ops**, type `/invite @Ops Team`. (It can only see channels it's a member of.)

### 2. Create the Asana token
1. Asana → https://app.asana.com/0/my-apps → **Create new token** (a Personal Access Token).
2. The token acts as you, so make sure your account can edit the **Ops Requests** project. (For cleaner attribution later, a dedicated Asana service account can own the token instead.)

### 3. Create the GitHub repo
1. Create a repo (e.g. `talos/ops-triage-bot`) and push this folder to it.
2. Repo → **Settings → Secrets and variables → Actions** → add two **repository secrets**:
   - `SLACK_BOT_TOKEN` — the `xoxb-` token from step 1
   - `ASANA_TOKEN` — the PAT from step 2
3. Repo → **Actions** tab → enable workflows if prompted → open **Ops request triage** → **Run workflow** to test. Green run = you're live.

## Configuration

- **Channels watched:** edit `SLACK_CHANNEL_IDS` in [`.github/workflows/ops-triage.yml`](.github/workflows/ops-triage.yml) (comma-separated Slack channel IDs; default is `C09RRCML3QQ` = #ops). Remember to also `/invite` the bot to each.
- **Board / usergroup / go-live date:** constants at the top of [`src/sync.js`](src/sync.js).

## Things worth knowing

- **Latency:** the cron fires every 5 minutes, but GitHub schedules can lag a few extra minutes under load. Expect tag → 👀 in roughly 5–15 minutes.
- **Private repo billing:** each run bills a minimum of 1 Actions minute; at 288 runs/day that's ~8,600 min/month, well past the 2,000 free private-repo minutes. Either make the repo **public** (the code contains no secrets — tokens live in GitHub Secrets), use an org plan with enough minutes, or stretch the cron.
- **60-day auto-disable:** GitHub pauses scheduled workflows after 60 days with no repo activity. GitHub emails a one-click re-enable; an occasional trivial commit also resets the clock.
- **Skip rule:** a message already carrying any 👀 or ✅ reaction is treated as handled and won't create a task. If a colleague reacts 👀 manually before the bot gets there, that request needs manual entry.
- **Every mention counts:** the script can't judge intent — any non-bot message containing the `@opsteam` mention becomes a task, including passing references. Delete unwanted tasks from Triage; the 👀 stays so it won't be re-ingested.
