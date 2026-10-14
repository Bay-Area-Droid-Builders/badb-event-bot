import { readFileSync } from "fs";
import { join } from "path";
import { http } from "@google-cloud/functions-framework";
import type { Request, Response } from "@google-cloud/functions-framework";
import type { calendar_v3 } from "googleapis";
import { buildRsvpConfirmEmail } from "./eventEmails";
import { getCalendarEvent } from "./googleCalendar";
import { sendEmail } from "./mailer";
import type { DiscordClaim } from "./rsvpButtons";
import { syncEventRsvps } from "./rsvpCalendar";
import { isRsvpChoice, RSVP_STATUS_LABELS, RsvpChoice } from "./rsvpLinks";
import { Identity, renderConfirmForm, renderMessagePage, renderRsvpForm } from "./rsvpPage";
import { claimConfirmEmailSlot, getDiscordLink, normalizeEmail, saveDiscordLink, saveRsvp } from "./rsvpStore";
import { signToken, verifyToken } from "./signedToken";

// The one RSVP page used from everywhere: the Discord buttons, the digest,
// and new-event emails. Someone is identified in one of three ways:
//   - a signed Discord token (from a Discord button) whose Discord account
//     is already linked to an email,
//   - a signed "remember me" cookie set after they first confirmed, or
//   - neither, in which case they type their name and email and confirm
//     through a link emailed to them.
// Confirming also links the Discord account when they came from Discord, so
// their Discord "Interested" clicks count from then on.

const COOKIE_NAME = "badb_rsvp";
const COOKIE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;

interface ConfirmClaim extends Identity {
  calendarEventId: string;
  status: RsvpChoice;
  discordUserId?: string;
}

// Read on first request rather than at load, so a missing file can't stop
// the page itself from working. Lives in assets/, beside lib/.
let logo: Buffer | undefined;
function logoPng(): Buffer {
  logo ??= readFileSync(join(__dirname, "..", "assets", "badb-logo.png"));
  return logo;
}

const RESPONSE_TO_CHOICE: Record<string, RsvpChoice> = { accepted: "attending", tentative: "maybe", declined: "declined" };

