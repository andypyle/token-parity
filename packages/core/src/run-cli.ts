// CLI logic, separated from the entry point so it can be tested without spawning a process.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { check, exitCodeFor } from "./check.js";
import { InputError } from "./errors.js";
import { renderJson } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import type { CompareSettings } from "./types.js";
import { VERSION } from "./version.js";

export const USAGE = `token-parity ${VERSION}

Usage:
  token-parity check --figma <file> --code <file> [--lock <file>] [options]

Options:
  --figma <file>           JSON export of Figma variables
  --code <file>            Tailwind v4 CSS with @theme variables
  --lock <file>            tokens.lock.json (last synced state); may not exist yet
  --format <md|json>       report format (default: md)
  --out <file>             write the report to a file instead of stdout
  --near-threshold <n>     ΔE_OK below which colors are a near-match (default: 0.005)
  --rgb-tolerance <n>      per-channel 0-1 tolerance vs locked RGB (default: 0.00196)
  --precision <l,c,h>      decimals when converting changed Figma RGB (default: 4,4,2)
  --rem-base <n>           px per rem (default: 16)
  --mode <name=selector>   CSS selector or at-rule for a mode; repeatable; replaces the
                           default (dark=.dark, dark=[data-theme="dark"], dark=@variant dark)
  -h, --help               show this help
  -v, --version            show the version

Exit codes: 0 in sync (warnings allowed), 1 drift found, 2 usage or input error.
`;

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        figma: { type: "string" },
        code: { type: "string" },
        lock: { type: "string" },
        format: { type: "string", default: "md" },
        out: { type: "string" },
        "near-threshold": { type: "string" },
        "rgb-tolerance": { type: "string" },
        precision: { type: "string" },
        "rem-base": { type: "string" },
        mode: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    io.stdout(`token-parity ${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    io.stdout(USAGE);
    return values.help ? 0 : 2;
  }

  const [command] = positionals;
  if (command !== "check") {
    io.stderr(`Unknown command: ${command}${command === "plan" || command === "apply" ? " (not implemented yet)" : ""}\n\n${USAGE}`);
    return 2;
  }

  try {
    if (!values.figma || !values.code) throw new UsageError("check requires --figma and --code");
    if (values.format !== "md" && values.format !== "json") throw new UsageError(`--format must be md or json, got ${values.format}`);

    const report = await check({
      figmaPath: values.figma,
      codePath: values.code,
      lockPath: values.lock ?? null,
      settings: settingsFrom(values),
    });
    const output = values.format === "json" ? renderJson(report) : renderMarkdown(report);
    if (values.out) {
      await writeFile(values.out, output);
      io.stderr(`Wrote ${values.out}\n`);
    } else {
      io.stdout(output);
    }
    return exitCodeFor(report);
  } catch (err) {
    if (err instanceof UsageError || err instanceof InputError) {
      io.stderr(`token-parity: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

class UsageError extends Error {}

function settingsFrom(values: Record<string, string | boolean | string[] | undefined>): Partial<CompareSettings> {
  const settings: Partial<CompareSettings> = {};
  const num = (flag: string) => {
    const raw = values[flag];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (typeof raw !== "string" || !Number.isFinite(n) || n < 0) throw new UsageError(`--${flag} must be a non-negative number`);
    return n;
  };

  const near = num("near-threshold");
  if (near !== undefined) settings.nearThreshold = near;
  const tol = num("rgb-tolerance");
  if (tol !== undefined) settings.rgbTolerance = tol;
  const rem = num("rem-base");
  if (rem !== undefined) settings.remBase = rem;

  if (typeof values.precision === "string") {
    const parts = values.precision.split(",").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
      throw new UsageError("--precision must be three non-negative integers: l,c,h");
    }
    settings.precision = { l: parts[0]!, c: parts[1]!, h: parts[2]! };
  }

  if (Array.isArray(values.mode)) {
    const modeMap: Record<string, string[]> = {};
    for (const entry of values.mode) {
      const eq = entry.indexOf("=");
      if (eq <= 0 || eq === entry.length - 1) throw new UsageError(`--mode must be name=selector, got ${entry}`);
      const name = entry.slice(0, eq).trim();
      (modeMap[name] ??= []).push(entry.slice(eq + 1).trim());
    }
    settings.modeMap = modeMap;
  }
  return settings;
}
