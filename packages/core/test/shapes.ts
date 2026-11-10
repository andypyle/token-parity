// Generated projects for the write-then-read tests: the same tokens, written in each project shape the engine
// supports (Tailwind prefix, color format, dark-mode selector, pass-through variables, formatting style).
import { formatOklch, rgbToOklch } from "../src/color.js";

export interface Shape {
  prefix: string | null;
  format: "hex" | "rgb" | "oklch";
  dark: ".dark" | '[data-theme="dark"]' | "@variant dark";
  passThrough: boolean;
  prettier: boolean;
}

export const SHAPES: Shape[] = [];
for (const prefix of [null, "tw"])
  for (const format of ["hex", "rgb", "oklch"] as const)
    for (const dark of [".dark", '[data-theme="dark"]', "@variant dark"] as const)
      for (const passThrough of [false, true])
        for (const prettier of [false, true]) SHAPES.push({ prefix, format, dark, passThrough, prettier });

export const shapeName = (s: Shape) =>
  [s.prefix ? `prefix(${s.prefix})` : "no prefix", s.format, s.dark, s.passThrough ? "pass-through" : "", s.prettier ? "prettier" : ""].filter(Boolean).join(", ");

type Bytes = [number, number, number];
export const COLORS = {
  blue: [37, 99, 235],
  red: [220, 38, 38],
  white: [250, 250, 250],
  gray: [24, 24, 27],
  legacy: [100, 100, 100],
  // Values introduced by the edits after the first sync:
  newBlue: [34, 85, 221],
  newDarkBg: [40, 40, 48],
  green: [22, 163, 74],
  amber: [245, 158, 11],
} satisfies Record<string, Bytes>;

/** A color as CSS in the shape's format. */
export function css(shape: Shape, [r, g, b]: Bytes): string {
  if (shape.format === "hex") return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  if (shape.format === "rgb") return `rgb(${r} ${g} ${b})`;
  const o = rgbToOklch({ space: "srgb", r: r / 255, g: g / 255, b: b / 255, alpha: 1 }, { l: 6, c: 6, h: 4 });
  return formatOklch(o, { l: 6, c: 6, h: 4 }, "0");
}

export const figmaColor = ([r, g, b]: Bytes) => ({ r: r / 255, g: g / 255, b: b / 255, a: 1 });

/** Runtime name of a theme variable: Tailwind emits --<prefix>-<name> with a prefix. */
const runtime = (shape: Shape, key: string) => `--${shape.prefix ? `${shape.prefix}-` : ""}${key}`;

function ref(shape: Shape, key: string): string {
  return shape.prettier ? `var(\n    ${runtime(shape, key)}\n  )` : `var(${runtime(shape, key)})`;
}

