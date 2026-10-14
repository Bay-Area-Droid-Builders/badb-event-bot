import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunction } from "@google-cloud/functions-framework/testing";

const events: string[] = [];

vi.mock("discord-interactions", () => ({ verifyKey: async () => true }));
vi.mock("../src/discordApi", () => ({
  editMessage: vi.fn(async () => {
    events.push("editMessage");
  }),
}));
vi.mock("../src/eventRequestActions", () => ({
  handleEventRequestAction: vi.fn(async () => {
    events.push("handleEventRequestAction");
    return { embeds: [{ title: "✅ Approved" }], components: [] };
  }),
}));

import "../src/interactions";
import { editMessage } from "../src/discordApi";

const handler = getFunction("interactions") as (req: any, res: any) => Promise<void>;

function fakeRequest(body: unknown) {
  const headers: Record<string, string> = { "x-signature-ed25519": "sig", "x-signature-timestamp": "1" };
  return { header: (name: string) => headers[name], rawBody: Buffer.from(JSON.stringify(body)), body };
}

function fakeResponse() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => {
    events.push("respond");
    return res;
  });
  res.send = vi.fn(() => res);
  return res;
}

const componentClick = {
  type: 3,
  channel_id: "chan",
  data: { custom_id: "create_event" },
  message: { id: "1290000000000000001", embeds: [{ title: "New event request: Droid Day" }] },
};

describe("interactions", () => {
  beforeEach(() => {
    events.length = 0;
    process.env.DISCORD_PUBLIC_KEY = "key";
    process.env.RSVP_SIGNING_SECRET = "test-secret";
    process.env.RSVP_PAGE_URL = "https://rsvp.example.com/badb-rsvp";
  });

  it("answers an RSVP button click with a private link, without touching the message", async () => {
    vi.mocked(editMessage).mockClear();
    const res = fakeResponse();

    await handler(
      fakeRequest({ ...componentClick, data: { custom_id: "rsvp:attending:cal-1" }, member: { user: { id: "user-r2", username: "r2d2" } } }),
      res,
    );

    const reply = res.json.mock.calls[0][0];
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(64);
    expect(reply.data.components[0].components[0].url).toContain("event=cal-1");
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("finishes the work and updates the message before responding to Discord", async () => {
    const res = fakeResponse();

    await handler(fakeRequest(componentClick), res);

    // Anything after the response runs with throttled CPU on Cloud Functions.
    expect(events).toEqual(["handleEventRequestAction", "editMessage", "respond"]);
    expect(editMessage).toHaveBeenCalledWith("chan", "1290000000000000001", { embeds: [{ title: "✅ Approved" }], components: [] });
    expect(res.json).toHaveBeenCalledWith({ type: 6 });
  });

  it("still acknowledges the click if updating the message fails", async () => {
    vi.mocked(editMessage).mockRejectedValueOnce(new Error("Discord is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeResponse();

    await handler(fakeRequest(componentClick), res);

    expect(res.json).toHaveBeenCalledWith({ type: 6 });
  });

  it("answers PINGs", async () => {
    const res = fakeResponse();

    await handler(fakeRequest({ type: 1 }), res);

    expect(res.json).toHaveBeenCalledWith({ type: 1 });
  });
});
