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

/** Where one mode's value is declared in CSS. context: "theme" | "root" | "mode:<name>". */
export interface CodeLocation {
  cssVar: string;
  context: string;
  line: number;
  selector: string;
}

export interface TokenSource {
  origin: "figma" | "code";
  figma?: {
    variableId: string;
    name: string;
    collection: string;
    collectionId: string;
    /** Normalized mode name -> Figma modeId. */
    modeIds: Record<ModeName, string>;
    /** Variable scopes, when the export includes them. */
    scopes?: string[];
  };
  code?: {
    cssVar: string;
    file: string;
    line: number;
    selector: string;
    /** Per-mode declaration site (differs from cssVar for pass-through variables). */
    modes: Record<ModeName, CodeLocation>;
  };
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

export interface FigmaCollectionInfo {
  id: string;
  name: string;
  /** Default mode first. `name` is normalized; single-mode collections use DEFAULT_MODE. */
  modes: Array<{ modeId: string; name: ModeName }>;
}

export interface TokenSet {
  origin: "figma" | "code";
  colorProfile?: ColorProfile;
  figmaCollections?: FigmaCollectionInfo[];
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
  /** Figma identity. Matching prefers variableId, so renamed variables stay matched. variableId is absent until commit for new variables. */
  figma?: { variableId?: string; name: string };
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

// ---------- Plan (Phase 2) ----------

export interface Resolutions {
  version: 1;
  /** "token:mode" (or "token:*") -> which side wins. */
  resolutions?: Record<string, "figma" | "code" | "skip">;
  /** Figma names for new variables. */
  names?: Record<TokenKey, string>;
  /** Target collection (by name) for new variables. */
  collections?: Record<TokenKey, string>;
}

export type FigmaValue =
  | { type: "COLOR"; r: number; g: number; b: number; a: number }
  | { type: "FLOAT"; value: number }
  | { type: "STRING"; value: string }
  | { type: "BOOLEAN"; value: boolean }
  | { type: "ALIAS"; variableId: string }
  | { type: "ALIAS"; name: string };

export interface ActionBase {
  id: string;
  token: TokenKey;
  mode: ModeName | null;
  finding: string | null;
  via: "suggested" | "prefer" | "resolution" | "near-match";
  lock: LockModeEntry | null;
}

export type Action = ActionBase &
  (
    | { op: "update-code"; cssVar: string; context: string; from: string | null; to: string }
    | { op: "add-code"; cssVar: string; values: Record<string, string> } // keyed by context
    | { op: "delete-code"; cssVar: string; destructive: true }
    | { op: "update-figma"; variableId: string; modeId: string; from: FigmaValue | null; to: FigmaValue }
    | {
        op: "add-figma";
        name: string;
        collectionId: string;
        collectionName: string;
        type: TokenType;
        values: Record<string, FigmaValue>; // keyed by modeId
        naming: { source: "explicit" | "inferred"; sibling?: string };
        scopes: string[];
        scopesFrom: "sibling" | "collection" | "namespace" | "none";
      }
    | { op: "delete-figma"; variableId: string; destructive: true }
    | { op: "lock-only" }
  );

export type UnresolvedReason =
  | "conflict"
  | "no-lock-difference"
  | "broken-alias"
  | "type-mismatch"
  | "no-target-collection"
  | "needs-figma-name"
  | "figma-mode-missing"
  | "no-code-mode-selector"
  | "depends-on-unresolved"
  | "unsupported";

export interface Unresolved {
  finding: string;
  token: TokenKey;
  mode: ModeName | null;
  reason: UnresolvedReason;
  hint: string;
}

export interface Plan {
  schemaVersion: 1;
  tool: { name: "token-parity"; version: string };
  inputs: {
    figma: { path: string; sha256: string };
    code: { path: string; sha256: string };
    lock: { path: string; sha256: string | null };
  };
  settings: CompareSettings;
  options: { prefer: "code" | "figma" | null; resolutions: string | null; figmaCollection: string | null };
  actions: Action[];
  unresolved: Unresolved[];
  /** Finding ids the resolutions file marked "skip". */
  skipped: string[];
  /** The lock after every action lands. Deleted tokens keep their old entries here; apply removes them only when the delete runs. */
  lockAfter: LockFile;
}

// ---------- Figma change set: the contract with the skill ----------

export type FigmaOperation =
  | { op: "create-variable"; name: string; collectionId: string; resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN"; scopes: string[] }
  | ({ op: "set-value"; modeId: string; value: FigmaValue } & ({ variableId: string } | { variableName: string }))
  | { op: "delete-variable"; variableId: string };

export interface FigmaChangeSet {
  version: 1;
  colorProfile: ColorProfile;
  /** exportChecksum: checksum of the Figma export the plan was made from; the push script refuses if Figma differs. */
  basedOn: { figmaSha256: string; exportChecksum: string };
  /** Run in order: all creates, then all set-values, then deletes. */
  operations: FigmaOperation[];
}
