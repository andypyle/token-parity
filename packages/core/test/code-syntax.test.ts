import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFigmaExport } from "../src/adapters/figma.js";
import { readTailwindCss } from "../src/adapters/tailwind.js";
import { check } from "../src/check.js";
import { codeSyntaxCandidates, codeSyntaxVarName, detectCodeSyntaxStyle, formatCodeSyntax, resolveCodeSyntax } from "../src/code-syntax.js";
import { exportScript } from "../src/figma-script.js";
import { plan } from "../src/plan.js";
import { DEFAULT_SETTINGS } from "../src/types.js";
import { PERCEPTUAL, copyFixture, readJsonFile, writeJson } from "./helpers.js";
import { mockFigma, runInFigma } from "./mock-figma.js";

const CODE = new Set(["color-primary", "color-primary-500", "spacing-4", "radius-md", "text-sm", "font-sans", "font-weight-bold", "color-brand", "color-slate-50"]);

describe("resolveCodeSyntax", () => {
  it.each([
    ["var(--color-primary)", "COLOR", "color-primary", "var"],
    ["var(--color-primary, #fff)", "COLOR", "color-primary", "var"],
    ["--color-primary", "COLOR", "color-primary", "var"],
    ["color-primary", "COLOR", "color-primary", "candidate"],
    ["bg-primary", "COLOR", "color-primary", "candidate"],
    ["border-x-primary", "COLOR", "color-primary", "candidate"],
    ["dark:hover:bg-primary", "COLOR", "color-primary", "candidate"],
    ["ds:bg-primary", "COLOR", "color-primary", "candidate"],
    ["text-primary", "COLOR", "color-primary", "candidate"],
    ["text-sm", "FLOAT", "text-sm", "candidate"],
    ["rounded-md", "FLOAT", "radius-md", "candidate"],
    ["p-4", "FLOAT", "spacing-4", "candidate"],
    ["font-sans", "STRING", "font-sans", "candidate"],
    ["font-bold", "FLOAT", "font-weight-bold", "candidate"],
    ["$color-primary", "COLOR", "color-primary", "candidate"],
    ["@color-primary", "COLOR", "color-primary", "candidate"],
    ["colorPrimary500", "COLOR", "color-primary-500", "candidate"],
    ["theme.colors.primary", "COLOR", "color-primary", "candidate"],
    ["tokens.color.brand", "COLOR", "color-brand", "candidate"],
  ] as const)("%s (%s) -> %s", (raw, type, key, via) => {
    expect(resolveCodeSyntax(raw, type, CODE)).toEqual({ ok: true, key, via });
  });

  it("strips the Tailwind prefix from var names", () => {
    expect(codeSyntaxVarName("var(--ds-color-slate-50)", "ds")).toBe("color-slate-50");
    expect(codeSyntaxVarName("--ds-text-xs", "ds")).toBe("text-xs");
    expect(codeSyntaxVarName("var(--color-x)", "ds")).toBe("color-x"); // unprefixed stays as is
    expect(resolveCodeSyntax("var(--ds-color-slate-50)", "COLOR", CODE, "ds")).toEqual({ ok: true, key: "color-slate-50", via: "var" });
  });

  it("does not use a var name that isn't in code", () => {
    expect(resolveCodeSyntax("var(--color-new)", "COLOR", CODE)).toEqual({ ok: false, problem: "var-not-in-code", tried: ["color-new"] });
  });

  it.each(["calc(var(--ds-spacing) * 4)", "calc(infinity * 1px)", "2px", "3px", "bg-[#3b82f6]", "#fff", "1rem"])("%s is not a name", (raw) => {
    expect(resolveCodeSyntax(raw, "FLOAT", CODE, "ds")).toEqual({ ok: false, problem: "not-a-name", tried: [] });
  });

  it("does not guess when nothing or several tokens match", () => {
    expect(resolveCodeSyntax("bg-secondary", "COLOR", CODE)).toEqual({ ok: false, problem: "no-match", tried: ["bg-secondary", "color-secondary"] });
    expect(resolveCodeSyntax("theme.colors.primary", "COLOR", new Set(["colors-primary", "color-primary"]))).toMatchObject({ ok: false, problem: "ambiguous" });
  });

  it("uses the variable type to read text-*", () => {
    expect(codeSyntaxCandidates("text-sm", "COLOR")).toContain("color-sm");
    expect(codeSyntaxCandidates("text-sm", "FLOAT")).toContain("text-sm");
  });
});

