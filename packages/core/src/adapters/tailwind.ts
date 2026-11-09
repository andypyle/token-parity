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
import { InputError } from "../errors.js";
import { DEFAULT_MODE, type CodeLocation, type Diagnostic, type ModeName, type NormalizedToken, type TokenSet, type TokenType, type TokenValue } from "../types.js";

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

export function readTailwindCss(css: string, file: string, modeMap: Record<ModeName, string[]>): TokenSet {
  let root;
  try {
    root = postcss.parse(css, { from: file });
  } catch (err) {
    throw new InputError(`could not parse CSS: ${(err as Error).message}`, file);
  }

  const selectorToMode = buildSelectorToMode(modeMap);

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

    const passThrough = VAR_RE.exec(decl.raw)?.[1];
    if (passThrough && !theme.has(passThrough) && scoped.get(passThrough)?.has(DEFAULT_MODE)) {
      for (const [mode, d] of scoped.get(passThrough)!) perMode.set(mode, d);
    }
    for (const [mode, d] of scoped.get(name) ?? []) {
      if (mode !== DEFAULT_MODE) perMode.set(mode, d);
    }

    const modes = modeOrder.filter((m) => perMode.has(m));
    const values: Record<ModeName, TokenValue> = {};
    const locations: Record<ModeName, CodeLocation> = {};
    for (const mode of modes) {
      const d = perMode.get(mode)!;
      values[mode] = parseValue(d.raw, key, diagnostics);
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

  const set: TokenSet = { origin: "code", modes: [...allModes], tokens, diagnostics };
  for (const token of tokens.values()) token.type = inferType(set, token);
  return set;
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

function parseValue(raw: string, key: string, diagnostics: Diagnostic[]): TokenValue {
  const ref = VAR_RE.exec(raw)?.[1];
  if (ref) return { kind: "alias", ref: ref.slice(2), raw };

  const dim = DIMENSION_RE.exec(raw);
  if (dim) return { kind: "dimension", value: Number(dim[1]), unit: dim[2] as "px" | "rem" | "em" | "%", raw };
  if (NUMBER_RE.test(raw)) return { kind: "number", value: Number(raw), raw };

  const color = parseCssColor(raw);
  if (color) {
    if (!color.wasOklch) {
      diagnostics.push({ level: "warning", origin: "code", token: key, message: `${raw} is not oklch(); OKLCH is the canonical color format.` });
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
  const first = token.values[token.modes[0]!];
  if (first) {
    const r = resolveAlias(set, first, token.modes[0]!);
    if (r.ok) return r.value.kind;
  }
  return NAMESPACE_TYPES.find(([re]) => re.test(token.key))?.[1] ?? "string";
}
