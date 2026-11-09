import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFigmaExport } from "../src/adapters/figma.js";
import { check } from "../src/check.js";
import { codeSyntaxCandidates, detectCodeSyntaxStyle, formatCodeSyntax, resolveCodeSyntax } from "../src/code-syntax.js";
import { exportScript } from "../src/figma-script.js";
import { copyFixture, readJsonFile, writeJson } from "./helpers.js";
import { mockFigma, runInFigma } from "./mock-figma.js";

const CODE = new Set(["color-primary", "color-primary-500", "spacing-4", "radius-md", "text-sm", "font-sans", "font-weight-bold", "color-brand"]);

describe("resolveCodeSyntax", () => {
  it.each([
    ["var(--color-primary)", "COLOR", "color-primary", true],
    ["var(--color-new, #fff)", "COLOR", "color-new", true], // direct even when code lacks it
    ["--color-primary", "COLOR", "color-primary", true],
    ["color-primary", "COLOR", "color-primary", false],
    ["bg-primary", "COLOR", "color-primary", false],
    ["border-x-primary", "COLOR", "color-primary", false],
    ["dark:hover:bg-primary", "COLOR", "color-primary", false],
    ["text-primary", "COLOR", "color-primary", false],
    ["text-sm", "FLOAT", "text-sm", false],
    ["rounded-md", "FLOAT", "radius-md", false],
    ["p-4", "FLOAT", "spacing-4", false],
    ["font-sans", "STRING", "font-sans", false],
    ["font-bold", "FLOAT", "font-weight-bold", false],
    ["$color-primary", "COLOR", "color-primary", false],
    ["@color-primary", "COLOR", "color-primary", false],
    ["colorPrimary500", "COLOR", "color-primary-500", false],
    ["theme.colors.primary", "COLOR", "color-primary", false],
    ["tokens.color.brand", "COLOR", "color-brand", false],
  ] as const)("%s (%s) -> %s", (raw, type, key, direct) => {
    expect(resolveCodeSyntax(raw, type, CODE)).toEqual({ ok: true, key, direct });
  });

  it("does not guess when nothing in code matches", () => {
    expect(resolveCodeSyntax("bg-secondary", "COLOR", CODE)).toEqual({ ok: false, problem: "no-match", candidates: ["bg-secondary", "color-secondary"] });
  });

  it("does not guess when more than one token matches", () => {
    const code = new Set(["colors-primary", "color-primary"]);
    expect(resolveCodeSyntax("theme.colors.primary", "COLOR", code)).toMatchObject({ ok: false, problem: "ambiguous" });
  });

  it("reports arbitrary values, which have no token", () => {
    expect(resolveCodeSyntax("bg-[#3b82f6]", "COLOR", CODE)).toEqual({ ok: false, problem: "arbitrary-value", candidates: [] });
  });

  it("uses the variable type to read text-*", () => {
    expect(codeSyntaxCandidates("text-sm", "COLOR").candidates).toContain("color-sm");
    expect(codeSyntaxCandidates("text-sm", "FLOAT").candidates).toContain("text-sm");
  });
});

describe("codeSyntax style for new variables", () => {
  it("follows the file's majority direct style, defaulting to var()", () => {
    expect(detectCodeSyntaxStyle(["var(--a)", "var(--b)", "--c"])).toBe("var");
    expect(detectCodeSyntaxStyle(["--a", "--b", "bg-x"])).toBe("property");
    expect(detectCodeSyntaxStyle(["a-b", "c"])).toBe("bare");
    expect(detectCodeSyntaxStyle(["bg-primary_x$"])).toBe("var");
    expect(detectCodeSyntaxStyle([])).toBe("var");
    expect(formatCodeSyntax("color-x", "var")).toBe("var(--color-x)");
    expect(formatCodeSyntax("color-x", "property")).toBe("--color-x");
  });
});

const FIXTURE = join(import.meta.dirname, "fixtures", "code-syntax");

describe("matching by codeSyntax", () => {
  it("warns about codeSyntax that matches nothing, and says what it tried", async () => {
    const report = await check({ figmaPath: join(FIXTURE, "figma.json"), codePath: join(FIXTURE, "theme.css"), lockPath: null });
    const warning = report.diagnostics.find((d) => d.level === "warning" && d.message.includes("bg-accent"));
    expect(warning?.message).toContain("matches no token in code (tried --bg-accent, --color-accent)");
    expect(report.findings[0]!.message).not.toContain("set codeSyntax.WEB"); // it has one; the hint is for variables without
  });

  it("beats a stale lock mapping, and reports the remap", async () => {
    const dir = copyFixture(FIXTURE);
    writeJson(join(dir, "tokens.lock.json"), {
      version: 1,
      figmaColorProfile: "srgb",
      tokens: { "brand-primary": { type: "color", modes: {}, figma: { variableId: "V:1", name: "Brand/Primary" } } },
    });
    const report = await check({ figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") });
    expect(report.findings.map((f) => f.token)).not.toContain("color-primary");
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "info", message: expect.stringContaining("now maps to --color-primary through its codeSyntax (was --brand-primary)") }));
  });

  it("reports two variables claiming the same CSS name", () => {
    const json = readJsonFile<{ variables: Record<string, { codeSyntax?: { WEB: string } }> }>(join(FIXTURE, "figma.json"));
    json.variables["V:4"]!.codeSyntax = { WEB: "--color-primary" };
    const set = readFigmaExport(json, "f.json", new Map(), new Set(["color-primary"]));
    expect(set.diagnostics).toContainEqual(expect.objectContaining({ level: "error", token: "color-primary", message: expect.stringContaining("like another variable") }));
  });

  it("only uses direct forms when code keys are unknown, without warnings", () => {
    const set = readFigmaExport(readJsonFile(join(FIXTURE, "figma.json")), "f.json");
    expect(set.tokens.has("color-primary")).toBe(true); // var(--color-primary)
    expect(set.tokens.has("spacing-medium")).toBe(true); // p-4 needs code keys: name rule
    expect(set.diagnostics).toEqual([]);
  });

  it("round-trips through the plugin export", async () => {
    const result = (await runInFigma(exportScript(), mockFigma(readJsonFile(join(FIXTURE, "figma.json"))).figma)) as { export: { collections: Array<{ variables: Array<{ name: string; code?: string }> }> } };
    const vars = result.export.collections[0]!.variables;
    expect(vars.find((v) => v.name === "Spacing/Medium")!.code).toBe("p-4");
    const set = readFigmaExport(result.export, "e.json", new Map(), new Set(["spacing-4"]));
    expect(set.tokens.get("spacing-4")!.source.figma!.codeSyntax).toBe("p-4");
  });
});
