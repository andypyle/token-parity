// CLI logic, separated from the entry point so it can be tested without spawning a process.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { applyPlan, StalePlanError } from "./apply.js";
import { check, exitCodeFor, parseJson } from "./check.js";
import { commitFromPush, commitPending } from "./commit.js";
import { CONFIG_FILE, loadConfig, settingsFromConfig, type Config } from "./config.js";
import { exportScript, jsonChecksum, pushScript } from "./figma-script.js";
import { InputError } from "./errors.js";
import { assertInside } from "./paths.js";
import { plan, planExitCode } from "./plan.js";
import { renderJson } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderPlanMarkdown } from "./report/plan-markdown.js";
import { defaultChangesPath, defaultPlanPath, toJson } from "./state.js";
import type { CompareSettings, FigmaChangeSet, Plan } from "./types.js";
import { VERSION } from "./version.js";

export const USAGE = `token-parity ${VERSION}

Usage:
  token-parity check  --figma <file> --code <file> [--lock <file>] [options]
  token-parity plan   --figma <file> --code <file> --lock <file> [--prefer code|figma]
                      [--resolutions <file>] [--figma-collection <name>] [--out <file>]
  token-parity apply  (--plan <file> | --lock <file>) [--allow-deletes] [--changes-out <file>]
  token-parity commit (--push-result <json|file|-> | --figma <fresh export>) (--plan <file> | --lock <file>)

Figma bridge (used by the Claude Code skill with the Figma MCP's use_figma tool):
  token-parity figma-script export [--figma <f>]  print use_figma code that exports variables
                                                 (answers "unchanged" if Figma still matches <f>)
  token-parity figma-script push [--changes <f>] print use_figma code that applies a change set
  token-parity verify-export --figma <file> --checksum <c>
                                                 confirm a saved export matches what Figma returned

Every command reads defaults from ./${CONFIG_FILE} (or --config <file>): figma, code, lock,
resolutions, figmaCollection, modes, prefix, ignore, colorFormat, colorMatch, nearThreshold, rgbTolerance,
precision, remBase.
Paths in it are relative to the config file. Flags override it.

check options:
  --format <md|json>       report format (default: md)
  --out <file>             write the report to a file instead of stdout

plan writes plan.json to --out (default: <lock dir>/.token-parity/plan.json) and prints a summary.
apply edits the CSS, then either writes the lock (nothing for Figma) or writes figma-changes.json
and a pending lock. After the changes are pushed to Figma, commit verifies a fresh export and
writes the lock.

Comparison options (check, plan):
  --near-threshold <n>     ΔE_OK below which colors are a near-match (default: 0.005)
  --rgb-tolerance <n>      per-channel 0-1 tolerance vs locked RGB (default: 0.00196)
  --precision <l,c,h>      decimals when converting changed Figma RGB (default: 4,4,2)
  --rem-base <n>           px per rem (default: 16)
  --color-format <f>       how plan writes colors into CSS: preserve (default; keep each value's
                           format, new tokens use the file's usual one), hex, rgb, or oklch
                           (oklch needs --color-match perceptual)
  --color-match <m>        exact (default): colors must be Figma's 8-bit value, written as hex or rgb();
                           perceptual: compare by OKLCH distance, rounding is a near-match
  --ignore <pattern>       leave a token alone: CSS or Figma name, glob, optional :mode
                           (e.g. animate-*, dark/*, color-amber-*:dark); repeatable
  --mode <name=selector>   CSS selector or at-rule for a mode; repeatable; replaces the
                           default (dark=.dark, dark=[data-theme="dark"], dark=@variant dark)

  -h, --help               show this help
  -v, --version            show the version

Exit codes:
  check   0 in sync (warnings allowed), 1 drift found
  plan    0 every finding has an action, 1 decisions remain
  apply   0 applied
  commit  0 lock written, 1 some changes are not in Figma yet (pending lock kept)
  verify-export  0 matches, 1 the file differs from what Figma returned
  all     2 usage or input error, or a stale plan
`;

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Project folder: files are only written or deleted inside it. Defaults to the working directory. */
  cwd?: string;
}

const rootOf = (io: CliIO) => io.cwd ?? process.cwd();

