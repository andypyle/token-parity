# Phase 2: plan / apply / commit

Status: implemented. This document describes what was built; the types live in `packages/core/src/types.ts`.

`check` finds drift. This phase adds the commands that fix it. The engine still only reads and writes
files. Changes for Figma go into a change set that the skill pushes over MCP in Phase 3.

## Flow

```
check   ──► report (unchanged; CI only runs this)
plan    ──► plan.json            what would change, and what still needs a decision
apply   ──► edits theme.css      in place, formatting preserved
            figma-changes.json   for the skill to push
            pending lock         .token-parity/tokens.lock.pending.json
(skill pushes figma-changes.json, then re-exports Figma)
commit  ──► re-checks with the fresh export + pending lock; on success replaces tokens.lock.json
```

If a plan has no Figma operations, `apply` writes `tokens.lock.json` directly. Figma is unchanged in that
case (its hash is verified), so there is nothing to confirm.

## Decisions (agreed)

- **Two-step lock.** The lock never claims a Figma write that hasn't been confirmed. `commit` promotes
  the pending lock only when a fresh export shows every touched token in sync.
- **Deletions are opt-in.** `plan` lists `delete-*` actions, and `apply` skips them unless
  `--allow-deletes` is passed.
- **First sync uses `--prefer`.** `plan --prefer code|figma` settles differences that have no lock
  entry. Conflicts always need a per-token entry in a resolutions file, and `--prefer` never touches them.

## CLI

```sh
token-parity plan   --figma <f> --code <f> --lock <f> [--prefer code|figma] [--resolutions <f>]
                    [--figma-collection <name>] [--out plan.json]
token-parity apply  --plan plan.json [--allow-deletes] [--changes-out .token-parity/figma-changes.json]
token-parity commit --figma <fresh export> --plan plan.json
```

