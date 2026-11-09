// Public API for token-parity.
export { VERSION } from "./version.js";
export * from "./types.js";
export { check, exitCodeFor, type CheckOptions } from "./check.js";
export { compare, type CompareInput, type CompareResult } from "./compare.js";
export { readFigmaExport, figmaNameToKey } from "./adapters/figma.js";
export { readTailwindCss } from "./adapters/tailwind.js";
export { parseLock } from "./lock.js";
export { renderJson } from "./report/json.js";
export { renderMarkdown } from "./report/markdown.js";
export { InputError } from "./errors.js";
export { plan, planExitCode, readResolutions, type PlanOptions } from "./plan.js";
export { applyPlan, StalePlanError, type ApplyOptions, type ApplyResult } from "./apply.js";
export { commitPending, type CommitResult } from "./commit.js";
export { renderPlanMarkdown } from "./report/plan-markdown.js";
export { inferFigmaName } from "./naming.js";
export { exportScript, pushScript, jsonChecksum } from "./figma-script.js";
export { loadConfig, CONFIG_FILE, type Config } from "./config.js";
