import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plan } from "../src/plan.js";
import { DEFAULT_SETTINGS, type RgbColor } from "../src/types.js";
import { codeTextFromFigma, cssColorFormat, majorityColorFormat, writeCssColor } from "../src/values.js";

const P = { precision: DEFAULT_SETTINGS.precision };
const srgb = (r: number, g: number, b: number, alpha = 1): RgbColor => ({ space: "srgb", r, g, b, alpha });

describe("writeCssColor", () => {
  it("writes hex, keeping uppercase when the replaced value used it, with alpha as 8 digits", () => {
    expect(writeCssColor(srgb(0.534875, 0.2618, 0.860658), "hex", P).text).toBe("#8843db");
    expect(writeCssColor(srgb(0.534875, 0.2618, 0.860658), "hex", P, "#FAFAFA").text).toBe("#8843DB");
    expect(writeCssColor(srgb(1, 0, 0, 0.5), "hex", P).text).toBe("#ff000080");
  });

  it("writes rgb() in the replaced value's syntax: modern by default, legacy when it used commas", () => {
    expect(writeCssColor(srgb(0.0196, 0.0275, 0.0353), "rgb", P).text).toBe("rgb(5 7 9)");
    expect(writeCssColor(srgb(0.0196, 0.0275, 0.0353, 0.6), "rgb", P).text).toBe("rgb(5 7 9 / 0.6)");
    expect(writeCssColor(srgb(0.0196, 0.0275, 0.0353, 0.6), "rgb", P, "rgba(10, 10, 10, 0.5)").text).toBe("rgba(5, 7, 9, 0.6)");
    expect(writeCssColor(srgb(0.0196, 0.0275, 0.0353), "rgb", P, "rgb(1, 2, 3)").text).toBe("rgb(5, 7, 9)");
  });

  it("converts Display P3 to sRGB, and falls back to oklch() with a note outside sRGB", () => {
    const inside: RgbColor = { space: "display-p3", r: 0.298242, g: 0.498827, b: 0.933858, alpha: 1 };
    expect(writeCssColor(inside, "hex", P)).toEqual({ text: "#3981f6" }); // = srgb(0.223, 0.505, 0.965)
    const vivid: RgbColor = { space: "display-p3", r: 0, g: 0.78047, b: 0, alpha: 1 };
    const out = writeCssColor(vivid, "hex", P);
    expect(out.text).toMatch(/^oklch\(/);
    expect(out.note).toBe("outside sRGB, so written as oklch() instead of hex");
  });
});

describe("format detection", () => {
  it("recognizes formats and picks the file's majority, ties going to oklch, then hex", () => {
    expect(cssColorFormat("#abc")).toBe("hex");
    expect(cssColorFormat("RGBA(1, 2, 3, 0.5)")).toBe("rgb");
    expect(cssColorFormat("oklch(0.5 0.1 200)")).toBe("oklch");
    expect(cssColorFormat("hsl(10 50% 50%)")).toBeNull();
    expect(majorityColorFormat(["#fff", "#000", "rgb(1 2 3)"])).toBe("hex");
    expect(majorityColorFormat(["#fff", "oklch(0.5 0 0)"])).toBe("oklch");
    expect(majorityColorFormat(["#fff", "rgb(1 2 3)"])).toBe("hex");
    expect(majorityColorFormat([])).toBe("oklch");
  });
});

describe("codeTextFromFigma with colorFormat", () => {
  const fv = { kind: "color" as const, color: srgb(0.534875, 0.2618, 0.860658), raw: "" };
  const like = { kind: "color" as const, color: { space: "oklch" as const, l: 0.5, c: 0.1, h: 10, alpha: 1 }, raw: "#ffffff" };

  it("preserve: follows the replaced value, else the file's format", () => {
    expect(codeTextFromFigma(fv, "k", like, DEFAULT_SETTINGS)).toMatchObject({ value: "#8843db" });
    expect(codeTextFromFigma(fv, "k", undefined, DEFAULT_SETTINGS, "rgb")).toMatchObject({ value: "rgb(136 67 219)" });
    expect(codeTextFromFigma(fv, "k", undefined, DEFAULT_SETTINGS)).toMatchObject({ value: "oklch(0.55 0.22 300)" });
  });

  it("an explicit format wins over the replaced value", () => {
    expect(codeTextFromFigma(fv, "k", like, { ...DEFAULT_SETTINGS, colorFormat: "oklch" })).toMatchObject({ value: "oklch(0.55 0.22 300)" });
    expect(codeTextFromFigma(fv, "k", like, { ...DEFAULT_SETTINGS, colorFormat: "rgb" })).toMatchObject({ value: "rgb(136 67 219)" });
  });

  it("keeps OKLCH in the lock whatever is written", () => {
    const r = codeTextFromFigma(fv, "k", like, DEFAULT_SETTINGS);
    expect(r.ok && "oklch" in r.lock && r.lock.oklch).toMatch(/^oklch\(/);
  });
});

describe("plan with colorFormat", () => {
  const dir = join(import.meta.dirname, "plan-fixtures", "color-format-preserve");
  const run = (colorFormat?: "oklch" | "hex" | "rgb") =>
    plan({
      figmaPath: join(dir, "figma.json"),
      codePath: join(dir, "theme.css"),
      lockPath: join(dir, "none.lock.json"),
      prefer: "figma",
      resolutionsPath: null,
      figmaCollection: null,
      ...(colorFormat ? { settings: { colorFormat } } : {}),
    });
  const written = async (colorFormat?: "oklch" | "hex" | "rgb") =>
    Object.fromEntries((await run(colorFormat)).actions.map((a) => [a.token, a.op === "update-code" ? a.to : a.op === "add-code" ? a.values.theme : null]));

  it("oklch everywhere", async () => {
    expect(await written("oklch")).toEqual({
      "color-bg": "oklch(0.21 0.006 285.9)",
      "color-brand": "oklch(0.55 0.22 300)",
      "color-new": "oklch(0.985 0 0)",
      "color-overlay": expect.stringMatching(/^oklch\(.* \/ 0\.6\)$/),
    });
  });

  it("rgb everywhere, in the replaced value's syntax", async () => {
    expect(await written("rgb")).toEqual({
      "color-bg": "rgb(24 24 27)",
      "color-brand": "rgb(136 67 219)",
      "color-new": "rgb(250 250 250)",
      "color-overlay": "rgba(5, 7, 9, 0.6)",
    });
  });
});
