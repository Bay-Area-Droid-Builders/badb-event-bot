// What people pick from on the RSVP page, the Discord buttons, and the
// email links. "removed" isn't offered — it's only used internally when a
// Discord "Interested" click is withdrawn.
export const RSVP_CHOICES = ["attending", "maybe", "declined"] as const;
export type RsvpChoice = (typeof RSVP_CHOICES)[number];

export const RSVP_LABELS: Record<RsvpChoice, string> = {
  attending: "Attending",
  maybe: "Maybe",
  declined: "Decline",
};

// How a choice reads once it's made ("You're marked Not attending").
export const RSVP_STATUS_LABELS: Record<RsvpChoice, string> = {
  attending: "Attending",
  maybe: "Maybe",
  declined: "Not attending",
};

export function isRsvpChoice(value: unknown): value is RsvpChoice {
  return typeof value === "string" && (RSVP_CHOICES as readonly string[]).includes(value);
}

function pageUrl(): string {
  const url = process.env.RSVP_PAGE_URL;
  if (!url) throw new Error("RSVP_PAGE_URL is not set");
  return url;
}

// A link to the RSVP page for one event, optionally with a choice already
// selected and, for Discord buttons, a signed token identifying who clicked.
export function rsvpPageUrl(calendarEventId: string, options: { status?: RsvpChoice; discord?: string } = {}): string {
  const url = new URL(pageUrl());
  url.searchParams.set("event", calendarEventId);
  if (options.status) url.searchParams.set("status", options.status);
  if (options.discord) url.searchParams.set("d", options.discord);
  return url.toString();
}

// The club logo, served by the rsvp function itself at /logo.png.
export function rsvpLogoUrl(): string {
  return `${pageUrl().replace(/\/+$/, "")}/logo.png`;
}
