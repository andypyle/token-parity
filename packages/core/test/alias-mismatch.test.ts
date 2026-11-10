import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { plan } from "../src/plan.js";
import { copyFixture, PERCEPTUAL, writeJson } from "./helpers.js";

const TARGETS = join(import.meta.dirname, "fixtures", "alias-different-targets");
const MIGRATION = join(import.meta.dirname, "plan-fixtures", "alias-migration");
const inputs = (dir: string, lock = "tokens.lock.json") => ({ figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, lock) });

describe("alias-mismatch", () => {
  it("says which variable each side aliases", async () => {
    const report = await check({ ...inputs(MIGRATION), settings: { ...PERCEPTUAL, ignore: ["dark/*"] } });
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: "missing-in-figma", token: "color-gray-950" }),
      expect.objectContaining({
        kind: "alias-mismatch",
        token: "color-page",
        mode: "dark",
        suggestedDirection: "needs-decision",
        message: "Same value, but Figma aliases {dark/page} and code aliases var(--ds-color-gray-950).",
      }),
    ]);
  });

  it("takes its direction from the per-side aliases in the lock", async () => {
    const dir = copyFixture(MIGRATION);
    // At the last sync both sides aliased dark/page (#14181c). Since then code moved to gray-950 (same color).
    const entry = { oklch: "oklch(0.20660967 0.01006444 248.313572)", figmaRgb: { r: 0.0784313725490196, g: 0.09411764705882353, b: 0.10980392156862745, a: 1 }, figmaAlias: "dark-page", codeAlias: "dark-page" };
    writeJson(join(dir, "tokens.lock.json"), { version: 1, figmaColorProfile: "srgb", tokens: { "color-page": { type: "color", modes: { dark: entry } } } });
    const report = await check({ ...inputs(dir), settings: { ...PERCEPTUAL, ignore: ["dark/*"] } });
    expect(report.findings.find((f) => f.kind === "alias-mismatch")).toMatchObject({
      suggestedDirection: "code-to-figma",
      changed: { figma: false, code: true },
      message: expect.stringContaining("Code changed its alias since the last sync."),
    });
  });

  it("re-aliases Figma to a target it creates in the same plan (create first, then alias)", async () => {
    const p = await plan({ ...inputs(MIGRATION), prefer: "code", resolutionsPath: null, figmaCollection: null, settings: { ...PERCEPTUAL, ignore: ["dark/*"] } });
    expect(p.actions.map((a) => a.op)).toEqual(["add-figma", "update-figma"]);
    expect(p.actions[1]).toMatchObject({ to: { type: "ALIAS", name: "gray/950" } });
    expect(p.actions[1]!.note).toBeUndefined();
  });
});

describe("an alias is only proposed if it gives code's value in that mode", () => {
  it("writes the value when the Figma target is single-mode but code overrides it in dark", async () => {
    // Code: accent-soft -> var(--color-green-100), with .dark { --color-green-100: #253222 }.
    // Figma's green/100 is single-mode and light, so aliasing it from Dark would give #e8f0e6.
    const p = await plan({ ...inputs(TARGETS, "none.lock.json"), prefer: "code", resolutionsPath: null, figmaCollection: null, settings: PERCEPTUAL });
    const accent = p.actions.find((a) => a.id === "update-figma:color-accent-soft:dark")!;
    expect(accent).toMatchObject({ op: "update-figma", to: { type: "COLOR" } });
    expect(accent.note).toMatch(/aliasing green\/100 would give .* in dark, not code's value; wrote the value instead/);
  });

  it("keeps the alias when it resolves to code's value", async () => {
    const p = await plan({ ...inputs(TARGETS, "none.lock.json"), prefer: "code", resolutionsPath: null, figmaCollection: null, settings: PERCEPTUAL });
    // on-control: code aliases on-fill, which this plan creates (aliasing gray/900 in both modes).
    expect(p.actions.find((a) => a.id === "update-figma:color-on-control:dark")).toMatchObject({ to: { type: "ALIAS", name: "on-fill" } });
  });
});
