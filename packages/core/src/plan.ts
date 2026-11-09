// plan: turn the three-way comparison into concrete actions, or into items that need a decision.
//
// Directions come from, in order: an explicit resolution ("token:mode" -> figma | code | skip), the
// direction check suggested (lock-based), or --prefer for first-sync differences. Conflicts never take
// --prefer. Nothing is guessed: anything else is listed in `unresolved` with a hint.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadInputs, parseJson } from "./check.js";
import { compare, lockMatches, pairModes, type Pair } from "./compare.js";
import { InputError } from "./errors.js";
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
  type Unresolved,
  type UnresolvedReason,
} from "./types.js";
import { codeTextFromFigma, entryFromSides, figmaValueFromCode, figmaValueOf, resolvedTypeOf } from "./values.js";
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
  };

  const { findings } = compare({ figma, code, lock, settings });
  const byToken = new Map<TokenKey, Finding[]>();
  for (const f of findings) byToken.set(f.token, [...(byToken.get(f.token) ?? []), f]);

  const baseline = new Map<TokenKey, Record<ModeName, LockModeEntry>>();
  for (const key of [...new Set([...figma.tokens.keys(), ...code.tokens.keys()])].sort()) {
    const f = figma.tokens.get(key);
    const c = code.tokens.get(key);
    const tokenFindings = (byToken.get(key) ?? []).filter((x) => x.kind !== "out-of-gamut");
    if (f && c) collectBaseline(ctx, f, c, tokenFindings, baseline);
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

function collectBaseline(ctx: Ctx, f: NormalizedToken, c: NormalizedToken, findings: Finding[], out: Map<TokenKey, Record<ModeName, LockModeEntry>>) {
  if (findings.some((x) => x.mode === null)) return; // whole-token problem: leave the lock alone
  const busy = new Set(findings.map((x) => x.mode));
  const lockToken = ctx.lock?.tokens[f.key];
  const lockCtx = { lockRgbUsable: !ctx.lock || ctx.lock.figmaColorProfile === (ctx.figma.colorProfile ?? "srgb"), settings: ctx.settings };

  for (const pair of pairModes(f, c)) {
    if (busy.has(pair.mode) || busy.has(pair.figmaMode) || busy.has(pair.codeMode) || !pair.figma || !pair.code) continue;
    const existing = lockToken?.modes[pair.mode];
    if (existing && lockMatches(lockCtx, "figma", pair.figma, existing) && lockMatches(lockCtx, "code", pair.code, existing)) continue;
    const entry = entryFromSides(pair.figma, pair.code);
    if (!entry) continue;
    out.set(f.key, { ...out.get(f.key), [pair.mode]: entry });
  }
}

// ---------------------------------------------------------------------------------------------
// Findings -> actions

function handleFinding(ctx: Ctx, finding: Finding, f: NormalizedToken | undefined, c: NormalizedToken | undefined) {
  if (finding.kind === "near-match") {
    const pair = f && c ? pairModes(f, c).find((p) => p.mode === finding.mode) : undefined;
    const entry = pair?.figma && pair.code ? entryFromSides(pair.figma, pair.code) : null;
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
    case "broken-alias": {
      const pairs = pairModes(f!, c!).filter((p) =>
        finding.kind === "broken-alias" ? (finding.alias!.side === "figma" ? p.figmaMode : p.codeMode) === finding.mode : p.mode === finding.mode,
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
  const firstSync = finding.kind === "value-mismatch" && finding.mode !== null && finding.changed.figma === null && finding.changed.code === null;
  if (firstSync && ctx.prefer) return { dir: ctx.prefer === "figma" ? "figma-to-code" : "code-to-figma", via: "prefer" };

  const reason: UnresolvedReason =
    finding.kind === "broken-alias"
      ? "broken-alias"
      : finding.kind === "value-mismatch"
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
    // A single-mode code token gets a mode override rather than having its shared default overwritten.
    let targetMode: ModeName;
    if (cSingle && !fSingle && pair.mode !== f.modes[0]) targetMode = pair.mode; // new override block
    else if (pair.code) targetMode = pair.codeMode; // existing declaration
    else targetMode = pair.mode === f.modes[0] ? DEFAULT_MODE : pair.mode; // missing mode: insert
    const loc = c.source.code!.modes[targetMode];
    if (!loc && targetMode !== DEFAULT_MODE && !ctx.settings.modeMap[targetMode]) return unresolve(ctx, finding, "no-code-mode-selector");

    const converted = codeTextFromFigma(fv, c.key, c.values[targetMode] ?? c.values[DEFAULT_MODE], ctx.settings);
    if (!converted.ok) return unresolve(ctx, finding, fv.kind === "alias" ? "broken-alias" : "unsupported", converted.reason);

    push(
      ctx,
      {
        op: "update-code",
        cssVar: loc?.cssVar ?? c.source.code!.cssVar,
        context: loc?.context ?? (targetMode === DEFAULT_MODE ? "theme" : `mode:${targetMode}`),
        from: loc ? (c.values[targetMode]?.raw ?? null) : null,
        to: converted.value,
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

  const target = toFigma(ctx, cv, f.type);
  if (!target.ok) return unresolve(ctx, finding, "type-mismatch", target.reason);
  push(
    ctx,
    {
      op: "update-figma",
      variableId: f.source.figma!.variableId,
      modeId: f.source.figma!.modeIds[pair.figmaMode]!,
      from: figmaValueOf(pair.figma, (k) => ctx.figma.tokens.get(k)?.source.figma?.variableId),
      to: target.value,
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
  const single = f.modes.length === 1 && f.modes[0] === DEFAULT_MODE;
  const values: Record<string, string> = {};
  const modes: Record<ModeName, LockModeEntry> = {};
  let type: LockToken["type"] = f.type;

  for (const [i, mode] of f.modes.entries()) {
    const codeMode = single || i === 0 ? DEFAULT_MODE : mode;
    if (codeMode !== DEFAULT_MODE && !ctx.settings.modeMap[codeMode]) return unresolve(ctx, finding, "no-code-mode-selector", `mode "${codeMode}"`);
    const converted = codeTextFromFigma(f.values[mode]!, f.key, undefined, ctx.settings);
    if (!converted.ok) return unresolve(ctx, finding, f.values[mode]!.kind === "alias" ? "broken-alias" : "unsupported", converted.reason);
    values[codeMode === DEFAULT_MODE ? "theme" : `mode:${codeMode}`] = converted.value;
    modes[mode] = converted.lock;
    if (/px$/.test(converted.value)) type = "dimension";
  }
  push(ctx, { op: "add-code", cssVar: `--${f.key}`, values }, finding, via, null, { token: f.key, type, modes });
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
    modes[m.name] = target.lock;
  }

  const scopes = pickScopes(ctx, c, collection, inferred?.sibling);
  push(
    ctx,
    {
      op: "add-figma",
      name,
      collectionId: collection.id,
      type: c.type,
      values,
      naming: explicit ? { source: "explicit" } : { source: "inferred", sibling: inferred!.sibling },
      scopes: scopes.scopes,
      scopesFrom: scopes.from,
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
  push(ctx, { op: "delete-code", cssVar: c.source.code!.cssVar, destructive: true }, finding, via, null, null);
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
      return `The Figma collection has no "${finding.mode}" mode. Add the mode in Figma, or resolve ${rk} to "figma".`;
    case "no-code-mode-selector":
      return `No CSS selector is configured for this mode${suffix || ` "${finding.mode}"`}. Pass --mode <name>=<selector>.`;
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

