# LoreDock

LoreDock is a local-first story project system for VS Code.

Current package version: **0.0.0**.

Current milestone: **v0.0 Project Kernel**.

LoreDock is being rebuilt as a transparent, local-first writing system for long-form fiction. The current implementation is intentionally focused on the kernel: project discovery, manifest lifecycle, safe writes, diagnostics, schema registration, migration boundaries, and the extension points that future writing, story bible, outline, timeline, assistant, and export modules will use.

## Current Status

`0.0.0` implements the foundation for a LoreDock project inside a VS Code workspace.

- VS Code extension and TypeScript project scaffold.
- Fixed workspace-folder project root for v0.0.
- `.loredock/project.json` manifest lifecycle with `schemaVersion: "0.0.0"`.
- Project initialization through a preview/apply operation plan.
- Manifest validation with degraded mode for invalid JSON, bad fields, unsupported versions, and invalid capabilities.
- Explicit manifest repair command that backs up the current manifest before writing a rebuilt v0.0 manifest.
- In-memory diagnostics printed through the LoreDock OutputChannel.
- Workspace-relative safe file writes through `SafeFileWriter`.
- Path checks for absolute paths, `..` traversal, undeclared files/directories, and symlink escapes.
- Schema registry and no-op migration runner foundations.
- Capability API for commands, tree views, file watchers, schemas, diagnostics, and disposable lifecycle.
- Multi-root workspace routing through explicit folder selection.
- Example empty capability used to prove capability activation and command routing.

The kernel does not understand manuscript, story bible, timeline, assistant, compile, or export concepts yet. Those are later capabilities, not v0.0 concerns.

## Project Files

Initialization creates only:

```text
.loredock/
  project.json
```

No manuscript, lore, schema, index, snapshot, diagnostic, or export directories are created in `0.0.0`.

The v0.0 manifest shape is:

```json
{
  "schemaVersion": "0.0.0",
  "projectId": "loredock_...",
  "title": "My Novel",
  "createdAt": "2026-06-29T00:00:00.000Z",
  "updatedAt": "2026-06-29T00:00:00.000Z",
  "capabilities": []
}
```

`projectId` is generated once and remains stable. `updatedAt` changes only when the manifest is written or repaired by the kernel.

## Commands

- `LoreDock: Initialize Project`
- `LoreDock: Open Project Manifest`
- `LoreDock: Show Diagnostics`
- `LoreDock: Repair Project Manifest`

## Architecture Boundaries

The v0.0 kernel owns workspace selection, manifest IO, validation, diagnostics, schema registration, migration entry points, command registration, safe file writes, and preview/apply execution.

Feature modules must attach through the Capability API. They should not import kernel private implementation details or write project files directly.

All project paths stored by LoreDock should be workspace-relative. All file mutations must be declared in an operation plan before they are applied.

## Not Included Yet

`0.0.0` intentionally does not include:

- Manuscript editing or chapter/scene files.
- Story bible modules for characters, locations, rules, factions, items, or events.
- Outline boards, plot grids, timelines, or visual planning tools.
- Knowledge graph, backlinks, entity indexing, or consistency checks.
- AI assistant features.
- Compile/export, snapshots, or publishing workflows.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) and [`docs/versions/`](docs/versions/) for the planned version path.

## Development

```sh
npm install
npm run compile
npm test
```

The current test suite covers manifest defaults and validation, manifest repair behavior, schema registry registration, migration no-op flow, safe file writer boundaries, project initialization, degraded mode disposal, and capability command routing.

Diagnostics are not written to disk in `0.0.0`; they live in memory and are printed to the LoreDock OutputChannel.
