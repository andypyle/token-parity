---
name: token-parity
description: Check and sync design tokens between Figma variables and Tailwind v4 CSS (@theme). Use when the user asks to check token drift, compare or sync Figma and code tokens, or after editing token CSS or Figma variables. Requires the Figma MCP.
---

# token-parity

## Rules

- Never edit token values or write Plugin API code for token data. Values come from the engine. Figma code
  comes from `token-parity figma-script`, passed to `use_figma` unchanged.
- Never apply without explicit approval of the plan. Deletes need a separate yes. If a re-plan changes the
  actions, ask again.
- Never decide conflicts, first-sync differences, or names and collections for new Figma variables. Ask.
- On any engine or push error, follow `reference/troubleshooting.md`. Never work around it.
- Write only the config, the resolutions file and the Figma export.

## Engine

Run `npx token-parity <command>` where `token-parity.config.json` lives. The config supplies the paths. If
the package is missing, ask before installing it (`npm i -D token-parity`).

## Figma MCP (each session)

1. Load the `figma:figma-use` skill (not `figma-generate-library`; the engine computes all values). Pass
   `skillNames: "figma-use"` on every `use_figma` call.
2. Load `create_session` and `use_figma` in one `ToolSearch`. The prefix varies, for example
   `select:mcp__claude_ai_Figma__create_session,mcp__claude_ai_Figma__use_figma`.
3. Take the file key from the config's `figmaFile` (`figma.com/design/<key>/…`; use the branch key for
   branch URLs). Call `create_session` once, and reuse its id.

## Setup (no config yet)

Ask for the Figma file URL, the CSS file with `@theme`, and a folder for token files (suggest `tokens/`).
Write the config per `reference/config.md`; the export path must be committed. Add `.token-parity/` to
`.gitignore`. Add `modes` if dark mode isn't `.dark`, `[data-theme="dark"]` or `@variant dark`.

## Export

1. Pass the stdout of `npx token-parity figma-script export` to `use_figma` as `code`.
2. `{ unchanged: true }`: the saved export is current. Skip steps 3–4 and continue the workflow.
3. Otherwise write the `export` object as one-line JSON to the config's `figma` path, then run
   `npx token-parity verify-export --checksum <checksum>`. On MISMATCH, rewrite and verify once more,
   then stop and tell the user.
4. Relay `warnings`. "Legacy color profile" is normal (treated as sRGB).

## Check

Export, then `npx token-parity check`. Report drift by token with its suggested direction, and warnings
(out-of-gamut is a warning, not drift). Offer to sync if there is drift. If the user says some differences
are intentional (code-only namespaces, Figma-only groups), offer `ignore` patterns (`reference/config.md`)
and add them only with their yes.

## Sync

1. Export, then `npx token-parity plan`.
2. Ask about each "Needs a decision" row with `AskUserQuestion`, up to 4 per call. Record the answers in
   the resolutions file (`reference/resolutions.md`) and re-plan. Repeat until none are left, or the user
   leaves the rest.
   - `conflict`, `no-lock-difference`: show both values. Options: Figma, code, skip. For many
     `no-lock-difference` items, offer `--prefer code|figma`.
   - `needs-figma-name`: ask for a `Group/Name`, and suggest one styled like nearby variables.
   - `no-target-collection`: offer the collections that fit the token's modes.
   - Other reasons: explain the hint. These need a manual fix or a skip.
3. Show the action table and get approval (deletes separately).
4. `npx token-parity apply`, with `--allow-deletes` only if the deletes were approved. "Nothing to push to
   Figma" means go to step 6.
5. Pass the stdout of `npx token-parity figma-script push` to `use_figma`. Then pass the result JSON to
   `npx token-parity commit --push-result - <<'EOF'` … `EOF`. If commit says the state "differs from the
   engine's prediction", Export, then `npx token-parity commit`. If commit lists tokens that aren't in
   sync, show them and stop (the pending lock is kept).
6. `npx token-parity check`. Tell the user what changed on each side, and that the CSS, lock and export
   are ready to commit.
