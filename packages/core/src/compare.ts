// Three-way compare: Figma vs code vs lock -> findings.
//
// Color rules (see CLAUDE.md):
// - If Figma's RGB still matches the locked RGB, Figma is unchanged and its effective OKLCH IS the
//   locked OKLCH. RGB is never converted for an unchanged color.
// - Only a changed Figma RGB is converted to OKLCH (rounded to settings.precision).
// - Colors are compared by ΔE_OK, never as strings.
// - A code color outside Figma's gamut is a warning; comparisons against converted Figma values use the
//   gamut-mapped code color so clamping never counts as drift.
import { resolveAlias, type Literal } from "./alias.js";
import * as color from "./color.js";
import {
  DEFAULT_MODE,
  type ColorProfile,
  type CompareSettings,
  type Diagnostic,
  type Direction,
  type Finding,
  type FindingKind,
  type LockFile,
  type LockModeEntry,
  type LockToken,
  type ModeName,
  type NormalizedToken,
  type OklchColor,
  type Rgba,
  type Severity,
  type SideValue,
  type TokenSet,
  type TokenType,
  type TokenValue,
} from "./types.js";

/** ΔE_OK below which two colors from different sources are the same color (float/rounding noise). */
export const SAME_COLOR_EPSILON = 1e-4;
/** ΔE_OK below which code is considered unchanged from the locked OKLCH (both are authored OKLCH). */
export const LOCK_COLOR_EPSILON = 1e-6;
const SCALAR_EPSILON = 1e-9;

const SEVERITY: Record<FindingKind, Severity> = {
  "missing-in-code": "error",
  "missing-in-figma": "error",
  "value-mismatch": "error",
  "broken-alias": "error",
  "missing-mode": "error",
  conflict: "error",
  "near-match": "info",
  "out-of-gamut": "warning",
};

export interface CompareInput {
  figma: TokenSet;
  code: TokenSet;
  lock: LockFile | null;
  settings: CompareSettings;
}

export interface CompareResult {
  findings: Finding[];
  tokensCompared: number;
  inSync: number;
  diagnostics: Diagnostic[];
}

type Relation = "same" | "near" | "different";

interface Ctx extends CompareInput {
  profile: ColorProfile;
  /** False when the lock's RGB was recorded in a different profile than the Figma file now uses. */
  lockRgbUsable: boolean;
  findings: Finding[];
}

export function compare(input: CompareInput): CompareResult {
  const profile = input.figma.colorProfile ?? "srgb";
  const diagnostics: Diagnostic[] = [];
  const lockRgbUsable = !input.lock || input.lock.figmaColorProfile === profile;
  if (!lockRgbUsable) {
    diagnostics.push({
      level: "warning",
      origin: "lock",
      message: `Lock RGB values were recorded in ${input.lock!.figmaColorProfile} but the Figma file is ${profile}; every Figma color is treated as changed.`,
    });
  }
  const ctx: Ctx = { ...input, profile, lockRgbUsable, findings: [] };

  const keys = [...new Set([...input.figma.tokens.keys(), ...input.code.tokens.keys()])].sort();
  for (const key of keys) {
    const f = input.figma.tokens.get(key);
    const c = input.code.tokens.get(key);
    const l = input.lock?.tokens[key];
    if (f && c) compareToken(ctx, f, c, l);
    else if (f) missingOnOneSide(ctx, "missing-in-code", f, l);
    else if (c) missingOnOneSide(ctx, "missing-in-figma", c, l);
  }

  const findings = dedupe(ctx.findings).sort(byTokenModeKind);
  const failing = new Set(findings.filter((f) => f.severity === "error").map((f) => f.token));
  return { findings, tokensCompared: keys.length, inSync: keys.length - failing.size, diagnostics };
}

// ---------------------------------------------------------------------------------------------
// Whole-token findings

