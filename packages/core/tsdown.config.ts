import { defineConfig } from "tsdown";

export default defineConfig([
  // The npm package: library + CLI, dependencies installed normally.
  {
    entry: ["src/index.ts", "src/cli.ts"],
    format: "esm",
    platform: "node",
    dts: true,
    clean: true,
    fixedExtension: false,
  },
  // The Claude Code plugin: the CLI as one self-contained file inside the skill, dependencies inlined,
  // so the skill can run it with plain `node` and nothing to install.
  {
    entry: { "token-parity": "src/cli.ts" },
    format: "esm",
    platform: "node",
    outDir: "../../skills/token-parity/bin",
    fixedExtension: true,
    dts: false,
    clean: false,
    minify: true,
    deps: { alwaysBundle: [/.*/] },
  },
]);
