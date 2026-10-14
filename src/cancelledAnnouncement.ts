// How a new-event announcement looks once its event is cancelled: retitled,
// turned red, and without RSVP buttons. Shared by the poller, which rebuilds
// the announcement from the event's mapping, and the RSVP button handler,
// which only has the message someone clicked.

export const NEW_EVENT_TITLE_PREFIX = "📅 New event: ";
const CANCELLED_TITLE_PREFIX = "🚫 CANCELLED: ";
export const CANCELLED_COLOR = 0xe74c3c;

export function cancelledTitle(summary: string): string {
  return `${CANCELLED_TITLE_PREFIX}${summary}`;
}

// The announcement's own embed, marked cancelled.
export function cancelledEmbed(embed: { title?: string; [key: string]: unknown }): object {
  const title = embed.title ?? "";
  if (title.startsWith(CANCELLED_TITLE_PREFIX)) return { ...embed, color: CANCELLED_COLOR };
  const summary = title.startsWith(NEW_EVENT_TITLE_PREFIX) ? title.slice(NEW_EVENT_TITLE_PREFIX.length) : title;
  return { ...embed, title: cancelledTitle(summary), color: CANCELLED_COLOR };
}
