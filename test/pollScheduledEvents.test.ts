import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunction } from "@google-cloud/functions-framework/testing";

const steps: string[] = [];

vi.mock("../src/eventSync", () => ({
  acquirePollLock: vi.fn(async () => "lock-token"),
  releasePollLock: vi.fn(async () => void steps.push("releasePollLock")),
  getSyncToken: vi.fn(async () => "sync-token"),
  saveSyncToken: vi.fn(async () => {}),
  getEventMapping: vi.fn(async () => undefined),
  saveEventMapping: vi.fn(async () => {}),
  listEventMappingsPendingEmail: vi.fn(async () => []),
  setEmailPending: vi.fn(async () => {}),
}));
vi.mock("../src/googleCalendar", () => ({ listCalendarChanges: vi.fn() }));
vi.mock("../src/mailer", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("../src/discordInterest", () => ({ syncDiscordInterest: vi.fn(async () => 0) }));
vi.mock("../src/rsvpCalendar", () => ({ syncPendingRsvps: vi.fn(async () => 0) }));
vi.mock("../src/discordApi", () => ({
  createGuildScheduledEvent: vi.fn(async () => ({ id: "discord-event" })),
  deleteGuildScheduledEvent: vi.fn(async () => {}),
  editMessage: vi.fn(async () => ({})),
  updateGuildScheduledEvent: vi.fn(async () => ({})),
  postChannelMessage: vi.fn(async () => ({})),
}));

import "../src/pollScheduledEvents";
import { createGuildScheduledEvent, deleteGuildScheduledEvent, editMessage, postChannelMessage, updateGuildScheduledEvent } from "../src/discordApi";
import { syncDiscordInterest } from "../src/discordInterest";
import { acquirePollLock, getEventMapping, listEventMappingsPendingEmail, releasePollLock, saveEventMapping, setEmailPending } from "../src/eventSync";
import { listCalendarChanges } from "../src/googleCalendar";
import { sendEmail } from "../src/mailer";
import { syncPendingRsvps } from "../src/rsvpCalendar";

const handler = getFunction("pollScheduledEvents") as (req: any, res: any) => Promise<void>;

function fakeResponse() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.send = vi.fn(() => {
    steps.push("respond");
    return res;
  });
  return res;
}

const allDayEvent = {
  id: "cal-1",
  status: "confirmed",
  summary: "Droid Day",
  start: { date: "2026-10-25" },
  end: { date: "2026-10-26" }, // Calendar's exclusive end: a one-day event
};

