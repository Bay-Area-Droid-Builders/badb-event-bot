import { randomUUID } from "crypto";
import { Firestore } from "@google-cloud/firestore";
import type { RsvpChoice } from "./rsvpLinks";

// RSVPs land here first and are then copied onto the Calendar event's guest
// list (src/rsvpCalendar.ts). Recording them separately means a Calendar
// failure never loses an RSVP — `synced: false` marks what still needs
// copying, and the poller retries it — and lets a Discord "Interested"
// click be told apart from an RSVP made on the page.
const firestore = new Firestore();
const RSVPS = firestore.collection("rsvps");
const DISCORD_LINKS = firestore.collection("discordLinks");
const CONFIRM_THROTTLE = firestore.collection("rsvpConfirmThrottle");

// "removed" takes someone off the guest list entirely — used when a
// Discord "Interested" click is withdrawn, since that person never
// actually said no.
export type RsvpStatus = RsvpChoice | "removed";
export type RsvpSource = "page" | "discord-interested";

export interface Rsvp {
  calendarEventId: string;
  email: string;
  name: string;
  status: RsvpStatus;
  source: RsvpSource;
  discordUserId?: string;
  synced: boolean;
  // Changes on every write, so marking an RSVP synced can tell whether it
  // changed again while it was being copied to Calendar.
  version: string;
}

export interface StoredRsvp extends Rsvp {
  id: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Email addresses may legally contain "/", which Firestore doesn't allow in
// a document ID.
function rsvpDocId(calendarEventId: string, email: string): string {
  return `${calendarEventId}__${encodeURIComponent(normalizeEmail(email))}`;
}

export async function getRsvp(calendarEventId: string, email: string): Promise<StoredRsvp | undefined> {
  const id = rsvpDocId(calendarEventId, email);
  const snap = await RSVPS.doc(id).get();
  const data = snap.data() as Rsvp | undefined;
  return data && { ...data, id };
}

export async function saveRsvp(rsvp: Omit<Rsvp, "synced" | "version">): Promise<void> {
  const email = normalizeEmail(rsvp.email);
  // Fields are copied one by one, since callers often pass a StoredRsvp
  // back in and its id/synced/version mustn't be written.
  const record: Rsvp = {
    calendarEventId: rsvp.calendarEventId,
    email,
    name: rsvp.name,
    status: rsvp.status,
    source: rsvp.source,
    synced: false,
    version: randomUUID(),
  };
  // Firestore rejects undefined field values.
  if (rsvp.discordUserId) record.discordUserId = rsvp.discordUserId;
  await RSVPS.doc(rsvpDocId(rsvp.calendarEventId, email)).set(record);
}

export async function listRsvpsForEvent(calendarEventId: string): Promise<StoredRsvp[]> {
  const snap = await RSVPS.where("calendarEventId", "==", calendarEventId).get();
  return snap.docs.map((doc) => ({ ...(doc.data() as Rsvp), id: doc.id }));
}

export async function listUnsyncedEventIds(): Promise<string[]> {
  const snap = await RSVPS.where("synced", "==", false).get();
  return [...new Set(snap.docs.map((doc) => (doc.data() as Rsvp).calendarEventId))];
}

// Only marks an RSVP synced if it hasn't changed since it was read, so a
// newer RSVP that arrived mid-sync still gets copied on the next run.
export async function markRsvpsSynced(rsvps: StoredRsvp[]): Promise<void> {
  for (const rsvp of rsvps) {
    const ref = RSVPS.doc(rsvp.id);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if ((snap.data() as Rsvp | undefined)?.version === rsvp.version) tx.update(ref, { synced: true });
    });
  }
}

export interface DiscordLink {
  email: string;
  name: string;
}

export async function getDiscordLink(discordUserId: string): Promise<DiscordLink | undefined> {
  const snap = await DISCORD_LINKS.doc(discordUserId).get();
  return snap.data() as DiscordLink | undefined;
}

export async function saveDiscordLink(discordUserId: string, link: DiscordLink): Promise<void> {
  await DISCORD_LINKS.doc(discordUserId).set({ email: normalizeEmail(link.email), name: link.name });
}

export const CONFIRM_EMAIL_INTERVAL_MS = 2 * 60 * 1000;

// Caps confirmation emails to one per address every couple of minutes, so
// the RSVP form can't be used to flood someone's inbox (or burn through the
// club Gmail account's daily sending limit). Returns false when throttled.
export async function claimConfirmEmailSlot(email: string, now = Date.now()): Promise<boolean> {
  const ref = CONFIRM_THROTTLE.doc(encodeURIComponent(normalizeEmail(email)));
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const lastSentAt: number = snap.data()?.lastSentAt ?? 0;
    if (now - lastSentAt < CONFIRM_EMAIL_INTERVAL_MS) return false;
    tx.set(ref, { lastSentAt: now });
    return true;
  });
}
