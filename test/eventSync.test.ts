import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal in-memory stand-in for the parts of Firestore eventSync.ts uses.
const { docs } = vi.hoisted(() => ({ docs: new Map<string, any>() }));
vi.mock("@google-cloud/firestore", () => {
  const ref = (path: string) => ({
    path,
    get: async () => ({ data: () => docs.get(path) }),
    set: async (data: any) => void docs.set(path, data),
  });
  class Firestore {
    collection(name: string) {
      return { doc: (id: string) => ref(`${name}/${id}`) };
    }
    async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn({
        get: (r: any) => r.get(),
        set: (r: any, data: any) => void docs.set(r.path, data),
        delete: (r: any) => void docs.delete(r.path),
      });
    }
  }
  return { Firestore };
});

import { acquirePollLock, POLL_LOCK_LEASE_MS, releasePollLock, saveEventMapping } from "../src/eventSync";

const NOW = 1_800_000_000_000;

describe("poll lock", () => {
  beforeEach(() => docs.clear());

  it("lets one run in and turns away an overlapping one", async () => {
    const first = await acquirePollLock(NOW);
    const second = await acquirePollLock(NOW + 1000);

    expect(first).toBeTruthy();
    expect(second).toBeUndefined();
  });

  it("lets the next run in once the lock is released", async () => {
    const first = await acquirePollLock(NOW);
    await releasePollLock(first!);

    await expect(acquirePollLock(NOW + 1000)).resolves.toBeTruthy();
  });

  it("expires on its own so a crashed run can't block syncing", async () => {
    await acquirePollLock(NOW); // never released

    await expect(acquirePollLock(NOW + POLL_LOCK_LEASE_MS - 1)).resolves.toBeUndefined();
    await expect(acquirePollLock(NOW + POLL_LOCK_LEASE_MS + 1)).resolves.toBeTruthy();
  });

  it("doesn't release a lock another run took after this one's lease expired", async () => {
    const stale = await acquirePollLock(NOW);
    const current = await acquirePollLock(NOW + POLL_LOCK_LEASE_MS + 1);

    await releasePollLock(stale!);

    expect(current).toBeTruthy();
    await expect(acquirePollLock(NOW + POLL_LOCK_LEASE_MS + 2)).resolves.toBeUndefined();
  });
});

describe("saveEventMapping", () => {
  beforeEach(() => docs.clear());

  it("drops undefined fields, which Firestore rejects", async () => {
    await saveEventMapping("cal-1", {
      discordEventId: undefined,
      status: "active",
      summary: "Build Night (BUILDERS ONLY)",
      description: "",
      startIso: "2099-10-25",
      endIso: "2099-10-26",
      location: "",
      buildersOnly: true,
    });

    expect(docs.get("calendarEvents/cal-1")).not.toHaveProperty("discordEventId");
    expect(docs.get("calendarEvents/cal-1")).toMatchObject({ buildersOnly: true });
  });
});
