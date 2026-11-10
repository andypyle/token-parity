// Reads and validates tokens.lock.json. Phase 1 never writes the lock.
import { parseOklch } from "./color.js";
import { InputError } from "./errors.js";
import type { LockFile, LockModeEntry, TokenType } from "./types.js";

const TYPES: readonly TokenType[] = ["color", "dimension", "number", "string", "boolean"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRgba = (v: unknown) => isObject(v) && ["r", "g", "b", "a"].every((k) => typeof v[k] === "number");

export function parseLock(input: unknown, file: string): LockFile {
  if (!isObject(input)) throw new InputError("expected a JSON object", file);
  if (input.version !== 1) throw new InputError(`unsupported lock version ${JSON.stringify(input.version)} (expected 1)`, file);
  if (input.figmaColorProfile !== "srgb" && input.figmaColorProfile !== "display-p3") {
    throw new InputError('`figmaColorProfile` must be "srgb" or "display-p3"', file);
  }
  if (!isObject(input.tokens)) throw new InputError("`tokens` must be an object", file);

  for (const [key, token] of Object.entries(input.tokens)) {
    if (!isObject(token) || !TYPES.includes(token.type as TokenType) || !isObject(token.modes)) {
      throw new InputError(`token ${key} is malformed`, file);
    }
    if (token.figma !== undefined) {
      const f = token.figma;
      if (!isObject(f) || typeof f.name !== "string" || (f.variableId !== undefined && typeof f.variableId !== "string")) {
        throw new InputError(`token ${key}: \`figma\` must be { name, variableId? }`, file);
      }
    }
    for (const [mode, entry] of Object.entries(token.modes)) {
      const where = `${key} (${mode})`;
      if (!isLockEntry(entry)) throw new InputError(`${where}: expected {oklch, figmaRgb}, {value} or {alias}`, file);
      if ("oklch" in entry && !parseOklch(entry.oklch)) throw new InputError(`${where}: ${entry.oklch} is not an oklch() color`, file);
    }
  }
  return input as unknown as LockFile;
}

function isLockEntry(v: unknown): v is LockModeEntry {
  if (!isObject(v)) return false;
  for (const k of ["figmaAlias", "codeAlias"]) if (k in v && typeof v[k] !== "string") return false;
  if ("oklch" in v) return typeof v.oklch === "string" && isRgba(v.figmaRgb);
  if ("value" in v) return typeof v.value === "string";
  if ("alias" in v) return typeof v.alias === "string";
  return false;
}
