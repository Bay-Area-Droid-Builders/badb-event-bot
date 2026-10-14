import { listScheduledEventUserIds } from "./discordApi";
import { listActiveEventMappings } from "./eventSync";
import { getDiscordLink, getRsvp, listRsvpsForEvent, saveRsvp } from "./rsvpStore";

// Lines Discord "Interested" clicks up with the Calendar guest list. Discord
// never tells a bot anyone's email, so this only works for people who've
// linked their Discord account by RSVPing once through a Discord button.
// For them, Interested counts as Attending, and un-clicking it takes them
// back off. An RSVP made on the page always wins over Interested.
export async function syncDiscordInterest(guildId: string, now = Date.now()): Promise<number> {
  const upcoming = (await listActiveEventMappings()).filter((m) => new Date(m.endIso || m.startIso).getTime() > now);
  let changed = 0;

  for (const mapping of upcoming) {
    try {
      changed += await syncEvent(guildId, mapping.calendarEventId, mapping.discordEventId);
    } catch (err) {
      console.error(`Failed to sync Discord interest for calendar event ${mapping.calendarEventId}`, err);
    }
  }
  return changed;
}

async function syncEvent(guildId: string, calendarEventId: string, discordEventId: string): Promise<number> {
  const interested = new Set(await listScheduledEventUserIds(guildId, discordEventId));
  const rsvps = await listRsvpsForEvent(calendarEventId);
  let changed = 0;

  // People already on record for this event from Discord need no lookup —
  // this keeps the per-poll Firestore reads down to unlinked users.
  const known = new Set(rsvps.map((r) => r.discordUserId).filter(Boolean));

  for (const discordUserId of interested) {
    const fromInterest = rsvps.find((r) => r.discordUserId === discordUserId && r.source === "discord-interested");
    if (fromInterest?.status === "removed") {
      await saveRsvp({ ...fromInterest, status: "attending" });
      changed++;
      continue;
    }
    if (known.has(discordUserId)) continue;

    const link = await getDiscordLink(discordUserId);
    if (!link) continue;
    // They may have RSVPed on the page with an email link (no Discord ID
    // attached), in which case that answer stands.
    if (await getRsvp(calendarEventId, link.email)) continue;

    await saveRsvp({ calendarEventId, email: link.email, name: link.name, status: "attending", source: "discord-interested", discordUserId });
    changed++;
  }

  for (const rsvp of rsvps) {
    if (rsvp.source !== "discord-interested" || rsvp.status !== "attending" || !rsvp.discordUserId) continue;
    if (interested.has(rsvp.discordUserId)) continue;
    await saveRsvp({ ...rsvp, status: "removed" });
    changed++;
  }

  return changed;
}
