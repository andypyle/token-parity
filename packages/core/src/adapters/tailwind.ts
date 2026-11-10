// Tailwind v4 adapter: @theme CSS custom properties -> TokenSet.
//
// - Variables declared inside `@theme` (any params, e.g. `@theme inline`) are tokens; the key is the
//   name without its leading `--`. Their @theme value is the default mode.
// - Declarations of the same name inside a selector or at-rule listed in `modeMap` are that mode's value.
// - Pass-through: `--color-x: var(--x)` in @theme where `--x` is not a theme variable but is defined in
//   `:root` (default) and/or mode selectors is inlined, so the shadcn-style pattern compares by value.
// - Variables in any other scope (component selectors, etc.) are ignored.
import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Rule } from "postcss";
import { resolveAlias } from "../alias.js";
import { parseCssColor } from "../color.js";
import { evaluateColorMix, isColorMix } from "../color-mix.js";
import { InputError } from "../errors.js";
import { DEFAULT_MODE, type CodeLocation, type Diagnostic, type OklchColor, type ModeName, type NormalizedToken, type TokenSet, type TokenType, type TokenValue } from "../types.js";

interface Decl {
  raw: string;
  line: number;
  selector: string;
  cssVar: string;
  context: string;
}

export type Context = { kind: "theme" } | { kind: "root" } | { kind: "mode"; mode: ModeName } | { kind: "other" };

/** Serialized context used in CodeLocation and plan actions. */
export function contextKey(ctx: Context): string {
  return ctx.kind === "mode" ? `mode:${ctx.mode}` : ctx.kind;
}

const ROOT_SELECTORS = new Set([":root", ":host", "html"]);
const VAR_RE = /^var\(\s*(--[A-Za-z0-9_\-.\\]+)\s*(?:,[^)]*)?\)$/;
const DIMENSION_RE = /^(-?\d*\.?\d+)(px|rem|em|%)$/;
const NUMBER_RE = /^-?\d*\.?\d+$/;

