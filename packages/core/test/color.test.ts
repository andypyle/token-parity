import { describe, expect, it } from "vitest";
import {
  deltaEOK,
  formatOklch,
  isInGamut,
  parseCssColor,
  parseOklch,
  rgbClose,
  rgbToOklch,
  toGamutRgb,
} from "../src/color.js";
import type { OklchColor, RgbColor } from "../src/types.js";

const P = { l: 4, c: 4, h: 2 };
const blue = parseOklch("oklch(0.62 0.19 259.8)")!;

describe("parseOklch / parseCssColor", () => {
  it("parses number and percent lightness", () => {
    expect(parseOklch("oklch(62% 0.19 259.8)")).toEqual({ space: "oklch", l: 0.62, c: 0.19, h: 259.8, alpha: 1 });
    expect(blue).toEqual({ space: "oklch", l: 0.62, c: 0.19, h: 259.8, alpha: 1 });
  });

  it("keeps alpha and treats achromatic hue as null", () => {
    expect(parseOklch("oklch(0.5 0 none / 0.5)")).toEqual({ space: "oklch", l: 0.5, c: 0, h: null, alpha: 0.5 });
  });

  it("returns undefined for non-oklch input", () => {
    expect(parseOklch("#ff0000")).toBeUndefined();
    expect(parseOklch("Inter, sans-serif")).toBeUndefined();
  });

  it("parseCssColor converts other syntaxes and flags them", () => {
    const red = parseCssColor("#ff0000");
    expect(red?.wasOklch).toBe(false);
    expect(red?.color.l).toBeCloseTo(0.628, 3);
    expect(parseCssColor("oklch(0.62 0.19 259.8)")?.wasOklch).toBe(true);
    expect(parseCssColor("bold")).toBeUndefined();
  });
});

describe("rgbToOklch", () => {
  it("round-trips an exact sRGB conversion to the authored OKLCH, rounded", () => {
    const rgb: RgbColor = { space: "srgb", r: 0.223056, g: 0.505183, b: 0.964919, alpha: 1 };
    expect(rgbToOklch(rgb, P)).toEqual({ space: "oklch", l: 0.62, c: 0.19, h: 259.8, alpha: 1 });
  });

  it("interprets channels in the file's profile", () => {
    const p3: RgbColor = { space: "display-p3", r: 0.298242, g: 0.498827, b: 0.933858, alpha: 1 };
    expect(rgbToOklch(p3, P)).toEqual({ space: "oklch", l: 0.62, c: 0.19, h: 259.8, alpha: 1 });
  });

  it("returns a null hue for greys", () => {
    expect(rgbToOklch({ space: "srgb", r: 0.5, g: 0.5, b: 0.5, alpha: 1 }, P).h).toBeNull();
  });
});

describe("deltaEOK", () => {
  it("is zero for identical colors and small for hex quantization", () => {
    expect(deltaEOK(blue, blue)).toBe(0);
    const quantized = rgbToOklch({ space: "srgb", r: 57 / 255, g: 129 / 255, b: 246 / 255, alpha: 1 }, { l: 8, c: 8, h: 8 });
    const d = deltaEOK(blue, quantized);
    expect(d).toBeGreaterThan(1e-4);
    expect(d).toBeLessThan(0.005);
  });
});

describe("gamut", () => {
  const vivid = parseOklch("oklch(0.7 0.35 145)")!;
  it("detects out-of-gamut colors per profile", () => {
    expect(isInGamut(blue, "srgb")).toBe(true);
    expect(isInGamut(vivid, "display-p3")).toBe(false);
    expect(isInGamut(parseOklch("oklch(1 0 0)")!, "srgb")).toBe(true);
    expect(isInGamut(parseOklch("oklch(0.65 0.19 259.8)")!, "srgb")).toBe(false);
    expect(isInGamut(parseOklch("oklch(0.65 0.19 259.8)")!, "display-p3")).toBe(true);
  });

  it("maps into gamut with culori toGamut", () => {
    const mapped = toGamutRgb(vivid, "display-p3");
    expect(mapped.r).toBeCloseTo(0, 6);
    expect(mapped.g).toBeCloseTo(0.78047, 5);
    expect(mapped.b).toBeCloseTo(0, 6);
    expect(mapped.a).toBe(1);
  });
});

describe("rgbClose", () => {
  it("uses a per-channel tolerance", () => {
    const a: RgbColor = { space: "srgb", r: 0.2235294133424759, g: 0.5, b: 0.5, alpha: 1 };
    expect(rgbClose(a, { r: 0.223529, g: 0.5, b: 0.5, a: 1 }, 0.5 / 255)).toBe(true);
    expect(rgbClose(a, { r: 0.23, g: 0.5, b: 0.5, a: 1 }, 0.5 / 255)).toBe(false);
    expect(rgbClose(a, { r: 0.223529, g: 0.5, b: 0.5, a: 0.5 }, 0.5 / 255)).toBe(false);
  });
});

describe("formatOklch", () => {
  it("formats compactly, with none for null hue and alpha only when < 1", () => {
    expect(formatOklch(blue)).toBe("oklch(0.62 0.19 259.8)");
    const grey: OklchColor = { space: "oklch", l: 0.5, c: 0, h: null, alpha: 0.5 };
    expect(formatOklch(grey)).toBe("oklch(0.5 0 none / 0.5)");
  });
});
