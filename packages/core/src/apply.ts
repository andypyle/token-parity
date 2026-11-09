// apply: execute a plan. Edits CSS in place and writes the Figma change set for the skill.
// The lock only moves when nothing needs to reach Figma; otherwise a pending lock waits for commit.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { editCss } from "./css-edit.js";
import { InputError } from "./errors.js";
import { defaultChangesPath, pendingPath, sha256, toJson, type Pending } from "./state.js";
import type { Action, FigmaChangeSet, FigmaOperation, Plan } from "./types.js";
import { resolvedTypeOf } from "./values.js";

/** An input changed after plan ran. CLI exit code 2. */
export class StalePlanError extends Error {
  constructor(file: string) {
    super(`${file} changed since the plan was made; re-run plan.`);
    this.name = "StalePlanError";
  }
}

export interface ApplyOptions {
  allowDeletes: boolean;
  changesOut?: string;
}

export interface ApplyResult {
  applied: string[];
  /** Destructive actions skipped because deletes were not allowed. */
  skipped: string[];
  figmaChanges: FigmaChangeSet;
  /** True when Figma has changes to push; the lock is then pending until commit. */
  pending: boolean;
  /** Where figma-changes.json was written, when there is anything to push. */
  changesPath: string | null;
  wrote: string[];
}

export async function applyPlan(plan: Plan, options: ApplyOptions): Promise<ApplyResult> {
  const { figma, code, lock } = plan.inputs;
  const css = await readOrNull(code.path);
  if (css === null) throw new InputError("cannot read file", code.path);
  if (sha256(css) !== code.sha256) throw new StalePlanError(code.path);
  const figmaText = await readOrNull(figma.path);
  if (figmaText === null || sha256(figmaText) !== figma.sha256) throw new StalePlanError(figma.path);
  const lockText = await readOrNull(lock.path);
  if ((lockText === null ? null : sha256(lockText)) !== lock.sha256) throw new StalePlanError(lock.path);

  const run = plan.actions.filter((a) => options.allowDeletes || !isDelete(a));
  const skipped = plan.actions.filter((a) => !run.includes(a)).map((a) => a.id);
  const wrote: string[] = [];

  // Code
  const codeActions = run.filter((a): a is Extract<Action, { op: "update-code" | "add-code" | "delete-code" }> =>
    a.op === "update-code" || a.op === "add-code" || a.op === "delete-code",
  );
  const newCss = codeActions.length > 0 ? editCss(css, code.path, codeActions, plan.settings.modeMap) : css;
  if (newCss !== css) {
    await writeFile(code.path, newCss);
    wrote.push(code.path);
  }

  // Figma
  const figmaChanges: FigmaChangeSet = {
    version: 1,
    colorProfile: plan.lockAfter.figmaColorProfile,
    basedOn: { figmaSha256: figma.sha256 },
    operations: figmaOperations(run),
  };

  // Lock
  const nextLock = structuredClone(plan.lockAfter);
  for (const a of run) if (isDelete(a)) delete nextLock.tokens[a.token];

  const pending = figmaChanges.operations.length > 0;
  let changesPath: string | null = null;
  if (!pending) {
    await writeFile(lock.path, toJson(nextLock));
    wrote.push(lock.path);
  } else {
    changesPath = options.changesOut ?? defaultChangesPath(lock.path);
    await mkdir(dirname(changesPath), { recursive: true });
    await writeFile(changesPath, toJson(figmaChanges));
    const state: Pending = {
      version: 1,
      plan: plan.inputs,
      applied: run.map((a) => a.id),
      touched: [...new Set(run.map((a) => a.token))].sort(),
      codeSha256: sha256(newCss),
      changesPath,
      lock: nextLock,
    };
    const statePath = pendingPath(lock.path);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, toJson(state));
    wrote.push(changesPath, statePath);
  }

  return { applied: run.map((a) => a.id), skipped, figmaChanges, pending, changesPath, wrote };
}

const isDelete = (a: Action) => a.op === "delete-code" || a.op === "delete-figma";

/** Creates, then values (new variables first), then deletes. */
function figmaOperations(actions: Action[]): FigmaOperation[] {
  const creates: FigmaOperation[] = [];
  const sets: FigmaOperation[] = [];
  const updates: FigmaOperation[] = [];
  const deletes: FigmaOperation[] = [];
  for (const a of actions) {
    if (a.op === "add-figma") {
      creates.push({ op: "create-variable", name: a.name, collectionId: a.collectionId, resolvedType: resolvedTypeOf(a.type) });
      for (const [modeId, value] of Object.entries(a.values)) sets.push({ op: "set-value", variableName: a.name, modeId, value });
    } else if (a.op === "update-figma") {
      updates.push({ op: "set-value", variableId: a.variableId, modeId: a.modeId, value: a.to });
    } else if (a.op === "delete-figma") {
      deletes.push({ op: "delete-variable", variableId: a.variableId });
    }
  }
  return [...creates, ...sets, ...updates, ...deletes];
}

async function readOrNull(path: string): Promise<string | null> {
  return existsSync(path) ? readFile(path, "utf8") : null;
}
