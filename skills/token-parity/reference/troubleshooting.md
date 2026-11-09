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
| Warning: codeSyntax.WEB "…" matches no token / several tokens | The variable's code syntax doesn't point at exactly one CSS token, so it was matched by name instead | Tell the user which variable and what was tried. The fix is in Figma: set its code syntax to `var(--the-css-name)`. |
| Info: "now maps to --x through its codeSyntax (was --y)" | A designer changed the variable's code syntax since the last sync | Mention it. It's a deliberate remap, not drift. |
| A Figma alias shows as `broken-alias` "Figma variable …" | It points at a library (remote) variable, which the export skips | Tell the user; library variables are outside this file's sync. |
