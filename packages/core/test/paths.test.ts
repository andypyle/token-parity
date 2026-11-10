// A cloned repository controls token-parity.config.json, .token-parity/plan.json and pending.json. None of
// them may make token-parity write or delete a file outside the project folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPlan } from "../src/apply.js";
import { commitPending } from "../src/commit.js";
import { InputError } from "../src/errors.js";
import { isInside } from "../src/paths.js";
import { plan } from "../src/plan.js";
import { runCli } from "../src/run-cli.js";
import { sha256 } from "../src/state.js";
import { copyFixture, PERCEPTUAL, writeJson } from "./helpers.js";

const FIXTURE = join(import.meta.dirname, "plan-fixtures", "prefer-figma");

/** A project, plus a file outside it that must never be touched. */
function setup() {
  const project = copyFixture(FIXTURE);
  const outside = join(mkdtempSync(join(tmpdir(), "tp-outside-")), "precious.txt");
  writeFileSync(outside, "do not touch\n");
  return { project, outside };
}
const planFor = (dir: string) =>
  plan({ figmaPath: join(dir, "figma.json"), codePath: join(dir, "theme.css"), lockPath: join(dir, "tokens.lock.json"), prefer: "figma", resolutionsPath: null, figmaCollection: null, settings: PERCEPTUAL });

describe("isInside", () => {
  it("handles nested, sibling, parent and dot-dot paths", () => {
    expect(isInside("/a/b", "/a/b/c.css")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/bc/x")).toBe(false);
    expect(isInside("/a/b", "/a/b/../c")).toBe(false);
  });
});

describe("apply stays inside the project", () => {
  it("refuses a plan that points the code file outside, and writes nothing", async () => {
    const { project, outside } = setup();
    const p = await planFor(project);
    p.inputs.code = { path: outside, sha256: sha256(readFileSync(outside, "utf8")) }; // a crafted plan.json
    await expect(applyPlan(p, { allowDeletes: false, root: project })).rejects.toThrow(InputError);
    expect(readFileSync(outside, "utf8")).toBe("do not touch\n");
  });

  it("refuses a symlinked code file that leads outside", async () => {
    const { project, outside } = setup();
    writeFileSync(outside, readFileSync(join(project, "theme.css"), "utf8"));
    const link = join(project, "linked.css");
    symlinkSync(outside, link);
    const p = await plan({ figmaPath: join(project, "figma.json"), codePath: link, lockPath: join(project, "tokens.lock.json"), prefer: "figma", resolutionsPath: null, figmaCollection: null, settings: PERCEPTUAL });
    const before = readFileSync(outside, "utf8");
    await expect(applyPlan(p, { allowDeletes: false, root: project })).rejects.toThrow(/outside the project folder/);
    expect(readFileSync(outside, "utf8")).toBe(before);
  });

  it("works normally inside the project", async () => {
    const { project } = setup();
    await expect(applyPlan(await planFor(project), { allowDeletes: false, root: project })).resolves.toBeDefined();
  });
});

describe("commit stays inside the project", () => {
  it("refuses a pending.json that would delete a file outside .token-parity/", async () => {
    const { project, outside } = setup();
    const p = await planFor(project);
    mkdirSync(join(project, ".token-parity"), { recursive: true });
    writeJson(join(project, ".token-parity", "pending.json"), { version: 1, plan: p.inputs, applied: [], touched: [], codeSha256: "", changesPath: outside, lock: p.lockAfter });
    await expect(commitPending(p, join(project, "figma.json"), project)).rejects.toThrow(/outside .*refusing/);
    expect(existsSync(outside)).toBe(true);
  });
});

describe("the CLI uses the working directory as the project folder", () => {
  it("refuses a config whose lock (and so plan.json) lives outside", async () => {
    const { project, outside } = setup();
    writeJson(join(project, "token-parity.config.json"), { figma: "figma.json", code: "theme.css", lock: join(outside, "..", "evil.lock.json"), colorMatch: "perceptual" });
    let stderr = "";
    const code = await runCli(["plan", "--config", join(project, "token-parity.config.json"), "--prefer", "figma"], { stdout: () => {}, stderr: (s) => (stderr += s), cwd: project });
    expect(code).toBe(2);
    expect(stderr).toContain("outside the project folder");
    expect(existsSync(join(outside, "..", ".token-parity"))).toBe(false);
  });
});
