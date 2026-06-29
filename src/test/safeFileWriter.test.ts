import assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { SafeFileWriter } from "../kernel/safeFileWriter";
import type { OperationPlan } from "../kernel/types";

suite("SafeFileWriter", () => {
  let workspace: string;
  let outside: string;

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-workspace-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-outside-"));
  });

  teardown(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  test("creates declared directories and writes declared files", async () => {
    const plan: OperationPlan = {
      summary: "init",
      directoriesToCreate: [".loredock"],
      filesToCreate: [".loredock/project.json"],
      filesToModify: []
    };
    const writer = new SafeFileWriter(workspace, plan);

    await writer.ensureDirectory(".loredock");
    await writer.writeFile(".loredock/project.json", "{}\n");

    assert.equal(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"), "{}\n");
  });

  test("rejects files not declared in the operation plan", async () => {
    const writer = new SafeFileWriter(workspace, {
      summary: "init",
      directoriesToCreate: [".loredock"],
      filesToCreate: [],
      filesToModify: []
    });

    await writer.ensureDirectory(".loredock");
    await assert.rejects(() => writer.writeFile(".loredock/project.json", "{}\n"), /not declared/);
  });

  test("does not create undeclared parent directories implicitly", async () => {
    const writer = new SafeFileWriter(workspace, {
      summary: "nested",
      directoriesToCreate: ["parent/child"],
      filesToCreate: [],
      filesToModify: []
    });

    await assert.rejects(() => writer.ensureDirectory("parent/child"), /does not exist|not declared/);
    assert.equal(await exists(path.join(workspace, "parent")), false);
  });

  test("allows nested directories when each level is declared and created in order", async () => {
    const writer = new SafeFileWriter(workspace, {
      summary: "nested",
      directoriesToCreate: ["parent", "parent/child"],
      filesToCreate: [],
      filesToModify: []
    });

    await writer.ensureDirectory("parent");
    await writer.ensureDirectory("parent/child");

    const stats = await fs.stat(path.join(workspace, "parent/child"));
    assert.equal(stats.isDirectory(), true);
  });

  test("rejects absolute and parent-traversal paths", async () => {
    const writer = new SafeFileWriter(workspace, {
      summary: "write",
      directoriesToCreate: [],
      filesToCreate: ["/tmp/outside", "../outside"],
      filesToModify: []
    });

    await assert.rejects(() => writer.writeFile("/tmp/outside", ""), /workspace-relative/);
    await assert.rejects(() => writer.writeFile("../outside", ""), /workspace-relative/);
  });

  test("rejects symlink parent escape", async () => {
    const linkPath = path.join(workspace, "linked");
    await fs.symlink(outside, linkPath);

    const writer = new SafeFileWriter(workspace, {
      summary: "write",
      directoriesToCreate: [],
      filesToCreate: ["linked/file.txt"],
      filesToModify: []
    });

    await assert.rejects(() => writer.writeFile("linked/file.txt", "nope"), /escapes the workspace/);
  });

  test("rejects existing symlink target escape", async () => {
    const outsideFile = path.join(outside, "project.json");
    await fs.writeFile(outsideFile, "{}\n", "utf8");
    await fs.symlink(outsideFile, path.join(workspace, "project.json"));

    const writer = new SafeFileWriter(workspace, {
      summary: "write",
      directoriesToCreate: [],
      filesToCreate: [],
      filesToModify: ["project.json"]
    });

    await assert.rejects(() => writer.writeFile("project.json", "{}\n"), /escapes the workspace/);
  });
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
