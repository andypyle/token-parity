import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan, StalePlanError } from "../src/apply.js";
import { check } from "../src/check.js";
import { commitPending } from "../src/commit.js";
import { plan, planExitCode } from "../src/plan.js";
import type { FigmaChangeSet, LockFile, Plan } from "../src/types.js";
import { PERCEPTUAL, copyFixture, readJsonFile, simulatePush, writeJson } from "./helpers.js";

const ROOT = import.meta.dirname;
const dirs = (sub: string) =>
  readdirSync(join(ROOT, sub), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(ROOT, sub, d.name))
    .sort();
const ALL = [...dirs("fixtures"), ...dirs("plan-fixtures")];

interface Options {
  settings?: Record<string, unknown>;
  prefer?: "code" | "figma";
  figmaCollection?: string;
  allowDeletes?: boolean;
}
interface ExpectedPlan {
  exitCode: number;
  actions: Array<{ id: string; op: string; via: string }>;
  unresolved: Array<{ finding: string; reason: string }>;
  skipped?: string[];
}

function options(dir: string): Options {
  const p = join(dir, "plan-options.json");
  return existsSync(p) ? readJsonFile<Options>(p) : {};
}

async function planIn(dir: string, figmaFile = "figma.json"): Promise<Plan> {
  const o = options(dir);
  const resolutions = join(dir, "resolutions.json");
  return plan({ settings: { ...PERCEPTUAL, ...o.settings },
    figmaPath: join(dir, figmaFile),
    codePath: join(dir, "theme.css"),
    lockPath: join(dir, "tokens.lock.json"),
    prefer: o.prefer ?? null,
    resolutionsPath: existsSync(resolutions) ? resolutions : null,
    figmaCollection: o.figmaCollection ?? null,
  });
}

const stripBasedOn = ({ basedOn: _, ...rest }: FigmaChangeSet) => rest;

describe("plan", () => {
  for (const fixture of ALL.filter((d) => existsSync(join(d, "expected-plan.json")))) {
    it(fixture.split("/").slice(-2).join("/"), async () => {
      const expected = readJsonFile<ExpectedPlan>(join(fixture, "expected-plan.json"));
      const p = await planIn(fixture);
      expect(p.actions.map(({ id, op, via }) => ({ id, op, via }))).toEqual(expected.actions);
      expect(p.unresolved.map(({ finding, reason }) => ({ finding, reason }))).toEqual(expected.unresolved);
      expect(p.skipped).toEqual(expected.skipped ?? []);
      expect(planExitCode(p)).toBe(expected.exitCode);
    });
  }

  it("records how a new Figma name was chosen", async () => {
    const p = await planIn(join(ROOT, "fixtures", "missing-in-figma"));
    const add = p.actions.find((a) => a.op === "add-figma");
    expect(add).toMatchObject({ name: "color/brand/primary".replace("primary", "secondary"), collectionId: "VC:1", naming: { source: "inferred", sibling: "color-brand-primary" } });
    expect(p.unresolved[0]!.hint).toMatch(/names/);
  });

  it("adds Figma identity to the lock for already-synced tokens", async () => {
    const p = await planIn(join(ROOT, "fixtures", "round-trip-unchanged"));
    expect(p.lockAfter.tokens["color-bg"]!.figma).toEqual({ variableId: "V:3", name: "color/bg" });
    // The old lock keyed the base mode "light"; it's migrated to "default" with the same entry.
    const old = readJsonFile<LockFile>(join(ROOT, "fixtures", "round-trip-unchanged", "tokens.lock.json")).tokens["color-bg"]!.modes;
    expect(p.lockAfter.tokens["color-bg"]!.modes).toEqual({ default: old.light, dark: old.dark });
  });

  it("baselines in-sync tokens that have no lock entry", async () => {
    const p = await planIn(join(ROOT, "fixtures", "in-sync-no-lock"));
    expect(p.lockAfter.tokens["color-bg"]!.modes.dark).toEqual({ oklch: "oklch(0.21 0.006 285.9)", figmaRgb: { r: 0.093799, g: 0.093792, b: 0.105831, a: 1 } });
    // Both sides alias color-blue-500: the lock keeps the resolved value and both aliases.
    expect(p.lockAfter.tokens["color-accent"]!.modes.default).toEqual({
      oklch: "oklch(0.62 0.19 259.8)",
      figmaRgb: { r: 0.223056, g: 0.505183, b: 0.964919, a: 1 },
      figmaAlias: "color-blue-500",
      codeAlias: "color-blue-500",
    });
    expect(p.lockAfter.tokens["radius-md"]!.modes.default).toEqual({ value: "0.5rem" });
  });

  it("records input hashes", async () => {
    const p = await planIn(join(ROOT, "fixtures", "near-match"));
    expect(p.inputs.figma.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.inputs.lock.sha256).toBeNull();
  });
});

