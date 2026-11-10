import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFigmaExport } from "../src/adapters/figma.js";
import { readTailwindCss } from "../src/adapters/tailwind.js";
import { check } from "../src/check.js";
import * as color from "../src/color.js";
import { compare } from "../src/compare.js";
import { DEFAULT_SETTINGS, type LockFile } from "../src/types.js";
import { PERCEPTUAL } from "./helpers.js";

vi.mock("../src/color.js", { spy: true });

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string, lock = true) =>
  check({ settings: PERCEPTUAL,
    figmaPath: join(FIXTURES, name, "figma.json"),
    codePath: join(FIXTURES, name, "theme.css"),
    lockPath: lock ? join(FIXTURES, name, "tokens.lock.json") : null,
  });

beforeEach(() => {
  vi.mocked(color.rgbToOklch).mockClear();
});

describe("never re-derive OKLCH for an unchanged color", () => {
  it("does not convert RGB when Figma matches the lock", async () => {
    const report = await fixture("round-trip-unchanged");
    expect(report.findings).toEqual([]);
    expect(color.rgbToOklch).not.toHaveBeenCalled();
  });

  it("the same inputs without the lock do convert, and see the 8-bit rounding", async () => {
    const report = await fixture("round-trip-unchanged", false);
    expect(color.rgbToOklch).toHaveBeenCalled();
    expect(report.findings.map((f) => f.kind)).toContain("near-match");
    expect(report.findings.every((f) => f.severity !== "error")).toBe(true);
  });
});

describe("finding details", () => {
  it("conflict carries both sides, the converted Figma OKLCH and change flags", async () => {
    const [f] = (await fixture("conflict")).findings;
    expect(f).toMatchObject({
      kind: "conflict",
      changed: { figma: true, code: true },
      figma: { raw: "color(srgb 0.5333 0.2627 0.8588)", oklchSource: "converted" },
      code: { raw: "oklch(0.6 0.2 30)", oklchSource: "code" },
      lock: { oklch: "oklch(0.62 0.19 259.8)" },
    });
    expect(f!.distance).toBeGreaterThan(0.1);
  });

  it("out-of-gamut carries the gamut-mapped RGB", async () => {
    const [f] = (await fixture("out-of-gamut")).findings;
    expect(f!.gamut!.profile).toBe("display-p3");
    expect(f!.gamut!.mappedRgb.g).toBeCloseTo(0.78047, 5);
  });

  it("near-match reports the distance", async () => {
    const [f] = (await fixture("near-match", false)).findings;
    expect(f!.distance).toBeGreaterThan(0.0001);
    expect(f!.distance).toBeLessThan(0.005);
    expect(f!.figma!.oklchSource).toBe("converted");
  });

  it("reports deterministically", async () => {
    expect(JSON.stringify(await fixture("value-mismatch"))).toBe(JSON.stringify(await fixture("value-mismatch")));
  });
});

// ---- inline cases ---------------------------------------------------------------------------

const PRIM = { "VC:1": { id: "VC:1", name: "Primitives", modes: [{ modeId: "1:0", name: "Value" }], defaultModeId: "1:0" } };
const SEM = {
  "VC:2": {
    id: "VC:2",
    name: "Semantic",
    modes: [
      { modeId: "2:0", name: "Light" },
      { modeId: "2:1", name: "Dark" },
    ],
    defaultModeId: "2:0",
  },
};
const BLUE = { r: 0.223056, g: 0.505183, b: 0.964919, a: 1 };
const BLUE_Q = { r: 0.223529, g: 0.505882, b: 0.964706, a: 1 };

function run(variables: Record<string, unknown>, css: string, lock: LockFile | null = null, collections: object = { ...PRIM, ...SEM }, profile = "srgb") {
  const figma = readFigmaExport({ colorProfile: profile, variableCollections: collections, variables }, "figma.json");
  const code = readTailwindCss(css, "theme.css", DEFAULT_SETTINGS.modeMap);
  return compare({ figma, code, lock, settings: { ...DEFAULT_SETTINGS, ...PERCEPTUAL } });
}
const v = (id: string, name: string, collection: string, valuesByMode: object, resolvedType = "COLOR") => ({
  [id]: { id, name, resolvedType, variableCollectionId: collection, valuesByMode },
});
const kinds = (r: ReturnType<typeof run>) => r.findings.map((f) => `${f.kind}:${f.token}:${f.mode}:${f.suggestedDirection}`);

