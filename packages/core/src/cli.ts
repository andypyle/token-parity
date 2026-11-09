#!/usr/bin/env node
import { VERSION } from "./index.js";

const [command] = process.argv.slice(2);

if (!command || command === "--version") {
  console.log(`token-parity ${VERSION}`);
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
