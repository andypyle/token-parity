# token-parity

Check and sync design tokens between Figma variables and code. Work in progress: Phase 1 ships the
core engine and `check`. `plan` and `apply` come next.

## check

```sh
token-parity check --figma figma-variables.json --code src/theme.css --lock tokens.lock.json
```

- `--figma`: a JSON export of Figma variables (`variableCollections`, `variables`, plus `colorProfile`:
  `"srgb"` or `"display-p3"`), in the same shape as Figma's `variables/local` REST response.
- `--code`: Tailwind v4 CSS. Variables in `@theme` are tokens. Dark values come from `.dark`,
  `[data-theme="dark"]` or `@variant dark` (change this with `--mode name=selector`).
- `--lock`: the last synced state. It may not exist yet; without it, `check` can say *that* two sides differ
  but not *which* side changed.

It prints a markdown report (`--format json` for JSON, `--out <file>` to write a file). Exit codes:
`0` in sync (warnings allowed), `1` drift found, `2` usage or input error.

### What it reports

| Kind | Severity | Meaning |
| --- | --- | --- |
| `missing-in-code` / `missing-in-figma` | error | Token exists on one side only |
| `value-mismatch` | error | One side changed since the last sync (or there is no lock entry) |
| `conflict` | error | Both sides changed since the last sync, differently. Never auto-resolved |
| `broken-alias` | error | Alias target missing, cyclic or of the wrong type |
| `missing-mode` | error | A mode exists on one side only |
| `near-match` | info | Colors differ by less than `--near-threshold` ΔE_OK (rounding) |
| `out-of-gamut` | warning | Code color can't be shown in Figma's color profile; the report includes the mapped RGB |

Every finding has a `suggestedDirection` (`figma-to-code`, `code-to-figma`, `none`, `needs-decision`)
for the upcoming `plan` command.

### Color rules

OKLCH in code is canonical and Figma stores RGB. Colors are compared in OKLCH (ΔE_OK), never as strings.
The lock stores each color's OKLCH and the RGB last written to Figma. When Figma's RGB still matches the
locked RGB, the locked OKLCH is used as-is and nothing is converted from RGB.

## Development

```sh
pnpm install
pnpm test        # fixtures live in packages/core/test/fixtures
pnpm typecheck
pnpm build
```
