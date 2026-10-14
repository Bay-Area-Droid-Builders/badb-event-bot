// One-time sign-in that lets the bot act on Google Calendar as the club
// account. Run it on your own machine, sign in as badroidbuilders@gmail.com,
// and paste the printed refresh token into .env.yaml as
// GOOGLE_OAUTH_REFRESH_TOKEN.
//
//   node scripts/authorize-calendar.js <OAuth client ID> <OAuth client secret>
//
// The OAuth client must be a "Desktop app" client, which allows this
// loopback redirect without registering it.
const http = require("http");
const { google } = require("googleapis");

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/authorize-calendar.js <client ID> <client secret>");
  process.exit(1);
}

const server = http.createServer();
server.listen(0, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const url = oauth.generateAuthUrl({
    access_type: "offline",
    // Forces Google to issue a refresh token even if this account has
    // authorized the client before.
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
  });
  console.log(`Open this URL and sign in as badroidbuilders@gmail.com:\n\n${url}\n`);

  server.on("request", async (req, res) => {
    const code = new URL(req.url, redirectUri).searchParams.get("code");
    if (!code) {
      res.end("No authorization code in this request.");
      return;
    }
    try {
      const { tokens } = await oauth.getToken(code);
      res.end("Done. You can close this tab and go back to the terminal.");
      if (!tokens.refresh_token) {
        console.error("Google didn't return a refresh token. Remove the app's access at https://myaccount.google.com/permissions and try again.");
        process.exitCode = 1;
      } else {
        console.log(`GOOGLE_OAUTH_REFRESH_TOKEN: "${tokens.refresh_token}"`);
      }
    } catch (err) {
      res.end("Sign-in failed. See the terminal.");
      console.error(err);
      process.exitCode = 1;
    }
    server.close();
  });
});
