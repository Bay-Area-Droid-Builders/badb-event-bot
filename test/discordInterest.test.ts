import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/discordApi", () => ({ listScheduledEventUserIds: vi.fn() }));
vi.mock("../src/eventSync", () => ({ listActiveEventMappings: vi.fn() }));
vi.mock("../src/rsvpStore", () => ({
  getDiscordLink: vi.fn(async () => undefined),
  getRsvp: vi.fn(async () => undefined),
  listRsvpsForEvent: vi.fn(async () => []),
  saveRsvp: vi.fn(async () => {}),
}));

import { listScheduledEventUserIds } from "../src/discordApi";
import { syncDiscordInterest } from "../src/discordInterest";
import { listActiveEventMappings } from "../src/eventSync";
import { getDiscordLink, getRsvp, listRsvpsForEvent, saveRsvp, StoredRsvp } from "../src/rsvpStore";

const NOW = Date.parse("2026-10-13T00:00:00Z");

const upcoming = {
  calendarEventId: "cal-1",
  discordEventId: "discord-1",
  status: "active" as const,
  summary: "Droid Day",
  description: "",
  startIso: "2026-10-25T01:00:00.000Z",
  endIso: "2026-10-25T04:00:00.000Z",
  location: "",
};

function rsvp(overrides: Partial<StoredRsvp>): StoredRsvp {
  return {
    id: "doc",
    calendarEventId: "cal-1",
    email: "r2@example.com",
    name: "R2",
    status: "attending",
    source: "discord-interested",
    discordUserId: "user-r2",
    synced: true,
    version: "v1",
    ...overrides,
  };
}

describe("syncDiscordInterest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listActiveEventMappings).mockResolvedValue([upcoming]);
    vi.mocked(listScheduledEventUserIds).mockResolvedValue([]);
    vi.mocked(getDiscordLink).mockResolvedValue(undefined);
    vi.mocked(getRsvp).mockResolvedValue(undefined);
    vi.mocked(listRsvpsForEvent).mockResolvedValue([]);
  });

  it("marks a linked member who clicked Interested as Attending", async () => {
    vi.mocked(listScheduledEventUserIds).mockResolvedValue(["user-r2"]);
    vi.mocked(getDiscordLink).mockResolvedValue({ email: "r2@example.com", name: "R2" });

    await expect(syncDiscordInterest("guild", NOW)).resolves.toBe(1);
    expect(saveRsvp).toHaveBeenCalledWith({
      calendarEventId: "cal-1",
      email: "r2@example.com",
      name: "R2",
      status: "attending",
      source: "discord-interested",
      discordUserId: "user-r2",
    });
  });

  it("skips builders-only events, which have no Scheduled Event", async () => {
    vi.mocked(listActiveEventMappings).mockResolvedValue([{ ...upcoming, discordEventId: undefined, buildersOnly: true }]);

    await expect(syncDiscordInterest("guild", NOW)).resolves.toBe(0);
    expect(listScheduledEventUserIds).not.toHaveBeenCalled();
  });

  it("skips Interested users who haven't linked an email", async () => {
    vi.mocked(listScheduledEventUserIds).mockResolvedValue(["stranger"]);

    await syncDiscordInterest("guild", NOW);

    expect(saveRsvp).not.toHaveBeenCalled();
  });

  it("never overrides an RSVP made on the page", async () => {
    vi.mocked(listScheduledEventUserIds).mockResolvedValue(["user-r2", "user-c3po"]);
    // R2 RSVPed from a Discord button, so the record carries their Discord ID.
    vi.mocked(listRsvpsForEvent).mockResolvedValue([rsvp({ source: "page", status: "declined" })]);
    // C-3PO RSVPed from an email link, so only the email matches.
    vi.mocked(getDiscordLink).mockResolvedValue({ email: "c3po@example.com", name: "C-3PO" });
    vi.mocked(getRsvp).mockResolvedValue(rsvp({ email: "c3po@example.com", source: "page", discordUserId: undefined }));

    await syncDiscordInterest("guild", NOW);

    expect(getDiscordLink).toHaveBeenCalledTimes(1); // R2 needed no lookup
    expect(saveRsvp).not.toHaveBeenCalled();
  });

  it("takes someone back off the guest list when they un-click Interested, and back on if they click again", async () => {
    vi.mocked(listRsvpsForEvent).mockResolvedValue([rsvp({})]);
    await syncDiscordInterest("guild", NOW);
    expect(saveRsvp).toHaveBeenLastCalledWith(expect.objectContaining({ status: "removed" }));

    vi.mocked(listScheduledEventUserIds).mockResolvedValue(["user-r2"]);
    vi.mocked(listRsvpsForEvent).mockResolvedValue([rsvp({ status: "removed" })]);
    await syncDiscordInterest("guild", NOW);
    expect(saveRsvp).toHaveBeenLastCalledWith(expect.objectContaining({ status: "attending" }));
  });

  it("ignores events that are already over", async () => {
    vi.mocked(listActiveEventMappings).mockResolvedValue([{ ...upcoming, endIso: "2026-10-01T00:00:00.000Z" }]);

    await syncDiscordInterest("guild", NOW);

    expect(listScheduledEventUserIds).not.toHaveBeenCalled();
  });

  it("keeps going past an event whose Discord lookup fails", async () => {
    vi.mocked(listActiveEventMappings).mockResolvedValue([upcoming, { ...upcoming, calendarEventId: "cal-2", discordEventId: "discord-2" }]);
    vi.mocked(listScheduledEventUserIds).mockRejectedValueOnce(new Error("Discord is down")).mockResolvedValueOnce(["user-r2"]);
    vi.mocked(getDiscordLink).mockResolvedValue({ email: "r2@example.com", name: "R2" });

    await expect(syncDiscordInterest("guild", NOW)).resolves.toBe(1);
  });
});
