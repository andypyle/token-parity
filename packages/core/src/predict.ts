// Predict the Figma export after a push, so commit needs no second export. The prediction applies the change
// set to the pre-push export exactly as the plugin would export the result (float32 numbers, sorted ids and
// scopes). The push returns the checksum of Figma's real post-push export; the prediction is only used when
// the two checksums match, so a wrong prediction can never be committed.
import { COMPACT_FORMAT, fullId } from "./adapters/figma.js";
import { InputError } from "./errors.js";
import { tpF32 } from "./figma-bridge.js";
import type { FigmaChangeSet, FigmaValue } from "./types.js";

type CompactValue = number[] | { alias: string } | number | string | boolean | null;
interface CompactVariable {
  id: string;
  name: string;
  type: string;
  scopes: string[];
  code?: string;
  values: CompactValue[];
}
interface CompactCollection {
  id: string;
  name: string;
  modes: Array<[string, string]>;
  default: string;
  variables: CompactVariable[];
}
export interface CompactExport {
  format: typeof COMPACT_FORMAT;
  colorProfile: string;
  collections: CompactCollection[];
}

export interface PushResult {
  created: Array<{ id: string; name: string }>;
  exportChecksum: string;
}

const shortId = (prefix: string, id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : `!${id}`);
const V = "VariableID:";

export function isCompactExport(value: unknown): value is CompactExport {
  return typeof value === "object" && value !== null && (value as { format?: unknown }).format === COMPACT_FORMAT;
}

export function predictExport(before: CompactExport, changes: FigmaChangeSet, push: PushResult): CompactExport {
  const after: CompactExport = structuredClone(before);
  const byFullId = new Map<string, { variable: CompactVariable; collection: CompactCollection }>();
  for (const collection of after.collections) {
    for (const variable of collection.variables) byFullId.set(fullId(V, variable.id), { variable, collection });
  }
  const collectionById = new Map(after.collections.map((c) => [fullId("VariableCollectionId:", c.id), c]));

  const creates = changes.operations.filter((op) => op.op === "create-variable");
  if (creates.length !== push.created.length) throw new InputError(`push created ${push.created.length} variables, the change set has ${creates.length}`);
  const createdByName = new Map<string, string>();

  const toCompact = (value: FigmaValue): CompactValue => {
    switch (value.type) {
      case "COLOR": {
        const rgb = [tpF32(value.r), tpF32(value.g), tpF32(value.b)];
        const a = tpF32(value.a);
        return a === 1 ? rgb : [...rgb, a];
      }
      case "FLOAT":
        return tpF32(value.value);
      case "ALIAS": {
        const id = "variableId" in value ? value.variableId : createdByName.get(value.name);
        if (!id) throw new InputError(`alias target ${JSON.stringify(value)} unknown`);
        return { alias: shortId(V, id) };
      }
      default:
        return value.value;
    }
  };

  for (const op of changes.operations) {
    if (op.op === "create-variable") {
      const created = push.created[creates.indexOf(op)]!;
      if (created.name !== op.name) throw new InputError(`push created "${created.name}" where "${op.name}" was expected`);
      const collection = collectionById.get(op.collectionId);
      if (!collection) throw new InputError(`collection ${op.collectionId} is not in the export`);
      // Same key order as the plugin's export: code (codeSyntax.WEB) sits between scopes and values.
      const variable: CompactVariable = {
        id: shortId(V, created.id),
        name: op.name,
        type: op.resolvedType,
        scopes: [...op.scopes].sort(),
        ...(op.codeSyntax ? { code: op.codeSyntax } : {}),
        values: collection.modes.map(() => null),
      };
      collection.variables.push(variable);
      byFullId.set(created.id, { variable, collection });
      createdByName.set(op.name, created.id);
    } else if (op.op === "set-value") {
      const id = "variableId" in op ? op.variableId : createdByName.get(op.variableName);
      const target = id ? byFullId.get(id) : undefined;
      if (!target) throw new InputError(`set-value target ${JSON.stringify(op)} is not in the export`);
      const i = target.collection.modes.findIndex(([modeId]) => modeId === op.modeId);
      if (i < 0) throw new InputError(`mode ${op.modeId} is not in ${target.collection.name}`);
      target.variable.values[i] = toCompact(op.value);
    } else {
      const target = byFullId.get(op.variableId);
      if (!target) throw new InputError(`delete target ${op.variableId} is not in the export`);
      target.collection.variables.splice(target.collection.variables.indexOf(target.variable), 1);
      byFullId.delete(op.variableId);
    }
  }

  for (const collection of after.collections) {
    collection.variables.sort((a, b) => {
      const x = fullId(V, a.id);
      const y = fullId(V, b.id);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  return after;
}
