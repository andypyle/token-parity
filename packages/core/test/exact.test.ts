// colorMatch "exact" (the default): code must hold Figma's 8-bit value, written as hex or rgb().
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/apply.js";
import { check, exitCodeFor } from "../src/check.js";
import { plan } from "../src/plan.js";
import { runCli } from "../src/run-cli.js";
import { DEFAULT_SETTINGS } from "../src/types.js";
import { figmaValueFromCode } from "../src/values.js";
import { copyFixture, readJsonFile } from "./helpers.js";

const ROOT = join(import.meta.dirname, "exact-fixtures");
const FIXTURES = readdirSync(ROOT).map((d) => join(ROOT, d));

const inputs = (dir: string) => ({ figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") });
const planIn = (dir: string) => {
  const o = existsSync(join(dir, "plan-options.json")) ? readJsonFile<{ prefer?: "code" | "figma" }>(join(dir, "plan-options.json")) : {};
  return plan({ ...inputs(dir), prefer: o.prefer ?? null, resolutionsPath: null, figmaCollection: null });
};

describe("exact fixtures (default settings)", () => {
  for (const dir of FIXTURES) {
    const name = dir.split("/").pop()!;

    it(`${name}: check`, async () => {
      const expected = readJsonFile<{ exitCode: number; findings: unknown[] }>(join(dir, "expected.json"));
      const report = await check(inputs(dir));
      expect(report.settings.colorMatch).toBe("exact");
      expect(report.findings.map(({ id, kind, token, mode, severity, suggestedDirection }) => ({ id, kind, token, mode, severity, suggestedDirection }))).toEqual(expected.findings);
      expect(exitCodeFor(report)).toBe(expected.exitCode);
    });

    it(`${name}: plan, apply, and a clean round trip`, async () => {
      const expected = readJsonFile<{ actions: unknown[]; unresolved: unknown[] }>(join(dir, "expected-plan.json"));
      const work = copyFixture(dir);
      const p = await planIn(work);
      expect(p.actions.map(({ id, op, via }) => ({ id, op, via }))).toEqual(expected.actions);
      expect(p.unresolved.map(({ finding, reason }) => ({ finding, reason }))).toEqual(expected.unresolved);

      await applyPlan(p, { allowDeletes: false });
      expect(readFileSync(join(work, "theme.css"), "utf8")).toBe(readFileSync(join(dir, "expected-apply", "theme.css"), "utf8"));
      expect((await check(inputs(work))).findings).toEqual([]);
      expect((await planIn(work)).actions).toEqual([]);
    });
  }
});

describe("exact matching", () => {
  it("compares 8-bit values: equal bytes are the same color, one step off is drift", async () => {
    // Perceptual mode calls this a near-match; its oklch() rounds to exactly Figma's 3981F6, so it's the same
    // color in exact mode, only written in the wrong notation.
    const same = await check({ ...inputs(join(import.meta.dirname, "fixtures", "near-match")), lockPath: null });
    expect(same.findings.map((f) => f.kind)).toEqual(["format-mismatch"]);
    const basic = await check(inputs(join(ROOT, "basic")));
    expect(basic.findings.find((f) => f.token === "color-near")).toMatchObject({ kind: "value-mismatch", severity: "error" });
  });

  it("explains a format mismatch with the hex to use", async () => {
    const report = await check(inputs(join(ROOT, "basic")));
    expect(report.findings.find((f) => f.kind === "format-mismatch")!.message).toBe(
      "Same color as Figma, but code writes it as oklch(0.6 0.2 30); exact matching needs hex or rgb() (#de3e2d) so it matches what Figma shows.",
    );
  });

  it("writes code's exact 8-bit value to Figma as k/255", () => {
    const parsed = { kind: "color" as const, color: { space: "srgb" as const, r: 16 / 255, g: 32 / 255, b: 1, alpha: 1 }, raw: "#1020ff" };
    const r = figmaValueFromCode(parsed, "color", "srgb", DEFAULT_SETTINGS);
    expect(r).toMatchObject({ ok: true, value: { type: "COLOR", r: 16 / 255, g: 32 / 255, b: 1, a: 1 } });
  });

  it("writes rgb() when asked, and refuses oklch output", async () => {
    const p = await plan({ ...inputs(join(ROOT, "basic")), prefer: "figma", resolutionsPath: null, figmaCollection: null, settings: { colorFormat: "rgb" } });
    expect(p.actions.map((a) => (a.op === "update-code" ? a.to : null))).toEqual(["rgb(0 0 255)", "rgb(222 62 45)"]);
    await expect(check({ ...inputs(join(ROOT, "basic")), settings: { colorFormat: "oklch" } })).rejects.toThrow(/can't give exact matches/);
    expect(await runCli(["check", "--figma", join(ROOT, "basic", "figma.json"), "--code", join(ROOT, "basic", "theme.css"), "--color-format", "oklch"], { stdout: () => {}, stderr: () => {} })).toBe(2);
  });

  it("falls back to perceptual matching for Display P3 files, and says so", async () => {
    const report = await check(inputs(join(import.meta.dirname, "fixtures", "out-of-gamut")));
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", message: expect.stringContaining("Display P3") }));
    expect(report.findings.map((f) => f.kind)).toEqual(["out-of-gamut"]);
  });
});