const normalizeSelector = (s: string) => s.replace(/\s+/g, " ").replace(/["']/g, "").trim();

export { normalizeSelector };

/**
 * @param prefixOverride Tailwind prefix from config. Otherwise it is read from `@import "tailwindcss" prefix(x)`.
 *   With a prefix, Tailwind emits `--x-color-…` at runtime, so mode overrides written with the prefixed name
 *   (`[data-theme="dark"] { --x-color-surface: … }`) count as overrides of the theme token `--color-surface`.
 */
export function readTailwindCss(
  css: string,
  file: string,
  modeMap: Record<ModeName, string[]>,
  prefixOverride?: string | null,
  /** Warn about colors not written as oklch() (only when `colorFormat` is "oklch"). */
  requireOklch = false,
): TokenSet {
  let root;
  try {
    root = postcss.parse(css, { from: file });
  } catch (err) {
    throw new InputError(`could not parse CSS: ${(err as Error).message}`, file);
  }

  const selectorToMode = buildSelectorToMode(modeMap);
  const prefix = prefixOverride ?? detectTailwindPrefix(root);

  const theme = new Map<string, Decl>(); // name -> @theme declaration
  const scoped = new Map<string, Map<ModeName, Decl>>(); // name -> mode -> declaration (root = DEFAULT_MODE)

  root.walkDecls(/^--/, (decl) => {
    const ctx = contextOf(decl, selectorToMode);
    const entry: Decl = {
      raw: decl.value.trim(),
      line: decl.source?.start?.line ?? 0,
      selector: selectorLabel(decl),
      cssVar: decl.prop,
      context: contextKey(ctx),
    };
    // Namespace resets (`--color-*: initial`, `--*: initial`) clear Tailwind's defaults; they aren't tokens.
    if (decl.prop.endsWith("*")) return;
    if (ctx.kind === "theme") theme.set(decl.prop, entry);
    else if (ctx.kind === "root" || ctx.kind === "mode") {
      const mode = ctx.kind === "root" ? DEFAULT_MODE : ctx.mode;
      if (!scoped.has(decl.prop)) scoped.set(decl.prop, new Map());
      scoped.get(decl.prop)!.set(mode, entry);
    }
  });

  const diagnostics: Diagnostic[] = [];
  const tokens = new Map<string, NormalizedToken>();
  const modeOrder = [DEFAULT_MODE, ...Object.keys(modeMap)];
  const allModes = new Set<ModeName>();

  for (const [name, decl] of theme) {
    const key = name.slice(2);
    const perMode = new Map<ModeName, Decl>([[DEFAULT_MODE, decl]]);

    // Tailwind doesn't rewrite var() references, so code writes the emitted (prefixed) name: var(--ds-color-x).
    const unprefix = (name: string) => {
      if (!prefix || !name.startsWith(`--${prefix}-`)) return name;
      const stripped = `--${name.slice(prefix.length + 3)}`;
      return theme.has(stripped) ? stripped : name;
    };
    const rawRef = VAR_RE.exec(decl.raw)?.[1];
    const passThrough = rawRef ? unprefix(rawRef) : undefined;
    if (passThrough && !theme.has(passThrough) && scoped.get(passThrough)?.has(DEFAULT_MODE)) {
      for (const [mode, d] of scoped.get(passThrough)!) perMode.set(mode, d);
    }
    // Unprefixed overrides first, then prefixed ones (the names Tailwind actually emits) on top.
    const overrides = [...(scoped.get(name) ?? []), ...(prefix ? (scoped.get(`--${prefix}-${key}`) ?? []) : [])];
    for (const [mode, d] of overrides) {
      if (mode !== DEFAULT_MODE) perMode.set(mode, d);
    }

    const modes = modeOrder.filter((m) => perMode.has(m));
    const values: Record<ModeName, TokenValue> = {};
    const locations: Record<ModeName, CodeLocation> = {};
    for (const mode of modes) {
      const d = perMode.get(mode)!;
      values[mode] = parseValue(d.raw, key, requireOklch ? diagnostics : [], unprefix);
      locations[mode] = { cssVar: d.cssVar, context: d.context, line: d.line, selector: d.selector };
      allModes.add(mode);
    }
    tokens.set(key, {
      key,
      type: "string", // provisional; set below once aliases can be resolved
      modes,
      values,
      source: { origin: "code", code: { cssVar: name, file, line: decl.line, selector: decl.selector, modes: locations } },
    });
  }

  const set: TokenSet = { origin: "code", modes: [...allModes], tokens, diagnostics, ...(prefix ? { tailwindPrefix: prefix } : {}) };
  evaluateColorMixes(set, prefix);
  for (const token of tokens.values()) token.type = inferType(set, token);
  return set;
}

/**
 * Replace color-mix() values with the color they produce, per mode. var() operands resolve in the same mode,
 * as the browser would. Values that can't be evaluated stay as text, with a warning.
 */
function evaluateColorMixes(set: TokenSet, prefix: string | null) {
  const keyOf = (name: string) => {
    const bare = name.replace(/^--/, "");
    return prefix && bare.startsWith(`${prefix}-`) && set.tokens.has(bare.slice(prefix.length + 1)) ? bare.slice(prefix.length + 1) : bare;
  };
  const colorOf = (value: TokenValue, mode: ModeName, depth: number): { ok: true; color: OklchColor } | { ok: false; reason: string } => {
    const r = resolveAlias(set, value, mode);
    if (!r.ok) return { ok: false, reason: `${value.raw} doesn't resolve` };
    if (r.value.kind === "color") return { ok: true, color: r.value.color.space === "oklch" ? r.value.color : parseCssColor(r.value.raw)!.color };
    if (depth < 5 && isColorMix(r.value.raw)) {
      const nested = evaluateColorMix(r.value.raw, (op) => operand(op, mode, depth + 1));
      return nested.ok ? nested : { ok: false, reason: nested.reason };
    }
    return { ok: false, reason: `${value.raw} isn't a color` };
  };
  const operand = (text: string, mode: ModeName, depth: number) => {
    const ref = VAR_RE.exec(text)?.[1];
    if (ref) {
      const target = set.tokens.get(keyOf(ref));
      if (!target) return { ok: false as const, reason: `${text} isn't a theme token` };
      const v = target.values[mode] ?? target.values[DEFAULT_MODE]!;
      return colorOf(v, mode, depth);
    }
    const c = parseCssColor(text);
    return c ? { ok: true as const, color: c.color } : { ok: false as const, reason: `"${text}" isn't a color` };
  };

  for (const token of set.tokens.values()) {
    for (const mode of token.modes) {
      const v = token.values[mode]!;
      if (v.kind !== "string" || !isColorMix(v.raw)) continue;
      const r = evaluateColorMix(v.raw, (op) => operand(op, mode, 0));
      if (r.ok) token.values[mode] = { kind: "color", color: r.color, raw: v.raw };
      else set.diagnostics.push({ level: "warning", origin: "code", token: token.key, message: `Can't evaluate ${v.raw}: ${r.reason}. This value isn't compared.` });
    }
  }
}

/** `@import "tailwindcss" prefix(ds);` -> "ds". */
function detectTailwindPrefix(root: postcss.Root): string | null {
  let found: string | null = null;
  root.walkAtRules("import", (at) => {
    if (!/tailwindcss/.test(at.params)) return;
    const m = /prefix\(\s*([A-Za-z0-9_-]+)\s*\)/.exec(at.params);
    if (m) found = m[1]!;
  });
  return found;
}

export function buildSelectorToMode(modeMap: Record<ModeName, string[]>): Map<string, ModeName> {
  const selectorToMode = new Map<string, ModeName>();
  for (const [mode, selectors] of Object.entries(modeMap)) {
    for (const s of selectors) selectorToMode.set(normalizeSelector(s), mode);
  }
  return selectorToMode;
}

export function contextOf(decl: Declaration, selectorToMode: Map<string, ModeName>): Context {
  let inTheme = false;
  let inRoot = false;
  for (let node: Container | undefined = decl.parent as Container | undefined; node && node.type !== "root"; node = node.parent as Container | undefined) {
    if (node.type === "atrule") {
      const at = node as AtRule;
      if (at.name === "theme") inTheme = true;
      const mode = selectorToMode.get(normalizeSelector(`@${at.name} ${at.params}`));
      if (mode) return { kind: "mode", mode };
    } else if (node.type === "rule") {
      for (const sel of (node as Rule).selectors) {
        const norm = normalizeSelector(sel);
        const mode = selectorToMode.get(norm);
        if (mode) return { kind: "mode", mode };
        if (ROOT_SELECTORS.has(norm)) inRoot = true;
      }
    }
  }
  if (inTheme) return { kind: "theme" };
  if (inRoot) return { kind: "root" };
  return { kind: "other" };
}

function selectorLabel(decl: Declaration): string {
  const parts: string[] = [];
  for (let node: ChildNode | Container | undefined = decl.parent as Container | undefined; node && node.type !== "root"; node = node.parent as Container | undefined) {
    if (node.type === "atrule") parts.unshift(`@${(node as AtRule).name}${(node as AtRule).params ? ` ${(node as AtRule).params}` : ""}`);
    else if (node.type === "rule") parts.unshift((node as Rule).selector);
  }
  return parts.join(" ");
}

function parseValue(raw: string, key: string, diagnostics: Diagnostic[], unprefix: (name: string) => string = (n) => n): TokenValue {
  const ref = VAR_RE.exec(raw)?.[1];
  if (ref) return { kind: "alias", ref: unprefix(ref).slice(2), raw };

  const dim = DIMENSION_RE.exec(raw);
  if (dim) return { kind: "dimension", value: Number(dim[1]), unit: dim[2] as "px" | "rem" | "em" | "%", raw };
  if (NUMBER_RE.test(raw)) return { kind: "number", value: Number(raw), raw };

  const color = parseCssColor(raw);
  if (color) {
    if (!color.wasOklch) {
      diagnostics.push({ level: "warning", origin: "code", token: key, message: `${raw} is not oklch(), and colorFormat is "oklch".` });
    }
    return { kind: "color", color: color.color, raw };
  }
  return { kind: "string", value: raw, raw };
}

const NAMESPACE_TYPES: Array<[RegExp, TokenType]> = [
  [/^color-/, "color"],
  [/^(spacing|radius|text|breakpoint|container|blur|inset)-/, "dimension"],
];

function inferType(set: TokenSet, token: NormalizedToken): TokenType {
  // An unevaluated color-mix() is still a color.
  if (Object.values(token.values).some((v) => isColorMix(v.raw))) return "color";
  const first = token.values[token.modes[0]!];
  if (first) {
    const r = resolveAlias(set, first, token.modes[0]!);
    if (r.ok) return r.value.kind;
  }
  return NAMESPACE_TYPES.find(([re]) => re.test(token.key))?.[1] ?? "string";
}
