// plan: turn the three-way comparison into concrete actions, or into items that need a decision.
//
// Directions come from, in order: an explicit resolution ("token:mode" -> figma | code | skip), the
// direction check suggested (lock-based), or --prefer for first-sync differences. Conflicts never take
// --prefer. Nothing is guessed: anything else is listed in `unresolved` with a hint.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadInputs, parseJson } from "./check.js";
import { compare, lockEntryFor, lockMatches, modeLabel, pairModes, resolvedOr, resolvesByValue, runtimeCodeMode, sameValue, type Pair } from "./compare.js";
import { InputError } from "./errors.js";
import { detectCodeSyntaxStyle, formatCodeSyntax } from "./code-syntax.js";
import { isColorMix } from "./color-mix.js";
import { compileIgnore, type IgnoreMatcher } from "./ignore.js";
import { inferFigmaName } from "./naming.js";
import {
  DEFAULT_MODE,
  type Action,
  type CompareSettings,
  type FigmaCollectionInfo,
  type FigmaValue,
  type Finding,
  type LockFile,
  type LockModeEntry,
  type LockToken,
  type ModeName,
  type NormalizedToken,
  type Plan,
  type Resolutions,
  type TokenKey,
  type TokenSet,
  type TokenValue,
  type Unresolved,
  type UnresolvedReason,
} from "./types.js";
import { codeTextFromFigma, entryFromSides, figmaValueFromCode, figmaValueOf, majorityColorFormat, resolvedTypeOf } from "./values.js";
import { VERSION } from "./version.js";

export interface PlanOptions {
  figmaPath: string;
  codePath: string;
  lockPath: string;
  prefer: "code" | "figma" | null;
  resolutionsPath: string | null;
  figmaCollection: string | null;
  settings?: Partial<CompareSettings>;
}

type Dir = "figma-to-code" | "code-to-figma";
type Via = Action["via"];

/** Placeholder for an alias to a Figma variable that this plan creates; resolved in finalize(). */
const PENDING_ALIAS = "\u0000pending:";

/** Per-action lock effect (adds touch several modes). Internal; the plan exposes the result as lockAfter. */
interface LockEffect {
  token: TokenKey;
  type: LockToken["type"];
  modes: Record<ModeName, LockModeEntry>;
  figmaName?: string;
}

interface Ctx {
  figma: TokenSet;
  code: TokenSet;
  lock: LockFile | null;
  settings: CompareSettings;
  resolutions: Resolutions;
  prefer: "code" | "figma" | null;
  figmaCollection: string | null;
  actions: Action[];
  effects: Map<string, LockEffect>;
  unresolved: Unresolved[];
  skipped: string[];
  /** Aliases to variables this plan creates, to verify once their values are known (see finalizeAliases). */
  aliasChecks: Map<string, { ref: TokenKey; figmaMode: ModeName; expected: TokenValue }>;
  /** The format the code file mostly writes colors in, for new tokens under colorFormat "preserve". */
  fileColorFormat: "oklch" | "hex" | "rgb";
}

export async function plan(options: PlanOptions): Promise<Plan> {
  const inputs = await loadInputs({ ...options });
  const resolutions = options.resolutionsPath ? await readResolutions(options.resolutionsPath) : { version: 1 as const };
  const { figma, code, lock, settings } = inputs;
  const profile = figma.colorProfile ?? "srgb";

  const ctx: Ctx = {
    figma,
    code,
    lock,
    settings,
    resolutions,
    prefer: options.prefer,
    figmaCollection: options.figmaCollection,
    actions: [],
    effects: new Map(),
    unresolved: [],
    skipped: [],
    aliasChecks: new Map(),
    fileColorFormat: majorityColorFormat(
      [...code.tokens.values()].flatMap((t) => Object.values(t.values).flatMap((v) => (v.kind === "color" ? [v.raw] : []))),
      settings.colorMatch !== "perceptual",
    ),
  };

  const { findings } = compare({ figma, code, lock, settings });
  const byToken = new Map<TokenKey, Finding[]>();
  for (const f of findings) byToken.set(f.token, [...(byToken.get(f.token) ?? []), f]);

  const baseline = new Map<TokenKey, Record<ModeName, LockModeEntry>>();
  const ignore = compileIgnore(settings.ignore);
  for (const key of [...new Set([...figma.tokens.keys(), ...code.tokens.keys()])].sort()) {
    const f = figma.tokens.get(key);
    const c = code.tokens.get(key);
    if (ignore.token(key, f, c)) continue; // left alone: no actions, lock entries untouched
    const tokenFindings = (byToken.get(key) ?? []).filter((x) => x.kind !== "out-of-gamut");
    if (f && c) collectBaseline(ctx, f, c, tokenFindings, baseline, ignore);
    for (const finding of tokenFindings) handleFinding(ctx, finding, f, c);
  }

  finalizeAliases(ctx);

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  return {
    schemaVersion: 1,
    tool: { name: "token-parity", version: VERSION },
    inputs: {
      figma: { path: options.figmaPath, sha256: sha(inputs.text.figma) },
      code: { path: options.codePath, sha256: sha(inputs.text.code) },
      lock: { path: options.lockPath, sha256: inputs.text.lock === null ? null : sha(inputs.text.lock) },
    },
    settings,
    options: { prefer: options.prefer, resolutions: options.resolutionsPath, figmaCollection: options.figmaCollection },
    actions: ctx.actions.sort(byTokenModeId),
    unresolved: ctx.unresolved,
    skipped: ctx.skipped,
    lockAfter: buildLockAfter(ctx, profile, baseline),
  };
}

