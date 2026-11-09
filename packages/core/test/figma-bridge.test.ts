import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFigmaExport } from "../src/adapters/figma.js";
import { applyPlan } from "../src/apply.js";
import { check } from "../src/check.js";
import { commitPending } from "../src/commit.js";
import { tpChecksum } from "../src/figma-bridge.js";
import { exportScript, jsonChecksum, pushScript } from "../src/figma-script.js";
import { plan } from "../src/plan.js";
import type { FigmaChangeSet } from "../src/types.js";
import { copyFixture, readJsonFile } from "./helpers.js";
import { mockFigma, runInFigma } from "./mock-figma.js";

const ROOT = import.meta.dirname;
type ExportResult = { checksum: string; json: string; variables: number; collections: number; colorProfile: string; warnings: string[] };

async function exportFrom(figma: unknown): Promise<ExportResult> {
  return (await runInFigma(exportScript(), figma)) as ExportResult;
}

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

    expect(result.checksum).toBe(jsonChecksum(result.json));
    expect(result).toMatchObject({ variables: 6, collections: 2, colorProfile: "srgb", warnings: [] });
    const set = readFigmaExport(JSON.parse(result.json), "export.json");
    expect([...set.tokens.keys()].sort()).toEqual(["color-accent", "color-bg", "color-blue-500", "color-fg", "color-surface", "radius-md"]);
    expect(set.tokens.get("color-bg")!.source.figma!.scopes).toEqual(["ALL_SCOPES"]);
  });

  it("is deterministic and reflects the document color profile", async () => {
    const source = readJsonFile<Parameters<typeof mockFigma>[0]>(join(ROOT, "fixtures", "out-of-gamut", "figma.json"));
    const a = await exportFrom(mockFigma(source).figma);
    const b = await exportFrom(mockFigma(source).figma);
    expect(a.json).toBe(b.json);
    expect(a.colorProfile).toBe("display-p3");
    const legacy = await exportFrom(mockFigma(source, "LEGACY").figma);
    expect(legacy.colorProfile).toBe("srgb");
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
    writeFileSync(join(dir, "figma.json"), (await exportFrom(mock.figma)).json);
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

      const pushed = (await runInFigma(pushScript(applied.figmaChanges), mock.figma)) as { created: unknown[] };
      expect(pushed.created.length).toBe(applied.figmaChanges.operations.filter((o) => o.op === "create-variable").length);

      writeFileSync(join(dir, "figma-fresh.json"), (await exportFrom(mock.figma)).json);
      const committed = await commitPending(p, join(dir, "figma-fresh.json"));
      expect(committed.problems).toEqual([]);

      const touched = new Set(p.actions.map((a) => a.token));
      const report = await check({ figmaPath: join(dir, "figma-fresh.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") });
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
