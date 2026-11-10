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
  let best: { token: NormalizedToken; shared: number; score: number; segs: string[] } | null = null;

  for (const token of [...figma.tokens.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const name = token.source.figma?.name;
    if (!name || token.key === key) continue;
    // A sibling tells us how key segments map to name groups when its key is its name (by the default rule),
    // or its name with a leading namespace dropped, as a codeSyntax match reveals: green/500 <-> color-green-500.
    const nameKey = figmaNameToKey(name);
    const lead = nameKey === token.key ? "" : token.key.endsWith(`-${nameKey}`) ? token.key.slice(0, token.key.length - nameKey.length) : null;
    if (lead === null || !key.startsWith(lead)) continue;
    const segs = key.slice(lead.length).split("-");
    const shared = sharedPrefix(segs, nameKey.split("-"));
    // Prefer the sibling that explains more of the key: its namespace plus the shared name segments.
    const score = shared + (lead ? lead.split("-").filter(Boolean).length : 0);
    if (shared > 0 && (!best || score > best.score)) best = { token, shared, score, segs };
  }
  if (!best) return null;
  const segs = best.segs;

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
