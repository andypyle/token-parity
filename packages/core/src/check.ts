// Orchestrates one `check`: load inputs -> normalize -> three-way compare -> Report.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readFigmaExport } from "./adapters/figma.js";
import { readTailwindCss } from "./adapters/tailwind.js";
import { compare } from "./compare.js";
import { InputError } from "./errors.js";
import { parseLock } from "./lock.js";
import { DEFAULT_SETTINGS, FINDING_KINDS, type CompareSettings, type Diagnostic, type FindingKind, type LockFile, type Report, type TokenSet } from "./types.js";
import { VERSION } from "./version.js";

export interface CheckOptions {
  figmaPath: string;
  codePath: string;
  lockPath: string | null;
  settings?: Partial<CompareSettings>;
}

export interface LoadedInputs {
  settings: CompareSettings;
  figma: TokenSet;
  code: TokenSet;
  lock: LockFile | null;
  /** null when no lock path was given or the file does not exist yet. */
  lockPath: string | null;
  /** Raw file contents, for hashing and editing. */
  text: { figma: string; code: string; lock: string | null };
  diagnostics: Diagnostic[];
}

/** Read and normalize all inputs. Shared by check, plan and commit so they always match tokens the same way. */
export async function loadInputs(options: CheckOptions): Promise<LoadedInputs> {
  const settings: CompareSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const diagnostics: Diagnostic[] = [];

  // A lock path that does not exist yet is the normal first run: compare without a baseline.
  let lockPath = options.lockPath;
  if (lockPath && !existsSync(lockPath)) {
    diagnostics.push({ level: "info", origin: "lock", message: `${lockPath} does not exist yet; comparing without a baseline.` });
    lockPath = null;
  }

  const [figmaText, codeText, lockText] = await Promise.all([
    readText(options.figmaPath),
    readText(options.codePath),
    lockPath ? readText(lockPath) : Promise.resolve(null),
  ]);

  const lock: LockFile | null = lockPath && lockText !== null ? parseLock(parseJson(lockText, lockPath), lockPath) : null;
  const figma = readFigmaExport(parseJson(figmaText, options.figmaPath), options.figmaPath, keysByVariableId(lock));
  const code = readTailwindCss(codeText, options.codePath, settings.modeMap);
  diagnostics.push(...renameDiagnostics(figma, lock));

  return { settings, figma, code, lock, lockPath, text: { figma: figmaText, code: codeText, lock: lockText }, diagnostics };
}

export async function check(options: CheckOptions): Promise<Report> {
  const { settings, figma, code, lock, lockPath, diagnostics: extra } = await loadInputs(options);
  const result = compare({ figma, code, lock, settings });
  const byKind = Object.fromEntries(FINDING_KINDS.map((k) => [k, 0])) as Record<FindingKind, number>;
  for (const f of result.findings) byKind[f.kind]++;

  return {
    schemaVersion: 1,
    tool: { name: "token-parity", version: VERSION },
    inputs: { figma: options.figmaPath, code: options.codePath, lock: lockPath, figmaColorProfile: figma.colorProfile ?? "srgb" },
    settings,
    summary: {
      tokensCompared: result.tokensCompared,
      inSync: result.inSync,
      byKind,
      errors: result.findings.filter((f) => f.severity === "error").length,
      warnings: result.findings.filter((f) => f.severity === "warning").length,
    },
    findings: result.findings,
    diagnostics: [...extra, ...figma.diagnostics, ...code.diagnostics, ...result.diagnostics],
  };
}

/** Lock token keys by Figma variable id, so matching survives custom names and renames. */
export function keysByVariableId(lock: LockFile | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, token] of Object.entries(lock?.tokens ?? {})) {
    if (token.figma?.variableId) map.set(token.figma.variableId, key);
  }
  return map;
}

function renameDiagnostics(figma: TokenSet, lock: LockFile | null): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [key, token] of Object.entries(lock?.tokens ?? {})) {
    const current = figma.tokens.get(key)?.source.figma;
    if (current && token.figma && token.figma.variableId === current.variableId && token.figma.name !== current.name) {
      out.push({ level: "info", origin: "figma", token: key, message: `Figma variable renamed from "${token.figma.name}" to "${current.name}"; still matched by id.` });
    }
  }
  return out;
}

/** 1 when there is drift (any error finding or error diagnostic), else 0. Warnings and near-matches pass. */
export function exitCodeFor(report: Report): 0 | 1 {
  return report.summary.errors > 0 || report.diagnostics.some((d) => d.level === "error") ? 1 : 0;
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new InputError(`cannot read file (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`, path);
  }
}

export function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InputError(`invalid JSON: ${(err as Error).message}`, path);
  }
}