describe("pollScheduledEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    process.env.DISCORD_GUILD_ID = "guild";
    process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = "events";
    process.env.DISCORD_BUILDERS_CHANNEL_ID = "builders";
    process.env.GOOGLE_CALENDAR_ID = "cal@example.com";
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [allDayEvent], nextSyncToken: "next" });
  });

  it("skips entirely while another run holds the lock", async () => {
    vi.mocked(acquirePollLock).mockResolvedValueOnce(undefined);
    const res = fakeResponse();

    await handler({}, res);

    expect(listCalendarChanges).not.toHaveBeenCalled();
    expect(createGuildScheduledEvent).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith("skipped — another poll run is in progress");
  });

  it("mirrors a new event, then releases the lock before responding", async () => {
    const res = fakeResponse();

    await handler({}, res);

    expect(createGuildScheduledEvent).toHaveBeenCalledTimes(1);
    expect(releasePollLock).toHaveBeenCalledWith("lock-token");
    expect(steps).toEqual(["releasePollLock", "respond"]);
    expect(res.send).toHaveBeenCalledWith(
      "checked 1, created 1, updated 0, cancelled 0; emailed 0; interest changes 0; rsvp events synced 0",
    );
  });

  it("strips HTML from the description before it reaches Discord", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({
      events: [{ ...allDayEvent, description: "Bring <b>droids</b><br>and snacks" }],
      nextSyncToken: "next",
    });

    await handler({}, fakeResponse());

    expect((vi.mocked(createGuildScheduledEvent).mock.calls[0][1] as any).description).toBe("Bring droids\nand snacks");
    expect((vi.mocked(postChannelMessage).mock.calls[0][1] as any).embeds[0].description).toBe("Bring droids\nand snacks");
  });

  it("announces a one-day all-day event as that single day", async () => {
    await handler({}, fakeResponse());

    const embed = vi.mocked(postChannelMessage).mock.calls[0][1] as any;
    expect(embed.embeds[0].fields[0]).toEqual({ name: "When", value: "Oct 25, 2026", inline: true });
  });

  it("releases the lock even when the sync fails", async () => {
    vi.mocked(listCalendarChanges).mockRejectedValueOnce(new Error("Calendar is down"));

    await expect(handler({}, fakeResponse())).rejects.toThrow("Calendar is down");
    expect(releasePollLock).toHaveBeenCalledWith("lock-token");
  });

  it("puts RSVP buttons on the announcement and queues the announcement email", async () => {
    await handler({}, fakeResponse());

    const message = vi.mocked(postChannelMessage).mock.calls[0][1] as any;
    expect(message.components[0].components.map((b: any) => [b.label, b.custom_id])).toEqual([
      ["Attending", "rsvp:attending:cal-1"],
      ["Maybe", "rsvp:maybe:cal-1"],
      ["Decline", "rsvp:declined:cal-1"],
    ]);
    expect(saveEventMapping).toHaveBeenCalledWith("cal-1", expect.objectContaining({ emailPending: true }));
  });

  it("emails a pending new event to the mailing list, with RSVP links, then clears the flag", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [], nextSyncToken: "next" });
    vi.mocked(listEventMappingsPendingEmail).mockResolvedValue([
      { ...pendingMapping, startIso: "2099-10-25T01:00:00.000Z", endIso: "2099-10-25T04:00:00.000Z" },
    ]);

    await handler({}, fakeResponse());

    const email = vi.mocked(sendEmail).mock.calls[0][0];
    expect(email.to).toBe("R2SF@googlegroups.com");
    expect(email.subject).toBe("New event: Droid Day");
    expect(email.text).toContain("RSVP: https://rsvp.example.com/badb-rsvp?event=cal-1");
    expect(email.html).toContain("status=attending");
    expect(setEmailPending).toHaveBeenCalledWith("cal-1", false);
  });

  it("drops the announcement email for an event that has already started", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [], nextSyncToken: "next" });
    vi.mocked(listEventMappingsPendingEmail).mockResolvedValue([{ ...pendingMapping, startIso: "2020-01-01T00:00:00.000Z" }]);

    await handler({}, fakeResponse());

    expect(sendEmail).not.toHaveBeenCalled();
    expect(setEmailPending).toHaveBeenCalledWith("cal-1", false);
  });

  it("keeps the announcement email pending when sending fails, so the next poll retries", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [], nextSyncToken: "next" });
    vi.mocked(listEventMappingsPendingEmail).mockResolvedValue([{ ...pendingMapping, startIso: "2099-10-25" }]);
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("SMTP down"));

    await handler({}, fakeResponse());

    expect(setEmailPending).not.toHaveBeenCalled();
  });

  it("still syncs RSVPs when an earlier step fails", async () => {
    vi.mocked(syncDiscordInterest).mockRejectedValueOnce(new Error("Discord is down"));
    const res = fakeResponse();

    await handler({}, res);

    expect(syncPendingRsvps).toHaveBeenCalledWith("cal@example.com");
    expect(res.send.mock.calls[0][0]).toContain("interest changes failed");
  });
});

const pendingMapping = {
  calendarEventId: "cal-1",
  discordEventId: "discord-event",
  status: "active" as const,
  summary: "Droid Day",
  description: "",
  startIso: "2099-10-25",
  endIso: "2099-10-26",
  location: "The Park",
  emailPending: true,
};

