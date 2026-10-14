import { http } from "@google-cloud/functions-framework";
import type { Request, Response } from "@google-cloud/functions-framework";
import { Firestore } from "@google-cloud/firestore";
import { buildDigestEmail, MAILING_LIST_ADDRESS } from "./eventEmails";
import { getCalendarClient } from "./googleAuth";
import { sendEmail } from "./mailer";

const firestore = new Firestore();
const DIGEST_STATE_DOC = firestore.collection("digestState").doc("state");

// Runs weekly via Cloud Scheduler but only actually sends every other run,
// giving a true bi-weekly cadence without relying on fragile day-of-month
// cron math (cron has no native "every 2 weeks"). `dueNext` alternates on
// every scheduled run: a sent week sets it false, a skipped week sets it
// back to true. It's only written after a run finishes, so a mid-run
// failure doesn't burn a cycle — the next scheduled run retries instead.
// Manual runs (?force=true, or ?to=<email> for a test send) always send and
// never read or change it, so testing can't knock the schedule off.
async function isDueThisRun(): Promise<boolean> {
  const snap = await DIGEST_STATE_DOC.get();
  return snap.data()?.dueNext !== false; // defaults to true if the doc doesn't exist yet
}

async function setDueNext(dueNext: boolean): Promise<void> {
  await DIGEST_STATE_DOC.set({ dueNext }, { merge: true });
}

http("sendEventDigest", async (req: Request, res: Response) => {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    res.status(500).send("GOOGLE_CALENDAR_ID not set");
    return;
  }

  // ?to=<email> overrides the recipient for manual testing, so a test run
  // never actually reaches the real mailing list.
  const testRecipient = typeof req.query?.to === "string" ? req.query.to : undefined;
  const recipient = testRecipient || MAILING_LIST_ADDRESS;
  const isScheduledRun = req.query?.force !== "true" && !testRecipient;

  if (isScheduledRun && !(await isDueThisRun())) {
    await setDueNext(true);
    res.status(200).send("skipped — not due this week");
    return;
  }

  const calendar = await getCalendarClient();
  const eventsRes = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const events = eventsRes.data.items ?? [];
  if (events.length === 0) {
    // Nothing to report — still counts as this cycle's run so the
    // bi-weekly cadence stays on schedule, just with nothing sent.
    if (isScheduledRun) await setDueNext(false);
    res.status(200).send("skipped — no upcoming events");
    return;
  }

  // Email only — #events gets new-event announcements, not the digest.
  await sendEmail(buildDigestEmail(events, recipient));

  if (isScheduledRun) await setDueNext(false);
  res.status(200).send(`sent digest with ${events.length} event(s) to ${recipient}`);
});
