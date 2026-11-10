// token-parity.config.json: project defaults for the CLI (and the skill). Paths are relative to the file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { InputError } from "./errors.js";
import type { CompareSettings } from "./types.js";

export const CONFIG_FILE = "token-parity.config.json";

export interface Config {
  /** Figma file URL. Used by the skill only. */
  figmaFile?: string;
  figma?: string;
  code?: string;
  lock?: string;
  resolutions?: string;
  figmaCollection?: string;
  modes?: Record<string, string[]>;
  nearThreshold?: number;
  rgbTolerance?: number;
  precision?: { l: number; c: number; h: number };
  remBase?: number;
  /** Tailwind prefix (`prefix(ds)` -> "ds"), when it isn't declared in the `code` file. */
  prefix?: string;
  /** Tokens to leave alone: `animate-*`, `dark/*`, `color-amber-*:dark`. */
  ignore?: string[];
  /** How colors are written into CSS: "preserve" (default), "oklch", "hex" or "rgb". */
  colorFormat?: "preserve" | "oklch" | "hex" | "rgb";
}

const PATH_KEYS = ["figma", "code", "lock", "resolutions"] as const;

/** Load the config named by --config, or ./token-parity.config.json if present. Returns {} when there is none. */
export function loadConfig(explicit: string | undefined, cwd = process.cwd()): Config {
  const path = explicit ? resolve(cwd, explicit) : join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    if (explicit) throw new InputError("config file not found", explicit);
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new InputError(`invalid JSON: ${(err as Error).message}`, path);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new InputError("expected a JSON object", path);
  const config = { ...(raw as Config) };

  const fail = (msg: string) => {
    throw new InputError(msg, path);
  };
  for (const key of [...PATH_KEYS, "figmaFile", "figmaCollection", "prefix"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "string") fail(`"${key}" must be a string`);
  }
  for (const key of ["nearThreshold", "rgbTolerance", "remBase"] as const) {
    if (config[key] !== undefined && (typeof config[key] !== "number" || config[key]! < 0)) fail(`"${key}" must be a non-negative number`);
  }
  if (config.modes !== undefined) {
    const ok = typeof config.modes === "object" && Object.values(config.modes).every((v) => Array.isArray(v) && v.every((s) => typeof s === "string"));
    if (!ok) fail('"modes" must map mode names to arrays of selectors, e.g. { "dark": [".dark"] }');
  }
  if (config.ignore !== undefined && !(Array.isArray(config.ignore) && config.ignore.every((p) => typeof p === "string" && p.length > 0))) {
    fail('"ignore" must be an array of patterns, e.g. ["animate-*", "dark/*", "color-amber-*:dark"]');
  }
  if (config.colorFormat !== undefined && !["preserve", "oklch", "hex", "rgb"].includes(config.colorFormat)) {
    fail('"colorFormat" must be "preserve", "oklch", "hex" or "rgb"');
  }
  if (config.precision !== undefined) {
    const p = config.precision;
    if (typeof p !== "object" || !["l", "c", "h"].every((k) => Number.isInteger((p as Record<string, unknown>)[k]))) fail('"precision" must be { "l": int, "c": int, "h": int }');
  }

  const base = dirname(path);
  for (const key of PATH_KEYS) {
    const value = config[key];
    if (value !== undefined && !isAbsolute(value)) config[key] = join(base, value);
  }
  return config;
}

export function settingsFromConfig(config: Config): Partial<CompareSettings> {
  const s: Partial<CompareSettings> = {};
  if (config.modes) s.modeMap = config.modes;
  if (config.nearThreshold !== undefined) s.nearThreshold = config.nearThreshold;
  if (config.rgbTolerance !== undefined) s.rgbTolerance = config.rgbTolerance;
  if (config.precision) s.precision = config.precision;
  if (config.remBase !== undefined) s.remBase = config.remBase;
  if (config.prefix !== undefined) s.prefix = config.prefix;
  if (config.ignore !== undefined) s.ignore = config.ignore;
  if (config.colorFormat !== undefined) s.colorFormat = config.colorFormat;
  return s;
}
