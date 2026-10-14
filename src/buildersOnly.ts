import type { calendar_v3 } from "googleapis";
import { htmlToText } from "./format";

// Builders-only events are ordinary events on the club calendar with their
// visibility set to Private, so the public calendar shows them only as
// "busy". They never get a Discord Scheduled Event or an #events post (both
// public); they're announced in the builders channel and still emailed to
// the mailing list, labelled so nobody forwards them.

export const BUILDERS_ONLY_SUFFIX = "(BUILDERS ONLY)";
export const BUILDERS_ONLY_NOTICE = "This is a Bay Area Droid Builders Members only event announcement. Do Not Share!";

export function isBuildersOnly(event: calendar_v3.Schema$Event): boolean {
  return event.visibility === "private" || event.visibility === "confidential";
}

// Adds the title suffix and description notice to a builders-only event,
// leaving out either one whoever made the event already typed in.
export function labelBuildersOnly(event: calendar_v3.Schema$Event): calendar_v3.Schema$Event {
  if (!isBuildersOnly(event)) return event;

  const summary = event.summary || "Untitled event";
  const description = event.description || "";
  const hasSuffix = summary.toUpperCase().includes(BUILDERS_ONLY_SUFFIX);
  const hasNotice = htmlToText(description).toLowerCase().includes(BUILDERS_ONLY_NOTICE.toLowerCase());
  return {
    ...event,
    summary: hasSuffix ? summary : `${summary} ${BUILDERS_ONLY_SUFFIX}`,
    // Literal newlines survive htmlToText, so this works for HTML
    // descriptions too.
    description: hasNotice ? description : description ? `${BUILDERS_ONLY_NOTICE}\n\n${description}` : BUILDERS_ONLY_NOTICE,
  };
}
