import { describe, expect, it } from "vitest";
import { figmaNameToKey, readFigmaExport } from "../src/adapters/figma.js";
import { readTailwindCss } from "../src/adapters/tailwind.js";
import { InputError } from "../src/errors.js";
import { DEFAULT_SETTINGS } from "../src/types.js";

const modeMap = DEFAULT_SETTINGS.modeMap;

describe("figma adapter", () => {
  const exportJson = {
    colorProfile: "display-p3",
    variableCollections: {
      "VC:1": { id: "VC:1", name: "Primitives", modes: [{ modeId: "1:0", name: "Value" }], defaultModeId: "1:0" },
      "VC:2": {
        id: "VC:2",
        name: "Semantic",
        modes: [
          { modeId: "2:1", name: "Dark Mode" },
          { modeId: "2:0", name: "Light" },
        ],
        defaultModeId: "2:0",
      },
    },
    variables: {
      "V:1": { id: "V:1", name: "color/Blue/500", resolvedType: "COLOR", variableCollectionId: "VC:1", valuesByMode: { "1:0": { r: 0.1, g: 0.2, b: 0.3, a: 1 } } },
      "V:2": { id: "V:2", name: "spacing/4", resolvedType: "FLOAT", variableCollectionId: "VC:1", valuesByMode: { "1:0": 16 } },
      "V:3": {
        id: "V:3",
        name: "color/accent",
        resolvedType: "COLOR",
        variableCollectionId: "VC:2",
        valuesByMode: { "2:0": { type: "VARIABLE_ALIAS", id: "V:1" }, "2:1": { type: "VARIABLE_ALIAS", id: "V:404" } },
      },
      "V:4": { id: "V:4", name: "font/body", resolvedType: "STRING", variableCollectionId: "VC:1", valuesByMode: { "1:0": "Inter" } },
      "V:5": { id: "V:5", name: "feature/rounded", resolvedType: "BOOLEAN", variableCollectionId: "VC:1", valuesByMode: { "1:0": true } },
    },
  };

  const set = readFigmaExport(exportJson, "figma.json");

  it("maps names to kebab keys", () => {
    expect(figmaNameToKey("color/brand/primary")).toBe("color-brand-primary");
    expect(figmaNameToKey("Color / Brand Primary")).toBe("color-brand-primary");
    expect([...set.tokens.keys()].sort()).toEqual(["color-accent", "color-blue-500", "feature-rounded", "font-body", "spacing-4"]);
  });

  it("keeps colors as RGB in the file profile", () => {
    const t = set.tokens.get("color-blue-500")!;
    expect(set.colorProfile).toBe("display-p3");
    expect(t.type).toBe("color");
    expect(t.modes).toEqual(["default"]);
    expect(t.values.default).toMatchObject({ kind: "color", color: { space: "display-p3", r: 0.1, g: 0.2, b: 0.3, alpha: 1 } });
  });

  it("puts the collection default mode first and normalizes mode names", () => {
    const t = set.tokens.get("color-accent")!;
    expect(t.modes).toEqual(["light", "dark-mode"]);
    expect(t.values.light).toMatchObject({ kind: "alias", ref: "color-blue-500" });
  });

  it("keeps aliases to unknown variables so compare can flag them", () => {
    const v = set.tokens.get("color-accent")!.values["dark-mode"]!;
    expect(v.kind).toBe("alias");
    expect(set.tokens.has(v.kind === "alias" ? v.ref : "")).toBe(false);
  });

  it("maps FLOAT, STRING and BOOLEAN", () => {
    expect(set.tokens.get("spacing-4")!.values.default).toMatchObject({ kind: "number", value: 16 });
    expect(set.tokens.get("font-body")!.values.default).toMatchObject({ kind: "string", value: "Inter" });
    expect(set.tokens.get("feature-rounded")!.values.default).toMatchObject({ kind: "boolean", value: true });
  });

  it("records the source location", () => {
    expect(set.tokens.get("spacing-4")!.source.figma).toEqual({ variableId: "V:2", name: "spacing/4", collection: "Primitives", collectionId: "VC:1", modeIds: { default: "1:0" } });
  });

  it("warns when the color profile is missing and defaults to sRGB", () => {
    const s = readFigmaExport({ variableCollections: {}, variables: {} }, "f.json");
    expect(s.colorProfile).toBe("srgb");
    expect(s.diagnostics).toEqual([expect.objectContaining({ level: "warning", origin: "figma" })]);
  });

  it("reports duplicate keys", () => {
    const s = readFigmaExport(
      {
        colorProfile: "srgb",
        variableCollections: exportJson.variableCollections,
        variables: {
          a: { id: "a", name: "color/x", resolvedType: "FLOAT", variableCollectionId: "VC:1", valuesByMode: { "1:0": 1 } },
          b: { id: "b", name: "color x", resolvedType: "FLOAT", variableCollectionId: "VC:1", valuesByMode: { "1:0": 2 } },
        },
      },
      "f.json",
    );
    expect(s.tokens.size).toBe(1);
    expect(s.diagnostics.some((d) => d.level === "error" && d.token === "color-x")).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(() => readFigmaExport({ variables: [] }, "f.json")).toThrow(InputError);
    expect(() => readFigmaExport(null, "f.json")).toThrow(InputError);
  });
});