/** 0 when every finding has an action (or was skipped), 1 when decisions remain. */
export function planExitCode(p: Plan): 0 | 1 {
  return p.unresolved.length > 0 ? 1 : 0;
}

export async function readResolutions(path: string): Promise<Resolutions> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new InputError("cannot read resolutions file", path);
  }
  const r = parseJson(text, path) as Resolutions;
  if (typeof r !== "object" || r === null || r.version !== 1) throw new InputError("expected { version: 1, resolutions?, names?, collections? }", path);
  for (const [k, v] of Object.entries(r.resolutions ?? {})) {
    if (!/^.+:.+$/.test(k) || !["figma", "code", "skip"].includes(v)) {
      throw new InputError(`resolution "${k}": "${v}" must be "token:mode" -> "figma" | "code" | "skip"`, path);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Baseline: pairs already in sync keep (or gain) a lock entry

function collectBaseline(
  ctx: Ctx,
  f: NormalizedToken,
  c: NormalizedToken,
  findings: Finding[],
  out: Map<TokenKey, Record<ModeName, LockModeEntry>>,
  ignore: IgnoreMatcher,
) {
  if (findings.some((x) => x.mode === null)) return; // whole-token problem: leave the lock alone
  const busy = new Set(findings.map((x) => x.mode));
  const lockToken = ctx.lock?.tokens[f.key];
  const lockCtx = { lockRgbUsable: !ctx.lock || ctx.lock.figmaColorProfile === (ctx.figma.colorProfile ?? "srgb"), settings: ctx.settings };

  for (const pair of pairModes(f, c)) {
    if (busy.has(pair.mode) || busy.has(pair.figmaMode) || busy.has(pair.codeMode) || !pair.figma || !pair.code) continue;
    if (ignore.mode(f.key, pair.mode, f, c)) continue;
    const existing = lockEntryFor(lockToken, pair.mode, pair.figmaMode);
    if (existing && lockMatches(lockCtx, "figma", pair.figma, existing) && lockMatches(lockCtx, "code", pair.code, existing)) continue;
    const entry = lockEntryOf(ctx, f, pair);
    if (!entry) continue;
    out.set(f.key, { ...out.get(f.key), [pair.mode]: entry });
  }
}

// ---------------------------------------------------------------------------------------------
// Findings -> actions

function handleFinding(ctx: Ctx, finding: Finding, f: NormalizedToken | undefined, c: NormalizedToken | undefined) {
  if (finding.kind === "near-match") {
    const pair = f && c ? pairModes(f, c).find((p) => p.mode === finding.mode) : undefined;
    const entry = pair?.figma && pair.code ? lockEntryOf(ctx, f!, pair) : null;
    if (pair && entry) {
      push(ctx, { op: "lock-only" }, finding, "near-match", entry, { token: finding.token, type: c!.type, modes: { [pair.mode]: entry } });
    }
    return;
  }

  const decision = decide(ctx, finding);
  if (!decision) return;
  const { dir, via } = decision;

  switch (finding.kind) {
    case "missing-in-code":
      return dir === "figma-to-code" ? addCode(ctx, finding, f!, via) : deleteFigma(ctx, finding, f!, via);
    case "missing-in-figma":
      return dir === "code-to-figma" ? addFigma(ctx, finding, c!, via) : deleteCode(ctx, finding, c!, via);
    case "value-mismatch":
      if (finding.mode === null) return unresolve(ctx, finding, "type-mismatch");
    // falls through
    case "conflict":
    case "missing-mode":
    case "format-mismatch":
    case "alias-mismatch":
    case "broken-alias": {
      const pairs = pairModes(f!, c!).filter((p) =>
        finding.kind === "broken-alias" ? (finding.alias!.side === "figma" ? modeLabel(f!, p.figmaMode) : p.codeMode) === finding.mode : p.mode === finding.mode,
      );
      if (finding.kind === "broken-alias" && finding.alias!.side === (dir === "figma-to-code" ? "figma" : "code")) {
        return unresolve(ctx, finding, "broken-alias");
      }
      for (const pair of pairs) copyValue(ctx, finding, f!, c!, pair, dir, via);
      return;
    }
    default:
      return;
  }
}

function decide(ctx: Ctx, finding: Finding): { dir: Dir; via: Via } | null {
  const key = `${finding.token}:${finding.mode ?? "*"}`;
  const resolution = ctx.resolutions.resolutions?.[key];
  if (resolution === "skip") {
    ctx.skipped.push(finding.id);
    return null;
  }
  if (resolution) return { dir: resolution === "figma" ? "figma-to-code" : "code-to-figma", via: "resolution" };
  if (finding.suggestedDirection === "figma-to-code" || finding.suggestedDirection === "code-to-figma") {
    return { dir: finding.suggestedDirection, via: "suggested" };
  }
  const firstSync =
    (finding.kind === "value-mismatch" || finding.kind === "alias-mismatch") &&
    finding.mode !== null &&
    finding.changed.figma === null &&
    finding.changed.code === null;
  if (firstSync && ctx.prefer) return { dir: ctx.prefer === "figma" ? "figma-to-code" : "code-to-figma", via: "prefer" };

  const reason: UnresolvedReason =
    finding.kind === "broken-alias"
      ? "broken-alias"
      : finding.kind === "value-mismatch" || finding.kind === "alias-mismatch"
        ? finding.mode === null
          ? "type-mismatch"
          : firstSync
            ? "no-lock-difference"
            : "conflict"
        : "conflict";
  unresolve(ctx, finding, reason);
  return null;
}

function copyValue(ctx: Ctx, finding: Finding, f: NormalizedToken, c: NormalizedToken, pair: Pair, dir: Dir, via: Via) {
  const fSingle = f.modes.length === 1 && f.modes[0] === DEFAULT_MODE;
  const cSingle = c.modes.length === 1 && c.modes[0] === DEFAULT_MODE;

  // A mode value removed on the winning side would mean deleting one mode on the other side.
  if (!(dir === "figma-to-code" ? pair.figma : pair.code)) {
    const removedFrom = dir === "figma-to-code" ? "Figma" : "code";
    return unresolve(ctx, finding, "unsupported", `"${pair.mode}" was removed from ${removedFrom}; remove it from the other side by hand, or resolve ${finding.token}:${pair.mode} the other way`);
  }

  if (dir === "figma-to-code") {
    const fv = pair.figma!;
    // Computed in code (calc(var(--spacing) * n), color-mix(…)): there is no plain value to rewrite.
    if (c.source.code?.derivedFrom) return unresolve(ctx, finding, "computed-in-code", `${c.source.code.selector}, with --${c.source.code.derivedFrom}`);
    const current = pair.code ?? c.values[DEFAULT_MODE];
    if (current && isColorMix(current.raw)) return unresolve(ctx, finding, "computed-in-code", current.raw);
    // A single-mode code token gets a mode override rather than having its shared default overwritten.
    let targetMode: ModeName;
    if (cSingle && !fSingle && pair.figmaMode !== f.modes[0]) targetMode = pair.mode; // new override block
    else if (pair.code) targetMode = pair.codeMode; // existing declaration
    else targetMode = pair.figmaMode === f.modes[0] ? DEFAULT_MODE : pair.mode; // missing mode: insert
    const loc = c.source.code!.modes[targetMode];
    if (!loc && targetMode !== DEFAULT_MODE && !ctx.settings.modeMap[targetMode]) return unresolve(ctx, finding, "no-code-mode-selector");

    const converted = codeTextFromFigma(forCode(ctx, fv, pair.figmaMode), c.key, c.values[targetMode] ?? c.values[DEFAULT_MODE], ctx.settings, ctx.fileColorFormat);
    if (!converted.ok) return unresolve(ctx, finding, fv.kind === "alias" ? "broken-alias" : "unsupported", converted.reason);

    push(
      ctx,
      {
        op: "update-code",
        // A new mode override uses the name Tailwind emits at runtime (prefixed), or it would have no effect.
        cssVar: loc?.cssVar ?? (targetMode !== DEFAULT_MODE && ctx.code.tailwindPrefix ? `--${ctx.code.tailwindPrefix}-${c.key}` : c.source.code!.cssVar),
        context: loc?.context ?? (targetMode === DEFAULT_MODE ? "theme" : `mode:${targetMode}`),
        from: loc ? (c.values[targetMode]?.raw ?? null) : null,
        to: converted.value,
        ...(converted.note ? { note: converted.note } : {}),
      },
      finding,
      via,
      converted.lock,
      { token: c.key, type: c.type, modes: { [pair.mode]: converted.lock } },
      pair.mode,
    );
    return;
  }

  // code -> Figma: Figma modes belong to the collection, so a missing one can't be invented here.
  const cv = pair.code!;
  if (!pair.figma && !f.source.figma!.modeIds[pair.figmaMode]) return unresolve(ctx, finding, "figma-mode-missing");
  if (fSingle && !cSingle && pair.codeMode !== DEFAULT_MODE) return unresolve(ctx, finding, "figma-mode-missing");

  let target = toFigma(ctx, cv, f.type);
  if (!target.ok) return unresolve(ctx, finding, "type-mismatch", target.reason);
  // Only alias in Figma if the alias gives code's value in this mode. A single-mode primitive aliased from
  // Dark gives its one (light) value, even when code overrides that primitive in dark.
  let note: string | undefined;
  if (cv.kind === "alias") {
    const expected = resolvedOr(ctx.code, cv, runtimeCodeMode(f, pair));
    const figmaTarget = ctx.figma.tokens.get(cv.ref);
    if (figmaTarget && expected.kind !== "alias") {
      const got = resolvedOr(ctx.figma, { kind: "alias", ref: cv.ref, raw: "" }, pair.figmaMode);
      if (!sameValue(ctx.settings, got, expected)) {
        const literal = toFigma(ctx, expected, f.type);
        if (literal.ok) {
          target = literal;
          note = `aliasing ${figmaTarget.source.figma?.name} would give ${got.raw} in ${pair.mode}, not code's value; wrote the value instead`;
        }
      }
    } else if (!figmaTarget && expected.kind !== "alias") {
      ctx.aliasChecks.set(`update-figma:${f.key}:${pair.mode}`, { ref: cv.ref, figmaMode: pair.figmaMode, expected });
    }
  }
  push(
    ctx,
    {
      op: "update-figma",
      variableId: f.source.figma!.variableId,
      modeId: f.source.figma!.modeIds[pair.figmaMode]!,
      from: figmaValueOf(pair.figma, (k) => ctx.figma.tokens.get(k)?.source.figma?.variableId),
      to: target.value,
      ...(note ? { note } : {}),
    },
    finding,
    via,
    target.lock,
    { token: f.key, type: c.type, modes: { [pair.mode]: target.lock } },
    pair.mode,
  );
}

function toFigma(ctx: Ctx, cv: NormalizedToken["values"][string], type: NormalizedToken["type"]) {
  const r = figmaValueFromCode(cv, type, ctx.figma.colorProfile ?? "srgb", ctx.settings);
  if (!r.ok) return r;
  if ("alias" in r) {
    const id = ctx.figma.tokens.get(r.alias)?.source.figma?.variableId;
    const value: FigmaValue = id ? { type: "ALIAS", variableId: id } : { type: "ALIAS", name: `${PENDING_ALIAS}${r.alias}` };
    return { ok: true as const, value, lock: { alias: r.alias } as LockModeEntry };
  }
  return r;
}

function addCode(ctx: Ctx, finding: Finding, f: NormalizedToken, via: Via) {
  // An exact var(--x) codeSyntax names the CSS token, so add it under that name. An identifier-shaped
  // codeSyntax that matched nothing gives no reliable name: ask instead of inventing one.
  const cssKey = f.source.figma?.codeSyntaxVar ?? f.key;
  if (!f.source.figma?.codeSyntaxVar && f.source.figma?.codeSyntaxUnmatched) {
    return unresolve(ctx, finding, "code-syntax-unmatched", f.source.figma.codeSyntax);
  }
  const single = f.modes.length === 1 && f.modes[0] === DEFAULT_MODE;
  const notes: string[] = [];
  const values: Record<string, string> = {};
  const modes: Record<ModeName, LockModeEntry> = {};
  let type: LockToken["type"] = f.type;

  for (const [i, mode] of f.modes.entries()) {
    const codeMode = single || i === 0 ? DEFAULT_MODE : mode;
    if (codeMode !== DEFAULT_MODE && !ctx.settings.modeMap[codeMode]) return unresolve(ctx, finding, "no-code-mode-selector", `mode "${codeMode}"`);
    const converted = codeTextFromFigma(forCode(ctx, f.values[mode]!, mode), cssKey, undefined, ctx.settings, ctx.fileColorFormat);
    if (converted.ok && converted.note) notes.push(`${mode}: ${converted.note}`);
    if (!converted.ok) return unresolve(ctx, finding, f.values[mode]!.kind === "alias" ? "broken-alias" : "unsupported", converted.reason);
    values[codeMode === DEFAULT_MODE ? "theme" : `mode:${codeMode}`] = converted.value;
    modes[i === 0 ? DEFAULT_MODE : mode] = converted.lock;
    if (/px$/.test(converted.value)) type = "dimension";
  }
  const prefix = ctx.code.tailwindPrefix;
  push(
    ctx,
    { op: "add-code", cssVar: `--${cssKey}`, values, ...(prefix ? { modeCssVar: `--${prefix}-${cssKey}` } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) },
    finding,
    via,
    null,
    { token: cssKey, type, modes },
  );
}

function addFigma(ctx: Ctx, finding: Finding, c: NormalizedToken, via: Via) {
  const explicit = ctx.resolutions.names?.[c.key];
  const inferred = explicit ? null : inferFigmaName(c.key, ctx.figma);
  if (!explicit && !inferred) return unresolve(ctx, finding, "needs-figma-name");
  const name = explicit ?? inferred!.name;

  const collection = pickCollection(ctx, c, inferred?.siblingCollectionId);
  if (!collection) return unresolve(ctx, finding, "no-target-collection");

  const values: Record<string, FigmaValue> = {};
  const modes: Record<ModeName, LockModeEntry> = {};
  for (const [i, m] of collection.modes.entries()) {
    const cv = c.values[i === 0 ? DEFAULT_MODE : m.name] ?? c.values[DEFAULT_MODE]!;
    const target = toFigma(ctx, cv, c.type);
    if (!target.ok) return unresolve(ctx, finding, "type-mismatch", target.reason);
    values[m.modeId] = target.value;
    modes[i === 0 ? DEFAULT_MODE : m.name] = target.lock;
  }

  const scopes = pickScopes(ctx, c, collection, inferred?.sibling);
  push(
    ctx,
    {
      op: "add-figma",
      name,
      collectionId: collection.id,
      collectionName: collection.name,
      type: c.type,
      values,
      naming: explicit ? { source: "explicit" } : { source: "inferred", sibling: inferred!.sibling },
      scopes: scopes.scopes,
      scopesFrom: scopes.from,
      codeSyntax: formatCodeSyntax(c.key, detectCodeSyntaxStyle(codeSyntaxValues(ctx.figma)), ctx.code.tailwindPrefix),
    },
    finding,
    via,
    null,
    { token: c.key, type: c.type, modes, figmaName: name },
  );
}

const NAMESPACE_SCOPES: Array<[RegExp, NormalizedToken["type"][], string[]]> = [
  [/^color-/, ["color"], ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"]],
  [/^spacing-/, ["dimension", "number"], ["GAP", "WIDTH_HEIGHT"]],
  [/^radius-/, ["dimension", "number"], ["CORNER_RADIUS"]],
  [/^text-/, ["dimension", "number"], ["FONT_SIZE"]],
  [/^font-/, ["string"], ["FONT_FAMILY"]],
];

/**
 * Explicit scopes for a new variable (never ALL_SCOPES by default): the naming sibling's when it has the same
 * type, else a Tailwind-namespace default, else the most common among same-type variables in the target
 * collection, else none. ALL_SCOPES on existing variables is ignored as "never set".
 */
function pickScopes(ctx: Ctx, c: NormalizedToken, collection: FigmaCollectionInfo, siblingKey: string | undefined): { scopes: string[]; from: "sibling" | "collection" | "namespace" | "none" } {
  const sameType = (t: NormalizedToken) => resolvedTypeOf(t.type) === resolvedTypeOf(c.type);
  // ALL_SCOPES is Figma's default and usually means "never set", so it is no signal to copy.
  const deliberate = (t: NormalizedToken | undefined) => {
    const scopes = t?.source.figma?.scopes;
    return scopes && !scopes.includes("ALL_SCOPES") ? scopes : undefined;
  };
  const sibling = siblingKey ? ctx.figma.tokens.get(siblingKey) : undefined;
  const siblingScopes = sibling && sameType(sibling) ? deliberate(sibling) : undefined;
  if (siblingScopes) return { scopes: [...siblingScopes], from: "sibling" };

  // The Tailwind namespace says what the token is for, which beats "same type in the same collection".
  const ns = NAMESPACE_SCOPES.find(([re, types]) => re.test(c.key) && types.includes(c.type));
  if (ns) return { scopes: [...ns[2]], from: "namespace" };

  const counts = new Map<string, number>();
  for (const t of ctx.figma.tokens.values()) {
    const scopes = deliberate(t);
    if (t.source.figma?.collectionId !== collection.id || !sameType(t) || !scopes) continue;
    const k = JSON.stringify([...scopes].sort());
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (common) return { scopes: JSON.parse(common[0]) as string[], from: "collection" };
  return { scopes: [], from: "none" };
}

function codeSyntaxValues(figma: TokenSet): string[] {
  return [...figma.tokens.values()].flatMap((t) => (t.source.figma?.codeSyntax ? [t.source.figma.codeSyntax] : []));
}

/** Explicit > the naming sibling's collection > --figma-collection > the only compatible collection. */
function pickCollection(ctx: Ctx, c: NormalizedToken, siblingCollectionId: string | undefined): FigmaCollectionInfo | null {
  const all = ctx.figma.figmaCollections ?? [];
  const compatible = all.filter((col) => fits(col, c));
  const byName = (name: string | null | undefined) => (name ? compatible.find((col) => col.name === name) : undefined);

  const explicit = ctx.resolutions.collections?.[c.key];
  if (explicit) return byName(explicit) ?? null;
  return compatible.find((col) => col.id === siblingCollectionId) ?? byName(ctx.figmaCollection) ?? (compatible.length === 1 ? compatible[0]! : null);
}

function fits(col: FigmaCollectionInfo, c: NormalizedToken): boolean {
  const cSingle = c.modes.length === 1 && c.modes[0] === DEFAULT_MODE;
  if (col.modes.length === 1) return cSingle;
  const names = new Set(col.modes.slice(1).map((m) => m.name));
  return c.modes.every((m) => m === DEFAULT_MODE || names.has(m));
}

function deleteFigma(ctx: Ctx, finding: Finding, f: NormalizedToken, via: Via) {
  push(ctx, { op: "delete-figma", variableId: f.source.figma!.variableId, destructive: true }, finding, via, null, null);
}

function deleteCode(ctx: Ctx, finding: Finding, c: NormalizedToken, via: Via) {
  const prefix = ctx.code.tailwindPrefix;
  push(ctx, { op: "delete-code", cssVar: c.source.code!.cssVar, ...(prefix ? { modeCssVar: `--${prefix}-${c.key}` } : {}), destructive: true }, finding, via, null, null);
}

/** Lock entry for an agreeing pair: always the resolved value, plus each side's alias. */
function lockEntryOf(ctx: Ctx, f: NormalizedToken, pair: Pair): LockModeEntry | null {
  return entryFromSides(resolvedOr(ctx.figma, pair.figma!, pair.figmaMode), resolvedOr(ctx.code, pair.code!, runtimeCodeMode(f, pair)), pair.figma!, pair.code!);
}

/** The values compare used for a pair: resolved, unless both are literals or alias the same variable. */
function comparable(ctx: Ctx, f: NormalizedToken, pair: Pair): [TokenValue, TokenValue] {
  return resolvesByValue(pair.figma!, pair.code!)
    ? [resolvedOr(ctx.figma, pair.figma!, pair.figmaMode), resolvedOr(ctx.code, pair.code!, runtimeCodeMode(f, pair))]
    : [pair.figma!, pair.code!];
}

/** A Figma alias whose target isn't a CSS token is written to code as its resolved value, not a dangling var(). */
function forCode(ctx: Ctx, value: TokenValue, mode: ModeName): TokenValue {
  return value.kind === "alias" && !ctx.code.tokens.has(value.ref) ? resolvedOr(ctx.figma, value, mode) : value;
}

// ---------------------------------------------------------------------------------------------
// Bookkeeping

type ActionBody = Action extends infer A ? (A extends Action ? Omit<A, "id" | "token" | "mode" | "finding" | "via" | "lock"> : never) : never;

function push(ctx: Ctx, body: ActionBody, finding: Finding | null, via: Via, lock: LockModeEntry | null, effect: LockEffect | null, mode?: ModeName) {
  const token = finding?.token ?? effect!.token;
  const m = mode ?? finding?.mode ?? null;
  const id = `${body.op}:${token}:${m ?? "*"}`;
  if (ctx.actions.some((a) => a.id === id)) return;
  ctx.actions.push({ id, token, mode: m, finding: finding?.id ?? null, via, lock, ...body } as Action);
  if (effect) ctx.effects.set(id, effect);
}

function unresolve(ctx: Ctx, finding: Finding, reason: UnresolvedReason, detail?: string) {
  if (ctx.unresolved.some((u) => u.finding === finding.id)) return;
  ctx.unresolved.push({ finding: finding.id, token: finding.token, mode: finding.mode, reason, hint: hint(finding, reason, detail) });
}

function hint(finding: Finding, reason: UnresolvedReason, detail?: string): string {
  const rk = `"${finding.token}:${finding.mode ?? "*"}"`;
  const suffix = detail ? ` (${detail})` : "";
  switch (reason) {
    case "conflict":
      return `Changed on both sides since the last sync. Add ${rk}: "figma" | "code" | "skip" to a resolutions file.`;
    case "no-lock-difference":
      return `No lock entry says which side changed. Pass --prefer code|figma, or add ${rk}: "figma" | "code" to a resolutions file.`;
    case "type-mismatch":
      return `The two sides have different types${suffix}. Fix one side by hand, then re-run plan.`;
    case "broken-alias":
      return `Fix the alias, or resolve ${rk} to the side whose value is valid${suffix}.`;
    case "needs-figma-name":
      return `No existing Figma variable shares a name prefix to copy naming from. Add "${finding.token}": "<Group/Name>" under "names" in a resolutions file.`;
    case "no-target-collection":
      return `No single Figma collection fits this token's modes. Add "${finding.token}": "<collection name>" under "collections" in a resolutions file, or pass --figma-collection.`;
    case "figma-mode-missing":
      return `The Figma collection has no "${finding.mode}" mode, so this value can't be synced. Add the mode in Figma, remove the override from code by hand, or keep it code-only with ${rk}: "skip".`;
    case "no-code-mode-selector":
      return `No CSS selector is configured for this mode${suffix || ` "${finding.mode}"`}. Pass --mode <name>=<selector>.`;
    case "code-syntax-unmatched":
      return `Its codeSyntax.WEB (${detail}) matches no token in code, so the CSS name is unknown. Set it in Figma to the CSS variable you want, e.g. var(--color-accent), then re-plan.`;
    case "computed-in-code":
      return `Code computes this value (${detail}), so it can't be edited directly. Change what it's computed from in code, change the value in Figma, or resolve ${rk} to "code".`;
    case "depends-on-unresolved":
      return `Aliases a token that this plan cannot create yet${suffix}. Resolve that token first.`;
    default:
      return `Not supported${suffix}.`;
  }
}

/** Aliases to variables this plan creates point at the new name; drop actions whose alias target isn't created. */
function finalizeAliases(ctx: Ctx) {
  const created = new Map(ctx.actions.flatMap((a) => (a.op === "add-figma" ? [[a.token, a.name] as const] : [])));
  const fix = (v: FigmaValue): FigmaValue | string => {
    if (v.type !== "ALIAS" || !("name" in v) || !v.name.startsWith(PENDING_ALIAS)) return v;
    const key = v.name.slice(PENDING_ALIAS.length);
    return created.has(key) ? { type: "ALIAS", name: created.get(key)! } : key;
  };

  for (const action of [...ctx.actions]) {
    const values = action.op === "update-figma" ? { only: action.to } : action.op === "add-figma" ? action.values : null;
    if (!values) continue;
    for (const [k, v] of Object.entries(values)) {
      const fixed = fix(v);
      if (typeof fixed === "string") {
        ctx.actions.splice(ctx.actions.indexOf(action), 1);
        ctx.effects.delete(action.id);
        const finding = action.finding ?? action.id;
        ctx.unresolved.push({ finding, token: action.token, mode: action.mode, reason: "depends-on-unresolved", hint: hint({ token: action.token, mode: action.mode } as Finding, "depends-on-unresolved", fixed) });
        break;
      }
      if (action.op === "update-figma") action.to = fixed;
      else (values as Record<string, FigmaValue>)[k] = fixed;
    }
  }

  // Aliases to variables created in this plan: check the new variable's value in the aliasing mode.
  for (const action of ctx.actions) {
    const check = ctx.aliasChecks.get(action.id);
    if (!check || action.op !== "update-figma" || action.to.type !== "ALIAS") continue;
    const create = ctx.actions.find((a): a is Extract<Action, { op: "add-figma" }> => a.op === "add-figma" && a.token === check.ref);
    const collection = create && ctx.figma.figmaCollections?.find((c) => c.id === create.collectionId);
    if (!create || !collection) continue;
    const mode = collection.modes.find((m) => m.name === check.figmaMode) ?? collection.modes[0]!;
    const planned = create.values[mode.modeId];
    const got = planned ? figmaValueAsToken(planned, ctx.figma.colorProfile ?? "srgb") : null;
    if (got && !sameValue(ctx.settings, got, check.expected)) {
      const literal = toFigma(ctx, check.expected, create.type);
      if (literal.ok) {
        action.to = literal.value;
        action.note = `aliasing the new ${create.name} would give ${got.raw} here, not code's value; wrote the value instead`;
      }
    }
  }
}

function figmaValueAsToken(v: FigmaValue, profile: "srgb" | "display-p3"): TokenValue | null {
  if (v.type === "COLOR") return { kind: "color", color: { space: profile, r: v.r, g: v.g, b: v.b, alpha: v.a }, raw: `color(${profile} ${v.r} ${v.g} ${v.b})` };
  if (v.type === "FLOAT") return { kind: "number", value: v.value, raw: String(v.value) };
  if (v.type === "STRING") return { kind: "string", value: v.value, raw: v.value };
  return null;
}

function buildLockAfter(ctx: Ctx, profile: LockFile["figmaColorProfile"], baseline: Map<TokenKey, Record<ModeName, LockModeEntry>>): LockFile {
  const tokens: Record<TokenKey, LockToken> = structuredClone(ctx.lock?.tokens ?? {});
  const ensure = (key: TokenKey, type: LockToken["type"]) => (tokens[key] ??= { type, modes: {} });

  for (const [key, modes] of baseline) {
    const t = ensure(key, ctx.code.tokens.get(key)?.type ?? ctx.figma.tokens.get(key)!.type);
    Object.assign(t.modes, modes);
  }
  for (const effect of ctx.effects.values()) {
    const t = ensure(effect.token, effect.type);
    Object.assign(t.modes, effect.modes);
    if (effect.figmaName) t.figma = { name: effect.figmaName };
  }
  // Older locks keyed a multi-mode token's base mode by Figma's name ("light"); it's "default" now.
  for (const [key, t] of Object.entries(tokens)) {
    const f = ctx.figma.tokens.get(key);
    const base = f && f.modes.length > 1 ? f.modes[0]! : null;
    if (base && base !== DEFAULT_MODE && t.modes[base]) {
      t.modes[DEFAULT_MODE] ??= t.modes[base]!;
      delete t.modes[base];
    }
  }
  // Figma identity for everything that exists in Figma, so later matching survives renames.
  for (const [key, t] of Object.entries(tokens)) {
    const f = ctx.figma.tokens.get(key)?.source.figma;
    if (f) t.figma = { variableId: f.variableId, name: f.name };
  }
  // Tokens gone from both sides have nothing left to track.
  for (const key of Object.keys(tokens)) {
    const pending = [...ctx.effects.values()].some((e) => e.token === key);
    if (!pending && !ctx.figma.tokens.has(key) && !ctx.code.tokens.has(key)) delete tokens[key];
  }

  const sorted = Object.fromEntries(Object.entries(tokens).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { version: 1, figmaColorProfile: profile, tokens: sorted };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function byTokenModeId(a: Action, b: Action): number {
  return cmp(a.token, b.token) || cmp(a.mode ?? "", b.mode ?? "") || cmp(a.id, b.id);
}

