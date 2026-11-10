# token-parity.config.json

Lives at the project root. The CLI reads it from the current directory (or `--config <file>`). Paths
are relative to the config file, and command-line flags override it.

```jsonc
{
  "figmaFile": "https://www.figma.com/design/AbC123/Design-System", // used by the skill only
  "figma": "tokens/figma-variables.json",        // the Figma export; commit it so CI can run check
  "code": "src/app.css",                          // CSS with the @theme block
  "lock": "tokens/tokens.lock.json",              // last synced state; commit it
  "resolutions": "tokens/token-parity.resolutions.json", // the user's decisions; optional until needed

  // Optional:
  "modes": { "dark": [".dark", "@variant dark"] },  // CSS selectors per mode; replaces the default
  "figmaCollection": "Primitives",                  // default collection for new single-mode variables
  "prefix": "ds",                                   // Tailwind prefix, if prefix(…) isn't in the code file
  "ignore": ["animate-*", "dark/*", "color-amber-*:dark"], // left alone: CSS or Figma names, glob, optional :mode
  "colorMatch": "exact",                            // or "perceptual" (OKLCH distance, near-matches for rounding)
  "colorFormat": "preserve",                        // or "hex" | "rgb" | "oklch" (oklch needs perceptual)
  "nearThreshold": 0.005,                           // ΔE_OK below which colors count as rounding
  "rgbTolerance": 0.00196,
  "precision": { "l": 4, "c": 4, "h": 2 },
  "remBase": 16
}
```

- The default `modes` is `dark` ← `.dark`, `[data-theme="dark"]`, `@variant dark`. Code's `@theme`
  values are the first mode of each Figma collection (for example "Light").
- Figma mode names are matched in lowercase kebab form: "Dark Mode" becomes `dark-mode`. The base mode
  (Figma's first mode, code's `@theme`) is always called `default`, in reports, the lock and `:mode`
  ignore patterns.
- `ignore` patterns match a token's CSS name (no `--`) or its Figma name (`dark/fg-1`); `*` is any run of
  characters. `name:mode` ignores only that mode. Ignored tokens are never reported, planned or written to
  the lock, but aliases to them still resolve.
- `.token-parity/` next to the lock holds the plan, change set and pending lock. It's temporary and
  should be gitignored.

## What to commit

The CSS, `tokens.lock.json`, the Figma export and the resolutions file. CI only needs `token-parity
check` (exit 1 on drift).
