// Figma adapter: a JSON export of local variables -> TokenSet.
// The input mirrors the shape of Figma's REST `variables/local` response and the Plugin API,
// plus a top-level `colorProfile` ("srgb" | "display-p3"). Colors stay RGB here; compare decides
// whether to use the locked OKLCH or convert.
import { formatRgb } from "../color.js";
import { InputError } from "../errors.js";
import {
  DEFAULT_MODE,
  type ColorProfile,
  type Diagnostic,
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

export function readFigmaExport(input: unknown, file: string): TokenSet {
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
  const byId = new Map(vars.map((v) => [v.id, { key: figmaNameToKey(v.name), name: v.name }]));

  const tokens = new Map<string, NormalizedToken>();
  const allModes = new Set<ModeName>();

  for (const v of vars) {
    const key = figmaNameToKey(v.name);
    const collection = collections.get(v.variableCollectionId);
    if (!collection) throw new InputError(`variable ${v.name} references unknown collection ${v.variableCollectionId}`, file);
    if (tokens.has(key)) {
      diagnostics.push({ level: "error", origin: "figma", token: key, message: `"${v.name}" maps to the same key as another variable; ignored.` });
      continue;
    }

    // Default mode first, then the rest in collection order. Single-mode collections use DEFAULT_MODE.
    const ordered = [...collection.modes].sort((a, b) => Number(b.modeId === collection.defaultModeId) - Number(a.modeId === collection.defaultModeId));
    const single = ordered.length === 1;
    const type = TYPE_MAP[v.resolvedType];
    const values: Record<ModeName, TokenValue> = {};
    const modes: ModeName[] = [];

    for (const mode of ordered) {
      const name = single ? DEFAULT_MODE : figmaModeName(mode.name);
      const raw = v.valuesByMode[mode.modeId];
      if (raw === undefined) continue;
      values[name] = toValue(raw, type, profile, byId, `${v.name} (${mode.name})`, file);
      modes.push(name);
      allModes.add(name);
    }

    tokens.set(key, {
      key,
      type,
      modes,
      values,
      source: { origin: "figma", figma: { variableId: v.id, name: v.name, collection: collection.name } },
    });
  }

  return { origin: "figma", colorProfile: profile, modes: [...allModes], tokens, diagnostics };
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
