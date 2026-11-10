// Values code computes rather than declares. Tailwind v4 has one `--spacing` and derives every step from it, so
// Figma variables carry codeSyntax like `calc(var(--ds-spacing) * 4)`. Those are evaluated against code's
// `--spacing` and compared like any token. Computed values have no declaration to edit, so plan never writes them.
import { DEFAULT_MODE, type Diagnostic, type NormalizedToken, type TokenSet, type TokenValue } from "./types.js";

const CALC_RE =
  /^calc\(\s*(?:var\(\s*--([A-Za-z0-9_-]+)\s*\)\s*\*\s*(-?\d*\.?\d+)|(-?\d*\.?\d+)\s*\*\s*var\(\s*--([A-Za-z0-9_-]+)\s*\))\s*\)$/;

/** `calc(var(--x) * n)` or `calc(n * var(--x))` -> { name: "x", factor: n }. */
export function parseCalcMultiple(raw: string): { name: string; factor: number } | null {
  const m = CALC_RE.exec(raw.trim());
  if (!m) return null;
  return m[1] ? { name: m[1], factor: Number(m[2]) } : { name: m[4]!, factor: Number(m[3]) };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Add a computed code token for each Figma variable whose codeSyntax multiplies a code variable, when code has no
 * token of that name. Returns an info diagnostic with the count.
 */
export function deriveComputedTokens(figma: TokenSet, code: TokenSet): Diagnostic[] {
  const prefix = code.tailwindPrefix;
  let count = 0;
  for (const f of figma.tokens.values()) {
    const calc = f.source.figma?.codeSyntax ? parseCalcMultiple(f.source.figma.codeSyntax) : null;
    if (!calc || code.tokens.has(f.key)) continue;
    const baseName = prefix && calc.name.startsWith(`${prefix}-`) ? calc.name.slice(prefix.length + 1) : calc.name;
    const base = code.tokens.get(baseName);
    const baseValue = base?.values[DEFAULT_MODE];
    if (!base || !baseValue || (baseValue.kind !== "dimension" && baseValue.kind !== "number")) continue;

    const value: TokenValue =
      baseValue.kind === "dimension"
        ? { kind: "dimension", value: round(baseValue.value * calc.factor), unit: baseValue.unit, raw: `${round(baseValue.value * calc.factor)}${baseValue.unit}` }
        : { kind: "number", value: round(baseValue.value * calc.factor), raw: String(round(baseValue.value * calc.factor)) };
    const token: NormalizedToken = {
      key: f.key,
      type: base.type,
      modes: [DEFAULT_MODE],
      values: { [DEFAULT_MODE]: value },
      source: {
        origin: "code",
        code: { ...base.source.code!, cssVar: `--${f.key}`, selector: `calc(var(--${baseName}) * ${calc.factor})`, modes: {}, derivedFrom: baseName },
      },
    };
    code.tokens.set(f.key, token);
    count++;
  }
  return count > 0
    ? [{ level: "info", origin: "code", message: `${count} Figma variable${count === 1 ? " is" : "s are"} checked against values code computes (calc(var(--x) * n)).` }]
    : [];
}