const COMPARE_OPTIONS = {
  "near-threshold": { type: "string" },
  "rgb-tolerance": { type: "string" },
  precision: { type: "string" },
  "rem-base": { type: "string" },
  mode: { type: "string", multiple: true },
  ignore: { type: "string", multiple: true },
  "color-format": { type: "string" },
  "color-match": { type: "string" },
} as const satisfies ParseArgsConfig["options"];

const OPTIONS = {
  check: { figma: { type: "string" }, code: { type: "string" }, lock: { type: "string" }, format: { type: "string", default: "md" }, out: { type: "string" }, ...COMPARE_OPTIONS },
  plan: {
    figma: { type: "string" },
    code: { type: "string" },
    lock: { type: "string" },
    prefer: { type: "string" },
    resolutions: { type: "string" },
    "figma-collection": { type: "string" },
    out: { type: "string" },
    ...COMPARE_OPTIONS,
  },
  apply: { plan: { type: "string" }, lock: { type: "string" }, "allow-deletes": { type: "boolean" }, "changes-out": { type: "string" } },
  commit: { figma: { type: "string" }, plan: { type: "string" }, lock: { type: "string" }, "push-result": { type: "string" } },
  "figma-script": { changes: { type: "string" }, lock: { type: "string" }, figma: { type: "string" } },
  "verify-export": { figma: { type: "string" }, checksum: { type: "string" } },
} as const satisfies Record<string, ParseArgsConfig["options"]>;

type Command = keyof typeof OPTIONS;
type Values = Record<string, string | boolean | string[] | undefined>;

class UsageError extends Error {}

