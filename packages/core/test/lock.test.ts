import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import { parseLock } from "../src/lock.js";

const valid = {
  version: 1,
  figmaColorProfile: "srgb",
  tokens: {
    "color-a": { type: "color", modes: { default: { oklch: "oklch(0.5 0.1 200)", figmaRgb: { r: 0.1, g: 0.2, b: 0.3, a: 1 } } } },
    "color-b": { type: "color", modes: { light: { alias: "color-a" } } },
    "spacing-4": { type: "dimension", modes: { default: { value: "1rem" } } },
  },
};

describe("parseLock", () => {
  it("accepts a valid lock", () => {
    expect(parseLock(valid, "tokens.lock.json")).toEqual(valid);
  });

  it.each([
    ["not an object", 42],
    ["wrong version", { ...valid, version: 2 }],
    ["bad profile", { ...valid, figmaColorProfile: "adobe-rgb" }],
    ["bad type", { ...valid, tokens: { x: { type: "shadow", modes: {} } } }],
    ["unparseable oklch", { ...valid, tokens: { x: { type: "color", modes: { default: { oklch: "#fff", figmaRgb: { r: 1, g: 1, b: 1, a: 1 } } } } } }],
    ["color without figmaRgb", { ...valid, tokens: { x: { type: "color", modes: { default: { oklch: "oklch(0.5 0.1 200)" } } } } }],
    ["unknown entry shape", { ...valid, tokens: { x: { type: "number", modes: { default: { foo: 1 } } } } }],
  ])("rejects %s", (_, input) => {
    expect(() => parseLock(input, "tokens.lock.json")).toThrow(InputError);
  });
});
