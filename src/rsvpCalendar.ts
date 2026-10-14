import type { calendar_v3 } from "googleapis";
import { getCalendarClient } from "./googleAuth";
import { httpStatus } from "./googleCalendar";
import { listRsvpsForEvent, listUnsyncedEventIds, markRsvpsSynced, normalizeEmail, RsvpStatus, StoredRsvp } from "./rsvpStore";

const RESPONSE_STATUS: Record<Exclude<RsvpStatus, "removed">, string> = {
  attending: "accepted",
  maybe: "tentative",
  declined: "declined",
};

const MAX_ATTEMPTS = 3;

// Applies RSVPs to a Calendar guest list. Guests without a pending RSVP —
// anyone added by hand, or anyone whose RSVP was already copied and who has
// since answered from Google Calendar's own invite — are left exactly as
// they are. `invitesNewGuest` says whether this adds someone who should get
// an invitation, so status changes and removals don't email anybody.
export function applyRsvpsToAttendees(
  attendees: calendar_v3.Schema$EventAttendee[],
  rsvps: StoredRsvp[],
): { attendees: calendar_v3.Schema$EventAttendee[]; invitesNewGuest: boolean } {
  let result = [...attendees];
  let invitesNewGuest = false;

  for (const rsvp of rsvps) {
    const email = normalizeEmail(rsvp.email);
    const index = result.findIndex((a) => normalizeEmail(a.email ?? "") === email);

    if (rsvp.status === "removed") {
      if (index !== -1) result = result.filter((_, i) => i !== index);
      continue;
    }

    const responseStatus = RESPONSE_STATUS[rsvp.status];
    if (index === -1) {
      result.push({ email, displayName: rsvp.name || undefined, responseStatus });
      if (rsvp.status !== "declined") invitesNewGuest = true;
    } else {
      result[index] = { ...result[index], responseStatus, displayName: result[index].displayName || rsvp.name || undefined };
    }
  }

  return { attendees: result, invitesNewGuest };
}

// Copies an event's pending RSVPs onto its Calendar guest list. The write
// is conditional on the event's ETag, so two RSVPs saved at the same moment
// can't overwrite each other's guest — the loser re-reads and tries again.
export async function syncEventRsvps(calendarId: string, calendarEventId: string): Promise<void> {
  const pending = (await listRsvpsForEvent(calendarEventId)).filter((r) => !r.synced);
  if (pending.length === 0) return;

  const calendar = await getCalendarClient();
  for (let attempt = 1; ; attempt++) {
    let event: calendar_v3.Schema$Event;
    try {
      event = (await calendar.events.get({ calendarId, eventId: calendarEventId })).data;
    } catch (err) {
      // The event is gone, so there's no guest list to update; stop retrying.
      if (httpStatus(err) === 404 || httpStatus(err) === 410) {
        await markRsvpsSynced(pending);
        return;
      }
      throw err;
    }
    if (event.status === "cancelled") {
      await markRsvpsSynced(pending);
      return;
    }

    const { attendees, invitesNewGuest } = applyRsvpsToAttendees(event.attendees ?? [], pending);
    try {
      await calendar.events.patch(
        { calendarId, eventId: calendarEventId, sendUpdates: invitesNewGuest ? "all" : "none", requestBody: { attendees } },
        { headers: { "If-Match": event.etag ?? "" } },
      );
      await markRsvpsSynced(pending);
      return;
    } catch (err) {
      // 412: the event changed after we read it.
      if (httpStatus(err) !== 412 || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}

// Retries every RSVP that hasn't reached Calendar yet. Run by the poller.
export async function syncPendingRsvps(calendarId: string): Promise<number> {
  const eventIds = await listUnsyncedEventIds();
  let synced = 0;
  for (const eventId of eventIds) {
    try {
      await syncEventRsvps(calendarId, eventId);
      synced++;
    } catch (err) {
      console.error(`Failed to sync RSVPs for calendar event ${eventId}`, err);
    }
  }
  return synced;
}
