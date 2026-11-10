// The Claude Code plugin runs the single-file bundle in skills/token-parity/bin. These tests drive that exact
// file the way the skill does, so a bundling problem (e.g. minified names breaking the generated Figma code)
// can't hide behind tests that only run the TypeScript source.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile } from "./helpers.js";
import { mockFigma, runInFigma } from "./mock-figma.js";

const BUNDLE = join(import.meta.dirname, "..", "..", "..", "skills", "token-parity", "bin", "token-parity.mjs");

function cli(cwd: string, ...args: string[]): { code: number; stdout: string } {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [BUNDLE, ...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

describe("plugin bundle", () => {
  it("exists and is self-contained (runs from a folder with no node_modules)", () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "tp-bundle-"));
    cpSync(BUNDLE, join(dir, "tp.mjs"));
    expect(execFileSync(process.execPath, [join(dir, "tp.mjs"), "--version"], { cwd: dir, encoding: "utf8" })).toMatch(/^token-parity \d/);
  });

  it("runs a full sync the way the skill does: export, verify, plan, apply, push, commit, check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-bundle-sync-"));
    cpSync(join(import.meta.dirname, "plan-fixtures", "new-token-multi-mode"), dir, { recursive: true });
    writeFileSync(join(dir, "token-parity.config.json"), JSON.stringify({ figma: "figma-export.json", code: "theme.css", lock: "tokens.lock.json", colorMatch: "perceptual" }));
    const mock = mockFigma(readJsonFile(join(dir, "figma.json")));

    // Export through the bundle's generated plugin code.
    const exported = (await runInFigma(cli(dir, "figma-script", "export").stdout, mock.figma)) as { checksum: string; export: unknown };
    writeFileSync(join(dir, "figma-export.json"), JSON.stringify(exported.export));
    expect(cli(dir, "verify-export", "--checksum", exported.checksum).code).toBe(0);

    expect(cli(dir, "plan").code).toBe(0);
    expect(cli(dir, "apply").code).toBe(0);

    // Push through the bundle's generated plugin code, then commit from the push result (no second export).
    const pushed = await runInFigma(cli(dir, "figma-script", "push").stdout, mock.figma);
    expect(cli(dir, "commit", "--push-result", JSON.stringify(pushed)).code).toBe(0);

    // The next export is "unchanged", and everything is in sync.
    expect(await runInFigma(cli(dir, "figma-script", "export").stdout, mock.figma)).toMatchObject({ unchanged: true });
    expect(cli(dir, "check").code).toBe(0);
  });
});
