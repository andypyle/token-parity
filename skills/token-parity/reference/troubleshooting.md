# Troubleshooting

| Symptom | Meaning | What to do |
| --- | --- | --- |
| `verify-export` prints MISMATCH | The saved file differs from what Figma returned | Write the `json` string again, exactly. If it fails twice, stop and tell the user; the export may be too large to transfer reliably. |
| Push error "altered in transit" | The code passed to `use_figma` differs from `figma-script push` output | Run `figma-script push` again and pass the stdout unchanged. Nothing was changed in Figma. |
| Push error "changed since the export" | Figma was edited after the plan's export | Nothing was changed. Export, `plan` and approve again. |
| Push error "change set does not match this file" | A collection, mode or variable in the change set is missing | Nothing was changed. Export and re-plan. If it repeats, report the listed problems to the user. |
| `figma-script push` exits 2, "over use_figma's 50000 limit" | Too many changes for one `use_figma` call (about 300 operations) | Sync in batches. Ask the user which changes go first, mark the rest `skip` in the resolutions file, then plan and apply. Remove those skips for the next batch. |
| `apply` exits 2, "re-run plan" | The CSS, export or lock changed after `plan` | Run `plan` again. Ask for approval again if the actions differ. |
| `commit --push-result` says the state "differs from the engine's prediction" | Figma stored something differently than predicted (or was edited during the push) | Not an error. Export, then run `commit` without `--push-result`. |
| `commit` exits 1 | Some changes aren't in the fresh export | Show the listed tokens. The pending lock is kept. Usually the push failed part-way or Figma was edited: export, then re-plan. |
| `commit`: "nothing pending" | `apply` wrote the lock directly (no Figma changes), or commit already ran | Nothing to do. Run `check`. |
| Exit 2 with "config" in the message | `token-parity.config.json` is malformed | Fix the field named in the message (see `config.md`). |
| Warning: codeSyntax.WEB "var(--…)" names a token "which isn't in code" | The variable's code syntax names a CSS variable your `@theme` doesn't have, so it was matched by name | Tell the user. Either the CSS lacks the token (a sync can add it) or the code syntax is stale and needs fixing in Figma. If every `--prefix-…` name fails, the Tailwind prefix wasn't found: set `prefix` in the config. |
| Info: "N variables' codeSyntax.WEB doesn't name a CSS token" | Their code syntax is an expression or literal (`calc(…)`, `2px`), or a class that matches nothing | Usually fine; they're matched by name. Mention it only if those tokens show up as missing. |
| Info: "now maps to --x through its codeSyntax (was --y)" | A designer changed the variable's code syntax since the last sync | Mention it. It's a deliberate remap, not drift. |
| `format-mismatch` "Same color as Figma, but code writes it as oklch(…)" | Exact matching (the default): the value is right but can't be found by searching for Figma's hex | A sync rewrites it as hex/rgb(). If the team wants OKLCH in code, set `colorMatch: "perceptual"` (ask first). |
| Unresolved `computed-in-code` | Figma's value should go to code, but code computes it (`calc(var(--spacing) * n)`) | Explain. The user changes `--spacing` (affects every step), changes the value in Figma, or resolves it to "code". |
| `alias-mismatch` "Same value, but Figma aliases {…} and code aliases var(…)" | Both sides alias different variables with the same value, often a half-done migration | Offer to re-alias the side that didn't move (the lock says which; otherwise ask, or `--prefer`). Plan creates missing targets first. |
| Plan action note "aliasing X would give … not code's value; wrote the value instead" | The alias target has no value for that mode in Figma (e.g. a single-mode primitive aliased from Dark) | Expected. Mention it; adding the step to Figma lets a later sync alias it. |
| Warning "Can't evaluate color-mix(…)" | An unsupported color-mix() form (e.g. `in hsl`) | That value isn't compared. Tell the user which token. |
| `missing-mode` "Code defines a dark value, but Figma collection … has no dark mode" | Code overrides a token in dark mode, but its Figma collection has a single mode | Not syncable as is. Offer: add the mode in Figma, remove the override in code by hand, or `skip` it to keep it code-only. |
| A Figma alias shows as `broken-alias` "Figma variable …" | It points at a library (remote) variable, which the export skips | Tell the user; library variables are outside this file's sync. |
