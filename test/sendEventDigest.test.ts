import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunction } from "@google-cloud/functions-framework/testing";

const { docs, sendMail, list } = vi.hoisted(() => ({ docs: new Map<string, any>(), sendMail: vi.fn(), list: vi.fn() }));

vi.mock("@google-cloud/firestore", () => {
  class Firestore {
    collection(name: string) {
      return {
        doc: (id: string) => ({
          get: async () => ({ data: () => docs.get(`${name}/${id}`) }),
          set: async (data: any, opts?: { merge?: boolean }) =>
            void docs.set(`${name}/${id}`, opts?.merge ? { ...docs.get(`${name}/${id}`), ...data } : data),
        }),
      };
    }
  }
  return { Firestore };
});
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock("../src/googleAuth", () => ({ getCalendarClient: async () => ({ events: { list } }) }));
vi.mock("../src/discordApi", () => ({ postChannelMessage: vi.fn(async () => ({})) }));

import "../src/sendEventDigest";

const handler = getFunction("sendEventDigest") as (req: any, res: any) => Promise<void>;

function fakeResponse() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.send = vi.fn(() => res);
  return res;
}

async function run(query: Record<string, string> = {}): Promise<string> {
  const res = fakeResponse();
  await handler({ query }, res);
  return res.send.mock.calls[0][0];
}

const upcoming = [{ summary: "Droid Day", start: { dateTime: "2026-10-04T01:00:00.000Z" }, end: { dateTime: "2026-10-04T04:00:00.000Z" } }];

describe("sendEventDigest cadence", () => {
  beforeEach(() => {
    docs.clear();
    sendMail.mockReset();
    list.mockReset().mockResolvedValue({ data: { items: upcoming } });
    process.env.GOOGLE_CALENDAR_ID = "cal@example.com";
    process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = "events";
    process.env.GMAIL_SENDER_EMAIL = "bot@example.com";
    process.env.GMAIL_APP_PASSWORD = "pw";
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
  });

  it("sends every other scheduled run, indefinitely", async () => {
    const results = [];
    for (let week = 0; week < 5; week++) results.push(await run());

    expect(results.map((r) => r.startsWith("sent"))).toEqual([true, false, true, false, true]);
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it("recovers from a toggle left at false", async () => {
    docs.set("digestState/state", { dueNext: false });

    expect(await run()).toBe("skipped — not due this week");
    expect(await run()).toMatch(/^sent/);
  });

  it("counts a week with no upcoming events as a cycle", async () => {
    list.mockResolvedValue({ data: { items: [] } });

    expect(await run()).toBe("skipped — no upcoming events");
    expect(docs.get("digestState/state")).toEqual({ dueNext: false });
  });

  it("doesn't change the schedule for a manual test send", async () => {
    docs.set("digestState/state", { dueNext: false });

    expect(await run({ to: "me@example.com" })).toBe("sent digest with 1 event(s) to me@example.com");
    expect(await run({ force: "true" })).toMatch(/^sent/);
    expect(docs.get("digestState/state")).toEqual({ dueNext: false });
  });

  it("leaves the schedule alone when sending fails, so the next run retries", async () => {
    sendMail.mockRejectedValueOnce(new Error("SMTP down"));

    await expect(run()).rejects.toThrow("SMTP down");
    expect(docs.get("digestState/state")).toBeUndefined();
    expect(await run()).toMatch(/^sent/);
  });
});

describe("sendEventDigest content", () => {
  beforeEach(() => {
    docs.clear();
    sendMail.mockReset();
    list.mockReset().mockResolvedValue({ data: { items: [{ id: "cal-1", ...upcoming[0] }] } });
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
  });

  it("gives each event in the email RSVP links, but leaves them out of the Discord post", async () => {
    const { postChannelMessage } = await import("../src/discordApi");
    vi.mocked(postChannelMessage).mockClear();

    await run({ to: "me@example.com" });

    const email = sendMail.mock.calls[0][0];
    expect(email.text).toContain("RSVP: https://rsvp.example.com/badb-rsvp?event=cal-1");
    for (const [label, status] of [["Attending", "attending"], ["Maybe", "maybe"], ["Decline", "declined"]]) {
      expect(email.html).toContain(`href="https://rsvp.example.com/badb-rsvp?event=cal-1&amp;status=${status}"`);
      expect(email.html).toContain(`>${label}</a>`);
    }
    const discordText = (vi.mocked(postChannelMessage).mock.calls[0][1] as any).embeds[0].description;
    expect(discordText).toContain("Droid Day");
    expect(discordText).not.toContain("RSVP");
  });
});