| Command | 0 | 1 | 2 |
| --- | --- | --- | --- |
| plan | every finding has an action | unresolved items remain (listed) | usage or input error |
| apply | applied | n/a | stale plan (an input's hash changed) or error |
| commit | lock written | something didn't land in Figma; pending lock kept | error |

## Resolutions file

```jsonc
{ "version": 1,
  "resolutions": {
    "color-brand-primary:default": "figma",   // token:mode -> "figma" | "code" | "skip"
    "color-legacy:*": "code"                   // "*" for whole-token findings
  },
  "names": {                                   // Figma names for new variables (code -> Figma)
    "color-brand-secondary": "Brand/Secondary"
  },
  "collections": {                             // target collection for new variables, by name
    "color-brand-secondary": "Primitives"
  } }
```

## Token matching (change to Phase 1)

Phase 1 matched tokens only by the default rule (Figma `a/b/c` ↔ CSS `--a-b-c`). That breaks for any
name that doesn't follow the rule, including names chosen through `names` above. Phase 2 changes this:

- The lock records each token's Figma identity: `LockToken` gains an optional `figma: { variableId, name }`
  (lock `version` stays 1; older locks without it still load).
- Matching tries the lock's `variableId` first, then the default rule. A variable renamed in Figma stays
  matched to its token. The rename is reported as info, and the new name is recorded at the next commit.
- New variables have no ID until the skill creates them. `commit` finds them in the fresh export by the
  planned name and writes their IDs into the lock.

## Plan schema (`plan.json`)

```ts
interface Plan {
  schemaVersion: 1;
  tool: { name: "token-parity"; version: string };
  inputs: {
    figma: { path: string; sha256: string };
    code:  { path: string; sha256: string };
    lock:  { path: string; sha256: string | null };   // null = no lock file yet
  };
  settings: CompareSettings;
  options: { prefer: "code" | "figma" | null; resolutions: string | null; figmaCollection: string | null };
  actions: Action[];
  unresolved: Unresolved[];
  skipped: string[];          // finding ids the resolutions file marked "skip"
  /** The lock after every action lands: existing entries, first-sync baselines for in-sync tokens,
   *  action results and Figma identities. Deleted tokens keep their entries here; apply removes them
   *  only when the delete actually runs. */
  lockAfter: LockFile;
}

interface ActionBase {
  id: string;                 // `${op}:${token}:${mode ?? "*"}`
  token: TokenKey;
  mode: ModeName | null;
  finding: string | null;     // report finding id this resolves
  via: "suggested" | "prefer" | "resolution" | "near-match";
                              // suggested = the direction check reported (lock-based, or a token new on one side)
  lock: LockModeEntry | null; // entry this per-mode action produces; null for adds and deletes (see lockAfter)
}

type Action = ActionBase & (
  // context: "theme" | "root" | "mode:<name>". from: null inserts a new declaration (e.g. a new .dark override).
  | { op: "update-code"; cssVar: string; context: string; from: string | null; to: string }
  | { op: "add-code"; cssVar: string; values: Record<string, string> }        // keyed by context
  | { op: "delete-code"; cssVar: string; destructive: true }
  | { op: "update-figma"; variableId: string; modeId: string; from: FigmaValue | null; to: FigmaValue }
  | { op: "add-figma"; name: string; collectionId: string; type: TokenType;
      values: Record<string, FigmaValue>;                                      // keyed by modeId
      naming: { source: "explicit" | "inferred"; sibling?: string } }
  | { op: "delete-figma"; variableId: string; destructive: true }
  | { op: "lock-only" }       // near-match: no value change, record both sides as they are
);

type FigmaValue =
  | { type: "COLOR"; r: number; g: number; b: number; a: number }
  | { type: "FLOAT"; value: number }
  | { type: "STRING"; value: string }
  | { type: "BOOLEAN"; value: boolean }
  | { type: "ALIAS"; variableId: string } | { type: "ALIAS"; name: string };   // name = created in this change set

interface Unresolved {
  finding: string;
  token: TokenKey;
  mode: ModeName | null;
  reason:
    | "conflict" | "no-lock-difference" | "broken-alias" | "type-mismatch"
    | "needs-figma-name" | "no-target-collection"
    | "figma-mode-missing"       // code has a mode the Figma collection lacks (modes belong to collections)
    | "no-code-mode-selector"    // Figma has a mode with no CSS selector in modeMap
    | "depends-on-unresolved"    // aliases a new token that can't be created yet
    | "unsupported";
  hint: string;               // e.g. add "color-x:default": "figma" | "code" to a resolutions file
}
```

## State files

`<lock dir>/.token-parity/` (already gitignored):

| File | Written by | Read by |
| --- | --- | --- |
| `plan.json` | plan (default `--out`) | apply, commit (`--lock` finds it) |
| `figma-changes.json` | apply, when Figma has changes | the skill |
| `pending.json` | apply, when Figma has changes: the pending lock, applied action ids, touched tokens | commit |

`commit` deletes `pending.json` and `figma-changes.json` once the lock is written.

## Figma change set (`figma-changes.json`): the contract with the skill

```jsonc
{ "version": 1,
  "colorProfile": "srgb",
  "basedOn": { "figmaSha256": "…" },
  "operations": [
    { "op": "create-variable", "name": "color/brand/secondary", "collectionId": "VC:1", "resolvedType": "COLOR" },
    { "op": "set-value", "variableName": "color/brand/secondary", "modeId": "1:0", "value": { "type": "COLOR", "r": 0.534875, "g": 0.2618, "b": 0.860658, "a": 1 } },
    { "op": "set-value", "variableId": "V:1", "modeId": "1:0", "value": { "type": "COLOR", "r": 0.223056, "g": 0.505183, "b": 0.964919, "a": 1 } },
    { "op": "set-value", "variableId": "V:4", "modeId": "2:0", "value": { "type": "ALIAS", "name": "color/brand/secondary" } },
    { "op": "delete-variable", "variableId": "V:9" }
  ] }
```
Run the operations in order: all `create-variable` ops, then all `set-value` ops (values for new
variables, which `set-value` names by `variableName`, come first), then deletes. An `ALIAS` value names its
target by `variableId`, or by `name` when the target is created in the same change set.

## Value rules

| Direction | Writes | Lock entry |
| --- | --- | --- |
| code → Figma, color | `toGamutRgb(code OKLCH, profile)`, 6 dp | `{ oklch: <code text>, figmaRgb: <that RGB> }` |
| Figma → code, color | `oklch(...)` from `rgbToOklch(rgb, precision)` | `{ oklch: <written text>, figmaRgb: <Figma's current RGB> }` |
| near-match (`lock-only`) | nothing | `{ oklch: <code text>, figmaRgb: <Figma's current RGB> }` |
| aliases | `var(--key)` / ALIAS to the target variable | `{ alias: key }` |
| numbers ↔ dimensions | Figma gets px; code keeps its existing unit (rem via `remBase`), px for new tokens | `{ value: <code text> }` |

All conversion goes through the existing `color.ts`. Nothing new touches culori directly.

## CSS editing

- Edits are made through postcss, which keeps formatting, comments and ordering. Only changed declaration values are rewritten.
- A per-mode value is written where it is currently declared: `@theme`, `.dark`, `@variant dark`, or the
  pass-through `:root` variable for shadcn-style tokens. The adapter will record a location per mode;
  today it records one per token.
- New tokens go at the end of the first `@theme` block. A new mode value goes into the first existing
  block for that mode in `modeMap`, or into a new `.dark {}` (first selector) appended to the file.

## New Figma variables

- **Name.** Figma lets each team name and group variables its own way, so the engine never assumes
  one convention. In order:
  1. **Explicit.** A name from the resolutions file (`names`), usually written by the skill after
     asking the user.
  2. **Inferred.** Use the existing variable whose key shares the longest prefix with the new key and
     is matched on both sides. Keep its group path, then build the last segment from the rest of the key,
     copying the sibling's casing (lower / Title / UPPER) and word separator (space, `-`, `_`, camelCase).
     Example: sibling `color-brand-primary` ↔ `Color/Brand/Primary` gives `Color/Brand/Secondary`.
     Each action records `via: "inferred"` and the sibling it used, so the plan shows its reasoning.
  3. **Otherwise** the token is `unresolved: needs-figma-name`, and the skill asks the user.
- **Collection:** a multi-mode token goes to the collection whose modes cover its modes. A single-mode
  token goes to `--figma-collection <name>`, or to the only single-mode collection if there is exactly one. Otherwise it is
  `unresolved: no-target-collection`.
- The Figma adapter will keep mode and collection IDs; today it keeps only names.

## Tests (test-first, as in Phase 1)

- Every check fixture in `test/fixtures/` also has an `expected-plan.json` (action ids, ops, `via`, and
  unresolved reasons). Plan-only cases live in `test/plan-fixtures/`: `prefer-code`, `prefer-figma`,
  `resolutions` (per-token choice, skip, explicit name and collection), `deletes`, `new-token-multi-mode`,
  `shadcn-passthrough` and `naming-inferred` (`Color/Brand Primary` style).
- Apply goldens in `expected-apply/`: `theme.css` (byte-exact, so formatting and comments must survive)
  and `figma-changes.json`.
- Naming: style unit tests (lower, Title, spaces, `_`, camelCase, UPPER, numbers), longest-prefix sibling
  choice, no sibling → `needs-figma-name` (the `radius-md` case in `missing-in-figma`).
- Matching by id: a variable renamed in Figma stays matched and is reported as info. The `resolutions`
  round trip covers a custom name (`Corner/Medium` ↔ `radius-md`) that only matches through the lock's
  `variableId`.
- Round trip, for every fixture: plan → apply → simulated push (`test/helpers.ts` applies the change set
  to the export and stores colors as float32, as Figma does) → commit → `check` reports nothing on
  touched tokens, and a second plan has zero actions.
- Commit refuses when the push hasn't happened (pending lock kept). Apply refuses a stale plan (exit 2).