describe("apply", () => {
  for (const fixture of ALL.filter((d) => existsSync(join(d, "expected-plan.json")))) {
    it(`goldens: ${fixture.split("/").slice(-2).join("/")}`, async () => {
      const dir = copyFixture(fixture);
      const before = readFileSync(join(dir, "theme.css"), "utf8");
      const p = await planIn(dir);
      const result = await applyPlan(p, { allowDeletes: options(dir).allowDeletes ?? false });

      const css = readFileSync(join(dir, "theme.css"), "utf8");
      const goldenCss = join(fixture, "expected-apply", "theme.css");
      expect(css).toBe(existsSync(goldenCss) ? readFileSync(goldenCss, "utf8") : before);

      const goldenChanges = join(fixture, "expected-apply", "figma-changes.json");
      if (existsSync(goldenChanges)) {
        expect(stripBasedOn(result.figmaChanges)).toEqual(readJsonFile(goldenChanges));
      } else {
        expect(result.figmaChanges.operations).toEqual([]);
      }
    });
  }

  it("skips deletes unless allowed, and keeps their lock entries", async () => {
    const dir = copyFixture(join(ROOT, "plan-fixtures", "deletes"));
    const before = readFileSync(join(dir, "theme.css"), "utf8");
    const result = await applyPlan(await planIn(dir), { allowDeletes: false });
    expect(result.skipped).toEqual(["delete-code:color-gone:*", "delete-figma:color-old:*"]);
    expect(readFileSync(join(dir, "theme.css"), "utf8")).toBe(before);
    expect(result.figmaChanges.operations).toEqual([]);
    const lock = readJsonFile<LockFile>(join(dir, "tokens.lock.json"));
    expect(Object.keys(lock.tokens).sort()).toEqual(["color-gone", "color-keep", "color-old"]);
  });

  it("writes the lock directly when nothing goes to Figma", async () => {
    const dir = copyFixture(join(ROOT, "plan-fixtures", "prefer-figma"));
    const result = await applyPlan(await planIn(dir), { allowDeletes: false });
    expect(result.pending).toBe(false);
    expect(readJsonFile<LockFile>(join(dir, "tokens.lock.json")).tokens["color-bg"]!.modes.dark).toMatchObject({ oklch: "oklch(0.55 0.22 300)" });
  });

  it("writes a pending lock when Figma has to change", async () => {
    const dir = copyFixture(join(ROOT, "plan-fixtures", "prefer-code"));
    const lockBefore = readFileSync(join(dir, "tokens.lock.json"), "utf8");
    const result = await applyPlan(await planIn(dir), { allowDeletes: false });
    expect(result.pending).toBe(true);
    expect(readFileSync(join(dir, "tokens.lock.json"), "utf8")).toBe(lockBefore);
    expect(existsSync(join(dir, ".token-parity", "pending.json"))).toBe(true);
    expect(existsSync(join(dir, ".token-parity", "figma-changes.json"))).toBe(true);
  });

  it("refuses a stale plan", async () => {
    const dir = copyFixture(join(ROOT, "plan-fixtures", "prefer-figma"));
    const p = await planIn(dir);
    writeFileSync(join(dir, "theme.css"), `${readFileSync(join(dir, "theme.css"), "utf8")}\n/* edited */\n`);
    await expect(applyPlan(p, { allowDeletes: false })).rejects.toBeInstanceOf(StalePlanError);
  });
});

describe("commit", () => {
  it("keeps the pending lock when the push did not land", async () => {
    const dir = copyFixture(join(ROOT, "plan-fixtures", "prefer-code"));
    const p = await planIn(dir);
    await applyPlan(p, { allowDeletes: false });
    const result = await commitPending(p, join(dir, "figma.json")); // Figma never received the change
    expect(result.ok).toBe(false);
    expect(result.problems.map((f) => f.token)).toContain("color-bg");
    expect(existsSync(join(dir, ".token-parity", "pending.json"))).toBe(true);
  });

  it("errors when there is nothing pending", async () => {
    const dir = copyFixture(join(ROOT, "plan-fixtures", "prefer-code"));
    await expect(commitPending(await planIn(dir), join(dir, "figma.json"))).rejects.toThrow(/pending/);
  });
});

describe("round trip: plan -> apply -> push -> commit leaves touched tokens in sync", () => {
  for (const fixture of ALL) {
    it(fixture.split("/").slice(-2).join("/"), async () => {
      const dir = copyFixture(fixture);
      const p = await planIn(dir);
      const touched = new Set(p.actions.map((a) => a.token));
      const result = await applyPlan(p, { allowDeletes: true });

      let figmaFile = "figma.json";
      if (result.pending) {
        const fresh = simulatePush(readJsonFile(join(dir, "figma.json")), result.figmaChanges);
        writeJson(join(dir, "figma-fresh.json"), fresh);
        figmaFile = "figma-fresh.json";
        const committed = await commitPending(p, join(dir, figmaFile));
        expect(committed.problems).toEqual([]);
        expect(committed.ok).toBe(true);
        expect(existsSync(join(dir, ".token-parity", "pending.json"))).toBe(false);
      }

      const report = await check({ settings: { ...PERCEPTUAL, ...options(dir).settings }, figmaPath: join(dir, figmaFile), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json") });
      // Everything the plan resolved must be in sync; what it left for the user to decide may remain.
      const leftForUser = new Set([...p.unresolved.map((u) => u.finding), ...p.skipped]);
      const leftovers = report.findings.filter((f) => touched.has(f.token) && f.severity !== "warning" && !leftForUser.has(f.id));
      expect(leftovers).toEqual([]);

      const again = await planIn(dir, figmaFile);
      expect(again.actions).toEqual([]);
    });
  }
});
