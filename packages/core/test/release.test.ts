// The version is declared in four places; a release must not ship with them out of step.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

describe("release metadata", () => {
  it("has one version everywhere", () => {
    const marketplace = json(".claude-plugin/marketplace.json");
    expect({
      engine: VERSION,
      npmPackage: json("packages/core/package.json").version,
      plugin: json(".claude-plugin/plugin.json").version,
      marketplacePlugin: marketplace.plugins[0].version,
      marketplace: marketplace.metadata.version,
    }).toEqual({ engine: VERSION, npmPackage: VERSION, plugin: VERSION, marketplacePlugin: VERSION, marketplace: VERSION });
  });
});
