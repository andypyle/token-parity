// Shared types for token-parity. See the Phase 1 plan for the reviewed schemas.

/** Canonical kebab key, e.g. "color-brand-primary". Figma "color/brand/primary" and CSS "--color-brand-primary" both map here. */
export type TokenKey = string;
/** Mode name, e.g. "light" or "dark". Single-mode values use DEFAULT_MODE. */
export type ModeName = string;
export const DEFAULT_MODE = "default";

export type TokenType = "color" | "dimension" | "number" | "string" | "boolean";
export type ColorProfile = "srgb" | "display-p3";

export interface OklchColor {
  space: "oklch";
  l: number;
  c: number;
  h: number | null;
  alpha: number;
}

/** RGB with 0-1 float channels, as Figma stores it. */
export interface RgbColor {
  space: ColorProfile;
  r: number;
  g: number;
  b: number;
  alpha: number;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type DimensionUnit = "px" | "rem" | "em" | "%";

export type TokenValue =
  | { kind: "color"; color: OklchColor | RgbColor; raw: string }
  | { kind: "dimension"; value: number; unit: DimensionUnit; raw: string }
  | { kind: "number"; value: number; raw: string }
  | { kind: "string"; value: string; raw: string }
  | { kind: "boolean"; value: boolean; raw: string }
  | { kind: "alias"; ref: TokenKey; raw: string };

export interface TokenSource {
  origin: "figma" | "code";
  figma?: { variableId: string; name: string; collection: string };
  code?: { cssVar: string; file: string; line: number; selector: string };
}

export interface NormalizedToken {
  key: TokenKey;
  type: TokenType;
  modes: ModeName[];
  values: Record<ModeName, TokenValue>;
  source: TokenSource;
}

export interface Diagnostic {
  level: "error" | "warning" | "info";
  origin: "figma" | "code" | "lock";
  message: string;
  token?: TokenKey;
}

export interface TokenSet {
  origin: "figma" | "code";
  colorProfile?: ColorProfile;
  modes: ModeName[];
  tokens: Map<TokenKey, NormalizedToken>;
  diagnostics: Diagnostic[];
}

// ---------- Lock file ----------

export type LockModeEntry =
  | { oklch: string; figmaRgb: Rgba }
  | { value: string }
  | { alias: TokenKey };

export interface LockToken {
  type: TokenType;
  modes: Record<ModeName, LockModeEntry>;
}

export interface LockFile {
  version: 1;
  figmaColorProfile: ColorProfile;
  tokens: Record<TokenKey, LockToken>;
}

// ---------- Settings ----------

export interface CompareSettings {
  /** ΔE_OK below which a differing color is a near-match rather than drift. */
  nearThreshold: number;
  /** Per-channel tolerance (0-1 scale) for "Figma RGB still matches the locked RGB". */
  rgbTolerance: number;
  /** Decimal places used when converting changed Figma RGB to OKLCH. */
  precision: { l: number; c: number; h: number };
  /** px per rem, for comparing Figma numbers to code dimensions. */
  remBase: number;
  /** Mode name -> CSS selectors (or "@variant <name>") that hold that mode's overrides. */
  modeMap: Record<ModeName, string[]>;
}

export const DEFAULT_SETTINGS: CompareSettings = {
  nearThreshold: 0.005,
  rgbTolerance: 0.5 / 255,
  precision: { l: 4, c: 4, h: 2 },
  remBase: 16,
  modeMap: { dark: [".dark", '[data-theme="dark"]', "@variant dark"] },
};

// ---------- Report ----------

export type FindingKind =
  | "missing-in-code"
  | "missing-in-figma"
  | "value-mismatch"
  | "near-match"
  | "broken-alias"
  | "missing-mode"
  | "conflict"
  | "out-of-gamut";

export const FINDING_KINDS: readonly FindingKind[] = [
  "missing-in-code",
  "missing-in-figma",
  "value-mismatch",
  "near-match",
  "broken-alias",
  "missing-mode",
  "conflict",
  "out-of-gamut",
];

export type Severity = "error" | "warning" | "info";
export type Direction = "figma-to-code" | "code-to-figma" | "none" | "needs-decision";

export interface SideValue {
  raw: string;
  oklch?: string;
  oklchSource?: "code" | "lock" | "converted";
  alias?: TokenKey;
  location: TokenSource;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  token: TokenKey;
  mode: ModeName | null;
  type: TokenType;
  figma: SideValue | null;
  code: SideValue | null;
  lock: LockModeEntry | null;
  changed: { figma: boolean | null; code: boolean | null };
  suggestedDirection: Direction;
  distance?: number;
  gamut?: { profile: ColorProfile; mappedRgb: Rgba };
  alias?: { ref: TokenKey; problem: "missing-target" | "cycle" | "type-mismatch"; side: "figma" | "code" };
  message: string;
}

export interface Report {
  schemaVersion: 1;
  tool: { name: "token-parity"; version: string };
  inputs: { figma: string; code: string; lock: string | null; figmaColorProfile: ColorProfile };
  settings: CompareSettings;
  summary: {
    tokensCompared: number;
    inSync: number;
    byKind: Record<FindingKind, number>;
    errors: number;
    warnings: number;
  };
  findings: Finding[];
  diagnostics: Diagnostic[];
}
