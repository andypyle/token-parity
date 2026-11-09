I'm building token-parity: a TypeScript tool that checks whether
design tokens in Figma match the tokens in code, and can fix drift
in either direction. Start with the core engine only. No Figma
access or agent skill yet.

Setup (already scaffolded, see CLAUDE.md):
- pnpm monorepo, packages/core, TypeScript strict, Vitest, tsdown
- ESM only
- Use culori for color conversion, OKLCH distance, and gamut mapping

Engine pipeline:
1. Adapters read inputs into one shared format (W3C DTCG-style):
   token path, type, per-mode values, alias references
   - figma adapter: reads a JSON export of Figma variables
     (collections, modes, aliases, RGB 0-1 float colors, and the
     file's color profile: sRGB or Display P3)
   - tailwind adapter: reads Tailwind v4 @theme CSS variables
     (colors in oklch())
2. Compare Figma, code, and a tokens.lock.json (last synced state)
   three ways. Compare colors in OKLCH, never as raw strings.
3. Classify each result: missing-in-code, missing-in-figma,
   value-mismatch, near-match (OKLCH distance under a configurable
   threshold), broken-alias, missing-mode, conflict (both sides
   changed), and out-of-gamut (a warning, not drift)
4. Output a report as JSON and markdown

Color rules:
- Code is the canonical color format (OKLCH). Figma stores RGB.
- The lock file stores, per color token and mode, both the original
  OKLCH value and the RGB value last written to Figma.
- If the Figma RGB still matches the locked RGB (within tolerance),
  treat it as unchanged and keep the locked OKLCH value. Never
  re-derive OKLCH from RGB for an unchanged color.
- Only convert RGB to OKLCH when Figma actually changed. Round to a
  configurable precision.

CLI: token-parity check --figma <file> --code <file> --lock <file>

Build test-first. Write fixtures before the logic: one per drift
type, plus:
- an unchanged color round-trips with zero diff
- an OKLCH/RGB rounding difference is a near-match, not drift
- an out-of-gamut P3 color produces a warning, not drift
- a color changed on both sides produces a conflict

Don't build plan/apply yet, but keep the report shape so a plan
can be generated from it later.

Before writing code, show me the normalized token type, the lock
file schema, and the report schema so I can review them.
