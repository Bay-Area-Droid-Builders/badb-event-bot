import type { calendar_v3 } from "googleapis";
import { getCalendarClient } from "./googleAuth";

export interface CalendarChanges {
  events: calendar_v3.Schema$Event[];
  nextSyncToken: string;
}

export function httpStatus(err: any): number | undefined {
  return err?.status ?? err?.response?.status ?? (err?.code ? Number(err.code) : undefined);
}

function isGoneError(err: any): boolean {
  return httpStatus(err) === 410;
}

async function fetchChanges(calendarId: string, syncToken?: string): Promise<CalendarChanges> {
  const calendar = await getCalendarClient();
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const res = await calendar.events.list({
      calendarId,
      syncToken,
      pageToken,
      singleEvents: true,
      showDeleted: true,
    });
    events.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
    nextSyncToken = res.data.nextSyncToken ?? undefined;
  } while (pageToken);

  if (!nextSyncToken) throw new Error("Calendar API did not return a nextSyncToken");
  return { events, nextSyncToken };
}

// Wraps events.list with incremental sync — each call returns only what
// changed (created/updated/cancelled) since the last syncToken. On first
// call (no syncToken) or after a token expires (410 Gone), falls back to a
// full resync; that's safe because already-mirrored events are recognized
// via their Firestore mapping (src/eventSync.ts) rather than recreated.
export async function listCalendarChanges(calendarId: string, syncToken?: string): Promise<CalendarChanges> {
  try {
    return await fetchChanges(calendarId, syncToken);
  } catch (err) {
    if (syncToken && isGoneError(err)) {
      return await fetchChanges(calendarId);
    }
    throw err;
  }
}

// The caller supplies the event ID (Calendar allows base32hex — a–v, 0–9 —
// 5–1024 chars), which makes this idempotent: inserting the same ID again
// is rejected with 409 Conflict, so a repeated Approve click or a retry
// after a timeout can never create a duplicate event.
export async function createCalendarEvent(params: {
  id: string;
  title: string;
  description: string;
  startIso: string;
  endIso: string;
  location: string;
}): Promise<string> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) throw new Error("GOOGLE_CALENDAR_ID is not set");

  const calendar = await getCalendarClient();
  let res;
  try {
    res = await calendar.events.insert({
      calendarId,
      requestBody: {
        id: params.id,
        summary: params.title,
        description: params.description,
        location: params.location,
        start: { dateTime: params.startIso },
        end: { dateTime: params.endIso },
      },
    });
  } catch (err) {
    if (httpStatus(err) === 409) return params.id; // already created by an earlier attempt
    throw err;
  }

  if (!res.data.id) throw new Error("Calendar API did not return an event id");
  return res.data.id;
}

// Returns undefined when the event doesn't exist (a bad or stale RSVP link).
export async function getCalendarEvent(calendarId: string, eventId: string): Promise<calendar_v3.Schema$Event | undefined> {
  const calendar = await getCalendarClient();
  try {
    const res = await calendar.events.get({ calendarId, eventId });
    return res.data;
  } catch (err) {
    if (httpStatus(err) === 404 || httpStatus(err) === 410) return undefined;
    throw err;
  }
}
