import { join } from "node:path";
import { PERCEPTUAL } from "./helpers.js";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { renderJson } from "../src/report/json.js";
import { renderMarkdown } from "../src/report/markdown.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const run = (name: string, lock = true) =>
  check({ settings: PERCEPTUAL,
    figmaPath: join(FIXTURES, name, "figma.json"),
    codePath: join(FIXTURES, name, "theme.css"),
    lockPath: lock ? join(FIXTURES, name, "tokens.lock.json") : null,
  });

describe("reports", () => {
  it("JSON round-trips the report object", async () => {
    const report = await run("value-mismatch");
    expect(JSON.parse(renderJson(report))).toEqual(report);
  });

  it("markdown lists drift with direction and the summary", async () => {
    const md = renderMarkdown(await run("value-mismatch"));
    expect(md).toContain("**Drift found:** 4 errors, 0 warnings.");
    expect(md).toContain("## Drift (4)");
    expect(md).toMatch(/\| `spacing-4` \| default \| value-mismatch \| Figma → code \|/);
    expect(md).toMatch(/\| `color-brand-primary` \| default \| value-mismatch \| code → Figma \|/);
    expect(md).not.toContain("## Warnings");
  });

  it("markdown separates warnings from drift", async () => {
    const md = renderMarkdown(await run("out-of-gamut"));
    expect(md).toContain("**In sync**, with 1 warning.");
    expect(md).toContain("## Warnings (1)");
    expect(md).not.toContain("## Drift");
  });

  it("markdown says when there is no lock baseline", async () => {
    const md = renderMarkdown(await run("near-match", false));
    expect(md).toContain("- Lock: none");
    expect(md).toContain("## Near-matches (1)");
  });

  it("an in-sync report is short", async () => {
    expect(renderMarkdown(await run("round-trip-unchanged"))).toContain("**In sync.**");
  });
});
