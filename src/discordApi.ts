const API_BASE = "https://discord.com/api/v10";

function botHeaders(): Record<string, string> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  return {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };
}

// Discord rate-limits each route and answers 429 with how long to wait.
// The poller checks "Interested" on every upcoming event back to back, which
// runs past the limit once there are more than a handful of events. Waits
// that long and tries again, unless the wait wouldn't fit in a function run.
const MAX_RATE_LIMIT_RETRIES = 3;
export const MAX_RATE_LIMIT_WAIT_MS = 10_000;

// How long a 429 says to wait, from its body (`retry_after`, in seconds),
// or else its Retry-After header.
async function retryAfterMs(res: Response): Promise<number | undefined> {
  const body = await res.clone().json().catch(() => undefined);
  const seconds = Number(body?.retry_after ?? res.headers.get("retry-after") ?? NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function discordFetch(path: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, init);
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const waitMs = await retryAfterMs(res);
      if (waitMs !== undefined && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(waitMs);
        continue;
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Discord API ${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
    }
    return res;
  }
}

export async function postChannelMessage(channelId: string, body: unknown): Promise<any> {
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function createGuildScheduledEvent(guildId: string, body: unknown): Promise<any> {
  const res = await discordFetch(`/guilds/${guildId}/scheduled-events`, {
    method: "POST",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function updateGuildScheduledEvent(guildId: string, eventId: string, body: unknown): Promise<any> {
  const res = await discordFetch(`/guilds/${guildId}/scheduled-events/${eventId}`, {
    method: "PATCH",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function deleteGuildScheduledEvent(guildId: string, eventId: string): Promise<void> {
  await discordFetch(`/guilds/${guildId}/scheduled-events/${eventId}`, { method: "DELETE", headers: botHeaders() });
}

// Edits the message that a component interaction came from, using the
// interaction's own webhook (no separate bot-token call needed here, but
// bot token auth works too and is simpler to reason about, so we use it).
export async function editMessage(channelId: string, messageId: string, body: unknown): Promise<any> {
  const res = await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: botHeaders(),
    body: JSON.stringify(body),
  });
  return res.json();
}

// The IDs of everyone who clicked "Interested" on a Scheduled Event. Discord
// pages this by user ID, at most 100 per call.
export async function listScheduledEventUserIds(guildId: string, eventId: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: "100", ...(after ? { after } : {}) });
    const res = await discordFetch(`/guilds/${guildId}/scheduled-events/${eventId}/users?${query}`, {
      method: "GET",
      headers: botHeaders(),
    });
    const page: { user: { id: string } }[] = await res.json();
    ids.push(...page.map((entry) => entry.user.id));
    if (page.length < 100) return ids;
    after = page[page.length - 1].user.id;
  }
}
