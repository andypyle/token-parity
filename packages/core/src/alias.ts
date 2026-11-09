import type { ModeName, NormalizedToken, TokenKey, TokenSet, TokenValue } from "./types.js";

export type Literal = Exclude<TokenValue, { kind: "alias" }>;

export type Resolution =
  | { ok: true; value: Literal; target: NormalizedToken }
  | { ok: false; problem: "missing-target" | "cycle"; ref: TokenKey };

/** The value a token has in `mode`, falling back to its default (first) mode for single-mode tokens. */
export function valueInMode(token: NormalizedToken, mode: ModeName): TokenValue | undefined {
  return token.values[mode] ?? (token.modes.length === 1 ? token.values[token.modes[0]!] : undefined);
}

/** Follow an alias chain within one side's token set until a literal value. */
export function resolveAlias(set: TokenSet, value: TokenValue, mode: ModeName): Resolution | { ok: true; value: Literal; target: null } {
  if (value.kind !== "alias") return { ok: true, value, target: null };
  const seen = new Set<TokenKey>();
  let current: TokenValue = value;
  let target: NormalizedToken | undefined;
  while (current.kind === "alias") {
    const ref: TokenKey = current.ref;
    if (seen.has(ref)) return { ok: false, problem: "cycle", ref: value.ref };
    seen.add(ref);
    target = set.tokens.get(ref);
    if (!target) return { ok: false, problem: "missing-target", ref };
    const next = valueInMode(target, mode) ?? target.values[target.modes[0]!];
    if (!next) return { ok: false, problem: "missing-target", ref };
    current = next;
  }
  return { ok: true, value: current, target: target! };
}