/** use_figma's maximum code length (Figma MCP tool schema). */
export const USE_FIGMA_CODE_LIMIT = 50_000;

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    io.stdout(`token-parity ${VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  if (!command || !(command in OPTIONS)) {
    io.stderr(`${command ? `Unknown command: ${command}\n\n` : ""}${USAGE}`);
    return 2;
  }

  let values: Values;
  let positionals: string[] = [];
  try {
    const parsed = parseArgs({
      args: rest,
      options: { ...OPTIONS[command as Command], config: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: command === "figma-script",
      strict: true,
    }) as unknown as { values: Values; positionals: string[] };
    ({ values, positionals } = parsed);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }

  try {
    const config = loadConfig(str(values, "config"));
    const v = withConfig(values, config);
    switch (command as Command) {
      case "check":
        return await runCheck(v, config, io);
      case "plan":
        return await runPlan(v, config, io);
      case "apply":
        return await runApply(v, io);
      case "commit":
        return await runCommit(v, io);
      case "figma-script":
        return await runFigmaScript(v, positionals, io);
      case "verify-export":
        return await runVerifyExport(v, io);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof InputError || err instanceof StalePlanError) {
      io.stderr(`token-parity: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

/** Config values become defaults for flags that weren't given. */
function withConfig(values: Values, config: Config): Values {
  const v = { ...values };
  for (const key of ["figma", "code", "lock", "resolutions"] as const) {
    if (v[key] === undefined && config[key] !== undefined) v[key] = config[key];
  }
  if (v["figma-collection"] === undefined && config.figmaCollection) v["figma-collection"] = config.figmaCollection;
  return v;
}

const str = (v: Values, k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
function required(v: Values, ...keys: string[]): string[] {
  const missing = keys.filter((k) => !str(v, k));
  if (missing.length > 0) throw new UsageError(`missing ${missing.map((k) => `--${k}`).join(", ")}`);
  return keys.map((k) => str(v, k)!);
}

async function runCheck(v: Values, config: Config, io: CliIO): Promise<number> {
  const [figmaPath, codePath] = required(v, "figma", "code");
  const format = str(v, "format");
  if (format !== "md" && format !== "json") throw new UsageError(`--format must be md or json, got ${format}`);
  const report = await check({ figmaPath: figmaPath!, codePath: codePath!, lockPath: str(v, "lock") ?? null, settings: { ...settingsFromConfig(config), ...settingsFrom(v) } });
  await emit(format === "json" ? renderJson(report) : renderMarkdown(report), str(v, "out"), io);
  return exitCodeFor(report);
}

async function runPlan(v: Values, config: Config, io: CliIO): Promise<number> {
  const [figmaPath, codePath, lockPath] = required(v, "figma", "code", "lock");
  const prefer = str(v, "prefer") ?? null;
  if (prefer !== null && prefer !== "code" && prefer !== "figma") throw new UsageError(`--prefer must be code or figma, got ${prefer}`);
  const p = await plan({
    figmaPath: figmaPath!,
    codePath: codePath!,
    lockPath: lockPath!,
    prefer,
    // A configured resolutions file is optional until the user has made a decision.
    resolutionsPath: str(v, "resolutions") && (v.resolutions !== config.resolutions || existsSync(str(v, "resolutions")!)) ? str(v, "resolutions")! : null,
    figmaCollection: str(v, "figma-collection") ?? null,
    settings: { ...settingsFromConfig(config), ...settingsFrom(v) },
  });
  const out = str(v, "out") ?? defaultPlanPath(lockPath!);
  assertInside(rootOf(io), out, "the plan file");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, toJson(p));
  io.stdout(renderPlanMarkdown(p));
  io.stderr(`Wrote ${out}\n`);
  return planExitCode(p);
}

async function loadPlan(v: Values): Promise<Plan> {
  const path = str(v, "plan") ?? (str(v, "lock") ? defaultPlanPath(str(v, "lock")!) : undefined);
  if (!path) throw new UsageError("pass --plan <file> or --lock <file>");
  if (!existsSync(path)) throw new InputError("plan not found; run plan first", path);
  const p = parseJson(await readFile(path, "utf8"), path) as Plan;
  if (p?.schemaVersion !== 1) throw new InputError("not a token-parity plan", path);
  return p;
}

async function runApply(v: Values, io: CliIO): Promise<number> {
  const p = await loadPlan(v);
  const changesOut = str(v, "changes-out");
  const result = await applyPlan(p, { allowDeletes: v["allow-deletes"] === true, root: rootOf(io), ...(changesOut ? { changesOut } : {}) });
  io.stdout(`Applied ${result.applied.length} action${result.applied.length === 1 ? "" : "s"}.\n`);
  if (result.skipped.length > 0) io.stdout(`Skipped ${result.skipped.length} delete${result.skipped.length === 1 ? "" : "s"} (pass --allow-deletes): ${result.skipped.join(", ")}\n`);
  if (result.pending) {
    io.stdout(
      `${result.figmaChanges.operations.length} Figma operation(s) written to ${result.changesPath}.\n` +
        "Push them to Figma (token-parity figma-script push), export the variables again to the same file,\n" +
        "then run: token-parity commit\n",
    );
  } else {
    io.stdout(`Nothing to push to Figma; wrote ${p.inputs.lock.path}.\n`);
  }
  return 0;
}

async function runCommit(v: Values, io: CliIO): Promise<number> {
  const p = await loadPlan(v);
  const pushArg = str(v, "push-result");
  let result;
  if (pushArg) {
    result = await commitFromPush(p, await readPushResult(pushArg), rootOf(io));
    if (result.predictionMismatch) {
      io.stdout(
        "Figma's state after the push differs from the engine's prediction (nothing is wrong yet). " +
          "Export again (figma-script export, save, verify-export), then run: token-parity commit\n",
      );
      return 1;
    }
  } else {
    const [figmaPath] = required(v, "figma");
    result = await commitPending(p, figmaPath!, rootOf(io));
  }
  for (const d of result.diagnostics) io.stderr(`${d.level}: ${d.message}\n`);
  if (!result.ok) {
    io.stdout(`Not committed: ${result.problems.length} change(s) are not in sync yet. The pending lock is kept.\n`);
    for (const f of result.problems) io.stdout(`- ${f.kind} ${f.token}${f.mode ? ` (${f.mode})` : ""}: ${f.message}\n`);
    return 1;
  }
  io.stdout(`Committed. Wrote ${result.lockPath}.\n`);
  return 0;
}

async function readPushResult(arg: string): Promise<{ created: Array<{ id: string; name: string }>; exportChecksum: string }> {
  let text = arg;
  if (arg === "-") text = await readStdin();
  else if (!arg.trimStart().startsWith("{")) text = await readFile(arg, "utf8").catch(() => {
    throw new InputError("cannot read push result", arg);
  });
  return parseJson(text, "--push-result") as { created: Array<{ id: string; name: string }>; exportChecksum: string };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function runFigmaScript(v: Values, positionals: string[], io: CliIO): Promise<number> {
  const [kind] = positionals;
  if (kind === "export") {
    // Embed the saved export's checksum so an unchanged Figma file costs no transfer.
    const saved = str(v, "figma");
    let known: string | null = null;
    if (saved && existsSync(saved)) {
      try {
        known = jsonChecksum(await readFile(saved, "utf8"));
      } catch {
        known = null;
      }
    }
    io.stdout(exportScript(known));
    return 0;
  }
  if (kind !== "push") throw new UsageError("figma-script needs `export` or `push`");
  const path = str(v, "changes") ?? (str(v, "lock") ? defaultChangesPath(str(v, "lock")!) : undefined);
  if (!path) throw new UsageError("pass --changes <file> or --lock <file>");
  if (!existsSync(path)) throw new InputError("no change set; run apply first", path);
  const changes = parseJson(await readFile(path, "utf8"), path) as FigmaChangeSet;
  if (changes?.version !== 1 || !Array.isArray(changes.operations) || !changes.basedOn?.exportChecksum) {
    throw new InputError("not a token-parity change set (or made before export checksums); re-run plan and apply", path);
  }
  const script = pushScript(changes);
  if (script.length > USE_FIGMA_CODE_LIMIT) {
    throw new UsageError(
      `the push script is ${script.length} characters, over use_figma's ${USE_FIGMA_CODE_LIMIT} limit (${changes.operations.length} operations). ` +
        "Sync in smaller batches: mark some items \"skip\" in the resolutions file, then plan and apply again.",
    );
  }
  io.stdout(script);
  return 0;
}

async function runVerifyExport(v: Values, io: CliIO): Promise<number> {
  const [figmaPath, expected] = required(v, "figma", "checksum");
  if (!/^[0-9a-f]{14}$/.test(expected!)) throw new UsageError("--checksum must be the 14-character checksum the Figma export returned");
  const text = await readFile(figmaPath!, "utf8").catch(() => {
    throw new InputError("cannot read file", figmaPath);
  });
  let actual: string;
  try {
    actual = jsonChecksum(text);
  } catch {
    io.stdout(`MISMATCH: ${figmaPath} is not valid JSON. Write the export's \`json\` string to the file again, exactly as returned.\n`);
    return 1;
  }
  if (actual !== expected) {
    io.stdout(`MISMATCH: ${figmaPath} has checksum ${actual}, Figma returned ${expected}. Write the export's \`json\` string to the file again, exactly as returned.\n`);
    return 1;
  }
  // Store it in one canonical layout so git diffs stay readable whoever wrote the file.
  const canonical = toJson(JSON.parse(text));
  if (canonical !== text) {
    assertInside(rootOf(io), figmaPath!, "the Figma export");
    await writeFile(figmaPath!, canonical);
  }
  io.stdout(`OK: ${figmaPath} matches the Figma export (${expected}).\n`);
  return 0;
}

async function emit(output: string, out: string | undefined, io: CliIO) {
  if (out) {
    await writeFile(out, output);
    io.stderr(`Wrote ${out}\n`);
  } else {
    io.stdout(output);
  }
}

function settingsFrom(values: Values): Partial<CompareSettings> {
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

  if (Array.isArray(values.ignore)) settings.ignore = values.ignore;
  if (typeof values["color-format"] === "string") {
    const f = values["color-format"];
    if (f !== "preserve" && f !== "oklch" && f !== "hex" && f !== "rgb") throw new UsageError("--color-format must be preserve, oklch, hex or rgb");
    settings.colorFormat = f;
  }
  if (typeof values["color-match"] === "string") {
    const m = values["color-match"];
    if (m !== "exact" && m !== "perceptual") throw new UsageError("--color-match must be exact or perceptual");
    settings.colorMatch = m;
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