describe("codeSyntax style for new variables", () => {
  it("follows the file's majority direct style, defaulting to var(), with the Tailwind prefix", () => {
    expect(detectCodeSyntaxStyle(["var(--a)", "var(--b)", "--c"])).toBe("var");
    expect(detectCodeSyntaxStyle(["--a", "--b", "bg-x"])).toBe("property");
    expect(detectCodeSyntaxStyle(["a-b", "c"])).toBe("bare");
    expect(detectCodeSyntaxStyle(["calc(var(--ds-spacing) * 4)"])).toBe("var");
    expect(detectCodeSyntaxStyle([])).toBe("var");
    expect(formatCodeSyntax("color-x", "var")).toBe("var(--color-x)");
    expect(formatCodeSyntax("color-x", "var", "ds")).toBe("var(--ds-color-x)");
    expect(formatCodeSyntax("color-x", "property", "ds")).toBe("--ds-color-x");
  });
});

describe("Tailwind prefix", () => {
  it("is read from the tailwindcss import, or from config", () => {
    expect(readTailwindCss('@import "tailwindcss" prefix(ds);\n@theme { --color-a: red; }', "a.css", {}).tailwindPrefix).toBe("ds");
    expect(readTailwindCss('@import "tailwindcss/theme.css" layer(theme) prefix(tw);', "a.css", {}).tailwindPrefix).toBe("tw");
    expect(readTailwindCss("@theme { --color-a: red; }", "a.css", {}).tailwindPrefix).toBeUndefined();
    expect(readTailwindCss("@theme { --color-a: red; }", "a.css", {}, "ds").tailwindPrefix).toBe("ds");
  });

  it("counts prefixed mode overrides as overrides of the theme token", () => {
    const css = '@import "tailwindcss" prefix(ds);\n@theme { --color-surface: oklch(1 0 0); }\n[data-theme="dark"] { --ds-color-surface: oklch(0.2 0 0); }';
    const t = readTailwindCss(css, "a.css", DEFAULT_SETTINGS.modeMap).tokens.get("color-surface")!;
    expect(t.modes).toEqual(["default", "dark"]);
    expect(t.values.dark).toMatchObject({ raw: "oklch(0.2 0 0)" });
    expect(t.source.code!.modes.dark).toMatchObject({ cssVar: "--ds-color-surface", context: "mode:dark" });
  });
});

const FIXTURES = join(import.meta.dirname, "fixtures");
const runCheck = (dir: string, lock: string | null = null) => check({ settings: PERCEPTUAL, figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: lock });

describe("matching by codeSyntax (Tailwind prefix fixture)", () => {
  it("warns only about var names that aren't in code; expressions get one info note", async () => {
    const report = await runCheck(join(FIXTURES, "tailwind-prefix"));
    expect(report.diagnostics.filter((d) => d.level === "warning")).toEqual([]);
    const info = report.diagnostics.find((d) => d.level === "info" && d.message.includes("doesn't name a CSS token"));
    // spacing/1's calc(var(--ds-spacing) * 1) is evaluated against code, so only border/2 really fell back.
    expect(info?.message).toBe(`1 variable's codeSyntax.WEB doesn't name a CSS token (e.g. "border/2: 2px"); matched by name instead.`);
  });

  it("warns and falls back when a var name isn't in code", async () => {
    const dir = copyFixture(join(FIXTURES, "tailwind-prefix"));
    const figma = readJsonFile<{ variables: Record<string, { codeSyntax?: { WEB: string } }> }>(join(dir, "figma.json"));
    figma.variables["V2"]!.codeSyntax = { WEB: "var(--ds-text-tiny)" };
    writeJson(join(dir, "figma.json"), figma);
    const report = await runCheck(dir);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ level: "warning", message: `"text/xs" codeSyntax.WEB "var(--ds-text-tiny)" names --text-tiny, which isn't in code; matched by name (--text-xs) instead.` }),
    );
    expect(report.findings.map((f) => f.token)).not.toContain("text-xs"); // the name fallback still matches
  });
});