describe("three-way classification", () => {
  const lock: LockFile = {
    version: 1,
    figmaColorProfile: "srgb",
    tokens: { "color-a": { type: "color", modes: { default: { oklch: "oklch(0.62 0.19 259.8)", figmaRgb: BLUE_Q } } } },
  };

  it("Figma changed by less than the threshold is a near-match, not drift", () => {
    const nudged = { ...BLUE_Q, r: BLUE_Q.r + 2 / 255 };
    const r = run(v("V:1", "color/a", "VC:1", { "1:0": nudged }), "@theme { --color-a: oklch(0.62 0.19 259.8); }", lock);
    expect(kinds(r)).toEqual(["near-match:color-a:default:none"]);
  });

  it("Figma changed beyond the threshold -> figma-to-code", () => {
    const r = run(v("V:1", "color/a", "VC:1", { "1:0": { r: 0.9, g: 0.1, b: 0.1, a: 1 } }), "@theme { --color-a: oklch(0.62 0.19 259.8); }", lock);
    expect(kinds(r)).toEqual(["value-mismatch:color-a:default:figma-to-code"]);
  });

  it("an RGB lock recorded in another profile is unusable and flagged", () => {
    const r = run(v("V:1", "color/a", "VC:1", { "1:0": BLUE_Q }), "@theme { --color-a: oklch(0.62 0.19 259.8); }", lock, PRIM, "display-p3");
    expect(r.diagnostics).toEqual([expect.objectContaining({ level: "warning", origin: "lock" })]);
    expect(r.findings[0]!.changed.figma).toBe(true);
  });

  it("alias changes are three-way too", () => {
    const aliasLock: LockFile = {
      version: 1,
      figmaColorProfile: "srgb",
      tokens: { "color-b": { type: "color", modes: { default: { alias: "color-a" } } } },
    };
    // Figma retargets color-b from color-a (blue) to color-c (red): a real change, resolved by value.
    const RED = { r: 1, g: 0, b: 0, a: 1 };
    const vars = { ...v("V:1", "color/a", "VC:1", { "1:0": BLUE }), ...v("V:2", "color/c", "VC:1", { "1:0": RED }), ...v("V:3", "color/b", "VC:1", { "1:0": { type: "VARIABLE_ALIAS", id: "V:2" } }) };
    const css = "@theme { --color-a: oklch(0.62 0.19 259.8); --color-c: #ff0000; --color-b: var(--color-a); }";
    expect(kinds(run(vars, css, aliasLock))).toEqual(["value-mismatch:color-b:default:figma-to-code"]);
    // Retargeting to a variable with the same color is not a value change.
    const same = { ...vars, ...v("V:2", "color/c", "VC:1", { "1:0": BLUE }) };
    expect(kinds(run(same, "@theme { --color-a: oklch(0.62 0.19 259.8); --color-c: oklch(0.62 0.19 259.8); --color-b: var(--color-a); }", aliasLock))).toEqual([]);
  });
});

describe("modes", () => {
  it("a mode only in code is missing-mode toward Figma", () => {
    const vars = v("V:1", "color/bg", "VC:2", { "2:0": BLUE, "2:1": BLUE });
    const css = "@theme { --color-bg: oklch(0.62 0.19 259.8); } .dark { --color-bg: oklch(0.62 0.19 259.8); } @media (prefers-contrast: more) { :root { --color-bg: oklch(0 0 0); } }";
    const figma = readFigmaExport({ colorProfile: "srgb", variableCollections: SEM, variables: vars }, "f.json");
    const code = readTailwindCss(css, "t.css", { ...DEFAULT_SETTINGS.modeMap, contrast: ["@media (prefers-contrast: more)"] });
    const r = compare({ figma, code, lock: null, settings: { ...DEFAULT_SETTINGS, ...PERCEPTUAL } });
    expect(r.findings.map((f) => `${f.kind}:${f.mode}:${f.suggestedDirection}`)).toEqual(["missing-mode:contrast:code-to-figma"]);
  });

  it("a single-mode value is compared against every mode of the other side", () => {
    const vars = v("V:1", "color/bg", "VC:2", { "2:0": BLUE, "2:1": { r: 0, g: 0, b: 0, a: 1 } });
    expect(kinds(run(vars, "@theme { --color-bg: oklch(0.62 0.19 259.8); }"))).toEqual(["value-mismatch:color-bg:dark:needs-decision"]);
  });
});

describe("types and aliases", () => {
  it("a type difference is one whole-token value-mismatch", () => {
    const r = run(v("V:1", "font/body", "VC:1", { "1:0": "Inter" }, "STRING"), "@theme { --font-body: oklch(0.5 0.1 100); }");
    expect(kinds(r)).toEqual(["value-mismatch:font-body:null:needs-decision"]);
  });

  it("an alias resolving to the wrong type is broken", () => {
    const vars = { ...v("V:1", "spacing/4", "VC:1", { "1:0": 16 }, "FLOAT"), ...v("V:2", "color/x", "VC:1", { "1:0": { type: "VARIABLE_ALIAS", id: "V:1" } }) };
    const r = run(vars, "@theme { --spacing-4: 1rem; --color-x: oklch(0.5 0.1 100); }");
    expect(r.findings.map((f) => [f.kind, f.alias?.problem])).toEqual([["broken-alias", "type-mismatch"]]);
  });

  it("number vs dimension compares in px using remBase", () => {
    const r = run(v("V:1", "spacing/4", "VC:1", { "1:0": 16 }, "FLOAT"), "@theme { --spacing-4: 1rem; }");
    expect(r.findings).toEqual([]);
  });

  it("out-of-gamut code colors that exist only in code still warn", () => {
    const r = run({}, "@theme { --color-hot: oklch(0.7 0.35 145); }");
    expect(r.findings.map((f) => f.kind)).toEqual(["missing-in-figma", "out-of-gamut"]);
  });
});
