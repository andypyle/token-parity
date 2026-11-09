// Figma's codeSyntax.WEB is free text written by designers. This turns it into a token key.
//
// - `var(--x)` and `--x` name a CSS custom property explicitly: they map to `x` directly, even if code doesn't
//   have it yet (that is then a real missing-in-code).
// - Every other form (Tailwind utilities, Sass/Less variables, camelCase, dotted JS paths, bare names) yields
//   candidate keys, and matches only when exactly one candidate exists in code. Nothing is guessed.

export type CodeSyntaxResult =
  | { ok: true; key: string; direct: boolean }
  | { ok: false; problem: "no-match" | "ambiguous" | "arbitrary-value"; candidates: string[] };

type FigmaType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";

// Tailwind v4 utility prefixes -> theme namespace, by variable type. Longest prefixes are tried first.
const COLOR_UTILITIES = [
  "bg", "text", "border", "border-x", "border-y", "border-t", "border-r", "border-b", "border-l", "border-s", "border-e",
  "divide", "outline", "ring", "ring-offset", "fill", "stroke", "decoration", "accent", "caret", "placeholder", "shadow",
  "inset-shadow", "from", "via", "to",
];
const SPACING_UTILITIES = [
  "p", "px", "py", "pt", "pr", "pb", "pl", "ps", "pe", "m", "mx", "my", "mt", "mr", "mb", "ml", "ms", "me",
  "gap", "gap-x", "gap-y", "space-x", "space-y", "w", "h", "size", "min-w", "min-h", "max-w", "max-h",
  "inset", "inset-x", "inset-y", "top", "right", "bottom", "left", "start", "end", "scroll-m", "scroll-p",
];
const RADIUS_UTILITIES = ["rounded", "rounded-t", "rounded-r", "rounded-b", "rounded-l", "rounded-s", "rounded-e", "rounded-tl", "rounded-tr", "rounded-br", "rounded-bl"];

const UTILITIES: Record<FigmaType, Array<[string, string]>> = {
  COLOR: COLOR_UTILITIES.map((u) => [u, "color"]),
  FLOAT: [
    ...SPACING_UTILITIES.map((u): [string, string] => [u, "spacing"]),
    ...RADIUS_UTILITIES.map((u): [string, string] => [u, "radius"]),
    ["text", "text"],
    ["leading", "leading"],
    ["tracking", "tracking"],
    ["font", "font-weight"],
    ["blur", "blur"],
    ["opacity", "opacity"],
  ],
  STRING: [["font", "font"]],
  BOOLEAN: [],
};

const SINGULAR: Record<string, string> = { colors: "color", radii: "radius", fonts: "font", shadows: "shadow", spacings: "spacing" };
const ROOTS = new Set(["theme", "tokens", "vars", "var", "t"]);

const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_.]+/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/** Candidate token keys for a codeSyntax.WEB value; `direct` when it explicitly names a custom property. */
export function codeSyntaxCandidates(raw: string, type: FigmaType): { direct: string | null; candidates: string[]; arbitrary: boolean } {
  let text = raw.trim();
  const varMatch = /^var\(\s*--([^,)\s]+)\s*(?:,[^)]*)?\)$/.exec(text);
  if (varMatch) return { direct: varMatch[1]!, candidates: [], arbitrary: false };
  if (/^--[^\s]+$/.test(text)) return { direct: text.slice(2), candidates: [], arbitrary: false };

  text = text.replace(/^(?:[a-z0-9-]+:)+/i, "").replace(/^!|!$/g, ""); // Tailwind variants (dark:, hover:) and !important
  if (/\[.*\]/.test(text)) return { direct: null, candidates: [], arbitrary: true };

  const out = new Set<string>();
  const add = (k: string) => k && out.add(k);

  if (/^[$@]/.test(text)) text = text.slice(1); // Sass $x, Less @x

  if (text.includes(".")) {
    const segments = text.split(".").filter(Boolean);
    while (segments.length > 1 && ROOTS.has(segments[0]!.toLowerCase())) segments.shift();
    add(kebab(segments.join("-")));
    const first = segments[0]!.toLowerCase();
    if (SINGULAR[first]) add(kebab([SINGULAR[first], ...segments.slice(1)].join("-")));
  } else {
    const k = kebab(text);
    add(k);
    // camelCase digits: colorPrimary500 -> color-primary-500 (also kept unsplit, e.g. heading h1).
    const digits = k.replace(/([a-z])([0-9])/g, "$1-$2");
    if (digits !== k) add(digits);
    for (const [plural, singular] of Object.entries(SINGULAR)) if (k.startsWith(`${plural}-`)) add(singular + k.slice(plural.length));
    const utilities = [...UTILITIES[type]].sort((a, b) => b[0].length - a[0].length);
    for (const [prefix, namespace] of utilities) {
      if (k.startsWith(`${prefix}-`)) {
        add(`${namespace}-${k.slice(prefix.length + 1)}`);
        break;
      }
    }
  }
  return { direct: null, candidates: [...out], arbitrary: false };
}

/** Resolve codeSyntax.WEB against the token keys that exist in code. */
export function resolveCodeSyntax(raw: string, type: FigmaType, codeKeys: ReadonlySet<string>): CodeSyntaxResult {
  const { direct, candidates, arbitrary } = codeSyntaxCandidates(raw, type);
  if (direct) return { ok: true, key: direct, direct: true };
  if (arbitrary) return { ok: false, problem: "arbitrary-value", candidates: [] };
  const present = candidates.filter((c) => codeKeys.has(c));
  if (present.length === 1) return { ok: true, key: present[0]!, direct: false };
  return { ok: false, problem: present.length > 1 ? "ambiguous" : "no-match", candidates: present.length > 1 ? present : candidates };
}

export type CodeSyntaxStyle = "var" | "property" | "bare";

/** How a file writes codeSyntax.WEB, by majority; `var(--x)` when nothing direct is in use. */
export function detectCodeSyntaxStyle(values: Iterable<string>): CodeSyntaxStyle {
  const counts: Record<CodeSyntaxStyle, number> = { var: 0, property: 0, bare: 0 };
  for (const v of values) {
    const t = v.trim();
    if (/^var\(--/.test(t)) counts.var++;
    else if (/^--/.test(t)) counts.property++;
    else if (/^[a-z][a-z0-9-]*$/.test(t)) counts.bare++;
  }
  const best = (Object.entries(counts) as Array<[CodeSyntaxStyle, number]>).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : "var";
}

export function formatCodeSyntax(key: string, style: CodeSyntaxStyle): string {
  return style === "var" ? `var(--${key})` : style === "property" ? `--${key}` : key;
}
