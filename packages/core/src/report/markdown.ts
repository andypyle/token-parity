import type { Finding, Report, Severity } from "../types.js";

const SECTIONS: Array<[Severity, string]> = [
  ["error", "Drift"],
  ["warning", "Warnings"],
  ["info", "Near-matches"],
];

const DIRECTION: Record<Finding["suggestedDirection"], string> = {
  "figma-to-code": "Figma → code",
  "code-to-figma": "code → Figma",
  none: "none",
  "needs-decision": "needs decision",
};

const cell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

export function renderMarkdown(report: Report): string {
  const { summary, inputs } = report;
  const lines: string[] = ["# token-parity check", ""];

  const status =
    summary.errors > 0
      ? `**Drift found:** ${summary.errors} error${summary.errors === 1 ? "" : "s"}, ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}.`
      : summary.warnings > 0
        ? `**In sync**, with ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}.`
        : "**In sync.**";
  lines.push(status, "");
  lines.push(
    `- Figma: ${code(inputs.figma)} (${inputs.figmaColorProfile})`,
    `- Code: ${code(inputs.code)}`,
    `- Lock: ${inputs.lock ? code(inputs.lock) : "none (no baseline; changed sides cannot be determined)"}`,
    `- Tokens compared: ${summary.tokensCompared}, in sync: ${summary.inSync}`,
    "",
  );

  const counts = Object.entries(summary.byKind).filter(([, n]) => n > 0);
  if (counts.length > 0) {
    lines.push("| Kind | Count |", "| --- | ---: |", ...counts.map(([k, n]) => `| ${k} | ${n} |`), "");
  }

  for (const [severity, title] of SECTIONS) {
    const findings = report.findings.filter((f) => f.severity === severity);
    if (findings.length === 0) continue;
    lines.push(`## ${title} (${findings.length})`, "");
    lines.push("| Token | Mode | Kind | Suggested | Details |", "| --- | --- | --- | --- | --- |");
    for (const f of findings) {
      lines.push(`| ${code(f.token)} | ${f.mode ?? "all"} | ${f.kind} | ${DIRECTION[f.suggestedDirection]} | ${cell(f.message)} |`);
    }
    lines.push("");
  }

  if (report.diagnostics.length > 0) {
    lines.push(`## Diagnostics (${report.diagnostics.length})`, "");
    for (const d of report.diagnostics) {
      lines.push(`- **${d.level}** (${d.origin}${d.token ? `, ${code(d.token)}` : ""}): ${d.message}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
