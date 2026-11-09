// commit: after the skill pushed figma-changes.json, verify a fresh Figma export against the pending
// lock. Only when every token apply touched is in sync does the pending lock become tokens.lock.json.
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { readFigmaExport } from "./adapters/figma.js";
import { readTailwindCss } from "./adapters/tailwind.js";
import { keysByVariableId, parseJson, readText } from "./check.js";
import { compare } from "./compare.js";
import { InputError } from "./errors.js";
import { parseLock } from "./lock.js";
import { pendingPath, sha256, toJson, type Pending } from "./state.js";
import type { Diagnostic, Finding, Plan } from "./types.js";

export interface CommitResult {
  ok: boolean;
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
  const freshJson = parseJson(await readText(freshFigmaPath), freshFigmaPath);
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
  const figma = readFigmaExport(freshJson, freshFigmaPath, keysByVariableId(lock));
  const code = readTailwindCss(css, plan.inputs.code.path, settings.modeMap);
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
