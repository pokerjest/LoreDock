import assert from "assert/strict";
import {
  createDefaultManifest,
  repairManifestValue,
  validateProjectManifest
} from "../kernel/manifest";
import { MANIFEST_SCHEMA_VERSION, PROJECT_ID_PREFIX } from "../kernel/types";

suite("manifest", () => {
  const workspaceFolder = "/workspace/My Novel";
  const now = new Date("2026-06-29T00:00:00.000Z");

  test("creates default manifest with fixed v0.0 defaults", () => {
    const manifest = createDefaultManifest(workspaceFolder, now);

    assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.match(manifest.projectId, new RegExp(`^${PROJECT_ID_PREFIX}`));
    assert.equal(manifest.title, "My Novel");
    assert.equal(manifest.createdAt, now.toISOString());
    assert.equal(manifest.updatedAt, now.toISOString());
    assert.deepEqual(manifest.capabilities, []);
  });

  test("validates a supported manifest", () => {
    const manifest = {
      schemaVersion: "0.0.0",
      projectId: "loredock_test",
      title: "Project",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:00:00.000Z",
      capabilities: ["example.empty"]
    };

    const result = validateProjectManifest(manifest, workspaceFolder, new Set(["example.empty"]));

    assert.equal(result.isValid, true);
    assert.equal(result.degraded, false);
    assert.deepEqual(result.manifest?.capabilities, ["example.empty"]);
    assert.deepEqual(result.diagnostics, []);
  });

  test("reports missing and invalid field types into degraded mode", () => {
    const result = validateProjectManifest(
      {
        schemaVersion: "0.0.0",
        projectId: "",
        title: 42,
        createdAt: "not-a-date",
        capabilities: "example.empty"
      },
      workspaceFolder
    );

    assert.equal(result.isValid, false);
    assert.equal(result.degraded, true);
    assert.equal(result.diagnostics.some((item) => item.code === "manifest.projectId.invalid"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "manifest.title.invalid"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "manifest.createdAt.invalid"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "manifest.updatedAt.invalid"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "manifest.capabilities.invalid"), true);
  });

  test("rejects unsupported schema versions into degraded mode", () => {
    const result = validateProjectManifest(
      {
        schemaVersion: "1.0.0",
        projectId: "loredock_test",
        title: "Project",
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:00.000Z",
        capabilities: []
      },
      workspaceFolder
    );

    assert.equal(result.isValid, false);
    assert.equal(result.degraded, true);
    assert.equal(result.diagnostics.some((item) => item.code === "manifest.schemaVersion.unsupported"), true);
  });

  test("validates capabilities without silently rewriting duplicates", () => {
    const result = validateProjectManifest(
      {
        schemaVersion: "0.0.0",
        projectId: "loredock_test",
        title: "Project",
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:00.000Z",
        capabilities: ["example.empty", "example.empty", "", 12]
      },
      workspaceFolder,
      new Set(["example.empty"])
    );

    assert.equal(result.isValid, false);
    assert.equal(result.degraded, true);
    assert.equal(result.diagnostics.some((item) => item.code === "manifest.capability.duplicate"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "manifest.capability.invalid"), true);
  });

  test("repairs parseable manifests while preserving valid identity fields", () => {
    const repaired = repairManifestValue(
      {
        schemaVersion: "9.0.0",
        projectId: "custom_id",
        title: "Existing",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
        capabilities: ["unknown.capability", "unknown.capability", ""]
      },
      workspaceFolder,
      now
    );

    assert.equal(repaired.schemaVersion, "0.0.0");
    assert.equal(repaired.projectId, "custom_id");
    assert.equal(repaired.title, "Existing");
    assert.equal(repaired.createdAt, "2025-01-01T00:00:00.000Z");
    assert.equal(repaired.updatedAt, now.toISOString());
    assert.deepEqual(repaired.capabilities, ["unknown.capability"]);
  });
});
