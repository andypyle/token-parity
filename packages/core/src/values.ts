// Converting a value from one side into the other side's representation, plus the lock entry that results.
// All color math goes through color.ts.
import * as color from "./color.js";
import type { ColorProfile, CompareSettings, FigmaValue, LockModeEntry, Rgba, TokenType, TokenValue } from "./types.js";

/** Lock text for a code color: the authored text when it is oklch(), otherwise a lossless OKLCH rendering. */
export function lockOklchText(v: Extract<TokenValue, { kind: "color" }>): string {
  if (color.parseOklch(v.raw)) return v.raw;
  const c = v.color.space === "oklch" ? v.color : color.rgbToOklch(v.color, { l: 8, c: 8, h: 6 });
  return color.formatOklch(c, { l: 8, c: 8, h: 6 });
}

export function figmaRgbOf(v: TokenValue): Rgba | null {
  if (v.kind !== "color" || v.color.space === "oklch") return null;
  return { r: v.color.r, g: v.color.g, b: v.color.b, a: v.color.alpha };
}

/** Lock entry describing two sides that agree (code text + Figma's current RGB). */
export function entryFromSides(figma: TokenValue, code: TokenValue): LockModeEntry | null {
  if (code.kind === "alias") return { alias: code.ref };
  if (code.kind === "color") {
    const rgb = figmaRgbOf(figma);
    return rgb ? { oklch: lockOklchText(code), figmaRgb: rgb } : null;
  }
  return { value: code.raw };
}

const NUM = (n: number) => String(Math.round(n * 1e4) / 1e4);
const DIMENSION_NAMESPACES = /^(spacing|radius|text|breakpoint|container|blur|inset)-/;

export type Converted<T> = { ok: true; value: T; lock: LockModeEntry; note?: string } | { ok: false; reason: string };

export type ColorFormat = "preserve" | "oklch" | "hex" | "rgb";
type Written = "oklch" | "hex" | "rgb";

