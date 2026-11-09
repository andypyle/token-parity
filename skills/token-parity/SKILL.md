---
name: token-parity
description: Check and sync design tokens between Figma variables and Tailwind v4 CSS (@theme). Use when the user asks to check token drift, compare Figma and code tokens, sync or push tokens to or from Figma, or after editing token CSS or Figma variables. Requires the Figma MCP.
---

# token-parity

The `token-parity` engine compares Figma variables, CSS tokens and a lock file, and computes every change.
This skill moves data between the engine and Figma with the Figma MCP, and asks the user every question
the engine can't answer.

## Rules

- **Never edit token values by hand**, in CSS or in Figma, and never write Plugin API code for token data.
  All values come from the engine. All Figma code comes from `token-parity figma-script` and is passed to
  `use_figma` unchanged.
- **Never apply without explicit approval** of the plan. Deletes need their own explicit yes.
- **Never resolve a conflict yourself.** Ask the user. The same goes for first-sync differences, names and
  collections for new Figma variables.
- **Every transfer is verified.** Run `verify-export` after saving an export. If a push or verification
  fails, stop and follow Troubleshooting; don't work around it.
- The only files you write are the config, the resolutions file (the user's answers) and the Figma export
  (checksum-verified).

## Running the engine

Run `npx token-parity <command>` from the directory that holds `token-parity.config.json`. The config
supplies the file paths, so most commands need no flags. If `npx` can't find the package, tell the user
and ask before installing anything (`npm i -D token-parity`).

## Figma MCP setup (every session)

1. Load the `figma:figma-use` skill. It's required before any `use_figma` call. Include `figma-use` in
   `skillNames` on every `use_figma` call. `figma-generate-library` isn't needed: token-parity doesn't
   design collections, it writes values the engine computed.
2. Load the Figma MCP's `create_session` and `use_figma` tools in one `ToolSearch` call. The name prefix
   depends on how Figma is connected; for example,
   `select:mcp__claude_ai_Figma__create_session,mcp__claude_ai_Figma__use_figma`.
3. Get the file key from the config's `figmaFile` URL (`figma.com/design/<fileKey>/…`; on a branch URL,
   use the branch key). Call `create_session` with it, and reuse the session id on every call.

## Setup (no `token-parity.config.json` yet)

Ask the user for:
- the Figma file URL;
- the CSS file with their `@theme` tokens;
- where the token files should live (suggest `tokens/`).

Then write the config, following `reference/config.md`. The export goes in a committed path, so CI can run
`npx token-parity check` without Figma access. If their dark mode isn't `.dark`,
`[data-theme="dark"]` or `@variant dark`, add `modes`.

## Export (both workflows start here)

1. Run `npx token-parity figma-script export`. Pass its entire stdout as the `code` of a `use_figma`
   call. It's read-only.
2. The result is `{ checksum, json, variables, collections, colorProfile, warnings }`. Write the `json`
   string to the config's `figma` path, exactly as returned.
3. Run `npx token-parity verify-export --checksum <checksum>`. On `MISMATCH`, write the file once more
   from the same result and verify again. If it still fails, stop and tell the user.
4. Mention any `warnings` (for example, a legacy color profile).

## Check (read-only)

Export, then run `npx token-parity check`. Summarize for the user:
- whether there's drift, and how much;
- each error, with its suggested direction;
- warnings (out-of-gamut colors are warnings, not drift).

Offer to sync if there is drift.

## Sync

1. **Export**, then run `npx token-parity plan`. It prints a summary and exits 1 if decisions remain.
2. **Resolve with the user.** For each row under "Needs a decision", ask with `AskUserQuestion`. Group up
   to 4 questions per call. Record the answers in the resolutions file (`reference/resolutions.md`), then
   run `plan` again. Repeat until nothing is unresolved, or the user chooses to leave the rest.
   - `conflict`: show both values. Options: keep Figma, keep code, skip.
   - `no-lock-difference`: options are Figma, code, or skip. If there are many, offer `--prefer code` or
     `--prefer figma` for all of them.
   - `needs-figma-name`: ask for the Figma name (`Group/Name`). Suggest one in the style of nearby
     variables.
   - `no-target-collection`: offer the Figma collections that fit the token's modes.
   - `type-mismatch`, `figma-mode-missing`, `broken-alias`, `unsupported`: explain the hint. These need a
     fix by hand in Figma or in code, or a skip.
3. **Approve.** Show the plan's action table and ask before applying. If there are delete actions, list
   them and ask about them separately.
4. **Apply** with `npx token-parity apply`, adding `--allow-deletes` only if the user approved the deletes.
   - If it prints "Nothing to push to Figma", the lock is already written. Go to step 6.
   - Otherwise, continue with step 5.
5. **Push and commit.**
   1. Run `npx token-parity figma-script push`. Pass its entire stdout to `use_figma` unchanged.
   2. The push verifies itself, changes nothing if anything is off, and returns the ids it created,
      updated and deleted.
   3. Export again (the full Export steps).
   4. Run `npx token-parity commit`. If it reports changes that aren't in sync, show them and stop. The
      pending lock is kept, so nothing is lost.
6. **Confirm** with `npx token-parity check`. Tell the user what changed on each side, and that the CSS,
   lock and export files are ready to commit.

## Troubleshooting

See `reference/troubleshooting.md`. Briefly:
- **"altered in transit":** the code given to `use_figma` didn't match what the engine printed. Run
  `figma-script push` again and pass the output exactly.
- **"changed since the export":** someone edited Figma after planning. Nothing was changed. Start the
  sync over from the export.
- **apply exits 2 ("re-run plan"):** an input changed after `plan`. Run `plan` again and get approval
  again if the plan changed.
