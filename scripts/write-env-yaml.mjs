// Writes .env.yaml for a deploy from GitHub Actions. Reads the repo's
// secrets as JSON from SECRETS_JSON (the workflow passes toJSON(secrets))
// and takes the list of keys from .env.yaml.example, so a config value
// added there without a matching secret fails the deploy by name instead
// of deploying without it.
import { readFileSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";

export function configKeys(exampleText) {
  return exampleText
    .split("\n")
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*):/)?.[1])
    .filter(Boolean);
}

// Every value is written as a JSON string, which is also a valid YAML
// string, so quotes, colons, and spaces in secrets survive.
export function buildEnvYaml(keys, secrets) {
  const missing = keys.filter((key) => !secrets[key]);
  if (missing.length) throw new Error(`Missing repository secrets: ${missing.join(", ")}`);
  return keys.map((key) => `${key}: ${JSON.stringify(secrets[key])}`).join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keys = configKeys(readFileSync(".env.yaml.example", "utf8"));
  writeFileSync(".env.yaml", buildEnvYaml(keys, JSON.parse(process.env.SECRETS_JSON ?? "{}")));
  console.log(`Wrote .env.yaml with ${keys.length} values.`);
}
