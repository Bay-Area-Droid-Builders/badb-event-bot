# BADB Event Bot

Google Form submission → admin approval in Discord → Google Calendar. From
there, **Google Calendar is the single source of truth** for public events —
it's shared on the website and members subscribe to it directly. Discord
(the `#events` channel and Discord's own Scheduled Events) and a bi-weekly
email are downstream notification channels that mirror whatever is on the
Calendar. The one thing that flows back is RSVPs: members RSVP through a
single RSVP page (linked from Discord buttons and every email), and the bot
adds them to the Calendar event's guest list.

## Architecture

- **`formSubmit`** (Cloud Function): receives a POST from the Apps Script
  trigger, posts a formatted embed with **Approve** / **Dismiss** buttons
  into your admin channel.
- **`interactions`** (Cloud Function): Discord's required Interactions
  Endpoint. Verifies the request is really from Discord, then on
  **Approve** adds the event to Google Calendar — nothing else. The Discord
  event and public announcement follow automatically once `pollScheduledEvents`
  picks up the new Calendar entry. The Calendar event's ID is derived from
  the request's Discord message ID, so clicking Approve twice (or retrying
  after a failure) never creates a duplicate. The outcome (✅ approved,
  ❌ dismissed, or ⚠️ not added, with the reason) is always written onto the
  request message itself, so check the message if Discord says "This
  interaction failed". That toast only means the reply took longer than
  Discord's 3-second limit.
- **`pollScheduledEvents`** (Cloud Function, run every 5 minutes via Cloud
  Scheduler): the core sync. Uses the Calendar API's incremental sync (a
  `syncToken`, stored in Firestore) so each run only sees what actually
  changed since the last one — created, updated, or cancelled — rather than
  re-scanning everything. For each change it mirrors the corresponding
  Discord Scheduled Event (create / update / mark CANCELED) and posts to
  the public `#events` channel: "📅 New event", "🔄 EVENT UPDATE", or
  "🚫 EVENT CANCELLED". New-event posts carry **Attending / Maybe /
  Decline** buttons, and each new event is also emailed to the R2SF Google
  Group with RSVP links. An event created directly in Discord (bypassing
  Calendar) is intentionally never picked up — Calendar is the only
  supported entry point. Each run then also lines up Discord "Interested"
  clicks with the guest list and retries any RSVPs that didn't reach
  Calendar (see **RSVPs** below).
- **`sendEventDigest`** (Cloud Function, run weekly via Cloud Scheduler but
  only actually sends every other run — see below): lists upcoming Calendar
  events and emails the list, with RSVP links, to the R2SF Google Group via
  Gmail SMTP. It doesn't post to Discord — `#events` only gets new-event
  announcements.
- **`rsvp`** (Cloud Function, public): the RSVP page. See **RSVPs** below.

## RSVPs

There's one RSVP page for everything. Each event's Discord buttons and email
links open it with that event (and the chosen answer) filled in. Someone
picks **Attending**, **Maybe**, or **Decline**, and the bot puts them on the
Calendar event's guest list with that response, so Attending or Maybe also
sends them a Google Calendar invite.

- **First RSVP:** they enter their name and email, and the page emails them
  a confirmation link, so nobody can RSVP an address that isn't theirs.
  Confirming sets a signed cookie, so that browser RSVPs in one click from
  then on.
- **From Discord:** a button replies with a private link carrying a signed
  token of the clicker's Discord ID. Once they confirm, their Discord
  account is linked to their email (`discordLinks` in Firestore).
- **Discord "Interested":** Discord never gives bots anyone's email, so this
  only works for linked members. For them, `pollScheduledEvents` treats
  Interested as Attending and takes them back off the guest list if they
  un-click it. An answer given on the page always wins over Interested.
- **Answers from Google Calendar stick:** if someone changes their response
  in their own calendar, the bot leaves it alone. It only writes to the
  guest list when someone RSVPs.

