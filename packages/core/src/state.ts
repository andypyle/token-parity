// Where apply leaves its work for commit: <lock dir>/.token-parity/
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { LockFile, Plan } from "./types.js";

export const stateDir = (lockPath: string) => join(dirname(lockPath), ".token-parity");
export const pendingPath = (lockPath: string) => join(stateDir(lockPath), "pending.json");
export const defaultChangesPath = (lockPath: string) => join(stateDir(lockPath), "figma-changes.json");
export const defaultPlanPath = (lockPath: string) => join(stateDir(lockPath), "plan.json");

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface Pending {
  version: 1;
  /** Plan input hashes, so commit can tell which plan this belongs to. */
  plan: Plan["inputs"];
  applied: string[];
  /** Tokens touched by applied actions; commit requires these to be in sync. */
  touched: string[];
  /** Hash of the CSS as apply left it. */
  codeSha256: string;
  changesPath: string;
  lock: LockFile;
}

export const toJson = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