function param(req: Request, name: string): string | undefined {
  const fromBody = typeof req.body === "object" && req.body ? req.body[name] : undefined;
  const value = fromBody ?? req.query?.[name];
  return typeof value === "string" ? value : undefined;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.header("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function rememberIdentity(res: Response, identity: Identity): void {
  const token = signToken(identity, COOKIE_TTL_MS);
  res.set("Set-Cookie", `${COOKIE_NAME}=${token}; Max-Age=${COOKIE_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function forgetIdentity(res: Response): void {
  res.set("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function sendHtml(res: Response, status: number, html: string): void {
  res.status(status).set("Content-Type", "text/html; charset=utf-8").send(html);
}

// A link back to this page (the confirmation link, "Not you?").
function pageUrl(query: Record<string, string>): string {
  const base = process.env.RSVP_PAGE_URL;
  if (!base) throw new Error("RSVP_PAGE_URL is not set");
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function hasEnded(event: calendar_v3.Schema$Event, now = Date.now()): boolean {
  const end = event.end?.dateTime ?? event.end?.date ?? event.start?.dateTime ?? event.start?.date;
  return !!end && new Date(end).getTime() <= now;
}

// Loads the event, or renders why it can't be RSVPed to and returns undefined.
async function loadOpenEvent(res: Response, calendarId: string, eventId: string | undefined): Promise<calendar_v3.Schema$Event | undefined> {
  const event = eventId ? await getCalendarEvent(calendarId, eventId) : undefined;
  if (!event) {
    sendHtml(res, 404, renderMessagePage("Event not found", "This RSVP link doesn't match any event on the calendar."));
    return undefined;
  }
  if (event.status === "cancelled") {
    sendHtml(res, 410, renderMessagePage("This event was cancelled", "There's nothing to RSVP to anymore.", event));
    return undefined;
  }
  if (hasEnded(event)) {
    sendHtml(res, 410, renderMessagePage("This event is over", "RSVPs are closed for events that have already happened.", event));
    return undefined;
  }
  return event;
}

async function resolveIdentity(req: Request): Promise<{ identity?: Identity; discord?: DiscordClaim; cookieIdentity?: Identity }> {
  const discord = verifyToken<DiscordClaim>(param(req, "d"));
  const cookieIdentity = verifyToken<Identity>(readCookie(req, COOKIE_NAME));
  const linked = discord ? await getDiscordLink(discord.discordUserId) : undefined;
  return { identity: linked ?? cookieIdentity, discord, cookieIdentity };
}

async function applyRsvp(calendarId: string, claim: ConfirmClaim): Promise<void> {
  await saveRsvp({
    calendarEventId: claim.calendarEventId,
    email: claim.email,
    name: claim.name,
    status: claim.status,
    source: "page",
    discordUserId: claim.discordUserId,
  });
  if (claim.discordUserId) await saveDiscordLink(claim.discordUserId, { email: claim.email, name: claim.name });
  // Best effort: the RSVP is saved either way, and the poller copies any
  // that didn't make it onto Calendar.
  try {
    await syncEventRsvps(calendarId, claim.calendarEventId);
  } catch (err) {
    console.error(`Failed to sync RSVP for calendar event ${claim.calendarEventId}`, err);
  }
}

function renderDone(event: calendar_v3.Schema$Event, claim: ConfirmClaim): string {
  const message =
    claim.status === "declined"
      ? "Thanks for letting us know."
      : `It'll show up on the Google Calendar for ${claim.email}. You can change your answer any time from the same link.`;
  return renderMessagePage(`You're marked ${RSVP_STATUS_LABELS[claim.status]}`, message, event);
}

async function showEventPage(req: Request, res: Response, calendarId: string): Promise<void> {
  const event = await loadOpenEvent(res, calendarId, param(req, "event"));
  if (!event) return;

  // "Not you?" forgets whoever this browser or Discord link says they are
  // and asks for a name and email again.
  const differentPerson = param(req, "different") === "1";
  if (differentPerson) forgetIdentity(res);
  const resolved = await resolveIdentity(req);
  const identity = differentPerson ? undefined : resolved.identity;
  const discord = resolved.discord;

  const attendee = identity && event.attendees?.find((a) => normalizeEmail(a.email ?? "") === normalizeEmail(identity.email));
  const status = param(req, "status");
  const notYouQuery: Record<string, string> = { event: event.id ?? "", different: "1" };
  if (param(req, "d")) notYouQuery.d = param(req, "d")!;

  sendHtml(
    res,
    200,
    renderRsvpForm({
      event,
      identity,
      suggestedName: discord?.discordName,
      selected: isRsvpChoice(status) ? status : undefined,
      current: attendee?.responseStatus ? RESPONSE_TO_CHOICE[attendee.responseStatus] : undefined,
      discordToken: param(req, "d"),
      notYouUrl: pageUrl(notYouQuery),
    }),
  );
}

async function submitRsvp(req: Request, res: Response, calendarId: string): Promise<void> {
  const event = await loadOpenEvent(res, calendarId, param(req, "event"));
  if (!event?.id) return;

  const status = param(req, "status");
  if (!isRsvpChoice(status)) {
    sendHtml(res, 400, renderMessagePage("Pick a response", "Choose Attending, Maybe, or Decline.", event));
    return;
  }

  const { identity, discord, cookieIdentity } = await resolveIdentity(req);

  if (param(req, "mode") === "known") {
    if (!identity) {
      sendHtml(res, 400, renderMessagePage("Please start again", "This page was open too long. Go back to your RSVP link and try again.", event));
      return;
    }
    const claim: ConfirmClaim = { ...identity, calendarEventId: event.id, status, discordUserId: discord?.discordUserId };
    await applyRsvp(calendarId, claim);
    rememberIdentity(res, identity);
    sendHtml(res, 200, renderDone(event, claim));
    return;
  }

  const name = (param(req, "name") ?? "").trim();
  const email = normalizeEmail(param(req, "email") ?? "");
  if (!name || name.length > MAX_NAME_LENGTH || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    sendHtml(res, 400, renderMessagePage("Check your details", "Enter your name and a valid email address.", event));
    return;
  }

  const claim: ConfirmClaim = { name, email, calendarEventId: event.id, status, discordUserId: discord?.discordUserId };

  // This browser already proved it owns that address.
  if (cookieIdentity && normalizeEmail(cookieIdentity.email) === email) {
    await applyRsvp(calendarId, claim);
    rememberIdentity(res, { name, email });
    sendHtml(res, 200, renderDone(event, claim));
    return;
  }

  // Throttled requests get the same reply, so the form can't be used to
  // check whether someone has RSVPed recently.
  if (await claimConfirmEmailSlot(email)) {
    const confirmUrl = pageUrl({ confirm: signToken(claim, CONFIRM_TTL_MS) });
    await sendEmail(buildRsvpConfirmEmail(event, name, RSVP_STATUS_LABELS[status], confirmUrl, email));
  }
  sendHtml(res, 200, renderMessagePage("Check your email", `We sent a confirmation link to ${email}. Click it to finish your RSVP.`, event));
}

// GET shows a button rather than confirming straight away, because some mail
// providers open every link in an email to scan it.
async function showConfirmPage(req: Request, res: Response, calendarId: string): Promise<void> {
  const claim = verifyToken<ConfirmClaim>(param(req, "confirm"));
  if (!claim) {
    sendHtml(res, 400, renderMessagePage("This link has expired", "Confirmation links last 24 hours. Go back to the RSVP link and try again."));
    return;
  }
  const event = await loadOpenEvent(res, calendarId, claim.calendarEventId);
  if (!event) return;
  sendHtml(res, 200, renderConfirmForm(event, claim, claim.status, param(req, "confirm")!));
}

async function submitConfirm(req: Request, res: Response, calendarId: string): Promise<void> {
  const claim = verifyToken<ConfirmClaim>(param(req, "confirm"));
  if (!claim) {
    sendHtml(res, 400, renderMessagePage("This link has expired", "Confirmation links last 24 hours. Go back to the RSVP link and try again."));
    return;
  }
  const event = await loadOpenEvent(res, calendarId, claim.calendarEventId);
  if (!event) return;

  await applyRsvp(calendarId, claim);
  rememberIdentity(res, { name: claim.name, email: claim.email });
  sendHtml(res, 200, renderDone(event, claim));
}

http("rsvp", async (req: Request, res: Response) => {
  if (req.path === "/logo.png") {
    res.status(200).set("Content-Type", "image/png").set("Cache-Control", "public, max-age=86400").send(logoPng());
    return;
  }

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    res.status(500).send("GOOGLE_CALENDAR_ID not set");
    return;
  }

  try {
    const isPost = req.method === "POST";
    if (param(req, "confirm")) {
      await (isPost ? submitConfirm : showConfirmPage)(req, res, calendarId);
    } else {
      await (isPost ? submitRsvp : showEventPage)(req, res, calendarId);
    }
  } catch (err) {
    console.error(err);
    sendHtml(res, 500, renderMessagePage("Something went wrong", "Your RSVP didn't go through. Please try again in a few minutes."));
  }
});
