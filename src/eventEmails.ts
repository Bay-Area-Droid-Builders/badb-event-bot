import type { calendar_v3 } from "googleapis";
import { formatCalendarEventWhen } from "./format";
import type { Email } from "./mailer";
import { RSVP_CHOICES, RSVP_LABELS, rsvpPageUrl } from "./rsvpLinks";

// The emails sent to the R2SF Google Group: the bi-weekly digest and the
// announcement of each new event. Every event in them carries RSVP links.

export const MAILING_LIST_ADDRESS = "R2SF@googlegroups.com";

function calendarViewUrl(): string {
  return "https://calendar.google.com/calendar/embed?src=" + encodeURIComponent(process.env.GOOGLE_CALENDAR_ID ?? "");
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function eventWhen(event: calendar_v3.Schema$Event): string {
  const startIso = event.start?.dateTime ?? event.start?.date ?? "";
  const endIso = event.end?.dateTime ?? event.end?.date ?? undefined;
  return formatCalendarEventWhen(startIso, endIso);
}

// The event as plain text, without RSVP links — also used for the Discord
// digest post, where a page link couldn't tell who clicked it anyway.
export function eventText(event: calendar_v3.Schema$Event): string {
  const lines = [event.summary || "Untitled event", eventWhen(event)];
  if (event.location) lines.push(event.location);
  if (event.description) lines.push(event.description);
  return lines.join("\n");
}

function eventTextWithRsvp(event: calendar_v3.Schema$Event): string {
  return event.id ? `${eventText(event)}\nRSVP: ${rsvpPageUrl(event.id)}` : eventText(event);
}

function rsvpLinksHtml(calendarEventId: string): string {
  const links = RSVP_CHOICES.map(
    (status) =>
      `<a href="${escapeHtml(rsvpPageUrl(calendarEventId, { status }))}" style="color: #8a2be2; font-weight: bold;">${RSVP_LABELS[status]}</a>`,
  );
  return `RSVP: ${links.join(" &middot; ")}`;
}

function eventHtml(event: calendar_v3.Schema$Event): string {
  const location = event.location ? `<br>${escapeHtml(event.location)}` : "";
  const description = event.description ? `<br>${escapeHtml(event.description)}` : "";
  const rsvp = event.id ? `<br>${rsvpLinksHtml(event.id)}` : "";
  return `<p><strong>${escapeHtml(event.summary || "Untitled event")}</strong><br>${escapeHtml(eventWhen(event))}${location}${description}${rsvp}</p>`;
}

function wrapHtml(intro: string, body: string): string {
  return `
<div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
  <p>Hey Builders!</p>
  <p>${intro}</p>
  ${body}
  <p>
    See the full, always-up-to-date calendar any time:
    <a href="${escapeHtml(calendarViewUrl())}" style="color: #8a2be2;">Bay Area Droid Builders Calendar</a>
  </p>
  <p>Thanks and may the force be with you!<br>Bay Area Droid Builders</p>
</div>
`.trim();
}

function wrapText(intro: string, body: string): string {
  return ["Hey Builders!", "", intro, "", body, "", "Thanks and may the force be with you!", "Bay Area Droid Builders"].join("\n");
}

const DIGEST_INTRO = "Here's your digest of the upcoming events for the Bay Area Droid Builders:";

// The digest's text for the Discord post: the same message, minus RSVP links.
export function buildDigestDiscordText(events: calendar_v3.Schema$Event[]): string {
  return wrapText(DIGEST_INTRO, events.map(eventText).join("\n\n"));
}

// Callers only invoke this with a non-empty list — sendEventDigest skips
// sending entirely when there's nothing upcoming.
export function buildDigestEmail(events: calendar_v3.Schema$Event[], to: string): Email {
  return {
    to,
    subject: "Upcoming Bay Area Droid Builder Events",
    text: wrapText(DIGEST_INTRO, events.map(eventTextWithRsvp).join("\n\n")),
    html: wrapHtml(DIGEST_INTRO, events.map(eventHtml).join("")),
  };
}

const NEW_EVENT_INTRO = "A new event was just added to the Bay Area Droid Builders calendar:";

export function buildNewEventEmail(event: calendar_v3.Schema$Event, to: string): Email {
  return {
    to,
    subject: `New event: ${event.summary || "Untitled event"}`,
    text: wrapText(NEW_EVENT_INTRO, eventTextWithRsvp(event)),
    html: wrapHtml(NEW_EVENT_INTRO, eventHtml(event)),
  };
}

// Sent the first time someone RSVPs from a browser that doesn't know them,
// so nobody can RSVP (and send calendar invites to) an address that isn't
// theirs.
export function buildRsvpConfirmEmail(
  event: calendar_v3.Schema$Event,
  name: string,
  statusLabel: string,
  confirmUrl: string,
  to: string,
): Email {
  const summary = event.summary || "Untitled event";
  const text = [
    `Hi ${name},`,
    "",
    `Confirm your RSVP (${statusLabel}) for ${summary} — ${eventWhen(event)}:`,
    confirmUrl,
    "",
    "If you didn't ask for this, ignore this email and nothing will happen.",
    "",
    "Bay Area Droid Builders",
  ].join("\n");
  const html = `
<div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #222;">
  <p>Hi ${escapeHtml(name)},</p>
  <p>Confirm your RSVP (<strong>${escapeHtml(statusLabel)}</strong>) for <strong>${escapeHtml(summary)}</strong> — ${escapeHtml(eventWhen(event))}:</p>
  <p><a href="${escapeHtml(confirmUrl)}" style="display: inline-block; background: #8a2be2; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: bold;">Confirm my RSVP</a></p>
  <p style="color: #666;">If you didn't ask for this, ignore this email and nothing will happen.</p>
  <p>Bay Area Droid Builders</p>
</div>
`.trim();
  return { to, subject: `Confirm your RSVP: ${summary}`, text, html };
}
