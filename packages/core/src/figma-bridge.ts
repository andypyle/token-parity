// Code that runs INSIDE Figma (via the Figma MCP's use_figma tool), plus the checksum shared with the engine.
//
// These functions are serialized with Function.prototype.toString by figma-script.ts, so each one must be
// self-contained: no imports, no module-level references except the other tp* functions listed in
// figma-script.ts, and only syntax the plugin sandbox supports. Names are prefixed to stay unique in bundles.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** cyrb53: a fast 53-bit string hash. Used to detect transcription errors, not for security. */
export function tpCyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Checksum of a JSON string, as 14 hex digits. */
export function tpChecksum(json: string): string {
  return tpCyrb53(json).toString(16).padStart(14, "0");
}

/** Local variables in the export format the engine reads. Deterministic: sorted by id. */
export async function tpBuildExport(figma: any): Promise<any> {
  const byId = (a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const collections = (await figma.variables.getLocalVariableCollectionsAsync()).filter((c: any) => !c.remote).sort(byId);
  const vars = (await figma.variables.getLocalVariablesAsync()).filter((v: any) => !v.remote).sort(byId);

  const variableCollections: any = {};
  for (const c of collections) {
    variableCollections[c.id] = {
      id: c.id,
      name: c.name,
      modes: c.modes.map((m: any) => ({ modeId: m.modeId, name: m.name })),
      defaultModeId: c.defaultModeId,
    };
  }

  const variables: any = {};
  for (const v of vars) {
    const valuesByMode: any = {};
    for (const modeId of Object.keys(v.valuesByMode).sort()) {
      const value = v.valuesByMode[modeId];
      if (value && typeof value === "object" && value.type === "VARIABLE_ALIAS") {
        valuesByMode[modeId] = { type: "VARIABLE_ALIAS", id: value.id };
      } else if (value && typeof value === "object" && "r" in value) {
        valuesByMode[modeId] = { r: value.r, g: value.g, b: value.b, a: "a" in value ? value.a : 1 };
      } else {
        valuesByMode[modeId] = value;
      }
    }
    variables[v.id] = {
      id: v.id,
      name: v.name,
      resolvedType: v.resolvedType,
      variableCollectionId: v.variableCollectionId,
      valuesByMode,
      scopes: (v.scopes || []).slice(),
    };
  }

  const profile = figma.root.documentColorProfile;
  return { colorProfile: profile === "DISPLAY_P3" ? "display-p3" : "srgb", variableCollections, variables };
}

/** Entry point for `figma-script export`. Returns the export as a JSON string plus its checksum. */
export async function tpExportVariables(figma: any): Promise<any> {
  const data = await tpBuildExport(figma);
  const json = JSON.stringify(data);
  const warnings: string[] = [];
  if (figma.root.documentColorProfile === "LEGACY") {
    warnings.push("This file uses Figma's legacy (unmanaged) color profile; colors are treated as sRGB.");
  }
  return {
    checksum: tpChecksum(json),
    collections: Object.keys(data.variableCollections).length,
    variables: Object.keys(data.variables).length,
    colorProfile: data.colorProfile,
    warnings,
    json,
  };
}

/**
 * Entry point for `figma-script push`. Verifies the change set arrived intact and that Figma has not changed
 * since the export the plan was built from, then validates every target before mutating anything.
 */
export async function tpPushChanges(figma: any, changes: any, changesChecksum: string): Promise<any> {
  if (tpChecksum(JSON.stringify(changes)) !== changesChecksum) {
    throw new Error("token-parity: the change set was altered in transit (checksum mismatch). Regenerate the code with `token-parity figma-script push` and pass it unchanged.");
  }
  const current = tpChecksum(JSON.stringify(await tpBuildExport(figma)));
  if (current !== changes.basedOn.exportChecksum) {
    throw new Error("token-parity: Figma variables changed since the export this plan is based on. Export again and re-run plan. Nothing was changed.");
  }

  const vars = await figma.variables.getLocalVariablesAsync();
  const varById = new Map<string, any>(vars.map((v: any) => [v.id, v]));
  const collections = new Map<string, any>();
  const creates = new Map<string, any>(); // name -> create op
  const problems: string[] = [];

  const collectionOf = async (id: string) => {
    if (!collections.has(id)) collections.set(id, await figma.variables.getVariableCollectionByIdAsync(id));
    return collections.get(id);
  };
  const modeIdsOf = (collection: any) => (collection ? collection.modes.map((m: any) => m.modeId) : []);

  // 1. Validate everything first. If anything is wrong, nothing is changed.
  for (const op of changes.operations) {
    if (op.op === "create-variable") {
      const collection = await collectionOf(op.collectionId);
      if (!collection) problems.push(`collection ${op.collectionId} not found for "${op.name}"`);
      else if (vars.some((v: any) => v.name === op.name && v.variableCollectionId === op.collectionId)) problems.push(`"${op.name}" already exists`);
      creates.set(op.name, op);
    } else if (op.op === "set-value") {
      let collectionId: string | null = null;
      if (op.variableId) {
        const v = varById.get(op.variableId);
        if (!v) problems.push(`variable ${op.variableId} not found`);
        else collectionId = v.variableCollectionId;
      } else {
        const c = creates.get(op.variableName);
        if (!c) problems.push(`"${op.variableName}" is neither existing nor created by this change set`);
        else collectionId = c.collectionId;
      }
      if (collectionId && modeIdsOf(await collectionOf(collectionId)).indexOf(op.modeId) === -1) {
        problems.push(`mode ${op.modeId} not in collection ${collectionId}`);
      }
      if (op.value.type === "ALIAS") {
        const ok = op.value.variableId ? varById.has(op.value.variableId) : creates.has(op.value.name);
        if (!ok) problems.push(`alias target ${op.value.variableId || op.value.name} not found`);
      }
    } else if (op.op === "delete-variable") {
      if (!varById.has(op.variableId)) problems.push(`variable ${op.variableId} not found for delete`);
    } else {
      problems.push(`unknown operation ${op.op}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`token-parity: change set does not match this file; nothing was changed.\n- ${problems.join("\n- ")}`);
  }

  // 2. Apply: creates, then values, then deletes (the order the engine wrote them in).
  const created = new Map<string, any>();
  const updatedIds: string[] = [];
  const deletedIds: string[] = [];
  const toValue = (value: any) => {
    if (value.type === "COLOR") return { r: value.r, g: value.g, b: value.b, a: value.a };
    if (value.type === "ALIAS") {
      const target = value.variableId ? varById.get(value.variableId) : created.get(value.name);
      return figma.variables.createVariableAlias(target);
    }
    return value.value;
  };

  for (const op of changes.operations) {
    if (op.op === "create-variable") {
      const v = figma.variables.createVariable(op.name, collections.get(op.collectionId), op.resolvedType);
      v.scopes = op.scopes || [];
      created.set(op.name, v);
    } else if (op.op === "set-value") {
      const v = op.variableId ? varById.get(op.variableId) : created.get(op.variableName);
      v.setValueForMode(op.modeId, toValue(op.value));
      if (op.variableId && updatedIds.indexOf(v.id) === -1) updatedIds.push(v.id);
    } else if (op.op === "delete-variable") {
      varById.get(op.variableId).remove();
      deletedIds.push(op.variableId);
    }
  }

  return {
    created: Array.from(created.values()).map((v: any) => ({ id: v.id, name: v.name })),
    updatedVariableIds: updatedIds,
    deletedVariableIds: deletedIds,
  };
}