describe("pollScheduledEvents builders-only events", () => {
  const privateEvent = { ...allDayEvent, visibility: "private", description: "Bring droids" };
  const channelsPostedTo = () => vi.mocked(postChannelMessage).mock.calls.map((call) => call[0]);
  const embedTitle = (call = 0) => (vi.mocked(postChannelMessage).mock.calls[call][1] as any).embeds[0].title;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISCORD_GUILD_ID = "guild";
    process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = "events";
    process.env.DISCORD_BUILDERS_CHANNEL_ID = "builders";
    process.env.GOOGLE_CALENDAR_ID = "cal@example.com";
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getEventMapping).mockResolvedValue(undefined);
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [privateEvent], nextSyncToken: "next" });
  });

  it("announces a private event only in the builders channel, labelled, with no Scheduled Event", async () => {
    await handler({}, fakeResponse());

    expect(createGuildScheduledEvent).not.toHaveBeenCalled();
    expect(channelsPostedTo()).toEqual(["builders"]);
    const message = vi.mocked(postChannelMessage).mock.calls[0][1] as any;
    expect(message.embeds[0].title).toBe("📅 New event: Droid Day (BUILDERS ONLY)");
    expect(message.embeds[0].description).toMatch(/^This is a Bay Area Droid Builders Members only event announcement\. Do Not Share!\n\nBring droids$/);
    expect(message.components).toHaveLength(1);
    const saved = vi.mocked(saveEventMapping).mock.calls[0][1];
    expect(saved).toMatchObject({ buildersOnly: true, summary: "Droid Day (BUILDERS ONLY)", emailPending: true });
    expect(saved.discordEventId).toBeUndefined();
  });

  it("posts a private event nowhere in Discord when no builders channel is set", async () => {
    delete process.env.DISCORD_BUILDERS_CHANNEL_ID;

    await handler({}, fakeResponse());

    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(createGuildScheduledEvent).not.toHaveBeenCalled();
    expect(saveEventMapping).toHaveBeenCalledWith("cal-1", expect.objectContaining({ emailPending: true }));
  });

  it("deletes the Scheduled Event of an event made private after it was mirrored, and announces it to builders", async () => {
    vi.mocked(getEventMapping).mockResolvedValue({ ...pendingMapping, description: "Bring droids", emailPending: false });

    await handler({}, fakeResponse());

    expect(deleteGuildScheduledEvent).toHaveBeenCalledWith("guild", "discord-event");
    expect(updateGuildScheduledEvent).not.toHaveBeenCalled();
    expect(channelsPostedTo()).toEqual(["builders"]);
    expect(embedTitle()).toBe("📅 New event: Droid Day (BUILDERS ONLY)");
    const saved = vi.mocked(saveEventMapping).mock.calls[0][1];
    expect(saved.buildersOnly).toBe(true);
    expect(saved.discordEventId).toBeUndefined();
  });

  it("creates a Scheduled Event and announces in #events when a builders-only event goes public", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [{ ...privateEvent, visibility: "default" }], nextSyncToken: "next" });
    vi.mocked(getEventMapping).mockResolvedValue({
      ...pendingMapping,
      discordEventId: undefined,
      buildersOnly: true,
      summary: "Droid Day (BUILDERS ONLY)",
    });

    await handler({}, fakeResponse());

    expect(createGuildScheduledEvent).toHaveBeenCalledTimes(1);
    expect(channelsPostedTo()).toEqual(["events"]);
    expect(embedTitle()).toBe("📅 New event: Droid Day");
    expect(saveEventMapping).toHaveBeenCalledWith("cal-1", expect.objectContaining({ buildersOnly: false, discordEventId: "discord-event" }));
  });

  it("posts updates to a builders-only event in the builders channel", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [{ ...privateEvent, location: "The Shop" }], nextSyncToken: "next" });
    vi.mocked(getEventMapping).mockResolvedValue({
      ...pendingMapping,
      discordEventId: undefined,
      buildersOnly: true,
      summary: "Droid Day (BUILDERS ONLY)",
      description: "This is a Bay Area Droid Builders Members only event announcement. Do Not Share!\n\nBring droids",
    });

    await handler({}, fakeResponse());

    expect(updateGuildScheduledEvent).not.toHaveBeenCalled();
    expect(createGuildScheduledEvent).not.toHaveBeenCalled();
    expect(channelsPostedTo()).toEqual(["builders"]);
    expect(embedTitle()).toBe("🔄 EVENT UPDATE: Droid Day (BUILDERS ONLY)");
  });

  it("posts a builders-only cancellation in the builders channel only", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [{ id: "cal-1", status: "cancelled" }], nextSyncToken: "next" });
    vi.mocked(getEventMapping).mockResolvedValue({
      ...pendingMapping,
      discordEventId: undefined,
      buildersOnly: true,
      summary: "Droid Day (BUILDERS ONLY)",
    });

    await handler({}, fakeResponse());

    expect(updateGuildScheduledEvent).not.toHaveBeenCalled();
    expect(channelsPostedTo()).toEqual(["builders"]);
    expect(embedTitle()).toBe("🚫 EVENT CANCELLED: Droid Day (BUILDERS ONLY)");
  });

  it("doesn't treat an event mirrored before builders-only existed as changed", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [{ ...allDayEvent, location: "The Park" }], nextSyncToken: "next" });
    vi.mocked(getEventMapping).mockResolvedValue({ ...pendingMapping, startIso: "2026-10-25", endIso: "2026-10-26", emailPending: false });

    await handler({}, fakeResponse());

    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(saveEventMapping).not.toHaveBeenCalled();
  });
});

