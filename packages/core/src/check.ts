// Orchestrates one `check`: load inputs -> normalize -> three-way compare -> Report.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readFigmaExport } from "./adapters/figma.js";
import { readTailwindCss } from "./adapters/tailwind.js";
import { compare } from "./compare.js";
import { InputError } from "./errors.js";
import { parseLock } from "./lock.js";
import { DEFAULT_SETTINGS, FINDING_KINDS, type CompareSettings, type Diagnostic, type FindingKind, type LockFile, type Report } from "./types.js";
import { VERSION } from "./version.js";

export interface CheckOptions {
  figmaPath: string;
  codePath: string;
  lockPath: string | null;
  settings?: Partial<CompareSettings>;
}

export async function check(options: CheckOptions): Promise<Report> {
  const settings: CompareSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const extra: Diagnostic[] = [];

  // A lock path that does not exist yet is the normal first run: compare without a baseline.
  let lockPath = options.lockPath;
  if (lockPath && !existsSync(lockPath)) {
    extra.push({ level: "info", origin: "lock", message: `${lockPath} does not exist yet; comparing without a baseline.` });
    lockPath = null;
  }

  const [figmaJson, css, lockJson] = await Promise.all([
    readJson(options.figmaPath),
    readText(options.codePath),
    lockPath ? readJson(lockPath) : Promise.resolve(null),
  ]);

  const figma = readFigmaExport(figmaJson, options.figmaPath);
  const code = readTailwindCss(css, options.codePath, settings.modeMap);
  const lock: LockFile | null = lockPath ? parseLock(lockJson, lockPath) : null;

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

/** 1 when there is drift (any error finding or error diagnostic), else 0. Warnings and near-matches pass. */
export function exitCodeFor(report: Report): 0 | 1 {
  return report.summary.errors > 0 || report.diagnostics.some((d) => d.level === "error") ? 1 : 0;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new InputError(`cannot read file (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`, path);
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InputError(`invalid JSON: ${(err as Error).message}`, path);
  }
}
