import { randomUUID } from "crypto";
import { Firestore } from "@google-cloud/firestore";

// Google Calendar is the source of truth; this tracks how each Calendar
// event maps to its mirrored Discord Scheduled Event, plus the last-known
// field values (used to detect whether a change is meaningful enough to
// warrant an "EVENT UPDATE" announcement) and the incremental-sync cursor.
const firestore = new Firestore();
const EVENTS_COLLECTION = "calendarEvents";
const SYNC_STATE_DOC = firestore.collection("calendarSync").doc("state");
const POLL_LOCK_DOC = firestore.collection("calendarSync").doc("pollLock");

export interface EventMapping {
  // Absent for builders-only events, which get no Discord Scheduled Event.
  discordEventId?: string;
  status: "active" | "cancelled";
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
  location: string;
  // Set when the event is first mirrored and cleared once its announcement
  // email has gone to the mailing list, so a failed send is retried on the
  // next poll. Absent on events mirrored before these emails existed.
  emailPending?: boolean;
  // A private Calendar event (see src/buildersOnly.ts). Absent on events
  // mirrored before builders-only events existed.
  buildersOnly?: boolean;
  // The new-event announcement with the RSVP buttons, so they can be taken
  // off when the event is cancelled. Absent on events announced before this
  // was saved, and when there was no channel to post in.
  announcementChannelId?: string;
  announcementMessageId?: string;
}

export interface StoredEventMapping extends EventMapping {
  calendarEventId: string;
}

export async function getSyncToken(): Promise<string | undefined> {
  const snap = await SYNC_STATE_DOC.get();
  return snap.data()?.syncToken;
}

export async function saveSyncToken(syncToken: string): Promise<void> {
  await SYNC_STATE_DOC.set({ syncToken }, { merge: true });
}

export async function getEventMapping(calendarEventId: string): Promise<EventMapping | undefined> {
  const doc = await firestore.collection(EVENTS_COLLECTION).doc(calendarEventId).get();
  return doc.data() as EventMapping | undefined;
}

// Undefined fields are dropped: Firestore rejects them, and a replaced
// document should lose them anyway (e.g. a discordEventId that was deleted).
export async function saveEventMapping(calendarEventId: string, mapping: EventMapping): Promise<void> {
  const fields = Object.fromEntries(Object.entries(mapping).filter(([, value]) => value !== undefined));
  await firestore.collection(EVENTS_COLLECTION).doc(calendarEventId).set(fields);
}

export async function setEmailPending(calendarEventId: string, emailPending: boolean): Promise<void> {
  await firestore.collection(EVENTS_COLLECTION).doc(calendarEventId).set({ emailPending }, { merge: true });
}

async function queryMappings(field: string, value: unknown): Promise<StoredEventMapping[]> {
  const snap = await firestore.collection(EVENTS_COLLECTION).where(field, "==", value).get();
  return snap.docs.map((doc) => ({ ...(doc.data() as EventMapping), calendarEventId: doc.id }));
}

export function listActiveEventMappings(): Promise<StoredEventMapping[]> {
  return queryMappings("status", "active");
}

export function listEventMappingsPendingEmail(): Promise<StoredEventMapping[]> {
  return queryMappings("emailPending", true);
}

// Two overlapping poll runs (e.g. a manual `gcloud scheduler jobs run`
// during a scheduled one) would read the same syncToken, see the same new
// Calendar event with no mapping yet, and each create a Discord event for
// it. So a run first takes this lease and skips if another run holds it.
// The lease expires on its own, so a run that crashes (or times out) can't
// wedge the sync; it must outlast the function's timeout (60s by default)
// but stay under the 5-minute schedule.
export const POLL_LOCK_LEASE_MS = 4 * 60 * 1000;

// Returns a token for releasePollLock, or undefined if another run holds it.
export async function acquirePollLock(now = Date.now()): Promise<string | undefined> {
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(POLL_LOCK_DOC);
    const lockedUntil: number = snap.data()?.lockedUntil ?? 0;
    if (lockedUntil > now) return undefined;
    const owner = randomUUID();
    tx.set(POLL_LOCK_DOC, { owner, lockedUntil: now + POLL_LOCK_LEASE_MS });
    return owner;
  });
}

// Only clears the lease if it's still ours — if this run overran its lease
// and another run has since taken it, that run's lease is left alone.
export async function releasePollLock(owner: string): Promise<void> {
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(POLL_LOCK_DOC);
    if (snap.data()?.owner === owner) tx.delete(POLL_LOCK_DOC);
  });
}