describe("matching by codeSyntax (mixed forms fixture)", () => {
  it("notes identifier codeSyntax that matches nothing as info, not a warning", async () => {
    const report = await runCheck(join(FIXTURES, "code-syntax"));
    expect(report.diagnostics.filter((d) => d.level === "warning")).toEqual([]);
    expect(report.diagnostics.find((d) => d.level === "info")?.message).toContain("Accent: bg-accent");
  });

  it("beats a stale lock mapping, and reports the remap", async () => {
    const dir = copyFixture(join(FIXTURES, "code-syntax"));
    writeJson(join(dir, "tokens.lock.json"), {
      version: 1,
      figmaColorProfile: "srgb",
      tokens: { "brand-primary": { type: "color", modes: {}, figma: { variableId: "V:1", name: "Brand/Primary" } } },
    });
    const report = await runCheck(dir, join(dir, "tokens.lock.json"));
    expect(report.findings.map((f) => f.token)).not.toContain("color-primary");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ level: "info", message: expect.stringContaining("now maps to --color-primary through its codeSyntax (was --brand-primary)") }),
    );
  });

  it("reports two variables claiming the same CSS name", () => {
    const json = readJsonFile<{ variables: Record<string, { codeSyntax?: { WEB: string } }> }>(join(FIXTURES, "code-syntax", "figma.json"));
    json.variables["V:4"]!.codeSyntax = { WEB: "--color-primary" };
    const set = readFigmaExport(json, "f.json", new Map(), new Set(["color-primary"]));
    expect(set.diagnostics).toContainEqual(expect.objectContaining({ level: "error", token: "color-primary", message: expect.stringContaining("like another variable") }));
  });

  it("uses only var names, unverified, when code keys are unknown", () => {
    const set = readFigmaExport(readJsonFile(join(FIXTURES, "code-syntax", "figma.json")), "f.json");
    expect(set.tokens.has("color-primary")).toBe(true);
    expect(set.tokens.has("spacing-medium")).toBe(true);
    expect(set.diagnostics).toEqual([]);
  });

  it("round-trips through the plugin export", async () => {
    const result = (await runInFigma(exportScript(), mockFigma(readJsonFile(join(FIXTURES, "code-syntax", "figma.json"))).figma)) as {
      export: { collections: Array<{ variables: Array<{ name: string; code?: string }> }> };
    };
    expect(result.export.collections[0]!.variables.find((v) => v.name === "Spacing/Medium")!.code).toBe("p-4");
    const set = readFigmaExport(result.export, "e.json", new Map(), new Set(["spacing-4"]));
    expect(set.tokens.get("spacing-4")!.source.figma!.codeSyntax).toBe("p-4");
  });
});

describe("plan with a Tailwind prefix", () => {
  function project(css: string, variables: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "tp-prefix-"));
    writeFileSync(join(dir, "theme.css"), css);
    writeJson(join(dir, "figma.json"), {
      colorProfile: "srgb",
      variableCollections: {
        P: { id: "P", name: "Primitives", modes: [{ modeId: "p", name: "Value" }], defaultModeId: "p" },
        C: { id: "C", name: "Color", modes: [{ modeId: "l", name: "Light" }, { modeId: "k", name: "Dark" }], defaultModeId: "l" },
      },
      variables,
    });
    return (prefer: "code" | "figma" | null = null) =>
      plan({ settings: PERCEPTUAL, figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json"), prefer, resolutionsPath: null, figmaCollection: null });
  }
  const WHITE = { r: 0.980256, g: 0.980256, b: 0.980256, a: 1 };
  const DARK = { r: 0.093799, g: 0.093792, b: 0.105831, a: 1 };

  it("adds a Figma-only token under its codeSyntax var name", async () => {
    const p = await project('@import "tailwindcss" prefix(ds);\n@theme {\n  --color-slate-50: oklch(0.985 0 0);\n}\n', {
      V1: { id: "V1", name: "slate/50", resolvedType: "COLOR", variableCollectionId: "P", codeSyntax: { WEB: "var(--ds-color-slate-50)" }, valuesByMode: { p: WHITE } },
      V2: { id: "V2", name: "Brand/Accent", resolvedType: "COLOR", variableCollectionId: "P", codeSyntax: { WEB: "var(--ds-color-accent)" }, valuesByMode: { p: DARK } },
    })();
    expect(p.actions).toEqual([expect.objectContaining({ op: "add-code", token: "brand-accent", cssVar: "--color-accent", modeCssVar: "--ds-color-accent" })]);
    expect(Object.keys(p.lockAfter.tokens)).toContain("color-accent");
  });

  it("writes a new dark override with the prefixed name, and new Figma variables with prefixed codeSyntax", async () => {
    const p = await project('@import "tailwindcss" prefix(ds);\n@theme {\n  --color-surface: oklch(0.985 0 0);\n  --color-muted: oklch(0.21 0.006 285.9);\n}\n', {
      V1: { id: "V1", name: "color/surface", resolvedType: "COLOR", variableCollectionId: "C", codeSyntax: { WEB: "var(--ds-color-surface)" }, valuesByMode: { l: WHITE, k: DARK } },
    })("figma");
    expect(p.actions.find((a) => a.op === "update-code")).toMatchObject({ token: "color-surface", mode: "dark", cssVar: "--ds-color-surface", context: "mode:dark", from: null });
    expect(p.actions.find((a) => a.op === "add-figma")).toMatchObject({ token: "color-muted", codeSyntax: "var(--ds-color-muted)" });
  });
});

