import { http } from "@google-cloud/functions-framework";
import type { Request, Response } from "@google-cloud/functions-framework";
import type { calendar_v3 } from "googleapis";
import { isBuildersOnly, labelBuildersOnly } from "./buildersOnly";
import { createGuildScheduledEvent, deleteGuildScheduledEvent, postChannelMessage, updateGuildScheduledEvent } from "./discordApi";
import { syncDiscordInterest } from "./discordInterest";
import { buildNewEventEmail, MAILING_LIST_ADDRESS } from "./eventEmails";
import {
  acquirePollLock,
  EventMapping,
  getEventMapping,
  getSyncToken,
  listEventMappingsPendingEmail,
  releasePollLock,
  saveEventMapping,
  saveSyncToken,
  setEmailPending,
  StoredEventMapping,
} from "./eventSync";
import { formatCalendarEventWhen, htmlToText } from "./format";
import { listCalendarChanges } from "./googleCalendar";
import { sendEmail } from "./mailer";
import { syncPendingRsvps } from "./rsvpCalendar";
import { rsvpButtonRow } from "./rsvpButtons";

// GUILD_SCHEDULED_EVENT_ENTITY_TYPE.EXTERNAL — since droid meetups happen at
// physical venues rather than in a Discord voice channel.
const ENTITY_TYPE_EXTERNAL = 3;
const EVENT_STATUS_SCHEDULED = 1;
const EVENT_STATUS_CANCELED = 4;
const PRIVACY_LEVEL_GUILD_ONLY = 2;

function extractFields(event: calendar_v3.Schema$Event) {
  const labelled = labelBuildersOnly(event);
  return {
    summary: labelled.summary || "Untitled event",
    description: htmlToText(labelled.description || ""),
    startIso: event.start?.dateTime ?? event.start?.date ?? "",
    endIso: event.end?.dateTime ?? event.end?.date ?? "",
    location: event.location || "",
    buildersOnly: isBuildersOnly(event),
  };
}

type EventFields = ReturnType<typeof extractFields>;

function hasMeaningfulChange(a: EventMapping, b: EventFields): boolean {
  return (
    a.summary !== b.summary ||
    a.description !== b.description ||
    a.startIso !== b.startIso ||
    a.endIso !== b.endIso ||
    a.location !== b.location ||
    !!a.buildersOnly !== b.buildersOnly
  );
}

interface Channels {
  announcement: string;
  // Unset means builders-only events aren't posted to Discord at all —
  // never to #events instead.
  buildersOnly?: string;
}

function channelFor(channels: Channels, buildersOnly: boolean | undefined): string | undefined {
  return buildersOnly ? channels.buildersOnly : channels.announcement;
}

async function postTo(channelId: string | undefined, body: object): Promise<void> {
  if (channelId) await postChannelMessage(channelId, body);
}

// Creates, updates, or removes the event's Discord Scheduled Event and
// returns its ID. Scheduled Events are visible to the whole server, so a
// builders-only event has none; one made private after it was mirrored has
// its Scheduled Event deleted rather than cancelled, which would leave the
// title showing.
async function syncScheduledEvent(guildId: string, discordEventId: string | undefined, fields: EventFields): Promise<string | undefined> {
  if (fields.buildersOnly) {
    if (discordEventId) await deleteGuildScheduledEvent(guildId, discordEventId);
    return undefined;
  }
  if (discordEventId) {
    await updateGuildScheduledEvent(guildId, discordEventId, {
      name: fields.summary,
      scheduled_start_time: fields.startIso,
      scheduled_end_time: fields.endIso,
      description: fields.description,
      entity_metadata: { location: fields.location || "TBD" },
    });
    return discordEventId;
  }
  const created = await createGuildScheduledEvent(guildId, {
    name: fields.summary,
    privacy_level: PRIVACY_LEVEL_GUILD_ONLY,
    scheduled_start_time: fields.startIso,
    scheduled_end_time: fields.endIso,
    description: fields.description,
    entity_type: ENTITY_TYPE_EXTERNAL,
    entity_metadata: { location: fields.location || "TBD" },
    status: EVENT_STATUS_SCHEDULED,
  });
  return created.id;
}

function eventEmbed(title: string, color: number, fields: EventFields): object {
  return {
    title,
    description: fields.description || undefined,
    color,
    fields: [
      { name: "When", value: formatCalendarEventWhen(fields.startIso, fields.endIso), inline: true },
      ...(fields.location ? [{ name: "Where", value: fields.location, inline: true }] : []),
    ],
  };
}

function newEventMessage(calendarEventId: string, fields: EventFields): object {
  const rsvpButtons = rsvpButtonRow(calendarEventId);
  return {
    ...(rsvpButtons ? { components: [rsvpButtons] } : {}),
    embeds: [eventEmbed(`📅 New event: ${fields.summary}`, 0x2ecc71, fields)],
  };
}

