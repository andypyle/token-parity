// Figma adapter: a JSON export of local variables -> TokenSet.
// The input mirrors the shape of Figma's REST `variables/local` response and the Plugin API,
// plus a top-level `colorProfile` ("srgb" | "display-p3"). Colors stay RGB here; compare decides
// whether to use the locked OKLCH or convert.
import { codeSyntaxVarName, resolveCodeSyntax } from "../code-syntax.js";
import { formatRgb } from "../color.js";
import { InputError } from "../errors.js";
import {
  DEFAULT_MODE,
  type ColorProfile,
  type Diagnostic,
  type FigmaCollectionInfo,
  type ModeName,
  type NormalizedToken,
  type TokenSet,
  type TokenType,
  type TokenValue,
} from "../types.js";

interface FigmaMode {
  modeId: string;
  name: string;
}
interface FigmaCollection {
  id: string;
  name: string;
  modes: FigmaMode[];
  defaultModeId: string;
}
interface FigmaVariable {
  id: string;
  name: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
  scopes?: string[];
  codeSyntax?: { WEB?: string };
}

const TYPE_MAP: Record<FigmaVariable["resolvedType"], TokenType> = {
  COLOR: "color",
  FLOAT: "number",
  STRING: "string",
  BOOLEAN: "boolean",
};

/** Missing alias targets keep their raw Figma id behind this prefix so compare reports them. */
export const UNKNOWN_FIGMA_REF = "figma-variable:";

const segment = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/** "color/brand/primary" -> "color-brand-primary". */
export function figmaNameToKey(name: string): string {
  return name.split("/").map(segment).filter(Boolean).join("-");
}

export const figmaModeName = segment;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Token keys come from, in order: the variable's codeSyntax.WEB (when it resolves; see code-syntax.ts), the
 * key recorded in the lock for its id, then the default name rule.
 *
 * @param codeKeys Token keys present in code. Needed to resolve indirect codeSyntax forms (classes, Sass,
 *   camelCase); without it only `var(--x)` / `--x` are used.
 * @param keyByVariableId Keys recorded in the lock, by Figma variable id. These take precedence over the
 *   default name rule, so variables with custom names (or renamed in Figma) stay matched to their token.
 */
