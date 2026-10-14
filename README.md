# BADB Event Bot

Keeps the Bay Area Droid Builders' events in one place and tells everyone
about them. Google Calendar is the source of truth. The bot gets events onto
it, announces them in Discord and by email, and collects RSVPs onto each
event's guest list.

## What it does

**Event requests.** Members request an event through a Google Form. Each
request shows up in the Discord admin channel with **Approve** and
**Dismiss** buttons. Approve adds the event to Google Calendar. The result
(✅ approved, ❌ dismissed, or ⚠️ not added, with the reason) is written
onto the request message.

**Announcements.** Within 5 minutes of an event being added to the
calendar, by approval or by hand, the bot:

- posts "📅 New event" in `#events` with **Attending / Maybe / Decline**
  buttons,
- creates a matching Discord Scheduled Event, and
- emails the event, with RSVP links, to the R2SF Google Group.

Changes to the title, time, location, or description post a
"🔄 EVENT UPDATE". When an event is cancelled or deleted, the original
announcement is marked "🚫 CANCELLED" (red, buttons removed), a
cancellation notice is posted as a reply to it, and the Scheduled Event is
marked cancelled.

**Digest.** Every other Monday at 8am Pacific, upcoming events are emailed
to the R2SF list. The digest isn't posted to Discord.

**RSVPs.** Every button and email link leads to one RSVP page. An answer
there puts the person on the Calendar event's guest list, so Attending or
Maybe also sends them a Google Calendar invite.

**Builders-only events.** Members-only events stay out of public channels.
See below.

## Everyday tasks

### Add a builders-only event

Add the event to the club calendar by hand and set its visibility to
**Private**. The public calendar then shows only "busy" for that time. The
bot:

- adds **(BUILDERS ONLY)** to the title and "This is a Bay Area Droid
  Builders Members only event announcement. Do Not Share!" to the top of
  the description, everywhere it shows the event. Typing them yourself is
  fine, since they aren't added twice.
- announces it in the builders channel, not `#events`, and creates no
  Scheduled Event (the whole server can see those).
- still emails it to R2SF and includes it in the digest.

Making an already-announced event private moves it to the builders
channel, but its `#events` post stays up, so delete that by hand.

### Test or resend the digest

Call `sendEventDigest` with `?to=<your email>` to send it only to you, or
`?force=true` to send it to the list off-schedule. Neither affects the
every-other-week schedule.

### Sync the calendar now

```
gcloud scheduler jobs run badb-poll-scheduled-events --location=us-west1
```

### Deploy a change

`npm run deploy:<function>`, where `<function>` is `form-submit`,
`interactions`, `poll-scheduled-events`, `send-event-digest`, or `rsvp`.
The deploy prints every value from `.env.yaml`, secrets included, so keep
its output to yourself.

## How it works

Five Cloud Functions, with Firestore for state:

| Function | Trigger | Job |
|---|---|---|
| `formSubmit` | Apps Script, on each form response | Posts the request to the admin channel. |
| `interactions` | Discord button clicks | Approve/Dismiss on requests; replies to RSVP buttons with a personal RSVP link. |
| `pollScheduledEvents` | Cloud Scheduler, every 5 minutes | Mirrors calendar changes into Discord, sends new-event emails, syncs Discord "Interested" clicks, and copies RSVPs onto Calendar. |
| `sendEventDigest` | Cloud Scheduler, weekly | Emails the digest every other run. |
| `rsvp` | Public web page | The RSVP page. |

- **Calendar is the only way in.** The poller reads Calendar changes with
  an incremental sync token, so each run sees only what changed. Events
  created directly in Discord are ignored.
- **Approving is safe to repeat.** The Calendar event's ID comes from the
  request's Discord message ID, so clicking Approve twice can't create a
  duplicate. If Discord says "This interaction failed", the click still
  worked. Check the request message for the result.
- **RSVP identity.** A first RSVP asks for a name and email and sends a
  confirmation link, so nobody can RSVP someone else's address. Confirming
  sets a cookie, so later RSVPs from that browser take one click. RSVPing
  from a Discord button also links that Discord account to the email.
  After that, clicking "Interested" on a Scheduled Event counts as
  Attending, and un-clicking takes them off again. An answer given on the
  page always wins, and the bot never overrides a response someone changed
  in their own calendar.
- **RSVPs can't be lost.** Each one is saved to Firestore first, and the
  poller retries any that haven't reached Calendar yet.
- **The club account acts on Calendar.** The bot uses OAuth as the club
  Google account, because Calendar only lets service accounts add guests
  inside a Google Workspace domain.

Firestore collections:

| Collection | Holds |
|---|---|
| `calendarEvents` | Each Calendar event's Discord event, announcement message, and last-seen fields. |
| `calendarSync` | The incremental sync token, and a lock so overlapping poll runs can't double-post. |
| `digestState` | The every-other-week toggle. |
| `rsvps`, `discordLinks`, `rsvpConfirmThrottle` | RSVPs, Discord-to-email links, and confirmation-email rate limiting. |

## Setup

1. **Discord.** Create the app and bot in the Discord Developer Portal and
   note the public key and the guild and channel IDs. The bot's role needs
   **Manage Events** server-wide, plus **View Channel**, **Send Messages**,
   and **Embed Links** in the admin channel, `#events`, and the builders
   channel. The builders channel is private, so add the bot to it
   explicitly.
2. **Calendar access.** Give the club account (badroidbuilders@gmail.com)
   **Make changes to events** on the calendar, and copy the Calendar ID
   from Calendar Settings > Integrate calendar.
3. **OAuth for the club account.**
   1. In Google Cloud Console > **Google Auth Platform**, set up an
      External consent screen with the
      `https://www.googleapis.com/auth/calendar.events` scope, and
      **publish it to Production**. In Testing, refresh tokens expire after
      7 days. Verification isn't needed, since only the club account signs
      in, but you'll click through an "unverified app" warning once.
   2. Create an OAuth client of type **Desktop app**.
   3. Run `node scripts/authorize-calendar.js <client ID> <client secret>`,
      sign in as the club account, and copy the refresh token it prints.
4. **Email.** Turn on 2-Step Verification for the club account and create
   an **App password** (Google Account > Security > 2-Step Verification >
   App passwords).
5. **Config.** `cp .env.yaml.example .env.yaml`, fill in every value (each
   is explained in the file), then `npm install`. `.env.yaml` is gitignored.
6. **GCP project.** Enable the APIs and create Firestore:
   ```
   gcloud services enable cloudfunctions.googleapis.com run.googleapis.com \
     cloudbuild.googleapis.com artifactregistry.googleapis.com \
     eventarc.googleapis.com firestore.googleapis.com cloudscheduler.googleapis.com \
     calendar-json.googleapis.com
   gcloud firestore databases create --location=us-west1 --type=firestore-native
   ```
7. **Deploy** all five functions:
   ```
   npm run deploy:form-submit
   npm run deploy:interactions
   npm run deploy:poll-scheduled-events
   npm run deploy:send-event-digest
   npm run deploy:rsvp
   ```
   Note the trigger URLs that `formSubmit`, `interactions`, and `rsvp`
   print. On the first deploy, set `RSVP_PAGE_URL` in `.env.yaml` to the
   `rsvp` URL, then redeploy `interactions`, `poll-scheduled-events`, and
   `send-event-digest`. `pollScheduledEvents` and `sendEventDigest` only
   accept calls from Cloud Scheduler. `interactions` keeps one instance
   warm (a few dollars a month), because Discord allows only 3 seconds to
   answer a click.
8. **Discord endpoint.** Paste the `interactions` URL into **Interactions
   Endpoint URL** in the Developer Portal and save. Discord verifies it
   straight away.
9. **Form trigger.** In the form's response Sheet, open **Extensions > Apps
   Script** and paste in `appsscript/onFormSubmit.js`. Set
   `FORM_SUBMIT_URL` to the `formSubmit` URL, `SHARED_SECRET` to
   `FORM_SHARED_SECRET` from `.env.yaml`, and `COLUMNS` to match the form's
   question order. Then add a trigger (clock icon > **Add Trigger**):
   function `onFormSubmit`, **From spreadsheet**, **On form submit**.
10. **Schedules.** Let Cloud Scheduler call the two scheduled functions:
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
    Cron has no "every 2 weeks", so the digest job runs weekly and the
    function sends on every other run.

## Development

- **Tests:** `npm test`. They run in UTC, like Cloud Functions, so time zone
  bugs show up locally.
- **Run locally:** `npm run start:<function>` (for example
  `start:poll-scheduled-events`) starts it on the Functions Framework. Use a
  tunnel such as `ngrok` if Discord needs to reach it.
- **End to end:** submit the real Google Form (editing the Sheet by hand
  doesn't fire the trigger), approve the request in the admin channel, then
  run the poll as shown above.

Things you may want to change:

- **Time zone:** all times are shown in Pacific time (`EVENT_TIME_ZONE` in
  `src/format.ts`).
- **Default length:** an event with no end time is treated as 3 hours long
  (`resolveEndIso` in `src/format.ts`).
- **Event type:** Scheduled Events are created as in-person (`EXTERNAL`),
  not voice-channel events (`entity_type` in
  `src/pollScheduledEvents.ts`).
- **Who can approve:** anyone who can see the admin channel can approve
  requests. To restrict it to certain roles, check
  `interaction.member.roles` in `src/interactions.ts`.
