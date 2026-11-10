// CSS color-mix() evaluation (CSS Color 5), for the spaces design tokens use: srgb, srgb-linear, oklab, oklch.
// Mixing is premultiplied by alpha, percentages are normalized, and a percentage sum under 100% scales the
// result's alpha. `color-mix(in srgb, X 50%, transparent)` is X at 50% alpha.
import { converter, type Color } from "culori";
import type { OklchColor } from "./types.js";

export type MixResult = { ok: true; color: OklchColor } | { ok: false; reason: string };
/** Resolves one operand (`#fff`, `var(--x)`, …) to a color, or explains why it can't. */
export type OperandResolver = (operand: string) => { ok: true; color: OklchColor } | { ok: false; reason: string };

const SPACES = { srgb: "rgb", "srgb-linear": "lrgb", oklab: "oklab", oklch: "oklch" } as const;
type Space = keyof typeof SPACES;
const toOklch = converter("oklch");

const HEAD = /^color-mix\(\s*in\s+([a-z0-9-]+)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?\s*,([\s\S]*)\)$/i;

export const isColorMix = (raw: string) => /^color-mix\(/i.test(raw.trim());

/** Split on commas that aren't inside parentheses. */
function topLevelArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

function splitPercent(arg: string): { color: string; pct: number | null } {
  const trailing = /^([\s\S]*?)\s+(-?\d*\.?\d+)%$/.exec(arg);
  if (trailing) return { color: trailing[1]!.trim(), pct: Number(trailing[2]) };
  const leading = /^(-?\d*\.?\d+)%\s+([\s\S]*)$/.exec(arg);
  if (leading) return { color: leading[2]!.trim(), pct: Number(leading[1]) };
  return { color: arg.trim(), pct: null };
}

const oklchToCulori = (c: OklchColor): Color => ({ mode: "oklch", l: c.l, c: c.c, ...(c.h === null ? {} : { h: c.h }), alpha: c.alpha });

export function evaluateColorMix(raw: string, resolve: OperandResolver): MixResult {
  const m = HEAD.exec(raw.trim());
  if (!m) return { ok: false, reason: "not a color-mix() this tool can read" };
  const space = m[1]!.toLowerCase() as Space;
  if (!(space in SPACES)) return { ok: false, reason: `"in ${m[1]}" isn't supported (srgb, srgb-linear, oklab, oklch are)` };
  const hueMethod = (m[2] ?? "shorter").toLowerCase();
  const args = topLevelArgs(m[3]!);
  if (args.length !== 2) return { ok: false, reason: "expected two colors" };

  const parts = args.map(splitPercent);
  const colors: OklchColor[] = [];
  for (const p of parts) {
    if (p.color.toLowerCase() === "transparent") {
      colors.push({ space: "oklch", l: 0, c: 0, h: null, alpha: 0 });
      continue;
    }
    const r = resolve(p.color);
    if (!r.ok) return r;
    colors.push(r.color);
  }

  let [p1, p2] = parts.map((p) => p.pct) as [number | null, number | null];
  if (p1 === null && p2 === null) [p1, p2] = [50, 50];
  else if (p1 === null) p1 = 100 - p2!;
  else if (p2 === null) p2 = 100 - p1;
  const sum = p1 + p2!;
  if (sum <= 0) return { ok: false, reason: "percentages add up to 0%" };
  const [w1, w2] = [p1 / sum, p2! / sum];
  const alphaScale = sum < 100 ? sum / 100 : 1;

  const [c1, c2] = colors as [OklchColor, OklchColor];
  const a1 = c1.alpha;
  const a2 = c2.alpha;
  const alpha = a1 * w1 + a2 * w2;

  let result: Color;
  if (space === "oklch") {
    // Polar: L and C premultiplied; hue interpolated directly, taking the other color's hue if one has none.
    const pm = (x: number, y: number) => (alpha === 0 ? 0 : (x * a1 * w1 + y * a2 * w2) / alpha);
    let h: number | undefined;
    if (c1.h === null || c1.alpha === 0) h = c2.h ?? undefined;
    else if (c2.h === null || c2.alpha === 0) h = c1.h;
    else {
      let [h1, h2] = [c1.h, c2.h];
      const d = h2 - h1;
      if (hueMethod === "shorter" && Math.abs(d) > 180) d > 0 ? (h1 += 360) : (h2 += 360);
      if (hueMethod === "longer" && Math.abs(d) < 180 && d !== 0) d > 0 ? (h1 += 360) : (h2 += 360);
      if (hueMethod === "increasing" && h2 < h1) h2 += 360;
      if (hueMethod === "decreasing" && h1 < h2) h1 += 360;
      h = (((h1 * w1 + h2 * w2) % 360) + 360) % 360;
    }
    result = { mode: "oklch", l: pm(c1.l, c2.l), c: pm(c1.c, c2.c), ...(h === undefined ? {} : { h }), alpha: alpha * alphaScale };
  } else {
    // Rectangular: every channel premultiplied.
    const mode = SPACES[space];
    const conv = converter(mode);
    const x = conv(oklchToCulori(c1)) as unknown as Record<string, number>;
    const y = conv(oklchToCulori(c2)) as unknown as Record<string, number>;
    const keys = mode === "oklab" ? ["l", "a", "b"] : ["r", "g", "b"];
    const mixed: Record<string, number> = {};
    for (const k of keys) mixed[k] = alpha === 0 ? 0 : (((x[k] ?? 0) * a1 * w1 + (y[k] ?? 0) * a2 * w2) / alpha);
    result = { mode, ...mixed, alpha: alpha * alphaScale } as unknown as Color;
  }

  const o = toOklch(result);
  return { ok: true, color: { space: "oklch", l: o.l, c: o.c, h: o.h === undefined || Number.isNaN(o.h) ? null : o.h, alpha: o.alpha ?? 1 } };
}
