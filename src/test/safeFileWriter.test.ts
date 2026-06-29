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
    await assert.rejects(() => writer.writeFile(".loredock/project.json", "{}\n"), /未在操作计划中声明/);
  });

  test("rejects create writes over existing files", async () => {
    await fs.writeFile(path.join(workspace, "file.txt"), "original", "utf8");
    const writer = new SafeFileWriter(workspace, {
      summary: "create",
      directoriesToCreate: [],
      filesToCreate: ["file.txt"],
      filesToModify: []
    });

    await assert.rejects(() => writer.writeFile("file.txt", "new"), /已存在/);
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "original");
  });

  test("does not create undeclared parent directories implicitly", async () => {
    const writer = new SafeFileWriter(workspace, {
      summary: "nested",
      directoriesToCreate: ["parent/child"],
      filesToCreate: [],
      filesToModify: []
    });

    await assert.rejects(() => writer.ensureDirectory("parent/child"), /不存在|未在操作计划中声明/);
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

    await assert.rejects(() => writer.writeFile("/tmp/outside", ""), /工作区相对路径/);
    await assert.rejects(() => writer.writeFile("../outside", ""), /工作区相对路径/);
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

    await assert.rejects(() => writer.writeFile("linked/file.txt", "nope"), /越出了工作区/);
  });

  test("rejects symlink directory target escape", async () => {
    await fs.symlink(outside, path.join(workspace, "linked"));
    const writer = new SafeFileWriter(workspace, {
      summary: "directory",
      directoriesToCreate: ["linked"],
      filesToCreate: [],
      filesToModify: []
    });

    await assert.rejects(() => writer.ensureDirectory("linked"), /越出了工作区/);
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

    await assert.rejects(() => writer.writeFile("project.json", "{}\n"), /越出了工作区/);
  });

  test("moves and deletes declared files", async () => {
    await fs.mkdir(path.join(workspace, "manuscript"));
    await fs.writeFile(path.join(workspace, "manuscript/source.md"), "draft", "utf8");
    const writer = new SafeFileWriter(workspace, {
      summary: "move/delete",
      directoriesToCreate: [],
      filesToCreate: [],
      filesToModify: [],
      filesToMove: [{ from: "manuscript/source.md", to: "manuscript/target.md" }],
      filesToDelete: ["manuscript/target.md"]
    });

    await writer.moveFile("manuscript/source.md", "manuscript/target.md");
    assert.equal(await exists(path.join(workspace, "manuscript/source.md")), false);
    assert.equal(await fs.readFile(path.join(workspace, "manuscript/target.md"), "utf8"), "draft");

    await writer.deleteFile("manuscript/target.md");
    assert.equal(await exists(path.join(workspace, "manuscript/target.md")), false);
  });

  test("rejects undeclared move and delete operations", async () => {
    await fs.mkdir(path.join(workspace, "manuscript"));
    await fs.writeFile(path.join(workspace, "manuscript/source.md"), "draft", "utf8");
    const writer = new SafeFileWriter(workspace, {
      summary: "move/delete",
      directoriesToCreate: [],
      filesToCreate: [],
      filesToModify: []
    });

    await assert.rejects(
      () => writer.moveFile("manuscript/source.md", "manuscript/target.md"),
      /未在操作计划中声明/
    );
    await assert.rejects(() => writer.deleteFile("manuscript/source.md"), /未在操作计划中声明/);
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
