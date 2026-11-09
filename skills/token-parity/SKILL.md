---
name: token-parity
description: Check and sync design tokens between Figma variables and code. Use when the user asks to sync tokens, check token drift, or after editing token files or Figma variables.
---

# token-parity

Draft. Fill in once the engine's check, plan, and apply commands work.

## Rules
- Never edit token values by hand, in code or in Figma. All changes come from the engine.
- Never apply changes without explicit user approval.
- Conflicts are never auto-resolved. Ask the user.