/** The format a CSS color value is written in, or null for anything else (hsl, named colors, …). */
export function cssColorFormat(raw: string): Written | null {
  const t = raw.trim();
  if (/^oklch\(/i.test(t)) return "oklch";
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return "hex";
  if (/^rgba?\(/i.test(t)) return "rgb";
  return null;
}

/** The format a file mostly uses for its colors. Ties go to oklch, then hex, then rgb. */
export function majorityColorFormat(raws: Iterable<string>): Written {
  const counts: Record<Written, number> = { oklch: 0, hex: 0, rgb: 0 };
  for (const raw of raws) {
    const f = cssColorFormat(raw);
    if (f) counts[f]++;
  }
  const order: Written[] = ["oklch", "hex", "rgb"];
  return order.reduce((best, f) => (counts[f] > counts[best] ? f : best), "oklch");
}

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const alphaText = (a: number) => String(Math.round(a * 1000) / 1000);

/**
 * Write a Figma color as CSS in the requested format. `like` (the value being replaced) decides the style
 * details: hex case, and legacy `rgba(r, g, b, a)` vs modern `rgb(r g b / a)`. Hex and rgb() can only hold
 * sRGB, so a color outside sRGB is written as oklch() with a note.
 */
export function writeCssColor(
  rgb: { space: "srgb" | "display-p3"; r: number; g: number; b: number; alpha: number },
  format: Written,
  settings: Pick<CompareSettings, "precision">,
  like?: string,
): { text: string; note?: string } {
  const oklchText = () => color.formatOklch(color.rgbToOklch(rgb, settings.precision), settings.precision, "0");
  if (format === "oklch") return { text: oklchText() };

  const srgb = rgb.space === "srgb" ? rgb : color.toSrgb(rgb);
  if (!srgb) return { text: oklchText(), note: `outside sRGB, so written as oklch() instead of ${format}` };
  const [r, g, b] = [byte(srgb.r), byte(srgb.g), byte(srgb.b)];

  if (format === "hex") {
    const text = `#${hex2(r)}${hex2(g)}${hex2(b)}${srgb.alpha < 1 ? hex2(byte(srgb.alpha)) : ""}`;
    return { text: like && /^#[0-9A-F]+$/.test(like.trim()) && /[A-F]/.test(like) ? text.toUpperCase() : text };
  }
  const legacy = like ? /^rgba?\([^)]*,/i.test(like.trim()) : false;
  if (legacy) return { text: srgb.alpha < 1 ? `rgba(${r}, ${g}, ${b}, ${alphaText(srgb.alpha)})` : `rgb(${r}, ${g}, ${b})` };
  return { text: srgb.alpha < 1 ? `rgb(${r} ${g} ${b} / ${alphaText(srgb.alpha)})` : `rgb(${r} ${g} ${b})` };
}

/**
 * Figma value -> CSS text. `like` is the existing code value at the target, if any, whose unit is kept.
 */
/**
 * @param fileFormat the format the code file mostly uses, for `colorFormat: "preserve"` when nothing is replaced.
 */
export function codeTextFromFigma(
  fv: TokenValue,
  key: string,
  like: TokenValue | undefined,
  settings: CompareSettings,
  fileFormat: Written = "oklch",
): Converted<string> {
  switch (fv.kind) {
    case "alias":
      if (fv.ref.startsWith("figma-variable:")) return { ok: false, reason: "alias target is not in the Figma export" };
      return { ok: true, value: `var(--${fv.ref})`, lock: { alias: fv.ref } };
    case "color": {
      const rgb = figmaRgbOf(fv);
      if (!rgb || fv.color.space === "oklch") return { ok: false, reason: "not an RGB color" };
      const wanted = settings.colorFormat ?? "preserve";
      const format: Written = wanted === "preserve" ? ((like?.kind === "color" ? cssColorFormat(like.raw) : null) ?? fileFormat) : wanted;
      const written = writeCssColor(fv.color, format, settings, like?.kind === "color" ? like.raw : undefined);
      // The lock keeps OKLCH: the written text when it is oklch(), otherwise a lossless rendering of it.
      const parsed = color.parseCssColor(written.text)!;
      const lockText = parsed.wasOklch ? written.text : color.formatOklch(parsed.color, { l: 8, c: 8, h: 6 });
      return { ok: true, value: written.text, lock: { oklch: lockText, figmaRgb: rgb }, ...(written.note ? { note: written.note } : {}) };
    }
    case "number": {
      let text: string;
      if (like?.kind === "dimension" && (like.unit === "rem" || like.unit === "em")) text = `${NUM(fv.value / settings.remBase)}${like.unit}`;
      else if (like?.kind === "dimension" && like.unit === "px") text = `${NUM(fv.value)}px`;
      else if (like?.kind === "number") text = NUM(fv.value);
      else text = DIMENSION_NAMESPACES.test(key) ? `${NUM(fv.value)}px` : NUM(fv.value);
      return { ok: true, value: text, lock: { value: text } };
    }
    case "string":
      return { ok: true, value: fv.value, lock: { value: fv.value } };
    default:
      return { ok: false, reason: `${fv.kind} values cannot be written to CSS` };
  }
}

/** Code value -> Figma value for a variable of `figmaType`. Aliases are resolved by the caller. */
export function figmaValueFromCode(
  cv: TokenValue,
  figmaType: TokenType,
  profile: ColorProfile,
  settings: CompareSettings,
): Converted<FigmaValue> | { ok: true; alias: string } {
  if (cv.kind === "alias") return { ok: true, alias: cv.ref };
  if (cv.kind === "color") {
    if (figmaType !== "color") return { ok: false, reason: `Figma variable is ${figmaType}` };
    const c = cv.color.space === "oklch" ? cv.color : color.rgbaToOklch({ r: cv.color.r, g: cv.color.g, b: cv.color.b, a: cv.color.alpha }, cv.color.space);
    const rgb = color.toGamutRgb(c, profile);
    return { ok: true, value: { type: "COLOR", ...rgb }, lock: { oklch: lockOklchText(cv), figmaRgb: rgb } };
  }
  if (cv.kind === "number" || cv.kind === "dimension") {
    if (figmaType !== "number" && figmaType !== "dimension") return { ok: false, reason: `Figma variable is ${figmaType}` };
    if (cv.kind === "dimension" && cv.unit === "%") return { ok: false, reason: "percentages have no Figma number equivalent" };
    const px = cv.kind === "number" || cv.unit === "px" ? cv.value : cv.value * settings.remBase;
    return { ok: true, value: { type: "FLOAT", value: px }, lock: { value: cv.raw } };
  }
  if (cv.kind === "string") {
    if (figmaType !== "string") return { ok: false, reason: `Figma variable is ${figmaType}` };
    return { ok: true, value: { type: "STRING", value: cv.value }, lock: { value: cv.raw } };
  }
  return { ok: false, reason: "boolean values do not come from CSS" };
}

/** Figma's current value in change-set form, for the plan's `from`. */
export function figmaValueOf(v: TokenValue | undefined, variableIdByKey: (key: string) => string | undefined): FigmaValue | null {
  if (!v) return null;
  switch (v.kind) {
    case "color": {
      const rgb = figmaRgbOf(v);
      return rgb ? { type: "COLOR", ...rgb } : null;
    }
    case "number":
      return { type: "FLOAT", value: v.value };
    case "string":
      return { type: "STRING", value: v.value };
    case "boolean":
      return { type: "BOOLEAN", value: v.value };
    case "alias": {
      const id = variableIdByKey(v.ref);
      return id ? { type: "ALIAS", variableId: id } : null;
    }
    default:
      return null;
  }
}

export function resolvedTypeOf(type: TokenType): "COLOR" | "FLOAT" | "STRING" | "BOOLEAN" {
  return type === "color" ? "COLOR" : type === "string" ? "STRING" : type === "boolean" ? "BOOLEAN" : "FLOAT";
}