RSVPs are saved to Firestore (`rsvps`) before being copied to Calendar, so a
Calendar outage never loses one; the poller retries anything not yet copied.
The bot acts on Calendar as the club Google account rather than a service
account, because Calendar won't let a service account add guests unless it
belongs to a Google Workspace domain.

Firestore (`(default)` database, Native mode) holds a few small collections:
`calendarEvents` (Calendar event ID → mirrored Discord event ID + last-seen
fields, so updates/cancellations can be detected and applied idempotently)
and `calendarSync` (the incremental sync cursor, plus a short-lived lock so
two overlapping `pollScheduledEvents` runs — say a manual run during a
scheduled one — can't both mirror the same new event into Discord). `digestState` holds the
bi-weekly on/off toggle. `rsvps`, `discordLinks`, and `rsvpConfirmThrottle`
back the RSVP flow above.

## One-time setup

1. Complete the Discord Developer Portal steps (app, bot, permissions,
   public key, guild/channel IDs) — see the walkthrough you were given
   alongside this code. The bot's role needs **Manage Events** (guild-wide)
   and **View Channel + Send Messages** on both the admin channel and the
   public `#events` channel.
2. Make sure the club Google account (badroidbuilders@gmail.com) has
   **Make changes to events** on the Calendar. Grab the Calendar ID from
   Calendar Settings > Integrate calendar.
3. Let the bot act on Calendar as the club account:
   1. In Google Cloud Console > **Google Auth Platform**, set up the
      consent screen (External), add the
      `https://www.googleapis.com/auth/calendar.events` scope, and
      **publish the app to Production**. While the app is in Testing,
      Google expires its refresh tokens after 7 days. It doesn't need
      Google's verification, since only the club account signs in; you'll
      just click through an "unverified app" warning once.
   2. Create an OAuth client of type **Desktop app**.
   3. Run `node scripts/authorize-calendar.js <client ID> <client secret>`,
      open the printed URL, sign in as the club account, and copy the
      printed refresh token.
4. Enable 2-Step Verification on the club Google account, then create an
   **App password** (Google Account > Security > 2-Step Verification > App
   passwords). It's used to send the digest, new-event, and RSVP
   confirmation emails.
5. `cp .env.yaml.example .env.yaml` and fill in the real values, including
   the OAuth client, refresh token, and a random `RSVP_SIGNING_SECRET`.
   `npm install`
6. Enable the required GCP APIs and create the Firestore database (one-time,
   per project):
   ```
   gcloud services enable cloudfunctions.googleapis.com run.googleapis.com \
     cloudbuild.googleapis.com artifactregistry.googleapis.com \
     eventarc.googleapis.com firestore.googleapis.com cloudscheduler.googleapis.com \
     calendar-json.googleapis.com
   gcloud firestore databases create --location=us-west1 --type=firestore-native
   ```
7. Deploy all five functions:
   ```
   npm run deploy:form-submit
   npm run deploy:interactions
   npm run deploy:poll-scheduled-events
   npm run deploy:send-event-digest
   npm run deploy:rsvp
   ```
   If this is the first deploy of `rsvp`, put its trigger URL in
   `.env.yaml` as `RSVP_PAGE_URL` and redeploy the other functions that
   build RSVP links (`interactions`, `poll-scheduled-events`,
   `send-event-digest`).
   `interactions` is deployed with `--min-instances=1` so one instance is
   always warm. Discord gives a button click only 3 seconds to be
   answered, and a cold start alone can use most of that. The idle instance
   is billed continuously (roughly a few dollars a month at the default
   size); drop the flag if that isn't worth it.
   `formSubmit`, `interactions`, and `rsvp` are public and print a
   **Trigger URL** — save them. `pollScheduledEvents`
   and `sendEventDigest` are deployed with `--no-allow-unauthenticated`
   since only Cloud Scheduler should be able to call them.
8. In the Discord Developer Portal, paste the `interactions` function's URL
   into **Interactions Endpoint URL** and save. Discord will immediately
   send a PING to verify it; if the deploy above succeeded this passes
   automatically.
9. In the Google Sheet collecting form responses: **Extensions > Apps
   Script**, paste in `appsscript/onFormSubmit.js`, update
   `FORM_SUBMIT_URL` (the `formSubmit` trigger URL from step 7) and
   `SHARED_SECRET` (must match `.env.yaml`'s `FORM_SHARED_SECRET`), then
   set the `COLUMNS` mapping to match your actual form's question order.
10. Add a trigger: clock icon on the left > **Add Trigger** > function
    `onFormSubmit` > event source **From spreadsheet** > event type
    **On form submit** > Save.
11. Wire up both schedules, letting each function invoke itself via its own
    service account:
    ```
    gcloud functions add-invoker-policy-binding badb-poll-scheduled-events \
      --region=us-west1 \
      --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com"
    gcloud scheduler jobs create http badb-poll-scheduled-events \
      --location=us-west1 \
      --schedule="*/5 * * * *" \
      --uri="<pollScheduledEvents trigger URL>" \
      --http-method=POST \
      --oidc-service-account-email="PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
      --oidc-token-audience="<pollScheduledEvents trigger URL>"

    gcloud functions add-invoker-policy-binding badb-send-event-digest \
      --region=us-west1 \
      --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com"
    gcloud scheduler jobs create http badb-send-event-digest \
      --location=us-west1 \
      --schedule="0 8 * * 1" \
      --time-zone="America/Los_Angeles" \
      --uri="<sendEventDigest trigger URL>" \
      --http-method=POST \
      --oidc-service-account-email="PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
      --oidc-token-audience="<sendEventDigest trigger URL>"
    ```
    `sendEventDigest` runs weekly but only actually sends every other
    invocation (a Firestore-backed toggle) — a real "every 2 weeks" cron
    schedule doesn't exist, so this is the standard workaround. For a manual
    test, pass `?to=<your email>` to send just to yourself, or
    `?force=true` to send to the real list off-schedule; neither changes
    the toggle, so testing never shifts the schedule.

## Testing

Unit tests: `npm test` (vitest; runs pinned to UTC like Cloud Functions so
timezone bugs aren't hidden by your machine's local zone).

End to end: submit a test response through the actual Google Form (Apps Script
`onFormSubmit` triggers don't fire from manually editing the sheet). You
should see the embed appear in the admin channel within a few seconds.
Click **Approve** and confirm the event shows up in Google Calendar —
Discord and the `#events` announcement follow within the next
`pollScheduledEvents` run (or trigger it manually with
`gcloud scheduler jobs run badb-poll-scheduled-events --location=us-west1`).

## Notes / things you may want to tweak

- Events are created as `EXTERNAL` (physical location) rather than tied to
  a voice channel — change `entity_type` in `pollScheduledEvents.ts` if
  that's ever wrong for a meetup.
- The form collects an explicit End Time, but `resolveEndIso` in
  `format.ts` still falls back to a 3-hour block if `endIso` is ever
  missing.
- All displayed times (the admin embed, announcements, the digest, and the
  "Arrival" line in event descriptions) are shown in Pacific time —
  `EVENT_TIME_ZONE` in `format.ts`.
- Only meaningful field changes (title, start/end time, location,
  description) trigger an "EVENT UPDATE" — incidental Calendar metadata
  touches are ignored, so `#events` doesn't get noisy.
- Cancelling/deleting a Calendar event marks the mirrored Discord event
  **CANCELED** rather than deleting it, so it stays visible (greyed out) to
  anyone who had saved it.
- If you ever want role-gating on who can click the admin buttons, the
  member's roles are available on `interaction.member.roles` inside the
  handler.
- Local testing: `npm run start:form-submit`, `start:interactions`,
  `start:poll-scheduled-events`, or `start:send-event-digest` runs the
  Functions Framework locally; use a tool like `ngrok` to expose it if you
  need Discord to actually reach it during dev.
