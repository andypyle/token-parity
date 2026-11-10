// Write-then-read: after plan -> apply -> push -> commit, re-read both sides and check that every action landed
// exactly as planned, and that every var() in the CSS points at a name that exists at runtime. Runs across
// generated project shapes (see shapes.ts), so a writer that only works in one shape can't hide.
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { buildSelectorToMode, contextKey, contextOf } from "../src/adapters/tailwind.js";
import { applyPlan } from "../src/apply.js";
import { check } from "../src/check.js";
import { commitPending } from "../src/commit.js";
import { plan } from "../src/plan.js";
import type { Action, CompareSettings, FigmaValue, LockFile, Plan } from "../src/types.js";
import { readJsonFile, simulatePush, writeJson } from "./helpers.js";
import { editCss, editFigma, initialCss, initialFigma, SHAPES, shapeName, type Shape } from "./shapes.js";

type Exported = { variables: Record<string, { id: string; name: string; variableCollectionId: string; valuesByMode: Record<string, unknown>; scopes?: string[]; codeSyntax?: { WEB?: string } }> };

const settingsFor = (shape: Shape): Partial<CompareSettings> => (shape.format === "oklch" ? { colorMatch: "perceptual" } : {});

/** One full sync: plan -> apply -> (push -> commit). Returns the plan and the Figma file now in effect. */
async function sync(dir: string, figmaFile: string, shape: Shape, prefer: "code" | "figma" | null) {
  const inputs = { figmaPath: join(dir, figmaFile), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") };
  const p = await plan({ ...inputs, prefer, resolutionsPath: null, figmaCollection: null, settings: settingsFor(shape) });
  const applied = await applyPlan(p, { allowDeletes: true });
  let current = figmaFile;
  if (applied.pending) {
    current = `${figmaFile.replace(/\.json$/, "")}-pushed.json`;
    writeJson(join(dir, current), simulatePush(readJsonFile(join(dir, figmaFile)), applied.figmaChanges));
    const committed = await commitPending(p, join(dir, current));
    expect(committed.problems).toEqual([]);
  }
  return { p, figma: current };
}

/** CSS declarations by `${prop}|${context}`, read the way the adapter reads them. */
function declarations(cssText: string, modeMap: Record<string, string[]>): Map<string, string> {
  const root = postcss.parse(cssText);
  const selectorToMode = buildSelectorToMode(modeMap);
  const out = new Map<string, string>();
  root.walkDecls(/^--/, (d) => {
    out.set(`${d.prop}|${contextKey(contextOf(d, selectorToMode))}`, d.value);
  });
  return out;
}

/** Custom properties that exist at runtime: theme variables under Tailwind's prefix, others as declared. */
function runtimeNames(cssText: string, prefix: string | null, modeMap: Record<string, string[]>): Set<string> {
  const names = new Set<string>();
  for (const key of declarations(cssText, modeMap).keys()) {
    const [prop, context] = key.split("|") as [string, string];
    names.add(context === "theme" && prefix ? `--${prefix}-${prop.slice(2)}` : prop);
  }
  return names;
}

const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const sameFloat = (a: number, b: number) => Math.fround(a) === Math.fround(b);

/** Does a Figma value (as exported) hold what the plan said it would write? */
function figmaHolds(stored: unknown, planned: FigmaValue, exported: Exported): boolean {
  switch (planned.type) {
    case "COLOR": {
      const s = stored as { r: number; g: number; b: number; a: number };
      return !!s && sameFloat(s.r, planned.r) && sameFloat(s.g, planned.g) && sameFloat(s.b, planned.b) && sameFloat(s.a, planned.a);
    }
    case "FLOAT":
      return typeof stored === "number" && sameFloat(stored, planned.value);
    case "ALIAS": {
      const s = stored as { type?: string; id?: string };
      const target = "variableId" in planned ? planned.variableId : Object.values(exported.variables).find((v) => v.name === planned.name)?.id;
      return s?.type === "VARIABLE_ALIAS" && s.id === target;
    }
    default:
      return (stored as unknown) === planned.value;
  }
}

function assertLanded(action: Action, cssText: string, exported: Exported, settings: CompareSettings) {
  const decls = declarations(cssText, settings.modeMap);
  const where = `${action.id}`;
  switch (action.op) {
    case "update-code":
      expect(decls.get(`${action.cssVar}|${action.context}`), where).toBe(action.to);
      return;
    case "add-code":
      for (const [context, value] of Object.entries(action.values)) {
        const prop = context === "theme" ? action.cssVar : (action.modeCssVar ?? action.cssVar);
        expect(decls.get(`${prop}|${context}`), `${where} ${context}`).toBe(value);
      }
      return;
    case "delete-code":
      for (const key of decls.keys()) {
        const [prop, context] = key.split("|") as [string, string];
        if (context === "theme" || context.startsWith("mode:")) expect([action.cssVar, action.modeCssVar], where).not.toContain(prop);
      }
      return;
    case "update-figma":
      expect(figmaHolds(exported.variables[action.variableId]?.valuesByMode[action.modeId], action.to, exported), where).toBe(true);
      return;
    case "add-figma": {
      const created = Object.values(exported.variables).find((v) => v.name === action.name && v.variableCollectionId === action.collectionId);
      expect(created, where).toBeDefined();
      expect([...(created!.scopes ?? [])].sort(), `${where} scopes`).toEqual([...action.scopes].sort());
      expect(created!.codeSyntax?.WEB, `${where} codeSyntax`).toBe(action.codeSyntax);
      for (const [modeId, value] of Object.entries(action.values)) {
        expect(figmaHolds(created!.valuesByMode[modeId], value, exported), `${where} ${modeId}`).toBe(true);
      }
      return;
    }
    case "delete-figma":
      expect(exported.variables[action.variableId], where).toBeUndefined();
      return;
    case "lock-only":
      return;
  }
}

describe("write then read: every action lands as planned", () => {
  for (const shape of SHAPES) {
    it(shapeName(shape), async () => {
      const dir = mkdtempSync(join(tmpdir(), "tp-shape-"));
      writeFileSync(join(dir, "theme.css"), initialCss(shape));
      writeJson(join(dir, "figma.json"), initialFigma(shape));

      // 1. First sync: Figma takes code's values; this establishes the lock.
      const first = await sync(dir, "figma.json", shape, "code");
      expect(first.p.unresolved).toEqual([]);

      // 2. Both sides change, in ways that exercise every writer.
      const exported = readJsonFile<Exported>(join(dir, first.figma));
      editFigma(exported);
      writeJson(join(dir, "figma-edited.json"), exported);
      writeFileSync(join(dir, "theme.css"), editCss(shape, readFileSync(join(dir, "theme.css"), "utf8")));

      // 3. Second sync: the lock says which side changed, so nothing needs a decision.
      const second = await sync(dir, "figma-edited.json", shape, null);
      expect(second.p.unresolved).toEqual([]);
      expect(new Set(second.p.actions.map((a) => a.op))).toEqual(new Set(["update-code", "add-code", "delete-code", "update-figma", "add-figma", "delete-figma"]));

      // 4. Read both sides back: each action landed exactly as planned.
      const cssText = readFileSync(join(dir, "theme.css"), "utf8");
      const final = readJsonFile<Exported>(join(dir, second.figma));
      for (const action of second.p.actions) assertLanded(action, cssText, final, second.p.settings);

      // 5. Every var() in the CSS points at a custom property that exists at runtime.
      const names = runtimeNames(cssText, shape.prefix, second.p.settings.modeMap);
      const dangling = [...cssText.matchAll(VAR_REF)].map((m) => m[1]!).filter((n) => !names.has(n));
      expect(dangling).toEqual([]);

      // 6. And the result is in sync, with nothing left to do.
      const inputs = { figmaPath: join(dir, second.figma), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") };
      expect((await check({ ...inputs, settings: settingsFor(shape) })).findings.filter((f) => f.severity !== "warning")).toEqual([]);
      expect((await plan({ ...inputs, prefer: null, resolutionsPath: null, figmaCollection: null, settings: settingsFor(shape) })).actions).toEqual([]);
      const lock = readJsonFile<LockFile>(join(dir, "tokens.lock.json"));
      expect(Object.keys(lock.tokens)).not.toContain("color-legacy");
      expect(Object.keys(lock.tokens)).not.toContain("radius-md");
    });
  }
});

// Guard against the test passing vacuously: a writer that drops the prefix must fail it.
describe("the runtime-name check catches an unprefixed reference", () => {
  it("flags var(--color-x) in a prefixed project", () => {
    const cssText = '@import "tailwindcss" prefix(tw);\n@theme {\n  --color-x: #000;\n  --color-y: var(--color-x);\n}\n';
    const names = runtimeNames(cssText, "tw", {});
    expect([...cssText.matchAll(VAR_REF)].map((m) => m[1]).filter((n) => !names.has(n!))).toEqual(["--color-x"]);
  });
});

export type { Plan };
