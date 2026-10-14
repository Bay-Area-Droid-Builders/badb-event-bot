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
    expect(email.text).toBe(
      [
        "Hi R2,",
        "",
        "Confirm your RSVP for the upcoming Bay Area Droid Builders event:",
        "",
        "Droid <Day> — Oct 3, 2026, 6:00 PM – Oct 3, 2026, 9:00 PM",
        "",
        "You've RSVPed as ATTENDING.",
        "",
        "Confirm my RSVP: https://rsvp.example.com/badb-rsvp?confirm=tok",
        "",
        "If you didn't ask for this, ignore this email and nothing will happen.",
        "",
        "Bay Area Droid Builders",
      ].join("\n"),
    );
    expect(email.html).toContain('href="https://rsvp.example.com/badb-rsvp?confirm=tok"');
    expect(email.html).toContain("You've RSVPed as <strong>ATTENDING</strong>.");
  });

  it("shows the club logo in every email", () => {
    const logo = '<img src="https://rsvp.example.com/badb-rsvp/logo.png" width="96" height="96" alt="Bay Area Droid Builders"';

    expect(buildRsvpConfirmEmail(event, "R2", "Maybe", "https://x", "r2@example.com").html).toContain(logo);
    expect(buildNewEventEmail(event, "R2SF@googlegroups.com").html).toContain(logo);
  });

  it("shows an HTML description as plain text, with tags neither rendered raw nor injected", () => {
    const withHtml = { ...event, description: 'Bring <b>droids</b><br><script>x</script>Info <a href="https://example.com">here</a>' };
    const email = buildNewEventEmail(withHtml, "R2SF@googlegroups.com");

    expect(email.text).toContain("Bring droids\nxInfo here (https://example.com)");
    expect(email.html).toContain("Bring droids<br>xInfo here (https://example.com)");
    expect(email.html).not.toContain("<b>");
    expect(email.html).not.toContain("<script>");
  });
});
