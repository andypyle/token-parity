import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { compileIgnore } from "../src/ignore.js";
import { plan } from "../src/plan.js";
import type { NormalizedToken } from "../src/types.js";
import { PERCEPTUAL, copyFixture, writeJson } from "./helpers.js";
import { runCli } from "../src/run-cli.js";

const figmaToken = (name: string) => ({ source: { origin: "figma", figma: { name } } }) as unknown as NormalizedToken;

describe("compileIgnore", () => {
  const ignore = compileIgnore(["animate-*", "dark/*", "color-amber-*:dark", "ease-?n"]);

  it("matches CSS names and Figma names", () => {
    expect(ignore.token("animate-spin")).toBe(true);
    expect(ignore.token("dark-fg-1", figmaToken("dark/fg-1"))).toBe(true);
    expect(ignore.token("dark-fg-1")).toBe(false); // the pattern is a Figma name
    expect(ignore.token("ease-in")).toBe(true);
    expect(ignore.token("ease-out")).toBe(false);
    expect(ignore.token("color-green-500")).toBe(false);
  });

  it("ignores single modes with pattern:mode, never the whole token", () => {
    expect(ignore.token("color-amber-100")).toBe(false);
    expect(ignore.mode("color-amber-100", "dark")).toBe(true);
    expect(ignore.mode("color-amber-100", "default")).toBe(false);
  });

  it("treats regex characters literally", () => {
    expect(compileIgnore(["spacing-0.5"]).token("spacing-0x5")).toBe(false);
    expect(compileIgnore(["spacing-0.5"]).token("spacing-0.5")).toBe(true);
  });
});

const PREFIX_DARK = join(import.meta.dirname, "fixtures", "tailwind-prefix-dark");

describe("ignore in check and plan", () => {
  const run = (dir: string, ignore: string[], lock: string | null = null) =>
    check({ figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: lock, settings: { ...PERCEPTUAL, ignore } });

  it("drops Figma-only groups and intentional code-only dark overrides from the report", async () => {
    const report = await run(PREFIX_DARK, ["dark/*", "color-amber-*:dark"]);
    expect(report.findings.map((f) => f.id)).toEqual(["near-match:color-amber-100:default"]); // the default value is still compared
    expect(report.summary.errors).toBe(0);
    expect(report.summary.tokensCompared).toBe(4);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "info", message: "Ignored 1 token and 1 mode value per the `ignore` setting." }));
  });

  it("still resolves aliases to ignored tokens", async () => {
    const report = await run(PREFIX_DARK, ["dark/*"]);
    expect(report.findings.map((f) => f.kind)).not.toContain("broken-alias"); // color-fg-1 dark aliases dark/fg-1
    expect(report.findings.map((f) => f.token)).not.toContain("color-fg-1");
  });

  it("skips code-only Tailwind namespaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-ignore-"));
    writeJson(join(dir, "figma.json"), { colorProfile: "srgb", variableCollections: {}, variables: {} });
    writeFileSync(join(dir, "theme.css"), "@theme { --animate-spin: spin 1s linear infinite; --ease-out: cubic-bezier(0, 0, 0.2, 1); --breakpoint-sm: 40rem; }");
    expect((await run(dir, [])).findings).toHaveLength(3);
    expect((await run(dir, ["animate-*", "ease-*", "breakpoint-*"])).findings).toEqual([]);
  });

  it("plan leaves ignored tokens alone, including their lock entries", async () => {
    const dir = copyFixture(PREFIX_DARK);
    const stale = { oklch: "oklch(0.5 0 0)", figmaRgb: { r: 0.5, g: 0.5, b: 0.5, a: 1 } };
    writeJson(join(dir, "tokens.lock.json"), { version: 1, figmaColorProfile: "srgb", tokens: { "dark-fg-1": { type: "color", modes: { default: stale } } } });
    const p = await plan({
      figmaPath: join(dir, "figma.json"),
      codePath: join(dir, "theme.css"),
      lockPath: join(dir, "tokens.lock.json"),
      prefer: null,
      resolutionsPath: null,
      figmaCollection: null,
      settings: { ...PERCEPTUAL, ignore: ["dark/*", "color-amber-*:dark"] },
    });
    expect(p.actions.map((a) => a.id)).toEqual(["lock-only:color-amber-100:default"]);
    expect(p.unresolved).toEqual([]);
    expect(p.lockAfter.tokens["dark-fg-1"]!.modes.default).toEqual(stale);
    expect(p.lockAfter.tokens["color-amber-100"]!.modes.dark).toBeUndefined();
  });

  it("comes from the config file or --ignore", async () => {
    const dir = copyFixture(PREFIX_DARK);
    writeJson(join(dir, "token-parity.config.json"), { figma: "figma.json", code: "theme.css", colorMatch: "perceptual", ignore: ["dark/*", "color-amber-*:dark"] });
    const io = { stdout: () => {}, stderr: () => {} };
    expect(await runCli(["check", "--config", join(dir, "token-parity.config.json")], io)).toBe(0);
    writeJson(join(dir, "token-parity.config.json"), { figma: "figma.json", code: "theme.css", colorMatch: "perceptual" });
    expect(await runCli(["check", "--config", join(dir, "token-parity.config.json")], io)).toBe(1);
    expect(await runCli(["check", "--config", join(dir, "token-parity.config.json"), "--ignore", "dark/*", "--ignore", "color-amber-*:dark"], io)).toBe(0);
    writeJson(join(dir, "token-parity.config.json"), { figma: "figma.json", code: "theme.css", ignore: "dark/*" });
    expect(await runCli(["check", "--config", join(dir, "token-parity.config.json")], io)).toBe(2);
  });
});
