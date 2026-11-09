// Names for new Figma variables. Figma naming is up to each team, so nothing is assumed:
// the name is either given explicitly, or copied from the closest existing variable's convention.
import { figmaNameToKey } from "./adapters/figma.js";
import type { NormalizedToken, TokenKey, TokenSet } from "./types.js";

export interface InferredName {
  name: string;
  sibling: TokenKey;
  siblingCollectionId: string;
}

/**
 * Use the Figma variable whose key shares the longest leading run of segments with `key`.
 * Keep its group path for the shared part, then build the rest from the key, copying the casing and
 * word separator of the sibling's group at that depth.
 * Returns null when no variable shares a segment, so the caller can ask the user.
 */
export function inferFigmaName(key: TokenKey, figma: TokenSet): InferredName | null {
  const segs = key.split("-");
  let best: { token: NormalizedToken; shared: number } | null = null;

  for (const token of [...figma.tokens.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const name = token.source.figma?.name;
    // Only siblings whose name follows the default rule tell us how key segments map to groups.
    if (!name || token.key === key || figmaNameToKey(name) !== token.key) continue;
    const shared = sharedPrefix(segs, token.key.split("-"));
    if (shared > 0 && (!best || shared > best.shared)) best = { token, shared };
  }
  if (!best) return null;

  const groups = best.token.source.figma!.name.split("/");
  const kept: string[] = [];
  let covered = 0;
  for (const group of groups) {
    const count = figmaNameToKey(group).split("-").filter(Boolean).length;
    if (covered + count > best.shared) break;
    kept.push(group.trim());
    covered += count;
  }
  const leaf = segs.slice(covered);
  if (leaf.length === 0) return null;

  const styleGroup = groups[kept.length] ?? groups[groups.length - 1]!;
  return {
    name: [...kept, formatLike(styleGroup.trim(), leaf)].join("/"),
    sibling: best.token.key,
    siblingCollectionId: best.token.source.figma!.collectionId,
  };
}

function sharedPrefix(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

type Casing = "lower" | "upper" | "title";

/** Render `words` in the style of `sample` (e.g. "Brand Primary", "brand-primary", "brandPrimary"). */
export function formatLike(sample: string, words: string[]): string {
  const camel = /[a-z][A-Z]/.test(sample) && !/[\s_-]/.test(sample);
  const sep = sample.includes(" ") ? " " : sample.includes("_") ? "_" : sample.includes("-") ? "-" : null;
  const letters = sample.replace(/[^A-Za-z]/g, "");
  const casing: Casing =
    letters.length > 0 && letters === letters.toUpperCase() && letters.length > 1
      ? "upper"
      : /^[A-Z]/.test(sample)
        ? "title"
        : "lower";

  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  if (camel) return words.map((w, i) => (i === 0 ? w : cap(w))).join("");
  const cased = words.map((w) => (casing === "upper" ? w.toUpperCase() : casing === "title" ? cap(w) : w));
  return cased.join(sep ?? (casing === "title" ? " " : "-"));
}
