import assert from "assert/strict";
import { MigrationRunner } from "../kernel/migrationRunner";
import type { ProjectManifest } from "../kernel/types";

suite("MigrationRunner", () => {
  test("runs v0.0 no-op migration without changing the manifest", async () => {
    const manifest: ProjectManifest = {
      schemaVersion: "0.0.0",
      projectId: "loredock_test",
      title: "Project",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      capabilities: []
    };
    const runner = new MigrationRunner();

    const result = await runner.runNoop(manifest);

    assert.equal(result.changed, false);
    assert.equal(result.manifest, manifest);
  });
});