describe("pollScheduledEvents RSVP buttons on cancelled events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DISCORD_GUILD_ID = "guild";
    process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = "events";
    process.env.DISCORD_BUILDERS_CHANNEL_ID = "builders";
    process.env.GOOGLE_CALENDAR_ID = "cal@example.com";
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getEventMapping).mockResolvedValue(undefined);
  });

  it("saves where a new event was announced", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [allDayEvent], nextSyncToken: "next" });
    vi.mocked(postChannelMessage).mockResolvedValueOnce({ id: "message-1" });

    await handler({}, fakeResponse());

    expect(saveEventMapping).toHaveBeenCalledWith(
      "cal-1",
      expect.objectContaining({ announcementChannelId: "events", announcementMessageId: "message-1" }),
    );
  });

  it("saves the new announcement when an event moves to the builders channel", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [{ ...allDayEvent, visibility: "private" }], nextSyncToken: "next" });
    vi.mocked(getEventMapping).mockResolvedValue({ ...pendingMapping, announcementChannelId: "events", announcementMessageId: "old" });
    vi.mocked(postChannelMessage).mockResolvedValueOnce({ id: "message-2" });

    await handler({}, fakeResponse());

    expect(saveEventMapping).toHaveBeenCalledWith(
      "cal-1",
      expect.objectContaining({ announcementChannelId: "builders", announcementMessageId: "message-2" }),
    );
  });

  it("takes the RSVP buttons off the announcement when the event is cancelled", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [{ id: "cal-1", status: "cancelled" }], nextSyncToken: "next" });
    vi.mocked(getEventMapping).mockResolvedValue({ ...pendingMapping, announcementChannelId: "events", announcementMessageId: "message-1" });

    await handler({}, fakeResponse());

    expect(editMessage).toHaveBeenCalledWith("events", "message-1", { components: [] });
    expect(saveEventMapping).toHaveBeenCalledWith("cal-1", expect.objectContaining({ status: "cancelled" }));
  });

  it("still cancels the event when the announcement can't be edited", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [{ id: "cal-1", status: "cancelled" }], nextSyncToken: "next" });
    vi.mocked(getEventMapping).mockResolvedValue({ ...pendingMapping, announcementChannelId: "events", announcementMessageId: "gone" });
    vi.mocked(editMessage).mockRejectedValueOnce(new Error("Unknown Message"));

    await handler({}, fakeResponse());

    expect(saveEventMapping).toHaveBeenCalledWith("cal-1", expect.objectContaining({ status: "cancelled" }));
  });

  it("cancels an event announced before announcements were saved without editing anything", async () => {
    vi.mocked(listCalendarChanges).mockResolvedValue({ events: [{ id: "cal-1", status: "cancelled" }], nextSyncToken: "next" });
    vi.mocked(getEventMapping).mockResolvedValue(pendingMapping);

    await handler({}, fakeResponse());

    expect(editMessage).not.toHaveBeenCalled();
    expect(saveEventMapping).toHaveBeenCalledWith("cal-1", expect.objectContaining({ status: "cancelled" }));
  });
});
