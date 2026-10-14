import { http } from "@google-cloud/functions-framework";
import type { Request, Response } from "@google-cloud/functions-framework";
import { verifyKey } from "discord-interactions";
import { editMessage } from "./discordApi";
import { handleEventRequestAction } from "./eventRequestActions";
import { getEventMapping } from "./eventSync";
import { cancelledEventReply, parseRsvpCustomId, rsvpLinkReply } from "./rsvpButtons";

const InteractionType = { PING: 1, MESSAGE_COMPONENT: 3 };
const InteractionResponseType = {
  PONG: 1,
  DEFERRED_UPDATE_MESSAGE: 6,
};

http("interactions", async (req: Request, res: Response) => {
  const signature = req.header("x-signature-ed25519");
  const timestamp = req.header("x-signature-timestamp");
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!signature || !timestamp || !publicKey) {
    res.status(401).send("Missing signature");
    return;
  }

  // req.rawBody is provided by the Cloud Functions/functions-framework
  // runtime — required here since signature verification is over the exact
  // raw bytes, not the re-serialized JSON.
  const rawBody: Buffer = (req as any).rawBody;
  const isValid = await verifyKey(rawBody, signature, timestamp, publicKey);
  if (!isValid) {
    res.status(401).send("Bad signature");
    return;
  }

  const interaction = req.body;

  if (interaction.type === InteractionType.PING) {
    res.status(200).json({ type: InteractionResponseType.PONG });
    return;
  }

  if (interaction.type !== InteractionType.MESSAGE_COMPONENT) {
    res.status(400).send("Unsupported interaction type");
    return;
  }

  const channelId = interaction.channel_id ?? interaction.channel?.id;

  // RSVP buttons on new-event announcements reply straight away with a
  // private link. The one lookup and edit here fit easily in Discord's 3
  // seconds.
  const rsvp = parseRsvpCustomId(interaction.data?.custom_id);
  const user = interaction.member?.user ?? interaction.user;
  if (rsvp && user?.id) {
    if (await isCancelled(rsvp.calendarEventId)) {
      // The poller takes the buttons off when an event is cancelled, but
      // not on posts from before it saved where it announced each event.
      await removeButtons(channelId, interaction.message?.id);
      res.status(200).json(cancelledEventReply());
      return;
    }
    res.status(200).json(rsvpLinkReply(rsvp.status, rsvp.calendarEventId, user));
    return;
  }

  const messageId = interaction.message?.id;
  const embed = interaction.message?.embeds?.[0];

  // All the work happens *before* responding. Cloud Functions throttles CPU
  // once the response is sent, so work left for afterwards can stall or
  // never finish — leaving the buttons in place with no sign of whether
  // anything happened. The outcome is written onto the message itself via
  // the bot API (not the interaction response), so it shows up even when
  // this takes longer than Discord's 3-second window and Discord shows the
  // clicker "This interaction failed".
  if (channelId && messageId && embed) {
    const edit = await handleEventRequestAction(interaction.data?.custom_id, messageId, embed);
    if (edit) {
      try {
        await editMessage(channelId, messageId, edit);
      } catch (err) {
        // Approve is idempotent, so the buttons (still there) can be
        // clicked again to retry and get the outcome reported.
        console.error(err);
      }
    }
  }

  res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
});

// A failed lookup counts as not cancelled: the RSVP page itself still says
// when an event was cancelled.
async function isCancelled(calendarEventId: string): Promise<boolean> {
  try {
    return (await getEventMapping(calendarEventId))?.status === "cancelled";
  } catch (err) {
    console.error(`Failed to look up calendar event ${calendarEventId}`, err);
    return false;
  }
}

async function removeButtons(channelId: string | undefined, messageId: string | undefined): Promise<void> {
  if (!channelId || !messageId) return;
  try {
    await editMessage(channelId, messageId, { components: [] });
  } catch (err) {
    console.error(`Failed to remove RSVP buttons from message ${messageId}`, err);
  }
}