export function readFigmaExport(
  input: unknown,
  file: string,
  keyByVariableId: ReadonlyMap<string, string> = new Map(),
  codeKeys?: ReadonlySet<string>,
  tailwindPrefix?: string | null,
): TokenSet {
  if (!isObject(input)) throw new InputError("expected a JSON object", file);
  if (input.format !== undefined) input = expandCompactExport(input, file);
  if (!isObject(input)) throw new InputError("expected a JSON object", file);
  const { variableCollections, variables, colorProfile } = input;
  if (!isObject(variableCollections)) throw new InputError("`variableCollections` must be an object keyed by id", file);
  if (!isObject(variables)) throw new InputError("`variables` must be an object keyed by id", file);

  const diagnostics: Diagnostic[] = [];
  let profile: ColorProfile = "srgb";
  if (colorProfile === "srgb" || colorProfile === "display-p3") {
    profile = colorProfile;
  } else if (colorProfile === undefined) {
    diagnostics.push({ level: "warning", origin: "figma", message: "No `colorProfile` in the export; assuming sRGB." });
  } else {
    throw new InputError(`unsupported colorProfile ${JSON.stringify(colorProfile)} (expected "srgb" or "display-p3")`, file);
  }

  const collections = new Map<string, FigmaCollection>();
  for (const [id, raw] of Object.entries(variableCollections)) {
    if (!isObject(raw) || !Array.isArray(raw.modes) || typeof raw.name !== "string") {
      throw new InputError(`collection ${id} is malformed`, file);
    }
    collections.set(id, raw as unknown as FigmaCollection);
  }

  const vars = Object.entries(variables).map(([id, raw]) => {
    if (!isObject(raw) || typeof raw.name !== "string" || !isObject(raw.valuesByMode) || !(String(raw.resolvedType) in TYPE_MAP)) {
      throw new InputError(`variable ${id} is malformed`, file);
    }
    return raw as unknown as FigmaVariable;
  });
  const match: KeyMatching = { lockKeys: keyByVariableId, codeKeys, prefix: tailwindPrefix ?? null, diagnostics, unmatched: new Set(), notNames: [] };
  const keys = new Map(vars.map((v) => [v.id, variableKey(v, match)]));
  if (codeKeys && match.notNames.length > 0) {
    const examples = match.notNames.slice(0, 3).map((n) => `"${n}"`).join(", ");
    diagnostics.push({
      level: "info",
      origin: "figma",
      message: `${match.notNames.length} variable${match.notNames.length === 1 ? "'s" : "s'"} codeSyntax.WEB doesn't name a CSS token (e.g. ${examples}); matched by name instead.`,
    });
  }
  const unmatched = match.unmatched;
  const keyOf = (v: FigmaVariable) => keys.get(v.id)!;
  const byId = new Map(vars.map((v) => [v.id, { key: keyOf(v), name: v.name }]));

  const figmaCollections: FigmaCollectionInfo[] = [...collections.values()].map((c) => {
    const ordered = orderModes(c);
    return {
      id: c.id,
      name: c.name,
      modes: ordered.map((m) => ({ modeId: m.modeId, name: ordered.length === 1 ? DEFAULT_MODE : figmaModeName(m.name) })),
    };
  });

  const tokens = new Map<string, NormalizedToken>();
  const allModes = new Set<ModeName>();

  for (const v of vars) {
    const key = keyOf(v);
    const collection = collections.get(v.variableCollectionId);
    if (!collection) throw new InputError(`variable ${v.name} references unknown collection ${v.variableCollectionId}`, file);
    if (tokens.has(key)) {
      diagnostics.push({ level: "error", origin: "figma", token: key, message: `"${v.name}" maps to --${key}, like another variable (check names and codeSyntax); ignored.` });
      continue;
    }

    // Default mode first, then the rest in collection order. Single-mode collections use DEFAULT_MODE.
    const ordered = orderModes(collection);
    const single = ordered.length === 1;
    const type = TYPE_MAP[v.resolvedType];
    const values: Record<ModeName, TokenValue> = {};
    const modes: ModeName[] = [];
    const modeIds: Record<ModeName, string> = {};

    for (const mode of ordered) {
      const name = single ? DEFAULT_MODE : figmaModeName(mode.name);
      const raw = v.valuesByMode[mode.modeId];
      if (raw === undefined) continue;
      values[name] = toValue(raw, type, profile, byId, `${v.name} (${mode.name})`, file);
      modes.push(name);
      modeIds[name] = mode.modeId;
      allModes.add(name);
    }

    tokens.set(key, {
      key,
      type,
      modes,
      values,
      source: { origin: "figma", figma: {
          variableId: v.id,
          name: v.name,
          collection: collection.name,
          collectionId: collection.id,
          modeIds,
          ...(Array.isArray(v.scopes) ? { scopes: v.scopes } : {}),
          ...(typeof v.codeSyntax?.WEB === "string" ? { codeSyntax: v.codeSyntax.WEB } : {}),
          ...(unmatched.has(v.id) ? { codeSyntaxUnmatched: true } : {}),
          ...(codeSyntaxVarName(v.codeSyntax?.WEB ?? "", tailwindPrefix) ? { codeSyntaxVar: codeSyntaxVarName(v.codeSyntax!.WEB!, tailwindPrefix)! } : {}),
        },
      },
    });
  }

  return { origin: "figma", colorProfile: profile, figmaCollections, modes: [...allModes], tokens, diagnostics };
}

interface KeyMatching {
  lockKeys: ReadonlyMap<string, string>;
  codeKeys: ReadonlySet<string> | undefined;
  prefix: string | null;
  diagnostics: Diagnostic[];
  /** Identifier-shaped codeSyntax that matched nothing: plan must not invent a CSS name for these. */
  unmatched: Set<string>;
  /** codeSyntax values that aren't names at all (calc(...), 2px, ...), reported once as info. */
  notNames: string[];
}

function variableKey(v: FigmaVariable, m: KeyMatching): string {
  const lockKey = m.lockKeys.get(v.id);
  const fallback = lockKey ?? figmaNameToKey(v.name);
  const web = v.codeSyntax?.WEB?.trim();
  if (!web) return fallback;

  const r = resolveCodeSyntax(web, v.resolvedType, m.codeKeys, m.prefix);
  if (r.ok) {
    if (lockKey && lockKey !== r.key) {
      m.diagnostics.push({ level: "info", origin: "figma", token: r.key, message: `"${v.name}" now maps to --${r.key} through its codeSyntax (was --${lockKey}).` });
    }
    return r.key;
  }
  if (!m.codeKeys) return fallback; // nothing to check against yet

  if (r.problem === "var-not-in-code") {
    m.diagnostics.push({
      level: "warning",
      origin: "figma",
      token: fallback,
      message: `"${v.name}" codeSyntax.WEB "${web}" names --${r.tried[0]}, which isn't in code; matched by name (--${fallback}) instead.`,
    });
  } else if (r.problem === "not-a-name") {
    m.notNames.push(`${v.name}: ${web}`);
  } else {
    m.unmatched.add(v.id);
    m.notNames.push(`${v.name}: ${web}`);
  }
  return fallback;
}

