// Color math. Every conversion, distance, and gamut operation goes through culori.
import { converter, differenceEuclidean, parse, toGamut, type Color } from "culori";
import type { ColorProfile, OklchColor, Rgba, RgbColor } from "./types.js";

const toOklch = converter("oklch");
const toRgb = converter("rgb");
const toP3 = converter("p3");
const oklabDistance = differenceEuclidean("oklab");

/** Channel slack when testing gamut membership, to absorb float noise at the edges. */
const GAMUT_EPSILON = 1e-6;

const culoriMode = (profile: ColorProfile) => (profile === "srgb" ? "rgb" : "p3");

function round(value: number, places: number): number {
  const f = 10 ** places;
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function fromCulori(c: { l: number; c: number; h?: number | undefined; alpha?: number | undefined }): OklchColor {
  const h = c.h === undefined || Number.isNaN(c.h) ? null : c.h;
  return { space: "oklch", l: c.l, c: c.c, h, alpha: c.alpha ?? 1 };
}

function toCulori(c: OklchColor): Color {
  return { mode: "oklch", l: c.l, c: c.c, ...(c.h === null ? {} : { h: c.h }), alpha: c.alpha };
}

function rgbToCulori(c: RgbColor): Color {
  return { mode: culoriMode(c.space), r: c.r, g: c.g, b: c.b, alpha: c.alpha };
}

/** Parse an `oklch(...)` string. Returns undefined for any other syntax. */
export function parseOklch(raw: string): OklchColor | undefined {
  const parsed = parse(raw.trim());
  if (!parsed || parsed.mode !== "oklch") return undefined;
  return fromCulori(parsed);
}

/** Parse any CSS color and convert to OKLCH. `wasOklch` is false when the source used another syntax. */
export function parseCssColor(raw: string): { color: OklchColor; wasOklch: boolean } | undefined {
  const parsed = parse(raw.trim());
  if (!parsed) return undefined;
  if (parsed.mode === "oklch") return { color: fromCulori(parsed), wasOklch: true };
  return { color: fromCulori(toOklch(parsed)), wasOklch: false };
}

/** Convert Figma RGB (in its profile) to OKLCH, rounded to `precision` decimal places. */
export function rgbToOklch(rgb: RgbColor, precision: { l: number; c: number; h: number }): OklchColor {
  const o = toOklch(rgbToCulori(rgb));
  const c = round(o.c, precision.c);
  const h = o.h === undefined || Number.isNaN(o.h) || c === 0 ? null : round(o.h, precision.h) % 360;
  return { space: "oklch", l: round(o.l, precision.l), c, h, alpha: round(rgb.alpha, 4) };
}

/** ΔE_OK: Euclidean distance in OKLab. */
export function deltaEOK(a: OklchColor, b: OklchColor): number {
  return oklabDistance(toCulori(a), toCulori(b));
}

function toProfile(c: Color, profile: ColorProfile) {
  return profile === "srgb" ? toRgb(c) : toP3(c);
}

export function isInGamut(color: OklchColor, profile: ColorProfile): boolean {
  const { r, g, b } = toProfile(toCulori(color), profile);
  return [r, g, b].every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
}

/** Gamut-map an OKLCH color into the profile (culori toGamut, CSS Color 4 algorithm). Channels rounded to 6 places. */
export function toGamutRgb(color: OklchColor, profile: ColorProfile): Rgba {
  const mapped = toGamut(culoriMode(profile), "oklch")(toCulori(color));
  const clamp = (v: number) => round(Math.min(1, Math.max(0, v)), 6);
  return { r: clamp(mapped.r), g: clamp(mapped.g), b: clamp(mapped.b), a: round(color.alpha, 4) };
}

/** The OKLCH of an in-profile RGB value (unrounded). Used to compare gamut-mapped code colors. */
export function rgbaToOklch(rgba: Rgba, profile: ColorProfile): OklchColor {
  return fromCulori(toOklch({ mode: culoriMode(profile), r: rgba.r, g: rgba.g, b: rgba.b, alpha: rgba.a }));
}

/**
 * A 0-1 channel as a byte. Exactly-half values round up, like browsers (127.5 -> 128); the small bias absorbs
 * float noise from color conversions (127.4999999 is 127.5), far below any real 8-bit difference.
 */
export const toByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255 + 1e-7);

/**
 * A color as 8-bit sRGB, the way Figma shows it (#0000FF, opacity as a byte): [r, g, b, a], each 0-255.
 * Null when the color is outside sRGB, where no byte value represents it.
 */
export function srgbBytes(c: OklchColor | RgbColor): [number, number, number, number] | null {
  const s = c.space === "srgb" ? c : toRgb(c.space === "oklch" ? toCulori(c) : rgbToCulori(c));
  const channels = [s.r, s.g, s.b];
  if (!channels.every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON)) return null;
  const alpha = c.alpha ?? 1;
  return [toByte(channels[0]!), toByte(channels[1]!), toByte(channels[2]!), toByte(alpha)];
}

export const sameBytes = (a: readonly number[] | null, b: readonly number[] | null) => !!a && !!b && a.every((v, i) => v === b[i]);

/** Convert Display P3 channels to sRGB; null when the color is outside sRGB. */
export function toSrgb(c: RgbColor): RgbColor | null {
  const s = toRgb(rgbToCulori(c));
  const inside = [s.r, s.g, s.b].every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
  return inside ? { space: "srgb", r: s.r, g: s.g, b: s.b, alpha: c.alpha } : null;
}

/** True when every channel (and alpha) differs by at most `tolerance`. */
export function rgbClose(a: RgbColor, b: Rgba, tolerance: number): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance &&
    Math.abs(a.alpha - b.a) <= tolerance
  );
}

const trim = (n: number, places: number) => String(round(n, places));

/** Format as `oklch(L C H)` / `oklch(L C H / A)`. Defaults to enough precision to be lossless for authored values. */
export function formatOklch(c: OklchColor, precision = { l: 6, c: 6, h: 4 }, nullHue: "none" | "0" = "none"): string {
  const h = c.h === null ? nullHue : trim(c.h, precision.h);
  const alpha = c.alpha < 1 ? ` / ${trim(c.alpha, 4)}` : "";
  return `oklch(${trim(c.l, precision.l)} ${trim(c.c, precision.c)} ${h}${alpha})`;
}

/** Format Figma RGB as a CSS color() string in its profile, e.g. `color(srgb 0.2235 0.5059 0.9647)`. */
export function formatRgb(c: RgbColor): string {
  const ch = [c.r, c.g, c.b].map((v) => trim(v, 4)).join(" ");
  const alpha = c.alpha < 1 ? ` / ${trim(c.alpha, 4)}` : "";
  return `color(${c.space} ${ch}${alpha})`;
}
