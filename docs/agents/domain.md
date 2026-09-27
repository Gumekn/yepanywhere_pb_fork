# Domain Docs

How engineering skills should consume this repository's domain documentation.

## Before exploring, read these

- `CONTEXT-MAP.md` at the repo root, if it exists.
- The relevant package's `CONTEXT.md`, such as `packages/server/CONTEXT.md`.
- `docs/adr/` for system-wide decisions, if it exists.
- `packages/<package>/docs/adr/` for package-specific decisions, if it exists.

If these files do not exist, proceed silently. Create them only when `/domain-modeling` establishes real terminology or decisions.

## File structure

/
├── CONTEXT-MAP.md
├── docs/adr/
└── packages/
    ├── client/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── server/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── shared/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── desktop/
        ├── CONTEXT.md
        └── docs/adr/

## Use the glossary's vocabulary

Use terms defined in the applicable `CONTEXT.md`; flag ADR conflicts rather than silently overriding them.
