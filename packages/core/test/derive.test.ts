import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { parseCalcMultiple } from "../src/derive.js";
import { plan } from "../src/plan.js";
import { writeJson } from "./helpers.js";

describe("parseCalcMultiple", () => {
  it.each([
    ["calc(var(--ds-spacing) * 4)", { name: "ds-spacing", factor: 4 }],
    ["calc(0.5 * var(--spacing))", { name: "spacing", factor: 0.5 }],
    ["calc( var(--spacing)*12 )", { name: "spacing", factor: 12 }],
  ])("%s", (raw, expected) => expect(parseCalcMultiple(raw)).toEqual(expected));

  it.each(["calc(infinity * 1px)", "calc(var(--a) + 4px)", "var(--spacing)", "2px"])("%s is not a multiple", (raw) => {
    expect(parseCalcMultiple(raw)).toBeNull();
  });
});

describe("Tailwind spacing steps computed from --spacing", () => {
  function project(steps: Record<string, number>, css = '@import "tailwindcss" prefix(ds);\n@theme {\n  --spacing: 0.25rem;\n}\n') {
    const dir = mkdtempSync(join(tmpdir(), "tp-derive-"));
    writeFileSync(join(dir, "theme.css"), css);
    writeJson(join(dir, "figma.json"), {
      colorProfile: "srgb",
      variableCollections: { D: { id: "D", name: "Dimension", modes: [{ modeId: "d", name: "Value" }], defaultModeId: "d" } },
      variables: Object.fromEntries(
        Object.entries(steps).map(([n, px], i) => [
          `V${i}`,
          { id: `V${i}`, name: `spacing/${n}`, resolvedType: "FLOAT", variableCollectionId: "D", codeSyntax: { WEB: `calc(var(--ds-spacing) * ${n})` }, valuesByMode: { d: px } },
        ]),
      ),
    });
    const inputs = { figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") };
    return { check: () => check(inputs), plan: (prefer: "code" | "figma" | null = null) => plan({ ...inputs, prefer, resolutionsPath: null, figmaCollection: null }) };
  }

  it("checks each step against n × --spacing", async () => {
    const report = await project({ "0.5": 2, "1": 4, "4": 16, "12": 48 }).check();
    expect(report.findings.filter((f) => f.token.startsWith("spacing-"))).toEqual([]);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "info", message: "4 Figma variables are checked against values code computes (calc(var(--x) * n))." }));
  });

  it("reports a step that doesn't match, and won't write a computed value into code", async () => {
    const p = project({ "4": 18 });
    const report = await p.check();
    expect(report.findings.map((f) => `${f.kind}:${f.token}`)).toContain("value-mismatch:spacing-4");
    const figmaWins = await p.plan("figma");
    expect(figmaWins.actions).toEqual([]);
    const step = figmaWins.unresolved.find((u) => u.token === "spacing-4");
    expect(step).toMatchObject({ reason: "computed-in-code" });
    expect(step!.hint).toContain("calc(var(--spacing) * 4), with --spacing");
    const codeWins = await p.plan("code");
    expect(codeWins.actions[0]).toMatchObject({ op: "update-figma", token: "spacing-4", to: { type: "FLOAT", value: 16 } });
  });

  it("leaves a real code token of that name alone", async () => {
    const report = await project({ "4": 16 }, "@theme {\n  --spacing: 0.25rem;\n  --spacing-4: 1.25rem;\n}\n").check();
    expect(report.findings.map((f) => f.token)).toContain("spacing-4"); // the declared 1.25rem (20px) is compared, not 4 × 4px
  });
});
