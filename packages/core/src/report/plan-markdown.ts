import type { Action, Plan } from "../types.js";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

function describeAction(a: Action): string {
  switch (a.op) {
    case "update-code":
      return a.from === null ? `add ${code(`${a.cssVar}: ${a.to}`)} (${a.context})` : `${code(a.cssVar)} (${a.context}): ${code(a.from)} → ${code(a.to)}`;
    case "add-code":
      return Object.entries(a.values).map(([ctx, v]) => `${code(`${a.cssVar}: ${v}`)} (${ctx})`).join(", ");
    case "delete-code":
      return `remove ${code(a.cssVar)}`;
    case "update-figma":
      return `set ${a.variableId} mode ${a.modeId} to ${code(JSON.stringify(a.to))}`;
    case "add-figma":
      return `create ${code(a.name)} in ${a.collectionName} (code: ${code(a.codeSyntax)}; scopes: ${a.scopes.length > 0 ? a.scopes.join(", ") : "none"}; ${a.naming.source === "explicit" ? "name from resolutions" : `named like ${code(a.naming.sibling ?? "")}`})`;
    case "delete-figma":
      return `delete variable ${a.variableId}`;
    case "lock-only":
      return "record both sides in the lock (rounding difference)";
  }
}

const SIDE: Record<Action["op"], string> = {
  "update-code": "code",
  "add-code": "code",
  "delete-code": "code",
  "update-figma": "Figma",
  "add-figma": "Figma",
  "delete-figma": "Figma",
  "lock-only": "lock",
};

export function renderPlanMarkdown(plan: Plan): string {
  const lines = ["# token-parity plan", ""];
  const deletes = plan.actions.filter((a) => a.op === "delete-code" || a.op === "delete-figma").length;
  lines.push(
    `${plan.actions.length} action${plan.actions.length === 1 ? "" : "s"}, ${plan.unresolved.length} unresolved, ${plan.skipped.length} skipped.` +
      (deletes > 0 ? ` ${deletes} delete${deletes === 1 ? "" : "s"} run only with \`apply --allow-deletes\`.` : ""),
    "",
  );
  if (plan.actions.length > 0) {
    lines.push("## Actions", "", "| Token | Mode | Changes | Why | What |", "| --- | --- | --- | --- | --- |");
    for (const a of plan.actions) {
      lines.push(`| ${code(a.token)} | ${a.mode ?? "all"} | ${SIDE[a.op]} | ${a.via} | ${cell(describeAction(a) + (a.note ? ` (note: ${a.note})` : ""))} |`);
    }
    lines.push("");
  }
  if (plan.unresolved.length > 0) {
    lines.push("## Needs a decision", "", "| Token | Mode | Reason | How to resolve |", "| --- | --- | --- | --- |");
    for (const u of plan.unresolved) lines.push(`| ${code(u.token)} | ${u.mode ?? "all"} | ${u.reason} | ${cell(u.hint)} |`);
    lines.push("");
  }
  if (plan.skipped.length > 0) lines.push("## Skipped", "", ...plan.skipped.map((s) => `- ${code(s)}`), "");
  return `${lines.join("\n").trimEnd()}\n`;
}