describe("Tailwind prefix, round 2 (real project)", () => {
  const dir = join(FIXTURES, "tailwind-prefix-dark");

  it("strips the prefix from var() references and skips namespace resets", () => {
    const css = readTailwindCss(
      '@import "tailwindcss" prefix(ds);\n@theme { --color-*: initial; --*: initial; --color-a: red; --color-b: var(--ds-color-a); --color-c: var(--ds-private); }',
      "a.css",
      {},
    );
    expect([...css.tokens.keys()].sort()).toEqual(["color-a", "color-b", "color-c"]);
    expect(css.tokens.get("color-b")!.values.default).toMatchObject({ kind: "alias", ref: "color-a" });
    expect(css.tokens.get("color-c")!.values.default).toMatchObject({ kind: "alias", ref: "ds-private" }); // not a theme token: left as written
  });

  it("strips the prefix from var() references in mode blocks too", () => {
    const css = readTailwindCss(
      '@import "tailwindcss" prefix(ds);\n@theme { --color-a: red; --color-b: blue; --color-c: var(--color-b); }\n.dark { --ds-color-c: var(--ds-color-a); }',
      "a.css",
      DEFAULT_SETTINGS.modeMap,
    );
    expect(css.tokens.get("color-c")!.values.dark).toMatchObject({ kind: "alias", ref: "color-a" });
  });

  it("compares an alias against an equal literal as equal, and records the resolved value in the lock", async () => {
    const report = await runCheck(dir);
    expect(report.findings.map((f) => f.token)).not.toContain("color-fg-1");
    expect(report.findings.map((f) => f.token)).not.toContain("color-accent");
    const p = await plan({ settings: PERCEPTUAL, figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "nope.lock.json"), prefer: null, resolutionsPath: null, figmaCollection: null });
    expect(p.lockAfter.tokens["color-fg-1"]!.modes.dark).toEqual({ oklch: expect.stringMatching(/^oklch\(/), figmaRgb: { r: 0.9137254901960784, g: 0.9294117647058824, b: 0.9411764705882353, a: 1 } });
  });

  it("says when code has a mode the Figma collection lacks", async () => {
    const report = await runCheck(dir);
    expect(report.findings.find((f) => f.id === "missing-mode:color-amber-100:dark")!.message).toBe(
      'Code defines a dark value, but Figma collection "Primitives" has no dark mode.',
    );
  });

  it("writes a Figma alias whose target isn't in code as its resolved value", async () => {
    const p = await plan({ settings: PERCEPTUAL, figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "nope.lock.json"), prefer: null, resolutionsPath: null, figmaCollection: null });
    expect(p.actions.find((a) => a.op === "add-code")).toMatchObject({ token: "dark-fg-1", values: { theme: expect.stringMatching(/^oklch\(/) } });
  });
});