function missingOnOneSide(ctx: Ctx, kind: "missing-in-code" | "missing-in-figma", token: NormalizedToken, lock: LockToken | undefined) {
  const side = token.source.origin;
  const towardOther: Direction = side === "figma" ? "figma-to-code" : "code-to-figma";
  const deleteOther: Direction = side === "figma" ? "code-to-figma" : "figma-to-code";

  // With a lock entry, the token was synced before and the other side deleted it.
  let direction: Direction = towardOther;
  let changedHere: boolean | null = null;
  if (lock) {
    changedHere = token.modes.some((m) => {
      const entry = lock.modes[m];
      return !entry || !lockMatches(ctx, side, token.values[m]!, entry);
    });
    direction = changedHere ? "needs-decision" : deleteOther;
  }

  const mode0 = token.modes[0]!;
  const sideValue = describe(token, token.values[mode0]!);
  const where = side === "figma" ? "Figma" : "code";
  const other = side === "figma" ? "code" : "Figma";
  push(ctx, {
    kind,
    token: token.key,
    mode: null,
    type: token.type,
    figma: side === "figma" ? sideValue : null,
    code: side === "code" ? sideValue : null,
    lock: lock?.modes[mode0] ?? null,
    changed: side === "figma" ? { figma: changedHere, code: lock ? true : null } : { figma: lock ? true : null, code: changedHere },
    suggestedDirection: direction,
    message: lock
      ? `Exists in ${where} but was removed from ${other} since the last sync.`
      : `Exists in ${where} but not in ${other}.`,
  });

  if (side === "code") {
    for (const m of token.modes) gamutCheck(ctx, token, m, token.values[m]!, null, { figma: null, code: null });
  }
}

