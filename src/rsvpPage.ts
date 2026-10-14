import type { calendar_v3 } from "googleapis";
import { escapeHtml, eventWhen } from "./eventEmails";
import { RSVP_CHOICES, RSVP_LABELS, RSVP_STATUS_LABELS, RsvpChoice } from "./rsvpLinks";

// HTML for the RSVP page. Plain server-rendered forms, no JavaScript, so it
// works from any email client's browser.

export interface Identity {
  email: string;
  name: string;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg: #f6f4fa; --card: #ffffff; --text: #222; --muted: #666; --accent: #8a2be2; --border: #ddd;
          --attending: #2e8b57; --maybe: #6b6b6b; --declined: #c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16131c; --card: #221e2a; --text: #eee; --muted: #aaa; --accent: #b57bff; --border: #3a3444; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text);
         font-family: -apple-system, Helvetica, Arial, sans-serif; line-height: 1.5; }
  main { max-width: 480px; margin: 0 auto; background: var(--card); border: 1px solid var(--border);
         border-radius: 12px; padding: 24px; }
  .club { color: var(--accent); font-weight: bold; font-size: 0.9rem; margin: 0 0 8px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .meta { color: var(--muted); margin: 0 0 20px; }
  label { display: block; font-weight: bold; margin: 12px 0 4px; }
  input[type=text], input[type=email] { width: 100%; padding: 10px; font-size: 1rem; border: 1px solid var(--border);
         border-radius: 8px; background: var(--bg); color: var(--text); }
  .choices { display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
  .choices button { flex: 1 1 120px; padding: 12px; font-size: 1rem; font-weight: bold; color: #fff;
         border: 3px solid transparent; border-radius: 8px; cursor: pointer; }
  .choices button.attending { background: var(--attending); }
  .choices button.maybe { background: var(--maybe); }
  .choices button.declined { background: var(--declined); }
  .choices button.selected { border-color: var(--text); }
  .note { color: var(--muted); font-size: 0.9rem; margin-top: 16px; }
  a { color: var(--accent); }
</style>
</head>
<body><main><p class="club">Bay Area Droid Builders</p>${body}</main></body>
</html>`;
}

function eventHeader(event: calendar_v3.Schema$Event): string {
  const location = event.location ? `<br>${escapeHtml(event.location)}` : "";
  return `<h1>${escapeHtml(event.summary || "Untitled event")}</h1><p class="meta">${escapeHtml(eventWhen(event))}${location}</p>`;
}

function hiddenInputs(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .filter(([, value]) => value)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value!)}">`)
    .join("");
}

function choiceButtons(selected?: RsvpChoice): string {
  const buttons = RSVP_CHOICES.map(
    (status) =>
      `<button type="submit" name="status" value="${status}" class="${status}${status === selected ? " selected" : ""}">${RSVP_LABELS[status]}</button>`,
  );
  return `<div class="choices">${buttons.join("")}</div>`;
}

export function renderMessagePage(heading: string, message: string, event?: calendar_v3.Schema$Event): string {
  return page(heading, `${event ? eventHeader(event) : ""}<h2>${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p>`);
}

export function renderRsvpForm(params: {
  event: calendar_v3.Schema$Event;
  identity?: Identity;
  suggestedName?: string;
  selected?: RsvpChoice;
  current?: RsvpChoice;
  discordToken?: string;
  notYouUrl: string;
}): string {
  const { event, identity } = params;
  const hidden = hiddenInputs({ event: event.id ?? "", d: params.discordToken, mode: identity ? "known" : "new" });
  const current = params.current ? `<p>You're currently marked <strong>${RSVP_STATUS_LABELS[params.current]}</strong>.</p>` : "";

  const who = identity
    ? `<p>RSVPing as <strong>${escapeHtml(identity.name)}</strong> (${escapeHtml(identity.email)}). <a href="${escapeHtml(params.notYouUrl)}">Not you?</a></p>`
    : `<label for="name">Your name</label>
<input type="text" id="name" name="name" required maxlength="100" autocomplete="name" value="${escapeHtml(params.suggestedName ?? "")}">
<label for="email">Your email</label>
<input type="email" id="email" name="email" required maxlength="254" autocomplete="email">`;

  const note = identity
    ? "Attending or Maybe adds this event to your Google Calendar."
    : "We'll email you a link to confirm. After that, this browser remembers you and future RSVPs take one click.";

  return page(
    `RSVP: ${event.summary || "Untitled event"}`,
    `${eventHeader(event)}${current}<form method="post">${hidden}${who}${choiceButtons(params.selected)}</form><p class="note">${note}</p>`,
  );
}

export function renderConfirmForm(event: calendar_v3.Schema$Event, identity: Identity, status: RsvpChoice, token: string): string {
  return page(
    "Confirm your RSVP",
    `${eventHeader(event)}<form method="post">${hiddenInputs({ confirm: token })}
<p>Mark <strong>${escapeHtml(identity.name)}</strong> (${escapeHtml(identity.email)}) as <strong>${RSVP_STATUS_LABELS[status]}</strong>?</p>
<div class="choices"><button type="submit" class="${status}">Confirm</button></div></form>`,
  );
}
