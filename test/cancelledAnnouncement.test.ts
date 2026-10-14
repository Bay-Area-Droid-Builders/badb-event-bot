import { describe, expect, it } from "vitest";
import { cancelledEmbed } from "../src/cancelledAnnouncement";

describe("cancelledEmbed", () => {
  it("retitles a new-event announcement and turns it red, keeping its details", () => {
    const embed = { title: "📅 New event: Build Night (BUILDERS ONLY)", color: 0x2ecc71, description: "Bring droids", fields: [{ name: "When" }] };
    expect(cancelledEmbed(embed)).toEqual({
      title: "🚫 CANCELLED: Build Night (BUILDERS ONLY)",
      color: 0xe74c3c,
      description: "Bring droids",
      fields: [{ name: "When" }],
    });
  });

  it("doesn't mark an announcement cancelled twice", () => {
    const embed = { title: "🚫 CANCELLED: Droid Day", color: 0xe74c3c };
    expect(cancelledEmbed(embed)).toEqual(embed);
  });

  it("keeps a title that isn't a new-event announcement's", () => {
    expect(cancelledEmbed({ title: "Droid Day" })).toMatchObject({ title: "🚫 CANCELLED: Droid Day" });
  });
});