function orderModes(c: FigmaCollection): FigmaMode[] {
  return [...c.modes].sort((a, b) => Number(b.modeId === c.defaultModeId) - Number(a.modeId === c.defaultModeId));
}

function toValue(raw: unknown, type: TokenType, profile: ColorProfile, byId: Map<string, { key: string; name: string }>, where: string, file: string): TokenValue {
  if (isObject(raw) && raw.type === "VARIABLE_ALIAS" && typeof raw.id === "string") {
    // raw uses DTCG alias syntax with the Figma variable name, or the bare id when the target is missing.
    const target = byId.get(raw.id);
    return target
      ? { kind: "alias", ref: target.key, raw: `{${target.name}}` }
      : { kind: "alias", ref: `${UNKNOWN_FIGMA_REF}${raw.id}`, raw: `{${raw.id}}` };
  }
  switch (type) {
    case "color": {
      if (!isObject(raw) || typeof raw.r !== "number" || typeof raw.g !== "number" || typeof raw.b !== "number") {
        throw new InputError(`${where}: expected {r,g,b,a} color`, file);
      }
      const color = { space: profile, r: raw.r, g: raw.g, b: raw.b, alpha: typeof raw.a === "number" ? raw.a : 1 };
      return { kind: "color", color, raw: formatRgb(color) };
    }
    case "number":
      if (typeof raw !== "number") throw new InputError(`${where}: expected a number`, file);
      return { kind: "number", value: raw, raw: String(raw) };
    case "string":
      if (typeof raw !== "string") throw new InputError(`${where}: expected a string`, file);
      return { kind: "string", value: raw, raw };
    default:
      if (typeof raw !== "boolean") throw new InputError(`${where}: expected a boolean`, file);
      return { kind: "boolean", value: raw, raw: String(raw) };
  }
}

// ---------------------------------------------------------------------------------------------
// Compact export (token-parity/compact@1), written by the plugin to keep transfers small.

export const COMPACT_FORMAT = "token-parity/compact@1";

/** Restore a full id from its compact form: constant prefix dropped, or "!" + the raw id. */
export function fullId(prefix: string, short: string): string {
  return short.startsWith("!") ? short.slice(1) : prefix + short;
}

/** Expand the compact export into the REST-like shape (variableCollections / variables keyed by id). */
export function expandCompactExport(input: Record<string, unknown>, file: string): Record<string, unknown> {
  if (input.format !== COMPACT_FORMAT) throw new InputError(`unsupported export format ${JSON.stringify(input.format)}`, file);
  if (!Array.isArray(input.collections)) throw new InputError("`collections` must be an array", file);
  const variableCollections: Record<string, unknown> = {};
  const variables: Record<string, unknown> = {};

  for (const c of input.collections as unknown[]) {
    if (!isObject(c) || typeof c.id !== "string" || typeof c.name !== "string" || !Array.isArray(c.modes) || !Array.isArray(c.variables)) {
      throw new InputError("malformed collection in compact export", file);
    }
    const collectionId = fullId("VariableCollectionId:", c.id);
    const modes = (c.modes as unknown[]).map((m) => {
      if (!Array.isArray(m) || typeof m[0] !== "string" || typeof m[1] !== "string") throw new InputError(`malformed mode in ${c.name}`, file);
      return { modeId: m[0] as string, name: m[1] as string };
    });
    variableCollections[collectionId] = { id: collectionId, name: c.name, modes, defaultModeId: c.default };

    for (const v of c.variables as unknown[]) {
      if (!isObject(v) || typeof v.id !== "string" || typeof v.name !== "string" || !Array.isArray(v.values)) {
        throw new InputError(`malformed variable in ${c.name}`, file);
      }
      const id = fullId("VariableID:", v.id);
      const valuesByMode: Record<string, unknown> = {};
      modes.forEach((m, i) => {
        const value = (v.values as unknown[])[i];
        if (value === null || value === undefined) return;
        if (Array.isArray(value)) valuesByMode[m.modeId] = { r: value[0], g: value[1], b: value[2], a: value[3] ?? 1 };
        else if (isObject(value) && typeof value.alias === "string") valuesByMode[m.modeId] = { type: "VARIABLE_ALIAS", id: fullId("VariableID:", value.alias) };
        else valuesByMode[m.modeId] = value;
      });
      variables[id] = {
        id,
        name: v.name,
        resolvedType: v.type,
        variableCollectionId: collectionId,
        valuesByMode,
        scopes: v.scopes,
        ...(typeof v.code === "string" ? { codeSyntax: { WEB: v.code } } : {}),
      };
    }
  }
  return { colorProfile: input.colorProfile, variableCollections, variables };
}
