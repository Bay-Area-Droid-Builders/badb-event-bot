import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listScheduledEventUserIds, postChannelMessage } from "../src/discordApi";

const fetchMock = vi.fn();

function rateLimited(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: retryAfterSeconds, global: false }), {
    status: 429,
  });
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Discord rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    process.env.DISCORD_BOT_TOKEN = "token";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits as long as a 429 asks, then retries", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited(3.644)).mockResolvedValueOnce(ok([{ user: { id: "user-r2" } }]));

    const result = listScheduledEventUserIds("guild", "event");
    await vi.advanceTimersByTimeAsync(3643);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual(["user-r2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the Retry-After header when the body has no retry_after", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(ok({ id: "message" }));

    const result = postChannelMessage("channel", { content: "hi" });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(result).resolves.toEqual({ id: "message" });
  });

  it("gives up after a few rate-limited retries", async () => {
    fetchMock.mockImplementation(async () => rateLimited(1));

    const result = postChannelMessage("channel", { content: "hi" });
    const assertion = expect(result).rejects.toThrow(/-> 429: .*rate limited/);
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails straight away when the wait is too long for a function run", async () => {
    fetchMock.mockResolvedValueOnce(rateLimited(60));

    await expect(postChannelMessage("channel", { content: "hi" })).rejects.toThrow(/-> 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry other errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"message": "Missing Access", "code": 50001}', { status: 403 }));

    await expect(postChannelMessage("channel", { content: "hi" })).rejects.toThrow(/-> 403: .*Missing Access/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
