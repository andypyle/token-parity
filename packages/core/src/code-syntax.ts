// Figma's codeSyntax.WEB is free text written by designers. This turns it into a token key.
//
// - Only an exact `var(--name)` (optionally with a fallback argument) or a bare `--name` gives a name. The
//   Tailwind prefix is stripped (`var(--ds-color-x)` -> `color-x` with `prefix(ds)`). A name that isn't in
//   code doesn't count: the variable falls back to name matching, with a warning.
// - Identifier-shaped forms (Tailwind utilities, Sass/Less variables, camelCase, dotted JS paths) only yield
//   candidates, and match when exactly one candidate exists in code.
// - Anything else (`calc(...)`, `2px`, arbitrary `bg-[#fff]`) is not a name; the variable is matched by name.

export type CodeSyntaxResult =
  | { ok: true; key: string; via: "var" | "candidate" }
  | { ok: false; problem: "var-not-in-code" | "not-a-name" | "no-match" | "ambiguous"; tried: string[] };

type FigmaType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";

const VAR_RE = /^var\(\s*--([A-Za-z0-9_-]+)\s*(?:,[^)]*)?\)$/;
const PROPERTY_RE = /^--([A-Za-z0-9_-]+)$/;
const IDENTIFIER_RE = /^[$@]?[A-Za-z][A-Za-z0-9_.-]*$/;

/** The custom property an exact `var(--x)` / `--x` names, without the Tailwind prefix; null for any other form. */
export function codeSyntaxVarName(raw: string, prefix?: string | null): string | null {
  const text = raw.trim();
  const name = VAR_RE.exec(text)?.[1] ?? PROPERTY_RE.exec(text)?.[1];
  if (!name) return null;
  return prefix && name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name;
}

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

/** Candidate token keys for an identifier-shaped codeSyntax.WEB value (null when it isn't one). */
export function codeSyntaxCandidates(raw: string, type: FigmaType): string[] | null {
  // Tailwind variants (dark:, hover:, and a v4 prefix like ds:) and !important
  let text = raw.trim().replace(/^(?:[A-Za-z0-9-]+:)+/, "").replace(/^!|!$/g, "");
  if (!IDENTIFIER_RE.test(text)) return null;

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
  return [...out];
}

/**
 * Resolve codeSyntax.WEB against the token keys that exist in code. Without `codeKeys`, only an exact var
 * name is used (unverified), since nothing can be checked.
 */
export function resolveCodeSyntax(raw: string, type: FigmaType, codeKeys: ReadonlySet<string> | undefined, prefix?: string | null): CodeSyntaxResult {
  const name = codeSyntaxVarName(raw, prefix);
  if (name !== null) {
    if (!codeKeys || codeKeys.has(name)) return { ok: true, key: name, via: "var" };
    return { ok: false, problem: "var-not-in-code", tried: [name] };
  }
  const candidates = codeSyntaxCandidates(raw, type);
  if (!candidates || !codeKeys) return { ok: false, problem: "not-a-name", tried: [] };
  const present = candidates.filter((c) => codeKeys.has(c));
  if (present.length === 1) return { ok: true, key: present[0]!, via: "candidate" };
  return { ok: false, problem: present.length > 1 ? "ambiguous" : "no-match", tried: present.length > 1 ? present : candidates };
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

/** codeSyntax.WEB for a token, with the Tailwind prefix Tailwind adds at runtime (`var(--ds-color-x)`). */
export function formatCodeSyntax(key: string, style: CodeSyntaxStyle, prefix?: string | null): string {
  const name = prefix ? `${prefix}-${key}` : key;
  return style === "var" ? `var(--${name})` : style === "property" ? `--${name}` : name;
}
