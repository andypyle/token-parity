import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFigmaExport } from "../src/adapters/figma.js";
import { check } from "../src/check.js";
import { formatLike, inferFigmaName } from "../src/naming.js";
import { copyFixture, readJsonFile, writeJson } from "./helpers.js";

describe("formatLike", () => {
  it.each([
    ["primary", ["brand", "secondary"], "brand-secondary"],
    ["Primary", ["brand", "secondary"], "Brand Secondary"],
    ["Brand Primary", ["brand", "secondary"], "Brand Secondary"],
    ["brand_primary", ["brand", "secondary"], "brand_secondary"],
    ["brandPrimary", ["brand", "secondary"], "brandSecondary"],
    ["BRAND-PRIMARY", ["brand", "secondary"], "BRAND-SECONDARY"],
    ["500", ["600"], "600"],
  ])("%s style -> %s", (sample, words, expected) => {
    expect(formatLike(sample, words)).toBe(expected);
  });
});

const set = (names: string[]) =>
  readFigmaExport(
    {
      colorProfile: "srgb",
      variableCollections: { C: { id: "C", name: "Tokens", modes: [{ modeId: "m", name: "Value" }], defaultModeId: "m" } },
      variables: Object.fromEntries(names.map((name, i) => [`V${i}`, { id: `V${i}`, name, resolvedType: "FLOAT", variableCollectionId: "C", valuesByMode: { m: 1 } }])),
    },
    "f.json",
  );

describe("inferFigmaName", () => {
  it("prefers the sibling with the longest shared prefix", () => {
    expect(inferFigmaName("color-brand-secondary", set(["color/blue/500", "color/brand/primary"]))).toMatchObject({ name: "color/brand/secondary", sibling: "color-brand-primary" });
  });

  it("keeps groups that are fully shared and styles the rest like the next group", () => {
    expect(inferFigmaName("color-brand-secondary", set(["Color/Brand Primary"]))?.name).toBe("Color/Brand Secondary");
    expect(inferFigmaName("spacing-12", set(["Spacing/4"]))?.name).toBe("Spacing/12");
  });

  it("returns null without a sibling sharing a segment", () => {
    expect(inferFigmaName("radius-md", set(["color/blue/500"]))).toBeNull();
    expect(inferFigmaName("radius-md", set([]))).toBeNull();
  });
});

describe("matching by Figma variable id", () => {
  it("keeps a renamed Figma variable matched and reports the rename", async () => {
    const dir = copyFixture(join(import.meta.dirname, "fixtures", "round-trip-unchanged"));
    const lock = readJsonFile<{ tokens: Record<string, { figma?: object }> }>(join(dir, "tokens.lock.json"));
    lock.tokens["color-bg"]!.figma = { variableId: "V:3", name: "color/bg" };
    writeJson(join(dir, "tokens.lock.json"), lock);
    const figma = readJsonFile<{ variables: Record<string, { name: string }> }>(join(dir, "figma.json"));
    figma.variables["V:3"]!.name = "Surface/Background";
    writeJson(join(dir, "figma.json"), figma);

    const report = await check({ figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") });
    expect(report.findings).toEqual([]);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ level: "info", token: "color-bg", message: expect.stringContaining("renamed") }));
  });
});
