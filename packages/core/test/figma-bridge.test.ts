import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandCompactExport, readFigmaExport } from "../src/adapters/figma.js";
import { applyPlan } from "../src/apply.js";
import { check } from "../src/check.js";
import { commitFromPush, commitPending } from "../src/commit.js";
import { tpChecksum, tpF32 } from "../src/figma-bridge.js";
import type { PushResult } from "../src/predict.js";
import { exportScript, jsonChecksum, pushScript } from "../src/figma-script.js";
import { plan } from "../src/plan.js";
import type { FigmaChangeSet } from "../src/types.js";
import { copyFixture, readJsonFile } from "./helpers.js";
import { mockFigma, runInFigma } from "./mock-figma.js";

const ROOT = import.meta.dirname;
type ExportResult = { unchanged: boolean; checksum: string; export: { colorProfile: string }; variables: number; collections: number; warnings: string[] };

async function exportFrom(figma: unknown, known: string | null = null): Promise<ExportResult> {
  return (await runInFigma(exportScript(known), figma)) as ExportResult;
}
/** What the skill writes to the export file: the `export` object, as JSON. */
const exportText = (r: ExportResult) => JSON.stringify(r.export);

describe("checksum", () => {
  it("is stable and formatting-independent", () => {
    expect(tpChecksum("")).toMatch(/^[0-9a-f]{14}$/);
    expect(tpChecksum('{"a":1}')).toBe(tpChecksum('{"a":1}'));
    expect(tpChecksum('{"a":1}')).not.toBe(tpChecksum('{"a":2}'));
    expect(jsonChecksum('{ "a": 1,\n "b": [1, 2] }')).toBe(jsonChecksum('{"a":1,"b":[1,2]}'));
  });

  it("catches a single-digit float change", () => {
    expect(jsonChecksum('{"r":0.2235294133424759}')).not.toBe(jsonChecksum('{"r":0.2235294133424758}'));
  });
});

describe("export script", () => {
  it("produces the engine's export format with a matching checksum", async () => {
    const source = readJsonFile<Parameters<typeof mockFigma>[0]>(join(ROOT, "fixtures", "in-sync-no-lock", "figma.json"));
    const { figma } = mockFigma(source);
    const result = await exportFrom(figma);

    expect(result.checksum).toBe(jsonChecksum(exportText(result)));
    expect(result).toMatchObject({ unchanged: false, variables: 6, collections: 2, warnings: [] });
    const set = readFigmaExport(JSON.parse(exportText(result)), "export.json");
    expect([...set.tokens.keys()].sort()).toEqual(["color-accent", "color-bg", "color-blue-500", "color-fg", "color-surface", "radius-md"]);
    expect(set.tokens.get("color-bg")!.source.figma!.scopes).toEqual(["ALL_SCOPES"]);

    // The compact export reads back as the same tokens as the full-format source.
    const full = readFigmaExport(source, "figma.json");
    for (const [key, token] of full.tokens) {
      expect(set.tokens.get(key)!.values).toEqual(token.values);
      expect(set.tokens.get(key)!.source.figma!.modeIds).toEqual(token.source.figma!.modeIds);
    }
  });

  it("is deterministic and reflects the document color profile", async () => {
    const source = readJsonFile<Parameters<typeof mockFigma>[0]>(join(ROOT, "fixtures", "out-of-gamut", "figma.json"));
    const a = await exportFrom(mockFigma(source).figma);
    const b = await exportFrom(mockFigma(source).figma);
    expect(exportText(a)).toBe(exportText(b));
    expect(a.export.colorProfile).toBe("display-p3");
    const legacy = await exportFrom(mockFigma(source, "LEGACY").figma);
    expect(legacy.export.colorProfile).toBe("srgb");
    expect(legacy.warnings[0]).toMatch(/legacy/);
  });

  it("skips remote (library) variables", async () => {
    const source = readJsonFile<Parameters<typeof mockFigma>[0]>(join(ROOT, "fixtures", "near-match", "figma.json"));
    const mock = mockFigma(source);
    (mock.variables.get("V:2") as unknown as { remote: boolean }).remote = true;
    expect((await exportFrom(mock.figma)).variables).toBe(1);
  });
});

