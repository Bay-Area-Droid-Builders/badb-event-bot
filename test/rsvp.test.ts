import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunction } from "@google-cloud/functions-framework/testing";

vi.mock("../src/googleCalendar", () => ({ getCalendarEvent: vi.fn() }));
vi.mock("../src/mailer", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("../src/rsvpCalendar", () => ({ syncEventRsvps: vi.fn(async () => {}) }));
vi.mock("../src/rsvpStore", async (importOriginal) => ({
  normalizeEmail: (await importOriginal<typeof import("../src/rsvpStore")>()).normalizeEmail,
  claimConfirmEmailSlot: vi.fn(async () => true),
  getDiscordLink: vi.fn(async () => undefined),
  saveDiscordLink: vi.fn(async () => {}),
  saveRsvp: vi.fn(async () => {}),
}));

import "../src/rsvp";
import { getCalendarEvent } from "../src/googleCalendar";
import { sendEmail } from "../src/mailer";
import { syncEventRsvps } from "../src/rsvpCalendar";
import { claimConfirmEmailSlot, getDiscordLink, saveDiscordLink, saveRsvp } from "../src/rsvpStore";
import { signToken, verifyToken } from "../src/signedToken";

const handler = getFunction("rsvp") as (req: any, res: any) => Promise<void>;

const event = {
  id: "cal-1",
  status: "confirmed",
  summary: "Droid Day",
  start: { dateTime: "2099-10-04T01:00:00.000Z" },
  end: { dateTime: "2099-10-04T04:00:00.000Z" },
  attendees: [{ email: "r2@example.com", responseStatus: "tentative" }],
};

const HOUR = 60 * 60 * 1000;
const r2 = { name: "R2", email: "r2@example.com" };

function cookieFor(identity: object): string {
  return `other=1; badb_rsvp=${signToken(identity, HOUR)}`;
}

function discordToken(discordUserId = "user-r2"): string {
  return signToken({ discordUserId, discordName: "R2-D2" }, HOUR);
}

async function call(
  method: "GET" | "POST",
  params: Record<string, string>,
  cookie?: string,
): Promise<{ status: number; html: string; setCookie?: string }> {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  const req = method === "GET" ? { method, query: params, body: {} } : { method, query: {}, body: params };
  let status = 0;
  let html = "";
  let setCookie: string | undefined;
  const res: any = {
    status: vi.fn((s: number) => ((status = s), res)),
    set: vi.fn((name: string, value: string) => {
      if (name === "Set-Cookie") setCookie = value;
      return res;
    }),
    send: vi.fn((body: string) => ((html = body), res)),
  };
  await handler({ ...req, header: (name: string) => headers[name.toLowerCase()] }, res);
  return { status, html, setCookie };
}

describe("rsvp page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.GOOGLE_CALENDAR_ID = "cal@example.com";
    process.env.RSVP_SIGNING_SECRET = "test-secret";
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
    vi.mocked(getCalendarEvent).mockResolvedValue(event);
    vi.mocked(getDiscordLink).mockResolvedValue(undefined);
    vi.mocked(claimConfirmEmailSlot).mockResolvedValue(true);
  });

  it("serves the club logo", async () => {
    const headers: Record<string, string> = {};
    let body: Buffer | undefined;
    const res: any = {
      status: vi.fn(() => res),
      set: vi.fn((name: string, value: string) => ((headers[name] = value), res)),
      send: vi.fn((b: Buffer) => ((body = b), res)),
    };

    await handler({ method: "GET", path: "/logo.png", query: {}, header: () => undefined }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(headers["Content-Type"]).toBe("image/png");
    expect(body!.subarray(1, 4).toString()).toBe("PNG");
    expect(getCalendarEvent).not.toHaveBeenCalled();
  });

  describe("showing the form", () => {
    it("shows the club logo, served by this function", async () => {
      const { html } = await call("GET", { event: "cal-1" });

      expect(html).toContain('<img class="logo" src="https://rsvp.example.com/badb-rsvp/logo.png" alt="Bay Area Droid Builders"');
    });

    it("asks a new visitor for their name and email, with their choice and Discord name filled in", async () => {
      const { status, html } = await call("GET", { event: "cal-1", status: "maybe", d: discordToken() });

      expect(status).toBe(200);
      expect(html).toContain('name="email"');
      expect(html).toContain('value="R2-D2"');
      expect(html).toContain('class="maybe selected"');
      expect(html).toContain('name="mode" value="new"');
    });

    it("recognizes a returning visitor from their cookie and shows their current answer from Calendar", async () => {
      const { html } = await call("GET", { event: "cal-1" }, cookieFor(r2));

      expect(html).toContain("RSVPing as <strong>R2</strong> (r2@example.com)");
      expect(html).toContain("currently marked <strong>Maybe</strong>");
      expect(html).not.toContain('name="email"');
    });

    it("recognizes a linked Discord member from the button's token", async () => {
      vi.mocked(getDiscordLink).mockResolvedValue(r2);

      const { html } = await call("GET", { event: "cal-1", d: discordToken() });

      expect(getDiscordLink).toHaveBeenCalledWith("user-r2");
      expect(html).toContain("RSVPing as <strong>R2</strong>");
    });

    it("ignores a forged cookie", async () => {
      const { html } = await call("GET", { event: "cal-1" }, "badb_rsvp=eyJlbWFpbCI6InIyQGV4YW1wbGUuY29tIn0.forged");

      expect(html).toContain('name="email"');
    });

    it("forgets the visitor when they say it's not them", async () => {
      const { html, setCookie } = await call("GET", { event: "cal-1", different: "1" }, cookieFor(r2));

      expect(html).toContain('name="email"');
      expect(setCookie).toMatch(/^badb_rsvp=; Max-Age=0/);
    });

    it("explains when the event doesn't exist, was cancelled, or is over", async () => {
      vi.mocked(getCalendarEvent).mockResolvedValueOnce(undefined);
      expect((await call("GET", { event: "nope" })).status).toBe(404);

      vi.mocked(getCalendarEvent).mockResolvedValueOnce({ ...event, status: "cancelled" });
      expect((await call("GET", { event: "cal-1" })).html).toContain("This event was cancelled");

      vi.mocked(getCalendarEvent).mockResolvedValueOnce({ ...event, end: { dateTime: "2020-01-01T00:00:00Z" } });
      expect((await call("GET", { event: "cal-1" })).html).toContain("This event is over");
    });

    it("shows an error page if Calendar can't be reached", async () => {
      vi.mocked(getCalendarEvent).mockRejectedValueOnce(new Error("Calendar is down"));

      const { status, html } = await call("GET", { event: "cal-1" });

      expect(status).toBe(500);
      expect(html).toContain("Something went wrong");
    });
  });

  describe("a new visitor RSVPing", () => {
    it("emails a confirmation link instead of RSVPing straight away", async () => {
      const { html } = await call("POST", { event: "cal-1", status: "attending", mode: "new", name: "R2", email: " R2@Example.com", d: discordToken() });

      expect(saveRsvp).not.toHaveBeenCalled();
      expect(html).toContain("Check your email");
      const email = vi.mocked(sendEmail).mock.calls[0][0];
      expect(email.to).toBe("r2@example.com");
      const confirmUrl = new URL(email.text.match(/https:\/\/\S+confirm=\S+/)![0]);
      expect(verifyToken(confirmUrl.searchParams.get("confirm")!)).toMatchObject({
        calendarEventId: "cal-1",
        status: "attending",
        name: "R2",
        email: "r2@example.com",
        discordUserId: "user-r2",
      });
    });

    it("doesn't send another confirmation email while throttled, and says the same thing", async () => {
      vi.mocked(claimConfirmEmailSlot).mockResolvedValue(false);

      const { html } = await call("POST", { event: "cal-1", status: "attending", mode: "new", name: "R2", email: "r2@example.com" });

      expect(sendEmail).not.toHaveBeenCalled();
      expect(html).toContain("Check your email");
    });

    it("rejects a missing name or invalid email", async () => {
      expect((await call("POST", { event: "cal-1", status: "attending", mode: "new", name: "", email: "r2@example.com" })).status).toBe(400);
      expect((await call("POST", { event: "cal-1", status: "attending", mode: "new", name: "R2", email: "not-an-email" })).status).toBe(400);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("rejects an unknown response", async () => {
      const { status } = await call("POST", { event: "cal-1", status: "removed", mode: "new", name: "R2", email: "r2@example.com" });

      expect(status).toBe(400);
    });

    it("skips confirmation when this browser already confirmed that address", async () => {
      await call("POST", { event: "cal-1", status: "attending", mode: "new", name: "R2", email: "r2@example.com" }, cookieFor(r2));

      expect(sendEmail).not.toHaveBeenCalled();
      expect(saveRsvp).toHaveBeenCalledWith(expect.objectContaining({ email: "r2@example.com", status: "attending", source: "page" }));
    });
  });

  describe("confirming", () => {
    const claim = { ...r2, calendarEventId: "cal-1", status: "attending", discordUserId: "user-r2" };

    it("asks for a click rather than confirming on page load, since mail scanners open links", async () => {
      const { html } = await call("GET", { confirm: signToken(claim, HOUR) });

      expect(saveRsvp).not.toHaveBeenCalled();
      expect(html).toContain('<form method="post">');
      expect(html).toContain("as <strong>Attending</strong>");
    });

    it("records the RSVP, links the Discord account, copies it to Calendar, and remembers the browser", async () => {
      const { html, setCookie } = await call("POST", { confirm: signToken(claim, HOUR) });

      expect(saveRsvp).toHaveBeenCalledWith({
        calendarEventId: "cal-1",
        email: "r2@example.com",
        name: "R2",
        status: "attending",
        source: "page",
        discordUserId: "user-r2",
      });
      expect(saveDiscordLink).toHaveBeenCalledWith("user-r2", r2);
      expect(syncEventRsvps).toHaveBeenCalledWith("cal@example.com", "cal-1");
      expect(html).toContain("You're marked Attending");
      const token = setCookie!.match(/^badb_rsvp=([^;]+);/)![1];
      expect(verifyToken(token)).toMatchObject(r2);
      expect(setCookie).toContain("HttpOnly; Secure; SameSite=Lax");
    });

    it("still succeeds when Calendar is down, since the poller retries", async () => {
      vi.mocked(syncEventRsvps).mockRejectedValueOnce(new Error("Calendar is down"));

      const { status, html } = await call("POST", { confirm: signToken(claim, HOUR) });

      expect(status).toBe(200);
      expect(html).toContain("You're marked Attending");
      expect(saveRsvp).toHaveBeenCalled();
    });

    it("rejects an expired or edited link", async () => {
      const expired = signToken(claim, -1);
      expect((await call("POST", { confirm: expired })).html).toContain("This link has expired");
      expect((await call("POST", { confirm: "garbage" })).status).toBe(400);
      expect(saveRsvp).not.toHaveBeenCalled();
    });
  });

  describe("a recognized visitor RSVPing", () => {
    it("records it in one click", async () => {
      const { html } = await call("POST", { event: "cal-1", status: "declined", mode: "known" }, cookieFor(r2));

      expect(saveRsvp).toHaveBeenCalledWith(expect.objectContaining({ email: "r2@example.com", status: "declined" }));
      expect(html).toContain("You're marked Not attending");
    });

    it("links their Discord account when they arrive from a Discord button with a known cookie", async () => {
      await call("POST", { event: "cal-1", status: "attending", mode: "known", d: discordToken() }, cookieFor(r2));

      expect(saveDiscordLink).toHaveBeenCalledWith("user-r2", r2);
    });

    it("asks them to start again if their identity can't be established anymore", async () => {
      const { status } = await call("POST", { event: "cal-1", status: "attending", mode: "known" });

      expect(status).toBe(400);
      expect(saveRsvp).not.toHaveBeenCalled();
    });
  });
});
