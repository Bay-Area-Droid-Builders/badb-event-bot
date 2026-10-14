import { isRsvpChoice, RSVP_CHOICES, RSVP_LABELS, RsvpChoice, rsvpPageUrl } from "./rsvpLinks";
import { signToken } from "./signedToken";

// Attending / Maybe / Decline buttons on each #events announcement. A click
// doesn't RSVP by itself: it hands the clicker a private link to the RSVP
// page, signed with their Discord ID, so whatever they RSVP there gets tied
// to their Discord account (see src/discordInterest.ts).

const BUTTON_STYLE: Record<RsvpChoice, number> = { attending: 3, maybe: 2, declined: 4 }; // green, grey, red
const CUSTOM_ID_PREFIX = "rsvp";
const DISCORD_CUSTOM_ID_MAX = 100;

// Long enough to fill in the page; the confirmation email that may follow
// carries its own, longer-lived token.
export const DISCORD_LINK_TTL_MS = 60 * 60 * 1000;

export interface DiscordClaim {
  discordUserId: string;
  discordName: string;
}

function customId(status: RsvpChoice, calendarEventId: string): string {
  return `${CUSTOM_ID_PREFIX}:${status}:${calendarEventId}`;
}

// Returns undefined when the Calendar event ID is too long to fit in a
// button's custom_id — the announcement is then posted without buttons.
export function rsvpButtonRow(calendarEventId: string): object | undefined {
  if (customId("attending", calendarEventId).length > DISCORD_CUSTOM_ID_MAX) return undefined;
  return {
    type: 1, // action row
    components: RSVP_CHOICES.map((status) => ({
      type: 2, // button
      style: BUTTON_STYLE[status],
      label: RSVP_LABELS[status],
      custom_id: customId(status, calendarEventId),
    })),
  };
}

export function parseRsvpCustomId(id: string | undefined): { status: RsvpChoice; calendarEventId: string } | undefined {
  const [prefix, status, ...rest] = (id ?? "").split(":");
  const calendarEventId = rest.join(":");
  if (prefix !== CUSTOM_ID_PREFIX || !isRsvpChoice(status) || !calendarEventId) return undefined;
  return { status, calendarEventId };
}

// The reply to an RSVP button click: a message only the clicker sees, with
// a link button to their personal RSVP page.
export function rsvpLinkReply(
  status: RsvpChoice,
  calendarEventId: string,
  user: { id: string; username?: string; global_name?: string | null },
): object {
  const claim: DiscordClaim = { discordUserId: user.id, discordName: user.global_name || user.username || "" };
  const url = rsvpPageUrl(calendarEventId, { status, discord: signToken(claim, DISCORD_LINK_TTL_MS) });
  return {
    type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
    data: {
      flags: 64, // EPHEMERAL
      content: "Finish your RSVP on the page below. It'll put the event on your Google Calendar.",
      components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open RSVP page", url }] }],
    },
  };
}
