# Resolutions file

The user's answers to the questions `plan` can't settle. Write only what the user decided. Every value in
it is a choice, a name or a collection; never a token value.

```json
{
  "version": 1,
  "resolutions": {
    "color-brand-primary:default": "figma",
    "color-success:default": "skip",
    "color-legacy:*": "code"
  },
  "names": { "radius-md": "Corner/Medium" },
  "collections": { "radius-md": "Primitives" }
}
```

- **`resolutions`**: keys are `token:mode`, exactly as shown in the plan's "Needs a decision" table.
  Whole-token items (mode "all") use `token:*`. The value is the side that wins, or `skip` to leave that
  item alone (it stops being reported as unresolved).
  - `"figma"`: Figma's value is copied to code.
  - `"code"`: code's value is copied to Figma.
  - For `missing-in-code` / `missing-in-figma`, the chosen side's *state* wins. If that side has the
    token, it's added to the other side. If it doesn't, the token is deleted from the other side, and
    that delete still needs `apply --allow-deletes`.
- **`names`**: the Figma variable name for a new token, using `/` for groups. It doesn't have to match the
  CSS name. The lock remembers the variable's id after commit, so the two stay matched.
- **`collections`**: the Figma collection name for a new token, when `plan` couldn't pick one.

Merge new answers into the existing file. Keep earlier answers unless the user changes them. Remove an
entry once its token is in sync and the user agrees; leftover entries are harmless.
