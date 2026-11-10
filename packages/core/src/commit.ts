// commit: after the skill pushed figma-changes.json, verify a fresh Figma export against the pending
// lock. Only when every token apply touched is in sync does the pending lock become tokens.lock.json.
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { expandCompactExport, readFigmaExport } from "./adapters/figma.js";
import { readTailwindCss } from "./adapters/tailwind.js";
import { keysByVariableId, parseJson, readText } from "./check.js";
import { compare } from "./compare.js";
import { deriveComputedTokens } from "./derive.js";
import { InputError } from "./errors.js";
import { parseLock } from "./lock.js";
import { pendingPath, sha256, toJson, type Pending } from "./state.js";
import { tpChecksum } from "./figma-bridge.js";
import { isCompactExport, predictExport, type PushResult } from "./predict.js";
import type { Diagnostic, FigmaChangeSet, Finding, Plan } from "./types.js";

export interface CommitResult {
  ok: boolean;
  /** Set by commitFromPush when Figma's post-push state differs from the prediction; export again and commit. */
  predictionMismatch?: boolean;
  /** Findings on touched tokens that are not in sync yet. */
  problems: Finding[];
  diagnostics: Diagnostic[];
  lockPath: string;
}

export async function commitPending(plan: Plan, freshFigmaPath: string): Promise<CommitResult> {
  const lockPath = plan.inputs.lock.path;
  const statePath = pendingPath(lockPath);
  if (!existsSync(statePath)) throw new InputError("nothing pending; run apply first", statePath);
  const pending = parseJson(await readFile(statePath, "utf8"), statePath) as Pending;
  if (pending.plan.figma.sha256 !== plan.inputs.figma.sha256 || pending.plan.code.sha256 !== plan.inputs.code.sha256) {
    throw new InputError("the pending changes come from a different plan", statePath);
  }

  const diagnostics: Diagnostic[] = [];
  let freshJson = parseJson(await readText(freshFigmaPath), freshFigmaPath);
  if (isCompactExport(freshJson)) freshJson = expandCompactExport(freshJson as unknown as Record<string, unknown>, freshFigmaPath);
  const lock = parseLock(structuredClone(pending.lock), statePath);

  // New variables got their ids in Figma: record them so matching uses ids from now on.
  const variables = Object.values((freshJson as { variables?: Record<string, { id: string; name: string }> }).variables ?? {});
  for (const token of Object.values(lock.tokens)) {
    if (token.figma && !token.figma.variableId) {
      const found = variables.find((v) => v.name === token.figma!.name);
      if (found) token.figma.variableId = found.id;
    }
  }

  const css = await readText(plan.inputs.code.path);
  if (sha256(css) !== pending.codeSha256) {
    diagnostics.push({ level: "warning", origin: "code", message: `${plan.inputs.code.path} changed after apply; verifying against its current contents.` });
  }

  const settings = plan.settings;
  const code = readTailwindCss(css, plan.inputs.code.path, settings.modeMap, settings.prefix ?? null, settings.colorFormat === "oklch");
  const figma = readFigmaExport(freshJson, freshFigmaPath, keysByVariableId(lock), new Set(code.tokens.keys()), code.tailwindPrefix ?? null);
  deriveComputedTokens(figma, code);
  const { findings } = compare({ figma, code, lock, settings });
  const touched = new Set(pending.touched);
  const problems = findings.filter((f) => touched.has(f.token) && f.severity !== "warning");

  if (problems.length > 0) return { ok: false, problems, diagnostics, lockPath };

  // Fresh ids/names for every variable, not just new ones.
  for (const [key, token] of Object.entries(lock.tokens)) {
    const f = figma.tokens.get(key)?.source.figma;
    if (f) token.figma = { variableId: f.variableId, name: f.name };
  }
  await writeFile(lockPath, toJson(lock));
  await rm(statePath);
  if (existsSync(pending.changesPath)) await rm(pending.changesPath);
  return { ok: true, problems: [], diagnostics, lockPath };
}

/**
 * Commit without a second export: predict Figma's post-push export from the pre-push export and the change
 * set, confirm it against the checksum the push returned, write it to the export path, then commit as usual.
 */
export async function commitFromPush(plan: Plan, push: PushResult): Promise<CommitResult> {
  const lockPath = plan.inputs.lock.path;
  const statePath = pendingPath(lockPath);
  if (!existsSync(statePath)) throw new InputError("nothing pending; run apply first", statePath);
  if (typeof push?.exportChecksum !== "string" || !Array.isArray(push.created)) {
    throw new InputError("push result must be the object use_figma returned: { created, exportChecksum, ... }");
  }
  const pending = parseJson(await readFile(statePath, "utf8"), statePath) as Pending;

  const figmaPath = plan.inputs.figma.path;
  const beforeText = await readText(figmaPath);
  if (sha256(beforeText) !== plan.inputs.figma.sha256) throw new InputError("changed since plan; export again and run commit with --figma", figmaPath);
  const before = parseJson(beforeText, figmaPath);
  if (!isCompactExport(before)) throw new InputError("is in the older export format; export again and run commit with --figma", figmaPath);
  const changes = parseJson(await readText(pending.changesPath), pending.changesPath) as FigmaChangeSet;

  const predicted = predictExport(before, changes, push);
  if (tpChecksum(JSON.stringify(predicted)) !== push.exportChecksum) {
    return { ok: false, predictionMismatch: true, problems: [], diagnostics: [], lockPath };
  }
  await writeFile(figmaPath, toJson(predicted));
  return commitPending(plan, figmaPath);
}
