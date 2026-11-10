# token-parity

Check that the design tokens in Figma and in your code are identical, and sync drift in either direction.

token-parity compares three things: a Figma variables export, your Tailwind v4 `@theme` CSS, and a lock file
recording the last sync. From those it reports every difference and which side changed. When both sides
changed, it asks you rather than guessing.

This package is the engine and CLI. Most people use it through the
[Claude Code plugin](https://github.com/andypyle/token-parity#quick-start), which also reads and writes
Figma for you. The CLI on its own is useful in CI, and for checking against an export you already have.

## Install

```sh
npm install -D token-parity
```

Requires Node 20 or later.

## Use

Put a `token-parity.config.json` at your project root:

```json
{
  "figma": "tokens/figma-variables.json",
  "code": "src/app.css",
  "lock": "tokens/tokens.lock.json"
}
```

```sh
npx token-parity check                          # report drift; exits 1 if there is any
npx token-parity plan [--prefer code|figma]     # show what a sync would change
npx token-parity apply [--allow-deletes]        # edit your CSS, prepare Figma's changes
npx token-parity commit --figma <fresh export>  # after Figma is updated: write the lock
```

Run `npx token-parity --help` for every command and flag.

## In CI

CI can't reach Figma, so it checks your code against the last committed Figma export:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx token-parity@0.1.0 check
```

## What it checks

- Tokens missing on either side, values that differ, missing modes (such as dark), broken aliases, and
  conflicts where both sides changed.
- Colors match exactly by default: code must have the same 8-bit sRGB value Figma shows, as hex or `rgb()`.
  Set `colorMatch: "perceptual"` to compare in OKLCH instead.
- Figma variables are matched to CSS variables by their code syntax, then by the lock, then by name.
  Tailwind's `prefix()`, `color-mix()` and `calc(var(--spacing) * n)` are handled.

The [full documentation](https://github.com/andypyle/token-parity#readme) covers configuration, matching
rules, and how syncing works.

## License

MIT