async function syncCalendarToDiscord(guildId: string, channels: Channels, calendarId: string): Promise<string> {
  const syncToken = await getSyncToken();
  const { events, nextSyncToken } = await listCalendarChanges(calendarId, syncToken);

  let created = 0;
  let updated = 0;
  let cancelled = 0;

  for (const event of events) {
    if (!event.id) continue;

    try {
      const mapping = await getEventMapping(event.id);

      if (event.status === "cancelled") {
        if (mapping && mapping.status !== "cancelled") {
          if (mapping.discordEventId) {
            await updateGuildScheduledEvent(guildId, mapping.discordEventId, { status: EVENT_STATUS_CANCELED });
          }
          await postTo(channelFor(channels, mapping.buildersOnly), {
            embeds: [{ title: `🚫 EVENT CANCELLED: ${mapping.summary}`, color: 0xe74c3c }],
          });
          await saveEventMapping(event.id, { ...mapping, status: "cancelled", emailPending: false });
          cancelled++;
        }
        continue;
      }

      const fields = extractFields(event);

      if (!mapping) {
        const discordEventId = await syncScheduledEvent(guildId, undefined, fields);
        await postTo(channelFor(channels, fields.buildersOnly), newEventMessage(event.id, fields));
        // The announcement email goes out from sendPendingEventEmails, right
        // after this loop, so a failed send gets retried on later polls.
        await saveEventMapping(event.id, { discordEventId, status: "active", ...fields, emailPending: true });
        created++;
      } else if (hasMeaningfulChange(mapping, fields)) {
        const discordEventId = await syncScheduledEvent(guildId, mapping.discordEventId, fields);
        // An event that just switched between public and builders-only has
        // never been posted in its new channel, so it's announced there as new.
        const message =
          !!mapping.buildersOnly !== fields.buildersOnly
            ? newEventMessage(event.id, fields)
            : { embeds: [eventEmbed(`🔄 EVENT UPDATE: ${fields.summary}`, 0xf1c40f, fields)] };
        await postTo(channelFor(channels, fields.buildersOnly), message);
        await saveEventMapping(event.id, { ...mapping, status: "active", ...fields, discordEventId });
        updated++;
      }
    } catch (err) {
      // Leave this event's mapping/state as-is so the next poll retries it.
      console.error(`Failed to sync calendar event ${event.id}`, err);
    }
  }

  // Advance the cursor even if some individual events failed above — a
  // stuck cursor would mean re-processing the whole backlog every run.
  await saveSyncToken(nextSyncToken);

  return `checked ${events.length}, created ${created}, updated ${updated}, cancelled ${cancelled}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function calendarTime(iso: string): calendar_v3.Schema$EventDateTime {
  return DATE_ONLY.test(iso) ? { date: iso } : { dateTime: iso };
}

// Emails each newly mirrored event to the mailing list. Rebuilt from the
// mapping's saved fields, which are the same values the Discord
// announcement used. Events that have already started by the time a
// retry comes around are dropped rather than announced late.
async function sendPendingEventEmails(now = Date.now()): Promise<number> {
  let sent = 0;
  for (const mapping of await listEventMappingsPendingEmail()) {
    try {
      if (mapping.status === "active" && new Date(mapping.startIso).getTime() > now) {
        await sendEmail(buildNewEventEmail(mappingToEvent(mapping), MAILING_LIST_ADDRESS));
        sent++;
      }
      await setEmailPending(mapping.calendarEventId, false);
    } catch (err) {
      console.error(`Failed to email new calendar event ${mapping.calendarEventId}`, err);
    }
  }
  return sent;
}

function mappingToEvent(mapping: StoredEventMapping): calendar_v3.Schema$Event {
  return {
    id: mapping.calendarEventId,
    summary: mapping.summary,
    description: mapping.description,
    location: mapping.location,
    start: calendarTime(mapping.startIso),
    end: calendarTime(mapping.endIso),
  };
}

// Each step after the Calendar mirror runs even if an earlier one failed —
// they're independent, and each picks up where it left off next poll.
async function runStep(name: string, step: () => Promise<number>): Promise<string> {
  try {
    return `${name} ${await step()}`;
  } catch (err) {
    console.error(`Poll step "${name}" failed`, err);
    return `${name} failed`;
  }
}

// Google Calendar is the source of truth for events; this mirrors it into
// Discord. Invoked on a schedule (Cloud Scheduler, every few minutes)
// rather than by Discord or Calendar directly. Uses Calendar's incremental
// sync (a syncToken) so each run only sees what actually changed —
// created, updated, or cancelled — since the last run.
http("pollScheduledEvents", async (_req: Request, res: Response) => {
  const guildId = process.env.DISCORD_GUILD_ID;
  const announcementChannelId = process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
  const calendarId = process.env.GOOGLE_CALENDAR_ID;

  if (!guildId || !announcementChannelId || !calendarId) {
    res.status(500).send("DISCORD_GUILD_ID / DISCORD_ANNOUNCEMENT_CHANNEL_ID / GOOGLE_CALENDAR_ID not set");
    return;
  }

  const lockOwner = await acquirePollLock();
  if (!lockOwner) {
    res.status(200).send("skipped — another poll run is in progress");
    return;
  }

  // Released before responding: work after the response runs with
  // throttled CPU on Cloud Functions and might not happen.
  let summary: string;
  try {
    const channels = { announcement: announcementChannelId, buildersOnly: process.env.DISCORD_BUILDERS_CHANNEL_ID || undefined };
    const parts = [await syncCalendarToDiscord(guildId, channels, calendarId)];
    parts.push(await runStep("emailed", () => sendPendingEventEmails()));
    parts.push(await runStep("interest changes", () => syncDiscordInterest(guildId)));
    parts.push(await runStep("rsvp events synced", () => syncPendingRsvps(calendarId)));
    summary = parts.join("; ");
  } finally {
    await releasePollLock(lockOwner);
  }
  res.status(200).send(summary);
});
