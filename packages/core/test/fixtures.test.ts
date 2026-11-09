import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, exitCodeFor } from "../src/check.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

interface Expected {
  exitCode: number;
  findings: Array<{ id: string; kind: string; token: string; mode: string | null; severity: string; suggestedDirection: string }>;
}

const cases = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe("fixtures", () => {
  it("has a fixture for every case in the brief", () => {
    for (const name of [
      "missing-in-code",
      "missing-in-figma",
      "value-mismatch",
      "near-match",
      "broken-alias",
      "missing-mode",
      "conflict",
      "out-of-gamut",
      "round-trip-unchanged",
    ]) {
      expect(cases).toContain(name);
    }
  });

  for (const name of cases) {
    it(name, async () => {
      const dir = join(FIXTURES, name);
      const lockPath = join(dir, "tokens.lock.json");
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;

      const report = await check({
        figmaPath: join(dir, "figma.json"),
        codePath: join(dir, "theme.css"),
        lockPath: existsSync(lockPath) ? lockPath : null,
      });

      const actual = report.findings.map(({ id, kind, token, mode, severity, suggestedDirection }) => ({
        id,
        kind,
        token,
        mode,
        severity,
        suggestedDirection,
      }));
      expect(actual).toEqual(expected.findings);
      expect(report.diagnostics.filter((d) => d.level === "error")).toEqual([]);
      expect(exitCodeFor(report)).toBe(expected.exitCode);
    });
  }
});