function compareToken(ctx: Ctx, f: NormalizedToken, c: NormalizedToken, lock: LockToken | undefined) {
  const brokenF = brokenAliases(ctx, ctx.figma, f, "figma");
  const brokenC = brokenAliases(ctx, ctx.code, c, "code");

  if (!typesCompatible(f.type, c.type)) {
    push(ctx, {
      kind: "value-mismatch",
      token: f.key,
      mode: null,
      type: f.type,
      figma: describe(f, f.values[f.modes[0]!]!),
      code: describe(c, c.values[c.modes[0]!]!),
      lock: null,
      changed: { figma: null, code: null },
      suggestedDirection: "needs-decision",
      message: `Type differs: Figma ${f.type}, code ${c.type}.`,
    });
    return;
  }

  for (const pair of pairModes(f, c)) {
    const lockEntry = lock?.modes[pair.mode] ?? null;
    if (pair.figma && pair.code) {
      if (brokenF.has(pair.figmaMode) || brokenC.has(pair.codeMode)) continue;
      comparePair(ctx, f, c, pair.mode, pair.figma, pair.code, lockEntry);
    } else {
      missingMode(ctx, f, c, pair.mode, pair.figma, pair.code, lockEntry);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Mode pairing

export interface Pair {
  mode: ModeName; // label used in findings and lock lookups
  figmaMode: ModeName;
  codeMode: ModeName;
  figma: TokenValue | undefined;
  code: TokenValue | undefined;
}

/**
 * - single vs single: one "default" pair.
 * - single vs multi: the single value is compared against every mode of the other side.
 * - multi vs multi: code's default (@theme) mode is Figma's default (first) mode; other modes match by name.
 */
export function pairModes(f: NormalizedToken, c: NormalizedToken): Pair[] {
  const fSingle = f.modes.length === 1 && f.modes[0] === DEFAULT_MODE;
  const cSingle = c.modes.length === 1 && c.modes[0] === DEFAULT_MODE;
  if (fSingle && cSingle) {
    return [{ mode: DEFAULT_MODE, figmaMode: DEFAULT_MODE, codeMode: DEFAULT_MODE, figma: f.values[DEFAULT_MODE], code: c.values[DEFAULT_MODE] }];
  }
  if (fSingle) {
    return c.modes.map((m) => ({ mode: m, figmaMode: DEFAULT_MODE, codeMode: m, figma: f.values[DEFAULT_MODE], code: c.values[m] }));
  }
  if (cSingle) {
    return f.modes.map((m) => ({ mode: m, figmaMode: m, codeMode: DEFAULT_MODE, figma: f.values[m], code: c.values[DEFAULT_MODE] }));
  }
  const figmaDefault = f.modes[0]!;
  const codeName = (m: ModeName) => (m === DEFAULT_MODE ? figmaDefault : m);
  const codeByName = new Map(c.modes.map((m) => [codeName(m), m]));
  const labels = [...f.modes, ...c.modes.map(codeName).filter((m) => !f.modes.includes(m))];
  return labels.map((label) => {
    const codeMode = codeByName.get(label) ?? label;
    return { mode: label, figmaMode: label, codeMode, figma: f.values[label], code: c.values[codeMode] };
  });
}

function missingMode(
  ctx: Ctx,
  f: NormalizedToken,
  c: NormalizedToken,
  mode: ModeName,
  fv: TokenValue | undefined,
  cv: TokenValue | undefined,
  lockEntry: LockModeEntry | null,
) {
  const side = fv ? "figma" : "code";
  const value = (fv ?? cv)!;
  const towardOther: Direction = side === "figma" ? "figma-to-code" : "code-to-figma";
  const deleteOther: Direction = side === "figma" ? "code-to-figma" : "figma-to-code";
  const unchangedHere = lockEntry ? lockMatches(ctx, side, value, lockEntry) : null;
  push(ctx, {
    kind: "missing-mode",
    token: f.key,
    mode,
    type: f.type,
    figma: fv ? describe(f, fv) : null,
    code: cv ? describe(c, cv) : null,
    lock: lockEntry,
    changed: { figma: null, code: null },
    suggestedDirection: lockEntry ? (unchangedHere ? deleteOther : "needs-decision") : towardOther,
    message: `Mode "${mode}" exists in ${side === "figma" ? "Figma" : "code"} but not in ${side === "figma" ? "code" : "Figma"}.`,
  });
}

// ---------------------------------------------------------------------------------------------
// Aliases

function brokenAliases(ctx: Ctx, set: TokenSet, token: NormalizedToken, side: "figma" | "code"): Set<ModeName> {
  const broken = new Set<ModeName>();
  for (const mode of token.modes) {
    const value = token.values[mode]!;
    if (value.kind !== "alias") continue;
    const r = resolveAlias(set, value, mode);
    let problem: "missing-target" | "cycle" | "type-mismatch" | null = null;
    let detail = "";
    if (!r.ok) {
      problem = r.problem;
      detail = r.problem === "cycle" ? `forms a cycle through "${r.ref}"` : `points at "${displayRef(r.ref)}", which does not exist`;
    } else if (!typesCompatible(r.value.kind, token.type)) {
      problem = "type-mismatch";
      detail = `resolves to a ${r.value.kind} but the token is a ${token.type}`;
    }
    if (!problem) continue;
    broken.add(mode);
    push(
      ctx,
      {
        kind: "broken-alias",
        token: token.key,
        mode,
        type: token.type,
        figma: side === "figma" ? describe(token, value) : null,
        code: side === "code" ? describe(token, value) : null,
        lock: null,
        changed: { figma: null, code: null },
        suggestedDirection: "needs-decision",
        alias: { ref: value.ref, problem, side },
        message: `${side === "figma" ? "Figma" : "Code"} alias ${value.raw} ${detail}.`,
      },
      side,
    );
  }
  return broken;
}

const displayRef = (ref: string) => ref.replace(/^figma-variable:/, "Figma variable ");

// ---------------------------------------------------------------------------------------------
// Value comparison for one (token, mode)

interface Comparison {
  figmaChanged: boolean | null;
  codeChanged: boolean | null;
  relation: Relation;
  distance?: number;
  figmaOklch?: { color: OklchColor; source: "lock" | "converted" };
}

function comparePair(ctx: Ctx, f: NormalizedToken, c: NormalizedToken, mode: ModeName, fv: TokenValue, cv: TokenValue, lockEntry: LockModeEntry | null) {
  const result =
    fv.kind === "color" && cv.kind === "color" ? compareColors(ctx, fv, cv, lockEntry) : compareGeneric(ctx, fv, cv, lockEntry);

  const changed = { figma: result.figmaChanged, code: result.codeChanged };
  gamutCheck(ctx, c, mode, cv, lockEntry, changed);

  const classification = classify(result);
  if (!classification) return;

  const figma = describe(f, fv, result.figmaOklch);
  const code = describe(c, cv);
  const fShow = showValue(ctx.figma, fv, mode, figma);
  const cShow = showValue(ctx.code, cv, mode, code);
  const distance = result.distance !== undefined ? round(result.distance, 6) : undefined;
  const messages: Record<typeof classification.kind, string> = {
    "near-match": `Figma ${fShow} and code ${cShow} differ by ΔE_OK ${distance}, below the near-match threshold ${ctx.settings.nearThreshold}.`,
    conflict: `Changed on both sides since the last sync: Figma ${fShow}, code ${cShow}.`,
    "value-mismatch":
      classification.direction === "figma-to-code"
        ? `Figma changed since the last sync: Figma ${fShow}, code ${cShow}.`
        : classification.direction === "code-to-figma"
          ? `Code changed since the last sync: code ${cShow}, Figma ${fShow}.`
          : `Values differ and there is no lock entry to tell which side changed: Figma ${fShow}, code ${cShow}.`,
  };

  push(ctx, {
    kind: classification.kind,
    token: f.key,
    mode,
    type: f.type,
    figma,
    code,
    lock: lockEntry,
    changed,
    suggestedDirection: classification.direction,
    ...(distance !== undefined ? { distance } : {}),
    message: messages[classification.kind],
  });
}

function classify(r: Comparison): { kind: "value-mismatch" | "near-match" | "conflict"; direction: Direction } | null {
  if (r.relation === "same") return null;
  if (r.figmaChanged === false && r.codeChanged === false) return null;
  if (r.relation === "near") return { kind: "near-match", direction: "none" };
  if (r.figmaChanged === null || r.codeChanged === null) return { kind: "value-mismatch", direction: "needs-decision" };
  if (r.figmaChanged && r.codeChanged) return { kind: "conflict", direction: "needs-decision" };
  return { kind: "value-mismatch", direction: r.figmaChanged ? "figma-to-code" : "code-to-figma" };
}

function compareColors(
  ctx: Ctx,
  fv: Extract<TokenValue, { kind: "color" }>,
  cv: Extract<TokenValue, { kind: "color" }>,
  lockEntry: LockModeEntry | null,
): Comparison {
  const codeColor = asOklch(cv.color);
  const locked = lockEntry && "oklch" in lockEntry ? lockEntry : null;

  // Effective Figma OKLCH: the locked value if Figma's RGB is unchanged, otherwise a fresh conversion.
  let figmaOklch: { color: OklchColor; source: "lock" | "converted" };
  let figmaChanged: boolean | null;
  if (locked && ctx.lockRgbUsable && fv.color.space !== "oklch" && color.rgbClose(fv.color, locked.figmaRgb, ctx.settings.rgbTolerance)) {
    figmaOklch = { color: color.parseOklch(locked.oklch)!, source: "lock" };
    figmaChanged = false;
  } else {
    const converted = fv.color.space === "oklch" ? fv.color : color.rgbToOklch(fv.color, ctx.settings.precision);
    figmaOklch = { color: converted, source: "converted" };
    figmaChanged = lockEntry ? true : null;
  }

  const codeChanged = lockEntry ? !(locked && color.deltaEOK(codeColor, color.parseOklch(locked.oklch)!) < LOCK_COLOR_EPSILON) : null;

  // A converted Figma value can only ever be in gamut, so compare it with what Figma could hold.
  let compareTo = codeColor;
  if (figmaOklch.source === "converted" && !color.isInGamut(codeColor, ctx.profile)) {
    compareTo = color.rgbaToOklch(color.toGamutRgb(codeColor, ctx.profile), ctx.profile);
  }
  const distance = color.deltaEOK(figmaOklch.color, compareTo);
  const relation: Relation = distance < SAME_COLOR_EPSILON ? "same" : distance < ctx.settings.nearThreshold ? "near" : "different";
  return { figmaChanged, codeChanged, relation, distance, figmaOklch };
}

function compareGeneric(ctx: Ctx, fv: TokenValue, cv: TokenValue, lockEntry: LockModeEntry | null): Comparison {
  return {
    figmaChanged: lockEntry ? !lockMatches(ctx, "figma", fv, lockEntry) : null,
    codeChanged: lockEntry ? !lockMatches(ctx, "code", cv, lockEntry) : null,
    relation: valuesEqual(ctx, fv, cv) ? "same" : "different",
  };
}

/** Does this side's value still equal what the lock recorded for it? */
export function lockMatches(ctx: Pick<Ctx, "lockRgbUsable" | "settings">, side: "figma" | "code", value: TokenValue, entry: LockModeEntry): boolean {
  if (value.kind === "alias") return "alias" in entry && entry.alias === value.ref;
  if (value.kind === "color") {
    if (!("oklch" in entry)) return false;
    if (side === "figma" && value.color.space !== "oklch") {
      return ctx.lockRgbUsable && color.rgbClose(value.color, entry.figmaRgb, ctx.settings.rgbTolerance);
    }
    return color.deltaEOK(asOklch(value.color), color.parseOklch(entry.oklch)!) < LOCK_COLOR_EPSILON;
  }
  if (!("value" in entry)) return false;
  return scalarEqual(scalar(value, ctx.settings.remBase), scalar(parseLockScalar(entry.value, value.kind), ctx.settings.remBase));
}

function valuesEqual(ctx: Ctx, a: TokenValue, b: TokenValue): boolean {
  if (a.kind === "alias" || b.kind === "alias") return a.kind === "alias" && b.kind === "alias" && a.ref === b.ref;
  if (a.kind === "color" || b.kind === "color") return false; // color pairs go through compareColors
  return scalarEqual(scalar(a, ctx.settings.remBase), scalar(b, ctx.settings.remBase));
}

// ---------------------------------------------------------------------------------------------
// Gamut

function gamutCheck(
  ctx: Ctx,
  token: NormalizedToken,
  mode: ModeName,
  value: TokenValue,
  lockEntry: LockModeEntry | null,
  changed: { figma: boolean | null; code: boolean | null },
) {
  if (value.kind !== "color") return;
  const c = asOklch(value.color);
  if (color.isInGamut(c, ctx.profile)) return;
  const mappedRgb = color.toGamutRgb(c, ctx.profile);
  push(ctx, {
    kind: "out-of-gamut",
    token: token.key,
    mode,
    type: token.type,
    figma: null,
    code: describe(token, value),
    lock: lockEntry,
    changed,
    suggestedDirection: "none",
    gamut: { profile: ctx.profile, mappedRgb },
    message: `${value.raw} is outside ${ctx.profile}; Figma can only hold the gamut-mapped ${color.formatRgb({ space: ctx.profile, r: mappedRgb.r, g: mappedRgb.g, b: mappedRgb.b, alpha: mappedRgb.a })}.`,
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers

export function typesCompatible(a: TokenType, b: TokenType): boolean {
  const numeric = (t: TokenType) => t === "number" || t === "dimension";
  return a === b || (numeric(a) && numeric(b));
}

function asOklch(c: OklchColor | { space: ColorProfile; r: number; g: number; b: number; alpha: number }): OklchColor {
  if (c.space === "oklch") return c;
  const rgba: Rgba = { r: c.r, g: c.g, b: c.b, a: c.alpha };
  return color.rgbaToOklch(rgba, c.space);
}

type Scalar = { num: number } | { str: string };

function scalar(v: Literal, remBase: number): Scalar {
  switch (v.kind) {
    case "number":
      return { num: v.value };
    case "dimension":
      if (v.unit === "px") return { num: v.value };
      if (v.unit === "rem" || v.unit === "em") return { num: v.value * remBase };
      return { str: v.raw };
    case "boolean":
      return { str: String(v.value) };
    case "string":
      return { str: v.value };
    default:
      return { str: v.raw };
  }
}

function scalarEqual(a: Scalar, b: Scalar): boolean {
  if ("num" in a && "num" in b) return Math.abs(a.num - b.num) < SCALAR_EPSILON;
  if ("str" in a && "str" in b) return a.str === b.str;
  return false;
}

function parseLockScalar(raw: string, kind: Literal["kind"]): Literal {
  if (kind === "string" || kind === "boolean") return { kind: "string", value: raw, raw };
  const dim = /^(-?\d*\.?\d+)(px|rem|em|%)$/.exec(raw);
  if (dim) return { kind: "dimension", value: Number(dim[1]), unit: dim[2] as "px" | "rem" | "em" | "%", raw };
  if (/^-?\d*\.?\d+$/.test(raw)) return { kind: "number", value: Number(raw), raw };
  return { kind: "string", value: raw, raw };
}

function describe(token: NormalizedToken, value: TokenValue, effective?: { color: OklchColor; source: "lock" | "converted" }): SideValue {
  const side: SideValue = { raw: value.raw, location: token.source };
  if (value.kind === "alias") side.alias = value.ref;
  if (effective) {
    side.oklch = color.formatOklch(effective.color);
    side.oklchSource = effective.source;
  } else if (value.kind === "color" && value.color.space === "oklch") {
    side.oklch = color.formatOklch(value.color);
    side.oklchSource = "code";
  }
  return side;
}

/** Human-readable value for messages: aliases show what they resolve to. */
function showValue(set: TokenSet, value: TokenValue, mode: ModeName, side: SideValue): string {
  if (value.kind !== "alias") return side.oklch && side.oklchSource !== "code" ? `${value.raw} (${side.oklch})` : value.raw;
  const r = resolveAlias(set, value, mode);
  return r.ok ? `${value.raw} → ${r.value.raw}` : value.raw;
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function push(ctx: Ctx, f: Omit<Finding, "id" | "severity">, suffix?: string) {
  const id = `${f.kind}:${f.token}:${f.mode ?? "*"}${suffix ? `:${suffix}` : ""}`;
  ctx.findings.push({ id, severity: SEVERITY[f.kind], ...f });
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) if (!seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Locale-independent ordering so reports are byte-for-byte deterministic. */
function byTokenModeKind(a: Finding, b: Finding): number {
  return cmp(a.token, b.token) || cmp(a.mode ?? "", b.mode ?? "") || cmp(a.kind, b.kind) || cmp(a.id, b.id);
}
