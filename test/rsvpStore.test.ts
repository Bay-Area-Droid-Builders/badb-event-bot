import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal in-memory stand-in for the parts of Firestore rsvpStore.ts uses.
const { docs } = vi.hoisted(() => ({ docs: new Map<string, any>() }));
vi.mock("@google-cloud/firestore", () => {
  const ref = (path: string) => ({
    path,
    get: async () => ({ data: () => docs.get(path) }),
    set: async (data: any) => void docs.set(path, data),
  });
  class Firestore {
    collection(name: string) {
      return {
        doc: (id: string) => ref(`${name}/${id}`),
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => ({
            docs: [...docs.entries()]
              .filter(([path, data]) => path.startsWith(`${name}/`) && data[field] === value)
              .map(([path, data]) => ({ id: path.slice(name.length + 1), data: () => data })),
          }),
        }),
      };
    }
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn({
        get: (r: any) => r.get(),
        set: (r: any, data: any) => void docs.set(r.path, data),
        update: (r: any, data: any) => void docs.set(r.path, { ...docs.get(r.path), ...data }),
      });
    }
  }
  return { Firestore };
});

import {
  claimConfirmEmailSlot,
  CONFIRM_EMAIL_INTERVAL_MS,
  getRsvp,
  listRsvpsForEvent,
  listUnsyncedEventIds,
  markRsvpsSynced,
  saveRsvp,
} from "../src/rsvpStore";

const base = { calendarEventId: "cal-1", email: " R2@Example.com ", name: "R2", status: "attending" as const, source: "page" as const };

describe("rsvpStore", () => {
  beforeEach(() => docs.clear());

  it("stores one RSVP per person per event, keyed by normalized email", async () => {
    await saveRsvp(base);
    await saveRsvp({ ...base, email: "r2@example.com", status: "maybe" });

    const all = await listRsvpsForEvent("cal-1");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ email: "r2@example.com", status: "maybe", synced: false });
  });

  it("handles an email containing a slash", async () => {
    await saveRsvp({ ...base, email: "odd/one@example.com" });

    await expect(getRsvp("cal-1", "odd/one@example.com")).resolves.toMatchObject({ email: "odd/one@example.com" });
  });

  it("doesn't write a stored RSVP's id or sync state back when re-saving it", async () => {
    await saveRsvp(base);
    const stored = (await getRsvp("cal-1", "r2@example.com"))!;
    await markRsvpsSynced([stored]);

    await saveRsvp({ ...(await getRsvp("cal-1", "r2@example.com"))!, status: "removed" });

    const raw = [...docs.values()][0];
    expect(raw.id).toBeUndefined();
    expect(raw.synced).toBe(false);
    expect(raw.discordUserId).toBeUndefined();
  });

  it("lists each event with pending RSVPs once", async () => {
    await saveRsvp(base);
    await saveRsvp({ ...base, email: "c3po@example.com" });
    await saveRsvp({ ...base, calendarEventId: "cal-2" });

    await expect(listUnsyncedEventIds()).resolves.toEqual(["cal-1", "cal-2"]);
  });

  it("doesn't mark an RSVP synced if it changed while being copied to Calendar", async () => {
    await saveRsvp(base);
    const readForSync = (await getRsvp("cal-1", "r2@example.com"))!;
    await saveRsvp({ ...base, status: "declined" }); // arrives mid-sync

    await markRsvpsSynced([readForSync]);

    await expect(getRsvp("cal-1", "r2@example.com")).resolves.toMatchObject({ status: "declined", synced: false });
  });

  it("allows one confirmation email per address per interval", async () => {
    const now = 1_800_000_000_000;

    await expect(claimConfirmEmailSlot("r2@example.com", now)).resolves.toBe(true);
    await expect(claimConfirmEmailSlot("R2@example.com", now + 1000)).resolves.toBe(false);
    await expect(claimConfirmEmailSlot("c3po@example.com", now + 1000)).resolves.toBe(true);
    await expect(claimConfirmEmailSlot("r2@example.com", now + CONFIRM_EMAIL_INTERVAL_MS)).resolves.toBe(true);
  });
});
