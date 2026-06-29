# LoreDock

LoreDock is a local-first story project system for VS Code.

Current package version: **0.0.0**.

Current milestone: **v0.1 Manuscript Core on the v0.0 Project Kernel**.

LoreDock is being rebuilt as a transparent, local-first writing system for long-form fiction. The current implementation includes the project kernel plus the first usable manuscript capability: project discovery, manifest lifecycle, safe writes, diagnostics, schema registration, capability routing, and a manuscript tree for books, volumes, chapters, notes, and basic progress statistics.

## Current Status

`0.0.0` now carries the v0.0 foundation and the in-development v0.1 manuscript core.

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
- Manuscript capability activation through `manuscript.core`.
- Chinese localized Manuscript tree view in the LoreDock activity bar.
- Manuscript structure management for books, volumes, chapters, per-book AI agent guides, notes, status, target word count, moves, and statistics.
- Per-book `agent.md` guides split read-only system rules from user-editable custom rules so AI plugins can follow LoreDock structure while preserving each book's collaboration preferences.
- Manuscript manifest validation for broken references, invalid paths, missing files, orphan Markdown files, duplicate paths, and symlink escapes.
- Manuscript recycle bin: deleting books, volumes, or chapters first moves them to `.loredock/trash/manuscript/`; recycle-bin items can be restored or permanently removed recursively.

The kernel remains independent from manuscript internals. Story bible, outline, timeline, assistant, compile, and export concepts are still later capabilities.

## Project Files

Project initialization creates only:

```text
.loredock/
  project.json
```

Enabling Manuscript adds:

```text
manuscript/
  manifest.json
  notes.md
  book-001/
    agent.md
    volume-001/
      chapter-001.md
```

No story bible, schema, index, snapshot, diagnostic, compile, or export directories are created yet.

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
- `LoreDock: Enable Manuscript`
- `LoreDock: New Book`
- `LoreDock: New Volume`
- `LoreDock: New Chapter`
- `LoreDock: Open Chapter`
- `LoreDock: Rename Book`
- `LoreDock: Rename Volume`
- `LoreDock: Rename Chapter`
- `LoreDock: Move Chapter`
- `LoreDock: Delete Book`
- `LoreDock: Delete Volume`
- `LoreDock: Delete Chapter`
- `LoreDock: Set Chapter Status`
- `LoreDock: Set Chapter Target Word Count`
- `LoreDock: Open Notes`
- `LoreDock: Manuscript Statistics`

## Architecture Boundaries

The v0.0 kernel owns workspace selection, manifest IO, validation, diagnostics, schema registration, migration entry points, command registration, safe file writes, and preview/apply execution.

Feature modules must attach through the Capability API. They should not import kernel private implementation details or write project files directly.

All project paths stored by LoreDock should be workspace-relative. All file mutations must be declared in an operation plan before they are applied.

## Not Included Yet

This version intentionally does not include:

- A custom rich manuscript editor; chapters are normal Markdown files opened by VS Code.
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

The current test suite covers manifest defaults and validation, manifest repair behavior, schema registry registration, migration no-op flow, safe file writer boundaries, project initialization, degraded mode disposal, capability command routing, manuscript structure operations, manuscript diagnostics, safe path handling, and word counts.

Diagnostics are not written to disk in `0.0.0`; they live in memory and are printed to the LoreDock OutputChannel.
