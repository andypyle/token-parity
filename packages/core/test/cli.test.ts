import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run-cli.js";
import { copyFixture, readJsonFile, simulatePush, writeJson } from "./helpers.js";
import { mockFigma, runInFigma } from "./mock-figma.js";
import type { FigmaChangeSet } from "../src/types.js";

const F = join(import.meta.dirname, "fixtures");

async function cli(...args: string[]) {
  return cliIn(undefined, ...args);
}

/** Run the CLI with `cwd` as the project folder, as a user would from their project root. */
async function cliIn(cwd: string | undefined, ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), ...(cwd ? { cwd } : {}) });
  return { code, stdout, stderr };
}
const fixtureArgs = (name: string, lock = true) => [
  "check",
  "--figma", join(F, name, "figma.json"),
  "--code", join(F, name, "theme.css"),
  ...(lock ? ["--lock", join(F, name, "tokens.lock.json")] : []),
  "--color-match",
  "perceptual", // these fixtures describe perceptual matching
];

describe("cli", () => {
  it("exits 1 with a markdown report on drift", async () => {
    const r = await cli(...fixtureArgs("conflict"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("# token-parity check");
    expect(r.stdout).toContain("conflict");
  });

  it("exits 0 for warnings only", async () => {
    expect((await cli(...fixtureArgs("out-of-gamut"))).code).toBe(0);
  });

  it("emits JSON with --format json", async () => {
    const r = await cli(...fixtureArgs("value-mismatch"), "--format", "json");
    expect(JSON.parse(r.stdout).summary.errors).toBe(4);
  });

  it("writes to --out", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "tp-")), "report.json");
    const r = await cli(...fixtureArgs("near-match", false), "--format", "json", "--out", out);
    expect(r.stdout).toBe("");
    expect(JSON.parse(readFileSync(out, "utf8")).findings[0].kind).toBe("near-match");
  });

  it("applies threshold flags", async () => {
    const r = await cli(...fixtureArgs("near-match", false), "--near-threshold", "0.0001", "--format", "json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).findings[0].kind).toBe("value-mismatch");
  });

  it("treats a lock path that does not exist yet as no baseline", async () => {
    const r = await cli("check", "--figma", join(F, "near-match", "figma.json"), "--code", join(F, "near-match", "theme.css"), "--lock", join(F, "near-match", "nope.lock.json"), "--format", "json");
    const report = JSON.parse(r.stdout);
    expect(report.inputs.lock).toBeNull();
    expect(report.diagnostics[0]).toMatchObject({ level: "info", origin: "lock" });
  });

  it("exits 2 on usage and input errors", async () => {
    expect((await cli()).code).toBe(2);
    expect((await cli("plan")).stderr).toContain("missing --figma, --code, --lock");
    expect((await cli("deploy")).stderr).toContain("Unknown command: deploy");
    expect((await cli("check", "--figma", "x.json")).code).toBe(2);
    expect((await cli("check", "--figma", "missing.json", "--code", join(F, "conflict", "theme.css"))).stderr).toContain("missing.json");
    expect((await cli(...fixtureArgs("conflict"), "--format", "xml")).code).toBe(2);
    expect((await cli(...fixtureArgs("conflict"), "--mode", "nope")).code).toBe(2);
  });

  it("prints help and version", async () => {
    expect((await cli("--help")).stdout).toContain("Usage:");
    expect((await cli("--version")).stdout).toMatch(/^token-parity \d/);
  });
});

