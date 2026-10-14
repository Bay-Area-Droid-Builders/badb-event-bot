import { google } from "googleapis";

// Acts as the club's Google account (badroidbuilders@gmail.com) through a
// stored OAuth refresh token, not the function's service account: Calendar
// refuses to let a service account add attendees unless it has Workspace
// domain-wide delegation, which a regular Gmail account can't grant. The
// refresh token comes from a one-time sign-in — see
// scripts/authorize-calendar.js.
export async function getCalendarClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN is not set");
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
}
