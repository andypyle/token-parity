// A minimal in-memory Figma Plugin API for the variables surface the bridge uses.
// Colors are stored as float32, as Figma does.

interface ExportJson {
  colorProfile?: string;
  variableCollections: Record<string, { id: string; name: string; modes: Array<{ modeId: string; name: string }>; defaultModeId: string }>;
  variables: Record<string, { id: string; name: string; resolvedType: string; variableCollectionId: string; valuesByMode: Record<string, unknown>; scopes?: string[]; codeSyntax?: Record<string, string> }>;
}

const f32 = (v: unknown) => {
  if (v && typeof v === "object" && "r" in v) {
    const c = v as { r: number; g: number; b: number; a?: number };
    return { r: Math.fround(c.r), g: Math.fround(c.g), b: Math.fround(c.b), a: Math.fround(c.a ?? 1) };
  }
  return v;
};

export function mockFigma(source: ExportJson, profile: "SRGB" | "DISPLAY_P3" | "LEGACY" = source.colorProfile === "display-p3" ? "DISPLAY_P3" : "SRGB") {
  let next = 1;
  const collections = new Map(Object.values(source.variableCollections).map((c) => [c.id, { ...structuredClone(c), remote: false }]));
  const variables = new Map<string, MockVariable>();

  class MockVariable {
    remote = false;
    scopes: string[];
    codeSyntax: Record<string, string> = {};
    valuesByMode: Record<string, unknown> = {};
    constructor(
      public id: string,
      public name: string,
      public resolvedType: string,
      public variableCollectionId: string,
      scopes: string[] = ["ALL_SCOPES"],
    ) {
      this.scopes = scopes;
    }
    setValueForMode(modeId: string, value: unknown) {
      if (!collections.get(this.variableCollectionId)!.modes.some((m) => m.modeId === modeId)) throw new Error(`bad mode ${modeId}`);
      this.valuesByMode[modeId] = f32(value);
    }
    remove() {
      variables.delete(this.id);
    }
    setVariableCodeSyntax(platform: string, value: string) {
      this.codeSyntax = { ...this.codeSyntax, [platform]: value };
    }
  }

  for (const v of Object.values(source.variables)) {
    const mv = new MockVariable(v.id, v.name, v.resolvedType, v.variableCollectionId, v.scopes ?? ["ALL_SCOPES"]);
    if (v.codeSyntax) mv.codeSyntax = { ...v.codeSyntax };
    for (const [m, value] of Object.entries(v.valuesByMode)) mv.valuesByMode[m] = f32(value);
    variables.set(v.id, mv);
  }

  const figma = {
    root: { documentColorProfile: profile },
    variables: {
      getLocalVariableCollectionsAsync: async () => [...collections.values()],
      getLocalVariablesAsync: async () => [...variables.values()],
      getVariableByIdAsync: async (id: string) => variables.get(id) ?? null,
      getVariableCollectionByIdAsync: async (id: string) => collections.get(id) ?? null,
      createVariable: (name: string, collection: { id: string }, type: string) => {
        if (!collection || typeof collection !== "object") throw new Error("pass a collection object");
        const v = new MockVariable(`V:created:${next++}`, name, type, collection.id);
        variables.set(v.id, v);
        return v;
      },
      createVariableAlias: (v: { id: string }) => ({ type: "VARIABLE_ALIAS", id: v.id }),
    },
  };
  return { figma, variables, collections };
}

/** Run generated use_figma code the way the tool does: top-level await and return, `figma` in scope. */
export async function runInFigma(code: string, figma: unknown): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (f: unknown) => Promise<unknown>;
  return new AsyncFunction("figma", code)(figma);
}
