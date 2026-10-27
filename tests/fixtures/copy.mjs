import fs from "node:fs";

const fixture = new URL("./lessons/level-1.json", import.meta.url);

/** The fixture level with every id re-prefixed, so several copies can share a catalog. */
export function fixtureCopy(prefix, extra) {
  const json = fs.readFileSync(fixture, "utf8").replaceAll('"fx-', `"${prefix}-`).replace('"fixture-1"', `"${prefix}-level"`);
  return { ...JSON.parse(json), ...extra };
}
