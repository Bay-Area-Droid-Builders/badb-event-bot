import { beforeEach, describe, expect, it } from "vitest";
import { parseRsvpCustomId, rsvpButtonRow, rsvpLinkReply } from "../src/rsvpButtons";
import { verifyToken } from "../src/signedToken";

describe("RSVP buttons", () => {
  beforeEach(() => {
    process.env.RSVP_SIGNING_SECRET = "test-secret";
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
  });

  it("round-trips a button's custom_id, including a recurring event's instance ID", () => {
    const id = "abc123_20261020T010000Z";
    const row = rsvpButtonRow(id) as any;

    expect(row.components.map((b: any) => parseRsvpCustomId(b.custom_id))).toEqual([
      { status: "attending", calendarEventId: id },
      { status: "maybe", calendarEventId: id },
      { status: "declined", calendarEventId: id },
    ]);
  });

  it("leaves the buttons off when the event ID won't fit in Discord's 100-character custom_id", () => {
    expect(rsvpButtonRow("x".repeat(90))).toBeUndefined();
  });

  it("ignores other buttons' custom_ids", () => {
    expect(parseRsvpCustomId("create_event")).toBeUndefined();
    expect(parseRsvpCustomId("rsvp:removed:cal-1")).toBeUndefined();
    expect(parseRsvpCustomId("rsvp:attending:")).toBeUndefined();
    expect(parseRsvpCustomId(undefined)).toBeUndefined();
  });

  it("replies privately with a page link signed with the clicker's Discord identity", () => {
    const reply = rsvpLinkReply("maybe", "cal-1", { id: "user-r2", username: "r2d2", global_name: "R2-D2" }) as any;

    expect(reply.data.flags).toBe(64);
    const url = new URL(reply.data.components[0].components[0].url);
    expect(url.origin + url.pathname).toBe("https://rsvp.example.com/badb-rsvp");
    expect(url.searchParams.get("event")).toBe("cal-1");
    expect(url.searchParams.get("status")).toBe("maybe");
    expect(verifyToken(url.searchParams.get("d")!)).toMatchObject({ discordUserId: "user-r2", discordName: "R2-D2" });
  });
});
