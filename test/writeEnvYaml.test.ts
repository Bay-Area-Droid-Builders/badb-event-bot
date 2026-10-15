import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS deploy script, no type declarations
import { buildEnvYaml, configKeys } from "../scripts/write-env-yaml.mjs";

describe("configKeys", () => {
  it("lists the keys in .env.yaml.example, skipping comments", () => {
    const keys = configKeys(readFileSync(".env.yaml.example", "utf8"));
    expect(keys).toContain("DISCORD_BOT_TOKEN");
    expect(keys).toContain("DISCORD_BUILDERS_CHANNEL_ID");
    expect(keys.every((key: string) => /^[A-Z][A-Z0-9_]*$/.test(key))).toBe(true);
  });
});

describe("buildEnvYaml", () => {
  it("writes each value as a quoted string", () => {
    const yaml = buildEnvYaml(["A", "B"], { A: 'has "quotes": and colons', B: "1529914770000576702", github_token: "x" });
    expect(yaml).toBe('A: "has \\"quotes\\": and colons"\nB: "1529914770000576702"\n');
  });

  it("names every missing secret", () => {
    expect(() => buildEnvYaml(["A", "B", "C"], { B: "set", C: "" })).toThrow("Missing repository secrets: A, C");
  });
});
