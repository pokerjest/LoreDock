import assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { manuscriptCapability } from "../capabilities/manuscript/capability";
import { storyBibleCapability } from "../capabilities/storyBible/capability";
import { ProjectKernel } from "../kernel/projectKernel";
import type { Capability, DiagnosticItem, OperationPlan } from "../kernel/types";

suite("ProjectKernel", function () {
  this.timeout(10000);

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
        summary: "初始化 LoreDock 项目。",
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

      assert.match(seenPlans[0].summary, /不是版本迁移/);
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
      await vscode.commands.executeCommand("loredock.test.routeCommand", { workspaceFolder });

      assert.deepEqual(invoked, [secondWorkspace, workspace]);
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
      const routes = (
        kernel as unknown as {
          capabilityCommandRoutes: Map<string, unknown>;
        }
      ).capabilityCommandRoutes;
      assert.equal(routes.has("loredock.test.partialActivationCommand"), false);
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

      const routes = (
        kernel as unknown as {
          capabilityCommandRoutes: Map<string, unknown>;
        }
      ).capabilityCommandRoutes;
      assert.equal(routes.has("loredock.test.removedWorkspaceCommand"), false);
      assert.equal(invoked, false);
    } finally {
      kernel.dispose();
    }
  });

  test("registers bootstrap commands before a capability is enabled", async () => {
    let invoked = false;
    const capability: Capability = {
      id: "test.bootstrapCapability",
      bootstrap(context) {
        return [
          context.registerCommand("loredock.test.bootstrapCommand", () => {
            invoked = true;
          })
        ];
      },
      activate() {
        return [];
      }
    };
    const kernel = createKernel({ capabilities: [capability] });

    try {
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      await vscode.commands.executeCommand("loredock.test.bootstrapCommand", workspaceFolder);
      assert.equal(invoked, true);
    } finally {
      kernel.dispose();
    }
  });

  test("restores bootstrap command handler after active handler is disposed", async () => {
    await writeManifest(workspace, "test.stackedCommandCapability");

    const invoked: string[] = [];
    const capability: Capability = {
      id: "test.stackedCommandCapability",
      bootstrap(context) {
        return [
          context.registerCommand("loredock.test.stackedCommand", () => {
            invoked.push("bootstrap");
          })
        ];
      },
      activate(context) {
        return [
          context.registerCommand("loredock.test.stackedCommand", () => {
            invoked.push("active");
          })
        ];
      }
    };
    const kernel = createKernel({ capabilities: [capability] });

    try {
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      await vscode.commands.executeCommand("loredock.test.stackedCommand", workspaceFolder);

      await fs.writeFile(path.join(workspace, ".loredock/project.json"), "{broken", "utf8");
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      await vscode.commands.executeCommand("loredock.test.stackedCommand", workspaceFolder);

      assert.deepEqual(invoked, ["active", "bootstrap"]);
    } finally {
      kernel.dispose();
    }
  });

  test("retries capability command dispatch after refreshing an empty route", async () => {
    const command = "loredock.test.lazyBootstrapCommand";
    const kernel = createKernel({});
    const routes = getCapabilityCommandRoutes(kernel);
    let refreshed = false;
    let invoked = false;

    routes.set(command, {
      disposable: { dispose() {} },
      handlers: new Map(),
      persistent: true
    });
    replaceRefreshAllWorkspaceFolders(kernel, async () => {
      refreshed = true;
      routes.get(command)?.handlers.set(workspace, [{
        workspaceFolder,
        callback: () => {
          invoked = true;
          return "ok";
        }
      }]);
    });

    try {
      const result = await dispatchCapabilityCommand(kernel, command, [workspaceFolder]);

      assert.equal(refreshed, true);
      assert.equal(invoked, true);
      assert.equal(result, "ok");
    } finally {
      kernel.dispose();
    }
  });

  test("reports unsafe project manifest paths without reading through symlinks", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-kernel-outside-"));
    const kernel = createKernel({});

    try {
      await fs.mkdir(path.join(outside, ".loredock"));
      await fs.writeFile(
        path.join(outside, ".loredock/project.json"),
        JSON.stringify(
          {
            schemaVersion: "0.0.0",
            projectId: "loredock_outside",
            title: "Outside",
            createdAt: "2026-06-29T00:00:00.000Z",
            updatedAt: "2026-06-29T00:00:00.000Z",
            capabilities: []
          },
          null,
          2
        ),
        "utf8"
      );
      await fs.symlink(path.join(outside, ".loredock"), path.join(workspace, ".loredock"), "dir");

      await kernel.refreshWorkspaceFolder(workspaceFolder);

      const diagnostics = getDiagnostics(kernel, workspace);
      assert.equal(diagnostics.some((item) => item.code === "manifest.path.unsafe"), true);
    } finally {
      kernel.dispose();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("scopes capability services to the workspace folder and disposes them", async () => {
    await writeManifest(workspace, "test.serviceCapability");

    let valueDuringActivation: string | undefined;
    const capability: Capability = {
      id: "test.serviceCapability",
      activate(context) {
        const service = { value: "workspace-service" };
        const registration = context.registerCapabilityService("test.service", service);
        valueDuringActivation = context.getCapabilityService<typeof service>("test.service")?.value;
        return [registration];
      }
    };
    const kernel = createKernel({ capabilities: [capability] });

    try {
      await kernel.refreshWorkspaceFolder(workspaceFolder);
      assert.equal(valueDuringActivation, "workspace-service");
    } finally {
      kernel.dispose();
    }
  });

  test("enableManuscript creates manuscript files and enables the capability", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      capabilities: [manuscriptCapability],
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.initProject(workspaceFolder);
      await vscode.commands.executeCommand("loredock.enableManuscript", workspaceFolder);

      assert.equal(await exists(path.join(workspace, "manuscript/manifest.json")), true);
      assert.equal(await exists(path.join(workspace, "manuscript/notes.md")), true);
      assert.equal(await exists(path.join(workspace, "manuscript/book-001/agent.md")), true);
      assert.equal(await exists(path.join(workspace, "manuscript/book-001/volume-001/chapter-001.md")), true);

      const projectManifest = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));
      assert.equal(projectManifest.capabilities.includes("manuscript.core"), true);
      assert.equal(seenPlans.some((plan) => plan.summary.includes("启用手稿")), true);
    } finally {
      kernel.dispose();
    }
  });

  test("enableManuscript refuses to overwrite existing initial files", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      capabilities: [manuscriptCapability],
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.initProject(workspaceFolder);
      await fs.mkdir(path.join(workspace, "manuscript"), { recursive: true });
      await fs.writeFile(path.join(workspace, "manuscript/notes.md"), "keep me", "utf8");

      await vscode.commands.executeCommand("loredock.enableManuscript", workspaceFolder);

      const projectManifest = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));
      assert.equal(projectManifest.capabilities.includes("manuscript.core"), false);
      assert.equal(await fs.readFile(path.join(workspace, "manuscript/notes.md"), "utf8"), "keep me");
      assert.equal(seenPlans.filter((plan) => plan.summary.includes("启用手稿")).length, 0);
    } finally {
      kernel.dispose();
    }
  });

  test("storyBible commands prompt instead of writing before Story Bible is enabled", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      capabilities: [storyBibleCapability],
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.initProject(workspaceFolder);
      await vscode.commands.executeCommand("loredock.storyBible.createCardFromSelection", workspaceFolder);

      assert.equal(await exists(path.join(workspace, "lore")), false);
      assert.equal(seenPlans.length, 1);
      assert.equal(seenPlans[0].summary, "初始化 LoreDock 项目。");
    } finally {
      kernel.dispose();
    }
  });

  test("enableStoryBible creates lore directories and enables the capability", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      capabilities: [storyBibleCapability],
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.initProject(workspaceFolder);
      await vscode.commands.executeCommand("loredock.enableStoryBible", workspaceFolder);

      assert.equal(await exists(path.join(workspace, "lore/characters")), true);
      assert.equal(await exists(path.join(workspace, "lore/locations")), true);
      assert.equal(await exists(path.join(workspace, "lore/rules")), true);
      assert.equal(await exists(path.join(workspace, "lore/tags")), true);

      const projectManifest = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));
      assert.equal(projectManifest.updatedAt, "2026-06-29T00:00:00.000Z");
      assert.equal(projectManifest.capabilities.includes("story-bible.core"), true);
      assert.equal(seenPlans.some((plan) => plan.summary.includes("启用故事圣经")), true);
    } finally {
      kernel.dispose();
    }
  });

  test("enableStoryBible cancellation writes no lore files or capability", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      capabilities: [storyBibleCapability],
      confirm: async (plan) => {
        seenPlans.push(plan);
        return !plan.summary.includes("启用故事圣经");
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.initProject(workspaceFolder);
      await vscode.commands.executeCommand("loredock.enableStoryBible", workspaceFolder);

      const projectManifest = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));
      assert.equal(projectManifest.capabilities.includes("story-bible.core"), false);
      assert.equal(await exists(path.join(workspace, "lore")), false);
    } finally {
      kernel.dispose();
    }
  });

  test("enableStoryBible recovers existing lore directories and repeated enable is conservative", async () => {
    const seenPlans: OperationPlan[] = [];
    const kernel = createKernel({
      capabilities: [storyBibleCapability],
      confirm: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });

    try {
      await kernel.initProject(workspaceFolder);
      await fs.mkdir(path.join(workspace, "lore/characters"), { recursive: true });
      await fs.mkdir(path.join(workspace, "lore/locations"), { recursive: true });
      await fs.mkdir(path.join(workspace, "lore/rules"), { recursive: true });
      await fs.mkdir(path.join(workspace, "lore/tags"), { recursive: true });

      await vscode.commands.executeCommand("loredock.enableStoryBible", workspaceFolder);
      await vscode.commands.executeCommand("loredock.enableStoryBible", workspaceFolder);

      const projectManifest = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));
      assert.equal(
        projectManifest.capabilities.filter((capability: string) => capability === "story-bible.core").length,
        1
      );
      assert.equal(seenPlans.filter((plan) => plan.summary === "启用现有故事圣经。").length, 1);
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

function getDiagnostics(kernel: ProjectKernel, workspacePath: string): DiagnosticItem[] {
  return (
    kernel as unknown as {
      diagnostics: { getForWorkspace(workspaceFolderPath: string): DiagnosticItem[] };
    }
  ).diagnostics.getForWorkspace(workspacePath);
}

function getCapabilityCommandRoutes(kernel: ProjectKernel): Map<
  string,
  {
    disposable: vscode.Disposable;
    handlers: Map<string, { workspaceFolder: vscode.WorkspaceFolder; callback: (...args: unknown[]) => unknown }[]>;
    persistent: boolean;
  }
> {
  return (
    kernel as unknown as {
      capabilityCommandRoutes: Map<
        string,
        {
          disposable: vscode.Disposable;
          handlers: Map<string, { workspaceFolder: vscode.WorkspaceFolder; callback: (...args: unknown[]) => unknown }[]>;
          persistent: boolean;
        }
      >;
    }
  ).capabilityCommandRoutes;
}

function replaceRefreshAllWorkspaceFolders(kernel: ProjectKernel, callback: () => Promise<void>): void {
  (
    kernel as unknown as {
      refreshAllWorkspaceFolders: () => Promise<void>;
    }
  ).refreshAllWorkspaceFolders = callback;
}

async function dispatchCapabilityCommand(
  kernel: ProjectKernel,
  command: string,
  args: unknown[]
): Promise<unknown> {
  return (
    kernel as unknown as {
      dispatchCapabilityCommand(command: string, args: unknown[]): Promise<unknown>;
    }
  ).dispatchCapabilityCommand(command, args);
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