describe("cli: plan -> apply -> commit", () => {
  it("runs the whole flow with default state paths", async () => {
    const dir = copyFixture(join(F, "..", "plan-fixtures", "new-token-multi-mode"));
    const p = (f: string) => join(dir, f);
    const inputs = ["--figma", p("figma.json"), "--code", p("theme.css"), "--lock", p("tokens.lock.json")];

    const planned = await cliIn(dir, "plan", ...inputs, "--color-match", "perceptual");
    expect(planned.code).toBe(0);
    expect(planned.stdout).toContain("# token-parity plan");
    expect(planned.stdout).toContain("in Semantic (code: `var(--color-muted)`; scopes: ALL_FILLS, STROKE_COLOR, EFFECT_COLOR; named like `color-bg`)");

    const applied = await cliIn(dir, "apply", "--lock", p("tokens.lock.json"));
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain(`Figma operation(s) written to ${p(".token-parity/figma-changes.json")}`);

    // Commit before pushing: refused, pending kept.
    const early = await cliIn(dir, "commit", "--figma", p("figma.json"), "--lock", p("tokens.lock.json"));
    expect(early.code).toBe(1);
    expect(early.stdout).toContain("color-muted");

    const changes = readJsonFile<FigmaChangeSet>(p(".token-parity/figma-changes.json"));
    writeJson(p("fresh.json"), simulatePush(readJsonFile(p("figma.json")), changes));
    const committed = await cliIn(dir, "commit", "--figma", p("fresh.json"), "--lock", p("tokens.lock.json"));
    expect(committed.code).toBe(0);

    const after = await cliIn(dir, "check", "--figma", p("fresh.json"), "--code", p("theme.css"), "--lock", p("tokens.lock.json"), "--color-match", "perceptual");
    expect(after.code).toBe(0);
    expect(after.stdout).toContain("**In sync.**");
  });

  it("plan exits 1 with hints when decisions remain, and --prefer settles first-sync differences", async () => {
    const dir = copyFixture(join(F, "value-mismatch"));
    const args = ["plan", "--figma", join(dir, "figma.json"), "--code", join(dir, "theme.css"), "--lock", join(dir, "tokens.lock.json")];
    const first = await cliIn(dir, ...args);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("Pass --prefer code\\|figma");
    expect((await cliIn(dir, ...args, "--prefer", "code")).code).toBe(0);
    expect((await cliIn(dir, ...args, "--prefer", "both")).code).toBe(2);
  });

  it("apply exits 2 on a stale plan", async () => {
    const dir = copyFixture(join(F, "..", "plan-fixtures", "prefer-figma"));
    await cliIn(dir, "plan", "--figma", join(dir, "figma.json"), "--code", join(dir, "theme.css"), "--lock", join(dir, "tokens.lock.json"), "--prefer", "figma");
    writeFileSync(join(dir, "theme.css"), "@theme { --color-bg: red; }\n");
    const r = await cliIn(dir, "apply", "--lock", join(dir, "tokens.lock.json"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("re-run plan");
  });
});

describe("cli: config file and Figma bridge", () => {
  it("reads defaults from the config file, relative to its location", async () => {
    const dir = copyFixture(join(F, "conflict"));
    writeJson(join(dir, "token-parity.config.json"), { figma: "figma.json", code: "theme.css", lock: "tokens.lock.json", nearThreshold: 0.01 });
    const r = await cliIn(dir, "check", "--config", join(dir, "token-parity.config.json"), "--format", "json");
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.findings[0].kind).toBe("conflict");
    expect(report.settings.nearThreshold).toBe(0.01);
  });

  it("flags override the config", async () => {
    const dir = copyFixture(join(F, "near-match"));
    writeJson(join(dir, "token-parity.config.json"), { figma: "figma.json", code: "theme.css", nearThreshold: 0.0001, colorMatch: "perceptual" });
    const config = join(dir, "token-parity.config.json");
    expect((await cliIn(dir, "check", "--config", config)).code).toBe(1);
    expect((await cliIn(dir, "check", "--config", config, "--near-threshold", "0.005")).code).toBe(0);
  });

  it("rejects a malformed config", async () => {
    const dir = copyFixture(join(F, "near-match"));
    writeJson(join(dir, "c.json"), { modes: { dark: ".dark" } });
    const r = await cliIn(dir, "check", "--config", join(dir, "c.json"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"modes"');
  });

  it("figma-script export prints runnable code; verify-export checks the saved file", async () => {
    const dir = copyFixture(join(F, "near-match"));
    const code = (await cliIn(dir, "figma-script", "export")).stdout;
    const result = (await runInFigma(code, mockFigma(readJsonFile(join(dir, "figma.json"))).figma)) as { export: unknown; checksum: string };
    const json = JSON.stringify(result.export);

    writeFileSync(join(dir, "export.json"), json); // any formatting verifies; verify-export stores it canonically
    expect((await cliIn(dir, "verify-export", "--figma", join(dir, "export.json"), "--checksum", result.checksum)).code).toBe(0);
    expect(readFileSync(join(dir, "export.json"), "utf8")).toBe(`${JSON.stringify(result.export, null, 2)}\n`);

    // With the saved file, the generated script asks Figma for "unchanged" instead of the data.
    const known = (await cliIn(dir, "figma-script", "export", "--figma", join(dir, "export.json"))).stdout;
    expect(await runInFigma(known, mockFigma(readJsonFile(join(dir, "figma.json"))).figma)).toMatchObject({ unchanged: true });

    const tampered = json.replace(/0\.22/, "0.23");
    expect(tampered).not.toBe(json);
    writeFileSync(join(dir, "export.json"), tampered);
    const bad = await cliIn(dir, "verify-export", "--figma", join(dir, "export.json"), "--checksum", result.checksum);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("MISMATCH");

    writeFileSync(join(dir, "export.json"), json.slice(0, 100));
    expect((await cliIn(dir, "verify-export", "--figma", join(dir, "export.json"), "--checksum", result.checksum)).stdout).toContain("not valid JSON");
  });

  it("figma-script push finds the change set next to the lock", async () => {
    const dir = copyFixture(join(F, "..", "plan-fixtures", "prefer-code"));
    const inputs = ["--figma", join(dir, "figma.json"), "--code", join(dir, "theme.css"), "--lock", join(dir, "tokens.lock.json")];
    expect((await cliIn(dir, "figma-script", "push", "--lock", join(dir, "tokens.lock.json"))).stderr).toContain("run apply first");
    await cliIn(dir, "plan", ...inputs, "--prefer", "code");
    await cliIn(dir, "apply", "--lock", join(dir, "tokens.lock.json"));
    const r = await cliIn(dir, "figma-script", "push", "--lock", join(dir, "tokens.lock.json"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("return await tpPushChanges(figma, CHANGES,");
    expect((await cliIn(dir, "figma-script", "nope")).code).toBe(2);
  });
});

describe("cli: use_figma size limit", () => {
  it("refuses a push script over use_figma's code limit, with a way forward", async () => {
    const dir = copyFixture(join(F, "..", "plan-fixtures", "prefer-code"));
    const inputs = ["--figma", join(dir, "figma.json"), "--code", join(dir, "theme.css"), "--lock", join(dir, "tokens.lock.json")];
    await cliIn(dir, "plan", ...inputs, "--prefer", "code");
    await cliIn(dir, "apply", "--lock", join(dir, "tokens.lock.json"));
    const changesPath = join(dir, ".token-parity", "figma-changes.json");
    const changes = readJsonFile<FigmaChangeSet>(changesPath);
    const op = changes.operations[0]!;
    changes.operations = Array.from({ length: 400 }, () => op);
    writeJson(changesPath, changes);
    const r = await cliIn(dir, "figma-script", "push", "--lock", join(dir, "tokens.lock.json"));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/over use_figma's 50000 limit \(400 operations\).*skip/);
  });
});

describe("cli: help", () => {
  it("names the config file", async () => {
    const help = (await cli("--help")).stdout;
    expect(help).toContain("./token-parity.config.json");
    expect(help).not.toContain("${");
  });
});

describe("cli: input validation", () => {
  it("rejects a malformed --checksum", async () => {
    const r = await cli("verify-export", "--figma", join(F, "near-match", "figma.json"), "--checksum", "abc; rm -rf ~");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("14-character checksum");
  });
});
