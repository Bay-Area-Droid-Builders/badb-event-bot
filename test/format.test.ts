import { describe, expect, it } from "vitest";
import { buildRichDescription, formatCalendarEventWhen, formatEventWhen, formatTime, htmlToText } from "../src/format";

// The Apps Script trigger sends UTC instants (Date#toISOString), so a 6 PM
// PDT start arrives as 01:00Z the next day.
const START_6PM_PDT = "2026-10-04T01:00:00.000Z";
const END_9PM_PDT = "2026-10-04T04:00:00.000Z";
const ARRIVAL_5PM_PDT = "2026-10-04T00:00:00.000Z";

describe("formatEventWhen", () => {
  it("shows times in Pacific, not the server's UTC", () => {
    expect(formatEventWhen(START_6PM_PDT, END_9PM_PDT)).toBe("Oct 3, 2026, 6:00 PM – Oct 3, 2026, 9:00 PM");
  });

  it("follows daylight saving time", () => {
    expect(formatEventWhen("2026-12-05T02:00:00.000Z")).toBe("Dec 4, 2026, 6:00 PM");
  });

  it("formats all-day (date-only) values as the date itself", () => {
    expect(formatEventWhen("2026-10-25", "2026-10-27")).toBe("Oct 25, 2026 – Oct 27, 2026");
  });
});

describe("formatCalendarEventWhen", () => {
  it("shows a multi-day all-day event ending on its last real day, not Calendar's exclusive end", () => {
    // Oct 25–27 is stored by Calendar with end.date = Oct 28.
    expect(formatCalendarEventWhen("2026-10-25", "2026-10-28")).toBe("Oct 25, 2026 – Oct 27, 2026");
  });

  it("shows a single-day all-day event as just its date", () => {
    expect(formatCalendarEventWhen("2026-10-25", "2026-10-26")).toBe("Oct 25, 2026");
  });

  it("handles an all-day event ending across a month boundary", () => {
    expect(formatCalendarEventWhen("2026-10-30", "2026-11-01")).toBe("Oct 30, 2026 – Oct 31, 2026");
  });

  it("leaves timed events unchanged", () => {
    expect(formatCalendarEventWhen(START_6PM_PDT, END_9PM_PDT)).toBe("Oct 3, 2026, 6:00 PM – Oct 3, 2026, 9:00 PM");
  });
});

describe("formatTime", () => {
  it("shows the time in Pacific", () => {
    expect(formatTime(ARRIVAL_5PM_PDT)).toBe("5:00 PM");
  });
});

describe("buildRichDescription", () => {
  it("writes the arrival time in Pacific", () => {
    expect(buildRichDescription("Bring droids.", "Meetup", ARRIVAL_5PM_PDT)).toBe("Type: Meetup\n\nArrival: 5:00 PM\n\nBring droids.");
  });
});

describe("htmlToText", () => {
  it("turns Google Calendar's HTML into plain text with the line breaks kept", () => {
    expect(htmlToText("Bring your <b>droids</b>!<br>Parking is <i>free</i>.<br><br>See you there")).toBe(
      "Bring your droids!\nParking is free.\n\nSee you there",
    );
  });

  it("keeps a link's URL next to its text, or just the URL when they match", () => {
    expect(htmlToText('Tickets <a href="https://example.com/t?a=1&amp;b=2" target="_blank">here</a>')).toBe(
      "Tickets here (https://example.com/t?a=1&b=2)",
    );
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe("https://example.com");
  });

  it("writes list items as bullets", () => {
    expect(htmlToText("What to bring:<ul><li>Droid</li><li>Snacks</li></ul>")).toBe("What to bring:\n• Droid\n• Snacks");
  });

  it("decodes entities, including numeric ones", () => {
    expect(htmlToText("<p>R2&nbsp;&amp;&nbsp;BB-8 &lt;3 &#8212; &#x1F916;</p>")).toBe("R2 & BB-8 <3 — 🤖");
  });

  it("drops paragraph and div wrappers without piling up blank lines", () => {
    expect(htmlToText("<div>First</div>\n<div><br></div><div><br></div><div>Second</div>")).toBe("First\n\nSecond");
  });

  it("leaves a plain-text description alone, even with a stray < or &", () => {
    const plain = "Type: Meetup\n\nArrival: 5:00 PM\n\nKids < 12 & parents welcome &amp; more";
    expect(htmlToText(plain)).toBe(plain);
  });
});
