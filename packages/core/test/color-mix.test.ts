import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTailwindCss } from "../src/adapters/tailwind.js";
import { check } from "../src/check.js";
import { parseCssColor, srgbBytes } from "../src/color.js";
import { evaluateColorMix } from "../src/color-mix.js";
import { plan } from "../src/plan.js";
import { DEFAULT_SETTINGS } from "../src/types.js";
import { writeJson } from "./helpers.js";

const literal = (text: string) => {
  const c = parseCssColor(text);
  return c ? { ok: true as const, color: c.color } : { ok: false as const, reason: `bad ${text}` };
};
const bytes = (raw: string) => {
  const r = evaluateColorMix(raw, literal);
  if (!r.ok) throw new Error(r.reason);
  return srgbBytes(r.color);
};

describe("evaluateColorMix", () => {
  it("mixes with transparent as the color at that alpha", () => {
    expect(bytes("color-mix(in srgb, #1a1f24 50%, transparent)")).toEqual([26, 31, 36, 128]);
    expect(bytes("color-mix(in srgb, #050709 60%, transparent)")).toEqual([5, 7, 9, 153]);
    expect(bytes("color-mix(in oklch, #050709 60%, transparent)")).toEqual([5, 7, 9, 153]);
  });

  it("mixes two colors, normalizing percentages", () => {
    expect(bytes("color-mix(in srgb, #ff0000, #0000ff)")).toEqual([128, 0, 128, 255]);
    expect(bytes("color-mix(in srgb, #ff0000 25%, #0000ff)")).toEqual([64, 0, 191, 255]);
    expect(bytes("color-mix(in srgb, 25% #ff0000, #0000ff 75%)")).toEqual([64, 0, 191, 255]);
    expect(bytes("color-mix(in srgb, #ff0000 20%, #0000ff 20%)")).toEqual([128, 0, 128, 102]); // sum 40%: alpha 0.4
  });

  it("interpolates oklch hue the shorter way", () => {
    const r = evaluateColorMix("color-mix(in oklch, oklch(0.6 0.2 350), oklch(0.6 0.2 30))", literal);
    expect(r.ok && Math.round(r.color.h!)).toBe(10);
  });

  it("explains what it can't evaluate", () => {
    expect(evaluateColorMix("color-mix(in hsl, red, blue)", literal)).toEqual({ ok: false, reason: '"in hsl" isn\'t supported (srgb, srgb-linear, oklab, oklch are)' });
    expect(evaluateColorMix("color-mix(in srgb, red, blue, green)", literal)).toMatchObject({ ok: false, reason: "expected two colors" });
  });
});

describe("color-mix() in code (an overlay)", () => {
  const css = `@import "tailwindcss" prefix(ds);
@theme {
  --color-gray-900: #1a1f24;
  --color-black: #050709;
  --color-overlay: color-mix(in srgb, var(--ds-color-gray-900) 50%, transparent);
  --color-odd: color-mix(in hsl, var(--ds-color-gray-900), white);
}
[data-theme="dark"] {
  --ds-color-overlay: color-mix(
    in srgb,
    var(--ds-color-black) 60%,
    transparent
  );
}
`;

  it("evaluates per mode, resolving var() operands in that mode", () => {
    const set = readTailwindCss(css, "t.css", DEFAULT_SETTINGS.modeMap);
    const overlay = set.tokens.get("color-overlay")!;
    expect(overlay.type).toBe("color");
    expect(overlay.values.default!.kind === "color" && srgbBytes(overlay.values.default!.color)).toEqual([26, 31, 36, 128]);
    expect(overlay.values.dark!.kind === "color" && srgbBytes(overlay.values.dark!.color)).toEqual([5, 7, 9, 153]);
    expect(set.diagnostics).toContainEqual(expect.objectContaining({ level: "warning", token: "color-odd", message: expect.stringContaining('Can\'t evaluate color-mix(in hsl') }));
    expect(set.tokens.get("color-odd")!.type).toBe("color");
  });

  function project() {
    const dir = mkdtempSync(join(tmpdir(), "tp-mix-"));
    writeFileSync(join(dir, "theme.css"), css);
    writeJson(join(dir, "figma.json"), {
      colorProfile: "srgb",
      variableCollections: {
        P: { id: "P", name: "Primitives", modes: [{ modeId: "p", name: "Value" }], defaultModeId: "p" },
        C: { id: "C", name: "Color", modes: [{ modeId: "l", name: "Light" }, { modeId: "k", name: "Dark" }], defaultModeId: "l" },
      },
      variables: {
        V1: { id: "V1", name: "gray/900", resolvedType: "COLOR", variableCollectionId: "P", codeSyntax: { WEB: "var(--ds-color-gray-900)" }, valuesByMode: { p: { r: 26 / 255, g: 31 / 255, b: 36 / 255, a: 1 } } },
        V2: { id: "V2", name: "black", resolvedType: "COLOR", variableCollectionId: "P", codeSyntax: { WEB: "var(--ds-color-black)" }, valuesByMode: { p: { r: 5 / 255, g: 7 / 255, b: 9 / 255, a: 1 } } },
        V3: { id: "V3", name: "overlay/light", resolvedType: "COLOR", variableCollectionId: "P", valuesByMode: { p: { r: 26 / 255, g: 31 / 255, b: 36 / 255, a: 0.5 } } },
        V4: { id: "V4", name: "overlay/dark", resolvedType: "COLOR", variableCollectionId: "P", valuesByMode: { p: { r: 5 / 255, g: 7 / 255, b: 9 / 255, a: 0.6 } } },
        V5: { id: "V5", name: "overlay", resolvedType: "COLOR", variableCollectionId: "C", codeSyntax: { WEB: "var(--ds-color-overlay)" }, valuesByMode: { l: { type: "VARIABLE_ALIAS", id: "V3" }, k: { type: "VARIABLE_ALIAS", id: "V4" } } },
      },
    });
    return { figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json"), settings: { ignore: ["overlay/*", "color-odd"] } };
  }

  it("compares exactly against Figma, with no type or format mismatch", async () => {
    const report = await check(project());
    expect(report.findings).toEqual([]);
  });

  it("won't overwrite a color-mix() with a literal", async () => {
    const inputs = project();
    const figma = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(inputs.figmaPath, "utf8")));
    figma.variables.V4.valuesByMode.p.a = 0.7;
    writeJson(inputs.figmaPath, figma);
    const p = await plan({ ...inputs, prefer: "figma", resolutionsPath: null, figmaCollection: null });
    expect(p.unresolved).toEqual([expect.objectContaining({ token: "color-overlay", mode: "dark", reason: "computed-in-code" })]);
  });
});

describe("color-mix() input bound", () => {
  it("refuses pathological input instead of parsing it", () => {
    expect(evaluateColorMix(`color-mix(in srgb, ${" ".repeat(5000)}red 50%, blue)`, literal)).toEqual({ ok: false, reason: "too long to evaluate" });
  });
});
