import { beforeEach, describe, expect, it } from "vitest";
import { buildNewEventEmail, buildRsvpConfirmEmail, escapeHtml } from "../src/eventEmails";

const event = {
  id: "cal-1",
  summary: "Droid <Day>",
  location: "The Park",
  start: { dateTime: "2026-10-04T01:00:00.000Z" },
  end: { dateTime: "2026-10-04T04:00:00.000Z" },
};

describe("event emails", () => {
  beforeEach(() => {
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
  });

  it("escapes HTML, including quotes so values are safe inside attributes", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("announces a new event with its time in Pacific and RSVP links", () => {
    const email = buildNewEventEmail(event, "R2SF@googlegroups.com");

    expect(email.subject).toBe("New event: Droid <Day>");
    expect(email.text).toContain("Oct 3, 2026, 6:00 PM – Oct 3, 2026, 9:00 PM");
    expect(email.html).toContain("Droid &lt;Day&gt;");
    expect(email.html).toContain("status=maybe");
  });

  it("sends the confirmation link to the person RSVPing", () => {
    const email = buildRsvpConfirmEmail(event, "R2", "Attending", "https://rsvp.example.com/badb-rsvp?confirm=tok", "r2@example.com");

    expect(email.to).toBe("r2@example.com");
    expect(email.subject).toBe("Confirm your RSVP: Droid <Day>");
    expect(email.text).toContain("https://rsvp.example.com/badb-rsvp?confirm=tok");
    expect(email.html).toContain('href="https://rsvp.example.com/badb-rsvp?confirm=tok"');
  });
});
