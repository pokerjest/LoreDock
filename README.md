# LoreDock

LoreDock is a local-first story project system for VS Code.

This repository currently implements the v0.0 Project Kernel: a clean extension foundation for future writing, story bible, timeline, assistant, and export capabilities.

## v0.0 Scope

- VS Code Extension + TypeScript scaffold.
- Fixed workspace-folder project root.
- `.loredock/project.json` manifest lifecycle.
- In-memory diagnostics printed through a LoreDock OutputChannel.
- Safe workspace-relative file writes.
- Preview/apply operation model.
- Capability API with an example empty capability.

v0.0 intentionally does not include manuscript editing, story bible modules, AI, boards, timelines, or export features.

## Commands

- `LoreDock: Initialize Project`
- `LoreDock: Open Project Manifest`
- `LoreDock: Show Diagnostics`
- `LoreDock: Repair Project Manifest`

## Development

```sh
npm install
npm run compile
npm test
```

Diagnostics are not written to disk in v0.0. The only project files created by initialization are `.loredock/` and `.loredock/project.json`.
