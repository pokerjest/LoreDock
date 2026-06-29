import assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectKernel } from "../kernel/projectKernel";
import type { Capability, OperationPlan } from "../kernel/types";

suite("ProjectKernel", () => {
  let workspace: string;
  let workspaceFolder: vscode.WorkspaceFolder;

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-kernel-"));
    workspaceFolder = {
      uri: vscode.Uri.file(workspace),
      name: path.basename(workspace),
      index: 0
    };
  });

  teardown(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("initProject cancel writes no files", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      confirm: async (plan) => {
        seenPlans.push(plan);
        return false;
      }
    });

    try {
      await kernel.initProject(workspaceFolder);

      assert.equal(seenPlans.length, 1);
      assert.equal(await exists(path.join(workspace, ".loredock")), false);
    } finally {
      kernel.dispose();
    }
  });

  test("initProject creates only .loredock and project manifest", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.initProject(workspaceFolder);

      assert.deepEqual(seenPlans[0], {
        summary: "Initialize LoreDock project.",
        directoriesToCreate: [".loredock"],
        filesToCreate: [".loredock/project.json"],
        filesToModify: []
      });
      assert.equal(await exists(path.join(workspace, ".loredock/project.json")), true);
      assert.equal(await exists(path.join(workspace, ".loredock/schemas")), false);

      const manifest = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));
      assert.equal(manifest.schemaVersion, "0.0.0");
      assert.match(manifest.projectId, /^loredock_/);
      assert.equal(manifest.title, path.basename(workspace));
      assert.equal(manifest.createdAt, "2026-06-29T00:00:00.000Z");
      assert.equal(manifest.updatedAt, "2026-06-29T00:00:00.000Z");
      assert.deepEqual(manifest.capabilities, []);
    } finally {
      kernel.dispose();
    }
  });

  test("repairProjectManifest backs up invalid JSON and writes a valid manifest", async () => {
    await fs.mkdir(path.join(workspace, ".loredock"));
    await fs.writeFile(path.join(workspace, ".loredock/project.json"), "{broken", "utf8");

    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.repairProjectManifest(workspaceFolder);

      assert.equal(seenPlans.length, 1);
      assert.equal(seenPlans[0].filesToModify.includes(".loredock/project.json"), true);
      assert.equal(seenPlans[0].filesToCreate.length, 1);
      assert.match(seenPlans[0].filesToCreate[0], /^\.loredock\/project\.json\..+\.bak$/);

      const backup = await fs.readFile(path.join(workspace, seenPlans[0].filesToCreate[0]), "utf8");
      assert.equal(backup, "{broken");

      const repaired = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));
      assert.equal(repaired.schemaVersion, "0.0.0");
      assert.match(repaired.projectId, /^loredock_/);
      assert.equal(repaired.createdAt, "2026-06-29T00:00:00.000Z");
      assert.equal(repaired.updatedAt, "2026-06-29T00:00:00.000Z");
      assert.deepEqual(repaired.capabilities, []);
    } finally {
      kernel.dispose();
    }
  });

  test("repairProjectManifest does not create a missing manifest", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      }
    });

    try {
      await kernel.repairProjectManifest(workspaceFolder);

      assert.deepEqual(seenPlans, []);
      assert.equal(await exists(path.join(workspace, ".loredock/project.json")), false);
    } finally {
      kernel.dispose();
    }
  });

  test("repairProjectManifest preserves legal parseable fields and warns for future versions", async () => {
    await fs.mkdir(path.join(workspace, ".loredock"));
    await fs.writeFile(
      path.join(workspace, ".loredock/project.json"),
      JSON.stringify(
        {
          schemaVersion: "9.0.0",
          projectId: "existing_project",
          title: "Existing Title",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-02-01T00:00:00.000Z",
          capabilities: ["unknown.capability"]
        },
        null,
        2
      ),
      "utf8"
    );

    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.repairProjectManifest(workspaceFolder);

      assert.match(seenPlans[0].summary, /not a migration/);
      const repaired = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));
      assert.equal(repaired.schemaVersion, "0.0.0");
      assert.equal(repaired.projectId, "existing_project");
      assert.equal(repaired.title, "Existing Title");
      assert.equal(repaired.createdAt, "2025-01-01T00:00:00.000Z");
      assert.equal(repaired.updatedAt, "2026-06-29T00:00:00.000Z");
      assert.deepEqual(repaired.capabilities, ["unknown.capability"]);
    } finally {
      kernel.dispose();
    }
  });

  test("refreshWorkspaceFolder activates enabled capability and disposes it in degraded mode", async () => {
    await fs.mkdir(path.join(workspace, ".loredock"));
    await fs.writeFile(
      path.join(workspace, ".loredock/project.json"),
      JSON.stringify(
        {
          schemaVersion: "0.0.0",
          projectId: "loredock_test",
          title: "Project",
          createdAt: "2026-06-29T00:00:00.000Z",
          updatedAt: "2026-06-29T00:00:00.000Z",
          capabilities: ["test.capability"]
        },
        null,
        2
      ),
      "utf8"
    );

    let activated = 0;
    let disposed = 0;
    const capability: Capability = {
      id: "test.capability",
      activate() {
        activated += 1;
        return [
          {
            dispose() {
              disposed += 1;
            }
          }
        ];
      }
    };
    const kernel = createKernel({ capabilities: [capability] });

    try {
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      assert.equal(activated, 1);
      assert.equal(disposed, 0);

      await fs.writeFile(path.join(workspace, ".loredock/project.json"), "{broken", "utf8");
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      assert.equal(activated, 1);
      assert.equal(disposed, 1);
    } finally {
      kernel.dispose();
    }
  });

  test("routes capability commands across multiple workspace folders without duplicate registration", async () => {
    const secondWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-kernel-second-"));
    const secondWorkspaceFolder: vscode.WorkspaceFolder = {
      uri: vscode.Uri.file(secondWorkspace),
      name: path.basename(secondWorkspace),
      index: 1
    };

    await writeManifest(workspace, "test.commandCapability");
    await writeManifest(secondWorkspace, "test.commandCapability");

    const invoked: string[] = [];
    const capability: Capability = {
      id: "test.commandCapability",
      activate(context) {
        return [
          context.registerCommand("loredock.test.routeCommand", () => {
            invoked.push(context.workspaceFolder.uri.fsPath);
          })
        ];
      }
    };
    const kernel = createKernel({ capabilities: [capability] });

    try {
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      await kernel.refreshWorkspaceFolder(secondWorkspaceFolder);

      await vscode.commands.executeCommand("loredock.test.routeCommand", secondWorkspaceFolder);

      assert.deepEqual(invoked, [secondWorkspace]);
    } finally {
      kernel.dispose();
      await fs.rm(secondWorkspace, { recursive: true, force: true });
    }
  });

  test("cleans up partially registered resources when capability activation fails", async () => {
    await writeManifest(workspace, "test.throwingCapability");

    let invoked = false;
    const capability: Capability = {
      id: "test.throwingCapability",
      activate(context) {
        context.registerCommand("loredock.test.partialActivationCommand", () => {
          invoked = true;
        });
        throw new Error("boom");
      }
    };
    const kernel = createKernel({ capabilities: [capability] });

    try {
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      await assert.rejects(async () => vscode.commands.executeCommand("loredock.test.partialActivationCommand"));
      assert.equal(invoked, false);
    } finally {
      kernel.dispose();
    }
  });

  test("continues disposing remaining capability resources after one dispose throws", async () => {
    await writeManifest(workspace, "test.disposeCapability");

    let goodDisposed = 0;
    const capability: Capability = {
      id: "test.disposeCapability",
      activate() {
        return [
          {
            dispose() {
              goodDisposed += 1;
            }
          },
          {
            dispose() {
              throw new Error("dispose boom");
            }
          }
        ];
      }
    };
    const kernel = createKernel({ capabilities: [capability] });

    try {
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      await fs.writeFile(path.join(workspace, ".loredock/project.json"), "{broken", "utf8");
      await kernel.refreshWorkspaceFolder(workspaceFolder);

      assert.equal(goodDisposed, 1);
    } finally {
      kernel.dispose();
    }
  });

  test("cleans up capability routes when a workspace folder is removed", async () => {
    await writeManifest(workspace, "test.removedWorkspaceCapability");

    let invoked = false;
    const capability: Capability = {
      id: "test.removedWorkspaceCapability",
      activate(context) {
        return [
          context.registerCommand("loredock.test.removedWorkspaceCommand", () => {
            invoked = true;
          })
        ];
      }
    };
    const kernel = createKernel({ capabilities: [capability] });

    try {
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      getWorkspaceFolderChangeHandler(kernel)({
        added: [],
        removed: [workspaceFolder]
      } as vscode.WorkspaceFoldersChangeEvent);

      await assert.rejects(async () => vscode.commands.executeCommand("loredock.test.removedWorkspaceCommand"));
      assert.equal(invoked, false);
    } finally {
      kernel.dispose();
    }
  });
});