describe("tailwind adapter", () => {
  const css = `
@import "tailwindcss";
@theme {
  --color-blue-500: oklch(0.62 0.19 259.8);
  --color-red: #ff0000;
  --spacing-4: 1rem;
  --opacity-half: 0.5;
  --font-sans: "Inter", sans-serif;
  --color-bg: oklch(0.985 0 0);
  --color-fg: oklch(0.21 0.006 285.9);
  --color-accent: var(--color-blue-500);
  --color-ghost: var(--color-missing);
}
@theme inline {
  --color-surface: var(--surface);
}
:root { --surface: oklch(1 0 0); }
.dark { --color-bg: oklch(0.2 0 0); --surface: oklch(0.3 0 0); }
[data-theme=dark] { --color-fg: oklch(0.9 0 0); }
@variant dark { :root { --color-blue-500: oklch(0.7 0.15 259.8); } }
.card { --color-bg: red; }
`;
  const set = readTailwindCss(css, "theme.css", modeMap);

  it("reads @theme variables as tokens keyed without the leading dashes", () => {
    expect(set.tokens.has("color-blue-500")).toBe(true);
    expect(set.tokens.has("surface")).toBe(false);
    expect(set.tokens.get("spacing-4")!.values.default).toMatchObject({ kind: "dimension", value: 1, unit: "rem" });
    expect(set.tokens.get("opacity-half")!.values.default).toMatchObject({ kind: "number", value: 0.5 });
    expect(set.tokens.get("font-sans")!).toMatchObject({ type: "string" });
  });

  it("parses oklch colors and flags non-OKLCH syntax", () => {
    expect(set.tokens.get("color-blue-500")!.values.default).toMatchObject({
      kind: "color",
      color: { space: "oklch", l: 0.62, c: 0.19, h: 259.8 },
      raw: "oklch(0.62 0.19 259.8)",
    });
    expect(set.tokens.get("color-red")!.type).toBe("color");
    expect(set.diagnostics.some((d) => d.token === "color-red" && d.level === "warning")).toBe(true);
  });

  it("collects mode overrides from .dark, [data-theme=dark] and @variant dark", () => {
    expect(set.tokens.get("color-bg")!.modes).toEqual(["default", "dark"]);
    expect(set.tokens.get("color-bg")!.values.dark).toMatchObject({ raw: "oklch(0.2 0 0)" });
    expect(set.tokens.get("color-fg")!.values.dark).toMatchObject({ raw: "oklch(0.9 0 0)" });
    expect(set.tokens.get("color-blue-500")!.values.dark).toMatchObject({ raw: "oklch(0.7 0.15 259.8)" });
  });

  it("ignores variables scoped to other selectors", () => {
    expect(set.tokens.get("color-bg")!.values.default).toMatchObject({ raw: "oklch(0.985 0 0)" });
  });

  it("turns var() references to theme variables into aliases, with types from the target", () => {
    const t = set.tokens.get("color-accent")!;
    expect(t.values.default).toMatchObject({ kind: "alias", ref: "color-blue-500" });
    expect(t.type).toBe("color");
    expect(set.tokens.get("color-ghost")!).toMatchObject({ type: "color", values: { default: { kind: "alias", ref: "color-missing" } } });
  });

  it("inlines pass-through variables defined in :root and mode selectors", () => {
    const t = set.tokens.get("color-surface")!;
    expect(t.modes).toEqual(["default", "dark"]);
    expect(t.values.default).toMatchObject({ kind: "color", raw: "oklch(1 0 0)" });
    expect(t.values.dark).toMatchObject({ kind: "color", raw: "oklch(0.3 0 0)" });
  });

  it("records source line and selector", () => {
    expect(set.tokens.get("color-blue-500")!.source.code).toMatchObject({ cssVar: "--color-blue-500", file: "theme.css", line: 4, selector: "@theme" });
  });

  it("throws InputError on unparseable CSS", () => {
    expect(() => readTailwindCss("@theme { --a: 1", "bad.css", modeMap)).toThrow(InputError);
  });
});
