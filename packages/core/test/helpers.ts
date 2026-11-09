// Test helpers: isolated fixture copies, and a stand-in for the skill's Figma push.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FigmaChangeSet, FigmaValue } from "../src/types.js";

export function copyFixture(dir: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "tp-fixture-"));
  cpSync(dir, tmp, { recursive: true });
  return tmp;
}

export const readJsonFile = <T = unknown>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

interface ExportJson {
  colorProfile?: string;
  variableCollections: Record<string, unknown>;
  variables: Record<string, { id: string; name: string; resolvedType: string; variableCollectionId: string; valuesByMode: Record<string, unknown> }>;
}

/**
 * Apply a change set to a Figma export the way the skill + Figma would. Colors are stored as float32,
 * as Figma does, so tests also prove the lock tolerance absorbs that.
 */
export function simulatePush(exportJson: ExportJson, changes: FigmaChangeSet): ExportJson {
  const out = structuredClone(exportJson);
  const idByName = new Map(Object.values(out.variables).map((v) => [v.name, v.id]));
  let n = 0;

  const toFigma = (value: FigmaValue): unknown => {
    switch (value.type) {
      case "COLOR":
        return { r: Math.fround(value.r), g: Math.fround(value.g), b: Math.fround(value.b), a: Math.fround(value.a) };
      case "ALIAS": {
        const id = "variableId" in value ? value.variableId : idByName.get(value.name);
        if (!id) throw new Error(`alias target ${JSON.stringify(value)} does not exist`);
        return { type: "VARIABLE_ALIAS", id };
      }
      default:
        return value.value;
    }
  };

  for (const op of changes.operations) {
    if (op.op === "create-variable") {
      const id = `V:new:${++n}`;
      out.variables[id] = { id, name: op.name, resolvedType: op.resolvedType, variableCollectionId: op.collectionId, valuesByMode: {} };
      idByName.set(op.name, id);
    } else if (op.op === "set-value") {
      const id = "variableId" in op ? op.variableId : idByName.get(op.variableName);
      if (!id || !out.variables[id]) throw new Error(`set-value target missing: ${JSON.stringify(op)}`);
      out.variables[id]!.valuesByMode[op.modeId] = toFigma(op.value);
    } else {
      delete out.variables[op.variableId];
    }
  }
  return out;
}

export function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
