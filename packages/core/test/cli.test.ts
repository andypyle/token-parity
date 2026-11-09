import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run-cli.js";

const F = join(import.meta.dirname, "fixtures");

async function cli(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}
const fixtureArgs = (name: string, lock = true) => [
  "check",
  "--figma", join(F, name, "figma.json"),
  "--code", join(F, name, "theme.css"),
  ...(lock ? ["--lock", join(F, name, "tokens.lock.json")] : []),
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
    expect((await cli("plan")).stderr).toContain("not implemented yet");
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