function createKernel(options: {
  confirm?: (plan: OperationPlan) => Promise<boolean>;
  now?: () => Date;
  capabilities?: Capability[];
}): ProjectKernel {
  return new ProjectKernel(
    { subscriptions: [] } as unknown as vscode.ExtensionContext,
    options.capabilities ?? [],
    {
      confirm: options.confirm,
      now: options.now,
      output: createOutputChannel()
    }
  );
}

function createOutputChannel(): vscode.OutputChannel {
  return {
    name: "LoreDock Test",
    append() {},
    appendLine() {},
    replace() {},
    clear() {},
    show() {},
    hide() {},
    dispose() {}
  } as vscode.OutputChannel;
}

function getWorkspaceFolderChangeHandler(
  kernel: ProjectKernel
): (event: vscode.WorkspaceFoldersChangeEvent) => void {
  return (
    kernel as unknown as {
      handleWorkspaceFoldersChanged(event: vscode.WorkspaceFoldersChangeEvent): void;
    }
  ).handleWorkspaceFoldersChanged.bind(kernel);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeManifest(workspacePath: string, capabilityId: string): Promise<void> {
  await fs.mkdir(path.join(workspacePath, ".loredock"));
  await fs.writeFile(
    path.join(workspacePath, ".loredock/project.json"),
    JSON.stringify(
      {
        schemaVersion: "0.0.0",
        projectId: "loredock_test",
        title: "Project",
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:00.000Z",
        capabilities: [capabilityId]
      },
      null,
      2
    ),
    "utf8"
  );
}