describe("push script", () => {
  async function setUp(fixture: string) {
    const dir = copyFixture(fixture);
    const mock = mockFigma(readJsonFile(join(dir, "figma.json")));
    // Start from a real export so the change set's exportChecksum matches what the plugin sees.
    writeFileSync(join(dir, "figma.json"), exportText(await exportFrom(mock.figma)));
    const options = existsSync(join(dir, "plan-options.json")) ? readJsonFile<{ prefer?: "code" | "figma"; allowDeletes?: boolean }>(join(dir, "plan-options.json")) : {};
    const p = await plan({
      figmaPath: join(dir, "figma.json"),
      codePath: join(dir, "theme.css"),
      lockPath: join(dir, "tokens.lock.json"),
      prefer: options.prefer ?? null,
      resolutionsPath: existsSync(join(dir, "resolutions.json")) ? join(dir, "resolutions.json") : null,
      figmaCollection: null,
    });
    const applied = await applyPlan(p, { allowDeletes: true });
    return { dir, mock, p, applied };
  }

  const withChanges = [...readdirSync(join(ROOT, "plan-fixtures")).map((d) => join(ROOT, "plan-fixtures", d)), join(ROOT, "fixtures", "value-mismatch"), join(ROOT, "fixtures", "missing-in-figma")];

  for (const fixture of withChanges) {
    it(`round trip through the real bridge: ${fixture.split("/").slice(-2).join("/")}`, async () => {
      const { dir, mock, p, applied } = await setUp(fixture);
      if (!applied.pending) return; // nothing to push for this fixture

      const pushed = (await runInFigma(pushScript(applied.figmaChanges), mock.figma)) as PushResult;
      expect(pushed.created.length).toBe(applied.figmaChanges.operations.filter((o) => o.op === "create-variable").length);

      // No second export: the engine predicts it, and the push's checksum confirms it.
      const committed = await commitFromPush(p, pushed);
      expect(committed.predictionMismatch).toBeUndefined();
      expect(committed.problems).toEqual([]);
      expect(committed.ok).toBe(true);
      const real = await exportFrom(mock.figma);
      expect(jsonChecksum(readFileSync(join(dir, "figma.json"), "utf8"))).toBe(real.checksum);

      const touched = new Set(p.actions.map((a) => a.token));
      const report = await check({ figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") });
      expect(report.findings.filter((f) => touched.has(f.token) && f.severity !== "warning")).toEqual([]);
    });
  }

  it("sets explicit scopes on created variables", async () => {
    const { mock, applied } = await setUp(join(ROOT, "plan-fixtures", "new-token-multi-mode"));
    await runInFigma(pushScript(applied.figmaChanges), mock.figma);
    const created = [...mock.variables.values()].find((v) => v.name === "color/muted")!;
    expect(created.scopes).toEqual(["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"]);
  });

  it("refuses a change set altered in transit", async () => {
    const { mock, applied } = await setUp(join(ROOT, "plan-fixtures", "prefer-code"));
    const tampered = pushScript(applied.figmaChanges).replace('"r":0.093799', '"r":0.093798');
    await expect(runInFigma(tampered, mock.figma)).rejects.toThrow(/altered in transit/);
  });

  it("refuses when Figma changed since the export, and changes nothing", async () => {
    const { mock, applied } = await setUp(join(ROOT, "plan-fixtures", "prefer-code"));
    mock.variables.get("V:2")!.name = "color/brand/renamed";
    const before = JSON.stringify([...mock.variables.values()]);
    await expect(runInFigma(pushScript(applied.figmaChanges), mock.figma)).rejects.toThrow(/changed since the export/);
    expect(JSON.stringify([...mock.variables.values()])).toBe(before);
  });

  it("validates every operation before changing anything", async () => {
    const { mock, applied } = await setUp(join(ROOT, "plan-fixtures", "prefer-code"));
    const bad: FigmaChangeSet = {
      ...applied.figmaChanges,
      operations: [...applied.figmaChanges.operations, { op: "set-value", variableId: "V:1", modeId: "nope", value: { type: "FLOAT", value: 1 } }],
    };
    const before = JSON.stringify([...mock.variables.values()]);
    await expect(runInFigma(pushScript(bad), mock.figma)).rejects.toThrow(/mode nope not in collection/);
    expect(JSON.stringify([...mock.variables.values()])).toBe(before);
  });
});

describe("token weight", () => {
  it("tpF32 gives the shortest decimal for the same float32", () => {
    expect(tpF32(Math.fround(0.223056))).toBe(0.223056);
    expect(tpF32(0.22305600345134735)).toBe(0.223056);
    expect(tpF32(16)).toBe(16);
    expect(tpF32(-0)).toBe(0);
    expect(Math.fround(tpF32(Math.fround(1 / 3)))).toBe(Math.fround(1 / 3));
  });

  it("answers `unchanged` with no data when Figma matches the saved export", async () => {
    const source = readJsonFile<Parameters<typeof mockFigma>[0]>(join(ROOT, "fixtures", "in-sync-no-lock", "figma.json"));
    const mock = mockFigma(source);
    const first = await exportFrom(mock.figma);
    const again = await exportFrom(mock.figma, first.checksum);
    expect(again).toEqual({ unchanged: true, checksum: first.checksum, warnings: [] });

    mock.variables.get("V:2")!.setValueForMode("1:0", 9);
    const changed = await exportFrom(mock.figma, first.checksum);
    expect(changed.unchanged).toBe(false);
    expect(changed.export).toBeDefined();
  });

  it("is much smaller than the full format", async () => {
    const source = readJsonFile<Parameters<typeof mockFigma>[0]>(join(ROOT, "fixtures", "in-sync-no-lock", "figma.json"));
    const compact = exportText(await exportFrom(mockFigma(source).figma));
    // What the previous plugin returned for the same Figma state: full ids, float32 noise, and an escaped string.
    const previous = JSON.stringify(expandCompactExport(JSON.parse(compact), "x.json"), (_, v) => (typeof v === "number" ? Math.fround(v) : v));
    const transferred = (s: string) => JSON.stringify(s).length;
    expect(compact.length).toBeLessThan(transferred(previous) * 0.6);
  });

  it("falls back cleanly when Figma's post-push state differs from the prediction", async () => {
    const dir = copyFixture(join(ROOT, "plan-fixtures", "prefer-code"));
    const mock = mockFigma(readJsonFile(join(dir, "figma.json")));
    writeFileSync(join(dir, "figma.json"), exportText(await exportFrom(mock.figma)));
    const p = await plan({ figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json"), prefer: "code", resolutionsPath: null, figmaCollection: null });
    const applied = await applyPlan(p, { allowDeletes: false });
    const pushed = (await runInFigma(pushScript(applied.figmaChanges), mock.figma)) as PushResult;

    const before = readFileSync(join(dir, "figma.json"), "utf8");
    const mismatch = await commitFromPush(p, { ...pushed, exportChecksum: "00000000000000" });
    expect(mismatch).toMatchObject({ ok: false, predictionMismatch: true });
    expect(readFileSync(join(dir, "figma.json"), "utf8")).toBe(before); // nothing written
    expect(existsSync(join(dir, ".token-parity", "pending.json"))).toBe(true);

    // The fallback: a real export, then a normal commit.
    writeFileSync(join(dir, "fresh.json"), exportText(await exportFrom(mock.figma)));
    expect((await commitPending(p, join(dir, "fresh.json"))).ok).toBe(true);
  });
});
