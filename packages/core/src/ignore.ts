// The `ignore` setting: tokens (or single modes of tokens) that compare, plan and the lock leave alone.
//
// A pattern matches a token's CSS name (`animate-spin`, without `--`) or its Figma variable name
// (`dark/fg-1`). `*` matches any run of characters, `?` one character. `pattern:mode` ignores only that
// mode (`color-amber-*:dark`). Ignored tokens stay in the token sets, so aliases to them still resolve.
import type { ModeName, NormalizedToken, TokenKey } from "./types.js";

export interface IgnoreMatcher {
  /** True when the whole token is ignored. */
  token(key: TokenKey, ...tokens: Array<NormalizedToken | undefined>): boolean;
  /** True when this mode of the token is ignored. */
  mode(key: TokenKey, mode: ModeName, ...tokens: Array<NormalizedToken | undefined>): boolean;
}

interface Rule {
  name: RegExp;
  mode: RegExp | null;
}

const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

export function compileIgnore(patterns: readonly string[] = []): IgnoreMatcher {
  const rules: Rule[] = patterns.map((p) => {
    const i = p.lastIndexOf(":");
    return i > 0 ? { name: glob(p.slice(0, i)), mode: glob(p.slice(i + 1)) } : { name: glob(p), mode: null };
  });
  const names = (key: TokenKey, tokens: Array<NormalizedToken | undefined>) => [
    key,
    ...tokens.flatMap((t) => [t?.source.figma?.name, t?.source.code?.cssVar.replace(/^--/, "")]).filter((n): n is string => !!n),
  ];
  const matches = (rule: Rule, key: TokenKey, tokens: Array<NormalizedToken | undefined>) => names(key, tokens).some((n) => rule.name.test(n));

  return {
    token: (key, ...tokens) => rules.some((r) => r.mode === null && matches(r, key, tokens)),
    mode: (key, mode, ...tokens) => rules.some((r) => r.mode !== null && r.mode.test(mode) && matches(r, key, tokens)),
  };
}