/** The project's CSS. Dark overrides of theme variables use runtime (prefixed) names, as they must. */
export function initialCss(shape: Shape): string {
  const theme = [
    `--color-blue-500: ${css(shape, COLORS.blue)};`,
    `--color-red-500: ${css(shape, COLORS.red)};`,
    `--color-legacy: ${css(shape, COLORS.legacy)};`,
    `--spacing-4: 1rem;`,
    `--radius-md: 0.375rem;`,
    `--color-bg: ${css(shape, COLORS.white)};`,
    `--color-accent: ${ref(shape, "color-blue-500")};`,
  ];
  const darkDecls = [`${runtime(shape, "color-bg")}: ${css(shape, COLORS.gray)};`, `${runtime(shape, "color-accent")}: ${ref(shape, "color-blue-500")};`];
  if (shape.passThrough) darkDecls.push(`--surface: ${css(shape, COLORS.gray)};`);

  const selector = shape.prettier ? shape.dark.replace(/"/g, "'") : shape.dark;
  const block = (sel: string, decls: string[], indent = "  ") => `${sel} {\n${decls.map((d) => `${indent}${d}`).join("\n")}\n}`;
  const dark =
    shape.dark === "@variant dark"
      ? `@variant dark {\n  :root {\n${darkDecls.map((d) => `    ${d}`).join("\n")}\n  }\n}`
      : block(selector, darkDecls);

  return [
    `@import "tailwindcss"${shape.prefix ? ` prefix(${shape.prefix})` : ""};`,
    block("@theme", theme),
    ...(shape.passThrough ? [block("@theme inline", ["--color-surface: var(--surface);"]), block(":root", [`--surface: ${css(shape, COLORS.white)};`])] : []),
    dark,
    "",
  ].join("\n\n");
}

const BLACK = { r: 0, g: 0, b: 0, a: 1 };

/** Figma with the same variables, values still unset (black / 0): the first sync fills them from code. */
export function initialFigma(shape: Shape) {
  const prim = (id: string, name: string, type: string, value: unknown, extra: object = {}) => ({
    [id]: { id, name, resolvedType: type, variableCollectionId: "P", valuesByMode: { p: value }, ...extra },
  });
  const color = (id: string, name: string, light: unknown, dark: unknown) => ({
    [id]: { id, name, resolvedType: "COLOR", variableCollectionId: "C", valuesByMode: { l: light, k: dark } },
  });
  const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });
  return {
    colorProfile: "srgb",
    variableCollections: {
      P: { id: "P", name: "Primitives", modes: [{ modeId: "p", name: "Value" }], defaultModeId: "p" },
      C: { id: "C", name: "Color", modes: [{ modeId: "l", name: "Light" }, { modeId: "k", name: "Dark" }], defaultModeId: "l" },
    },
    variables: {
      // blue has codeSyntax (written verbatim when aliased); red doesn't (the prefix is added back).
      ...prim("V1", "color/blue/500", "COLOR", BLACK, { codeSyntax: { WEB: `var(${runtime(shape, "color-blue-500")})` } }),
      ...prim("V2", "color/red/500", "COLOR", BLACK),
      ...prim("V3", "color/legacy", "COLOR", BLACK),
      ...prim("V4", "spacing/4", "FLOAT", 0),
      ...prim("V5", "radius/md", "FLOAT", 0),
      ...color("V6", "color/bg", BLACK, BLACK),
      ...color("V7", "color/accent", alias("V1"), alias("V1")),
      ...(shape.passThrough ? color("V8", "color/surface", BLACK, BLACK) : {}),
    },
  };
}

/** Edits on the Figma side after the first sync: a value, a re-alias, a new variable, a number, a delete. */
export function editFigma(exported: { variables: Record<string, { valuesByMode: Record<string, unknown> }> }) {
  const v = exported.variables;
  v["V1"]!.valuesByMode["p"] = figmaColor(COLORS.newBlue);
  v["V7"]!.valuesByMode["k"] = { type: "VARIABLE_ALIAS", id: "V2" }; // accent's Dark now aliases red
  v["V4"]!.valuesByMode["p"] = 20;
  delete v["V3"]; // color/legacy deleted in Figma
  (v as Record<string, unknown>)["V9"] = {
    id: "V9",
    name: "color/green/500",
    resolvedType: "COLOR",
    variableCollectionId: "P",
    valuesByMode: { p: figmaColor(COLORS.green) },
  };
}

/** Edits on the code side after the first sync: a dark value, a new token, a delete. */
export function editCss(shape: Shape, text: string): string {
  const darkBg = `${runtime(shape, "color-bg")}: ${css(shape, COLORS.gray)};`;
  if (!text.includes(darkBg)) throw new Error("edit target not found: dark bg");
  return text
    .replace(darkBg, `${runtime(shape, "color-bg")}: ${css(shape, COLORS.newDarkBg)};`)
    .replace(/(\n\s*--color-legacy: [^;]+;)/, `$1\n  --color-amber-500: ${css(shape, COLORS.amber)};`)
    .replace(/\n\s*--radius-md: [^;]+;/, "");
}
