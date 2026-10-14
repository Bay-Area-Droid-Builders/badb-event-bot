import { describe, expect, it } from "vitest";
import { BUILDERS_ONLY_NOTICE, isBuildersOnly, labelBuildersOnly } from "../src/buildersOnly";

describe("isBuildersOnly", () => {
  it("treats private and confidential Calendar events as builders-only", () => {
    expect(isBuildersOnly({ visibility: "private" })).toBe(true);
    expect(isBuildersOnly({ visibility: "confidential" })).toBe(true);
    expect(isBuildersOnly({ visibility: "public" })).toBe(false);
    expect(isBuildersOnly({ visibility: "default" })).toBe(false);
    expect(isBuildersOnly({})).toBe(false);
  });
});

describe("labelBuildersOnly", () => {
  it("leaves public events alone", () => {
    const event = { summary: "Droid Day", description: "Bring droids" };
    expect(labelBuildersOnly(event)).toBe(event);
  });

  it("adds the title suffix and the notice above the description", () => {
    const labelled = labelBuildersOnly({ visibility: "private", summary: "Build Night", description: "Bring droids" });
    expect(labelled.summary).toBe("Build Night (BUILDERS ONLY)");
    expect(labelled.description).toBe(`${BUILDERS_ONLY_NOTICE}\n\nBring droids`);
  });

  it("uses the notice alone when there's no description", () => {
    expect(labelBuildersOnly({ visibility: "private", summary: "Build Night" }).description).toBe(BUILDERS_ONLY_NOTICE);
  });

  it("doesn't repeat labels that were typed in by hand", () => {
    const event = {
      visibility: "private",
      summary: "Build Night (Builders Only)",
      description: `<b>${BUILDERS_ONLY_NOTICE}</b><br>Bring droids`,
    };
    expect(labelBuildersOnly(event)).toEqual(event);
  });

  it("is idempotent", () => {
    const once = labelBuildersOnly({ visibility: "private", summary: "Build Night", description: "Bring droids" });
    expect(labelBuildersOnly(once)).toEqual(once);
  });
});
