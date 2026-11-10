// Keep every file token-parity writes or deletes inside the project folder. Paths come from the config, from
// plan.json and from .token-parity/pending.json, which a cloned repository controls. Without this, a crafted
// plan or pending file could make apply overwrite, or commit delete, a file anywhere on the machine.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { InputError } from "./errors.js";

/** The real path of `path`, resolving symlinks through its nearest existing ancestor. */
function realPath(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(realPath(parent), basename(abs));
}

/** True when `path` (after resolving symlinks) is `root` or inside it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(realPath(root), realPath(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Throw unless `path` is inside `root`. */
export function assertInside(root: string, path: string, what: string): void {
  if (!isInside(root, path)) {
    throw new InputError(`${what} is outside the project folder (${realPath(root)}); token-parity only writes inside it. Run it from your project's root.`, path);
  }
}
