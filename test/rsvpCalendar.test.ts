import { beforeEach, describe, expect, it, vi } from "vitest";

const { get, patch } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("../src/googleAuth", () => ({ getCalendarClient: async () => ({ events: { get, patch } }) }));
vi.mock("../src/rsvpStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/rsvpStore")>()),
  listRsvpsForEvent: vi.fn(),
  listUnsyncedEventIds: vi.fn(),
  markRsvpsSynced: vi.fn(async () => {}),
}));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class { collection() { return {}; } } }));

import { applyRsvpsToAttendees, syncEventRsvps, syncPendingRsvps } from "../src/rsvpCalendar";
import { listRsvpsForEvent, listUnsyncedEventIds, markRsvpsSynced, StoredRsvp } from "../src/rsvpStore";

function rsvp(overrides: Partial<StoredRsvp>): StoredRsvp {
  return {
    id: "doc",
    calendarEventId: "cal-1",
    email: "r2@example.com",
    name: "R2",
    status: "attending",
    source: "page",
    synced: false,
    version: "v1",
    ...overrides,
  };
}

describe("applyRsvpsToAttendees", () => {
  it("adds a new guest and says an invitation is needed", () => {
    const result = applyRsvpsToAttendees([], [rsvp({})]);

    expect(result).toEqual({
      attendees: [{ email: "r2@example.com", displayName: "R2", responseStatus: "accepted" }],
      invitesNewGuest: true,
    });
  });

  it("maps Maybe and Decline to Calendar's responses", () => {
    const { attendees } = applyRsvpsToAttendees(
      [],
      [rsvp({ email: "a@example.com", status: "maybe" }), rsvp({ email: "b@example.com", status: "declined" })],
    );

    expect(attendees.map((a) => a.responseStatus)).toEqual(["tentative", "declined"]);
  });

  it("doesn't send an invitation just to record a decline", () => {
    expect(applyRsvpsToAttendees([], [rsvp({ status: "declined" })]).invitesNewGuest).toBe(false);
  });

  it("updates an existing guest in place, matching email case-insensitively, without inviting", () => {
    const result = applyRsvpsToAttendees(
      [{ email: "R2@Example.com", displayName: "Artoo", responseStatus: "accepted", optional: true }],
      [rsvp({ status: "maybe" })],
    );

    expect(result).toEqual({
      attendees: [{ email: "R2@Example.com", displayName: "Artoo", responseStatus: "tentative", optional: true }],
      invitesNewGuest: false,
    });
  });

  it("removes a guest whose Discord interest was withdrawn and leaves everyone else alone", () => {
    const others = [{ email: "organizer@example.com", organizer: true }, { email: "c3po@example.com", responseStatus: "declined" }];

    const { attendees } = applyRsvpsToAttendees([...others, { email: "r2@example.com" }], [rsvp({ status: "removed" })]);

    expect(attendees).toEqual(others);
  });
});

describe("syncEventRsvps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    get.mockResolvedValue({ data: { id: "cal-1", status: "confirmed", etag: '"etag-1"', attendees: [] } });
    patch.mockResolvedValue({ data: {} });
  });

  it("copies pending RSVPs onto the guest list conditionally on the ETag, then marks them synced", async () => {
    const pending = rsvp({});
    vi.mocked(listRsvpsForEvent).mockResolvedValue([pending, rsvp({ email: "done@example.com", synced: true })]);

    await syncEventRsvps("cal@example.com", "cal-1");

    expect(patch).toHaveBeenCalledWith(
      {
        calendarId: "cal@example.com",
        eventId: "cal-1",
        sendUpdates: "all",
        requestBody: { attendees: [{ email: "r2@example.com", displayName: "R2", responseStatus: "accepted" }] },
      },
      { headers: { "If-Match": '"etag-1"' } },
    );
    expect(markRsvpsSynced).toHaveBeenCalledWith([pending]);
  });

  it("doesn't email anyone for a status change on an existing guest", async () => {
    get.mockResolvedValue({ data: { status: "confirmed", etag: "e", attendees: [{ email: "r2@example.com" }] } });
    vi.mocked(listRsvpsForEvent).mockResolvedValue([rsvp({ status: "declined" })]);

    await syncEventRsvps("cal@example.com", "cal-1");

    expect(patch.mock.calls[0][0].sendUpdates).toBe("none");
  });

  it("re-reads and retries when someone else changed the event first", async () => {
    vi.mocked(listRsvpsForEvent).mockResolvedValue([rsvp({})]);
    patch.mockRejectedValueOnce({ code: 412 });

    await syncEventRsvps("cal@example.com", "cal-1");

    expect(get).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(markRsvpsSynced).toHaveBeenCalledTimes(1);
  });

  it("gives up after repeated conflicts and leaves the RSVPs pending", async () => {
    vi.mocked(listRsvpsForEvent).mockResolvedValue([rsvp({})]);
    patch.mockRejectedValue({ code: 412 });

    await expect(syncEventRsvps("cal@example.com", "cal-1")).rejects.toEqual({ code: 412 });
    expect(markRsvpsSynced).not.toHaveBeenCalled();
  });

  it("stops retrying RSVPs for an event that was deleted or cancelled", async () => {
    vi.mocked(listRsvpsForEvent).mockResolvedValue([rsvp({})]);
    get.mockRejectedValueOnce({ code: 404 });
    await syncEventRsvps("cal@example.com", "cal-1");

    get.mockResolvedValueOnce({ data: { status: "cancelled" } });
    await syncEventRsvps("cal@example.com", "cal-1");

    expect(patch).not.toHaveBeenCalled();
    expect(markRsvpsSynced).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there's nothing pending", async () => {
    vi.mocked(listRsvpsForEvent).mockResolvedValue([rsvp({ synced: true })]);

    await syncEventRsvps("cal@example.com", "cal-1");

    expect(get).not.toHaveBeenCalled();
  });
});

describe("syncPendingRsvps", () => {
  it("keeps going past an event that fails", async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listUnsyncedEventIds).mockResolvedValue(["bad", "good"]);
    vi.mocked(listRsvpsForEvent).mockImplementation(async (id) => [rsvp({ calendarEventId: id })]);
    get.mockImplementation(async ({ eventId }) => {
      if (eventId === "bad") throw new Error("Calendar is down");
      return { data: { status: "confirmed", etag: "e", attendees: [] } };
    });
    patch.mockResolvedValue({ data: {} });

    await expect(syncPendingRsvps("cal@example.com")).resolves.toBe(1);
  });
});
