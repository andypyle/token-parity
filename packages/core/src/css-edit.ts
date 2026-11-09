// In-place CSS edits for apply. postcss keeps every untouched byte (comments, spacing, ordering);
// only the declarations named by the plan change.
import postcss, { type AtRule, type Container, type Declaration, type Root, type Rule } from "postcss";
import { buildSelectorToMode, contextKey, contextOf, normalizeSelector } from "./adapters/tailwind.js";
import { InputError } from "./errors.js";
import type { Action, ModeName } from "./types.js";

type CodeAction = Extract<Action, { op: "update-code" | "add-code" | "delete-code" }>;

const ROOT_SELECTORS = [":root", ":host", "html"];

export function editCss(css: string, file: string, actions: CodeAction[], modeMap: Record<ModeName, string[]>): string {
  const root = postcss.parse(css, { from: file });
  const selectorToMode = buildSelectorToMode(modeMap);

  const index = new Map<string, Declaration>(); // `${prop}|${context}` -> last declaration (the one that wins)
  root.walkDecls(/^--/, (decl) => {
    index.set(`${decl.prop}|${contextKey(contextOf(decl, selectorToMode))}`, decl);
  });

  for (const action of actions) {
    if (action.op === "update-code") {
      const existing = index.get(`${action.cssVar}|${action.context}`);
      if (action.from === null) {
        if (existing) existing.value = action.to;
        else insert(root, action.cssVar, action.context, action.to, modeMap, index);
      } else {
        if (!existing) throw new InputError(`${action.cssVar} (${action.context}) is no longer declared; re-run plan`, file);
        existing.value = action.to;
      }
    } else if (action.op === "add-code") {
      for (const [context, value] of Object.entries(action.values)) insert(root, action.cssVar, context, value, modeMap, index);
    } else {
      for (const [key, decl] of index) {
        const [prop, context] = key.split("|") as [string, string];
        if (prop === action.cssVar && (context === "theme" || context.startsWith("mode:"))) {
          decl.remove();
          index.delete(key);
        }
      }
    }
  }
  return root.toString();
}

function insert(root: Root, prop: string, context: string, value: string, modeMap: Record<ModeName, string[]>, index: Map<string, Declaration>) {
  const container = findContainer(root, context, modeMap) ?? createContainer(root, context, modeMap);
  const decl = postcss.decl({ prop, value });
  container.append(decl);
  index.set(`${prop}|${context}`, decl);
}

function findContainer(root: Root, context: string, modeMap: Record<ModeName, string[]>): Container | undefined {
  if (context === "theme") return first<AtRule>(root, (n) => n.type === "atrule" && (n as AtRule).name === "theme");
  if (context === "root") {
    return first<Rule>(root, (n) => n.type === "rule" && n.parent?.type === "root" && (n as Rule).selectors.some((s) => ROOT_SELECTORS.includes(normalizeSelector(s))));
  }
  const mode = context.slice("mode:".length);
  for (const entry of modeMap[mode] ?? []) {
    const target = normalizeSelector(entry);
    if (target.startsWith("@")) {
      const at = first<AtRule>(root, (n) => n.type === "atrule" && normalizeSelector(`@${(n as AtRule).name} ${(n as AtRule).params}`) === target);
      if (at) return (at.nodes?.find((n) => n.type === "rule") as Rule | undefined) ?? at;
    } else {
      const rule = first<Rule>(root, (n) => n.type === "rule" && (n as Rule).selectors.some((s) => normalizeSelector(s) === target));
      if (rule) return rule;
    }
  }
  return undefined;
}

function createContainer(root: Root, context: string, modeMap: Record<ModeName, string[]>): Container {
  if (context === "theme") {
    const theme = postcss.atRule({ name: "theme", params: "" });
    const lastImport = first<AtRule>(root, (n) => n.type === "atrule" && (n as AtRule).name === "import", true);
    if (lastImport) lastImport.after(theme);
    else root.prepend(theme);
    return theme;
  }
  if (context === "root") {
    const rule = postcss.rule({ selector: ":root" });
    root.append(rule);
    return rule;
  }
  const mode = context.slice("mode:".length);
  const entries = modeMap[mode] ?? [];
  const selector = entries.find((e) => !e.trim().startsWith("@"));
  if (selector) {
    const rule = postcss.rule({ selector });
    root.append(rule);
    return rule;
  }
  const at = entries[0];
  if (!at) throw new InputError(`no selector configured for mode "${mode}"`);
  const [, name = "", params = ""] = /^@(\S+)\s*(.*)$/.exec(at.trim()) ?? [];
  const atRule = postcss.atRule({ name, params });
  const rule = postcss.rule({ selector: ":root" });
  atRule.append(rule);
  root.append(atRule);
  return rule;
}

function first<T>(root: Root, match: (n: { type: string; parent?: { type: string } | undefined }) => boolean, last = false): T | undefined {
  let found: T | undefined;
  root.walk((node) => {
    if (match(node as never)) {
      found = node as T;
      if (!last) return false;
    }
    return undefined;
  });
  return found;
}
