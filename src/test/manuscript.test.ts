import assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { bookAgentPath, createBookAgentText } from "../capabilities/manuscript/bookAgent";
import { ManuscriptController } from "../capabilities/manuscript/controller";
import { ManuscriptTreeProvider } from "../capabilities/manuscript/tree";
import {
  createInitialManuscriptManifest,
  readManuscriptManifest,
  stringifyManuscriptManifest
} from "../capabilities/manuscript/manifest";
import {
  MANUSCRIPT_MANIFEST_PATH,
  type BookId,
  type ChapterId,
  type ManuscriptStatus,
  type VolumeId
} from "../capabilities/manuscript/types";
import { countMarkdownWords } from "../capabilities/manuscript/wordCount";
import type { DiagnosticItem, OperationPlan } from "../kernel/types";

suite("Manuscript", () => {
  let workspace: string;
  let workspaceFolder: vscode.WorkspaceFolder;
  let seenPlans: OperationPlan[];
  let destructivePrompts: string[];
  let destructiveConfirmResult: boolean;
  let diagnostics: DiagnosticItem[];
  let controller: ManuscriptController;

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-manuscript-"));
    workspaceFolder = {
      uri: vscode.Uri.file(workspace),
      name: path.basename(workspace),
      index: 0
    };
    seenPlans = [];
    destructivePrompts = [];
    destructiveConfirmResult = true;
    diagnostics = [];
    await writeInitialManuscript(workspace);
    controller = new ManuscriptController({
      workspaceFolder,
      output: createOutputChannel(),
      diagnostics: {
        add(item) {
          diagnostics.push(item);
        },
        clearMatching(workspaceFolderPath, predicate) {
          diagnostics = diagnostics.filter((item) => item.workspaceFolder !== workspaceFolderPath || !predicate(item));
        }
      },
      confirmOperationPlan: async (plan) => {
        seenPlans.push(plan);
        return true;
      },
      confirmDestructiveDelete: async (message) => {
        destructivePrompts.push(message);
        return destructiveConfirmResult;
      },
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });
  });

  teardown(async () => {
    controller.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("creates chapters with monotonic filenames after delete", async () => {
    const volume = (await controller.listVolumes())[0];

    await controller.createChapter(volume.id, "第二章");
    let chapters = await controller.listChapters(volume.id);
    const second = chapters.find((chapter) => chapter.title === "第二章");
    assert.equal(second?.path.endsWith("chapter-002.md"), true);

    await controller.deleteChapter(second!.id);
    await controller.createChapter(volume.id, "第三章");

    chapters = await controller.listChapters(volume.id);
    const third = chapters.find((chapter) => chapter.title === "第三章");
    const trashItem = (await controller.listTrashItems()).find((item) => item.originalPath === second!.path);

    assert.equal(third?.path.endsWith("chapter-003.md"), true);
    assert.equal(await exists(path.join(workspace, volume.path, "chapter-002.md")), false);
    assert.ok(trashItem);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath, "chapter-002.md")), true);
  });

  test("creates a book agent guide for every new book", async () => {
    await controller.createBook("第二本书");

    const createdBook = (await controller.listBooks()).find((book) => book.title === "第二本书");
    assert.ok(createdBook);

    const agentPath = path.join(workspace, bookAgentPath(createdBook.path));
    const text = await fs.readFile(agentPath, "utf8");
    assert.match(text, /第二本书 AI Agent 使用说明/);
    assert.match(text, /LOREDOCK_AGENT_SYSTEM_RULES_START/);
    assert.match(text, /## 系统规则（只读）/);
    assert.match(text, /用户确认后，AI 在本次协作中按用户自己的规则执行/);
    assert.match(text, /LOREDOCK_AGENT_USER_RULES_START/);
    assert.match(text, /## 用户自定义规则（可编辑）/);

    const result = await readManuscriptManifest(workspace);
    assert.equal(result.diagnostics.some((item) => item.relativePath === bookAgentPath(createdBook.path)), false);
  });

  test("moves chapters across volumes without overwriting filename conflicts", async () => {
    const book = (await controller.listBooks())[0];
    const sourceVolume = (await controller.listVolumes(book.id))[0];
    await controller.createVolume(book.id, "第二卷");
    const targetVolume = (await controller.listVolumes(book.id)).find((volume) => volume.title === "第二卷")!;
    await controller.createChapter(targetVolume.id, "目标卷第一章");

    const sourceChapter = (await controller.listChapters(sourceVolume.id))[0];
    await controller.moveChapter(sourceChapter.id, targetVolume.id);

    const moved = await controller.getChapter(sourceChapter.id);
    assert.equal(moved?.volumeId, targetVolume.id);
    assert.equal(moved?.path, `${targetVolume.path}/chapter-002.md`);
    assert.equal(await exists(path.join(workspace, `${targetVolume.path}/chapter-001.md`)), true);
    assert.equal(await exists(path.join(workspace, `${targetVolume.path}/chapter-002.md`)), true);
  });

  test("does not move a chapter when the target is its current volume", async () => {
    const volume = (await controller.listVolumes())[0];
    await controller.createChapter(volume.id, "第二章");
    const before = await controller.listChapters(volume.id);
    const first = before[0];
    seenPlans = [];

    const result = await controller.moveChapter(first.id, volume.id);
    const after = await controller.listChapters(volume.id);

    assert.equal(result.applied, false);
    assert.deepEqual(
      after.map((chapter) => chapter.id),
      before.map((chapter) => chapter.id)
    );
    assert.equal(seenPlans.length, 0);
  });

  test("reorders chapters within a volume by index without moving files", async () => {
    const volume = (await controller.listVolumes())[0];
    await controller.createChapter(volume.id, "第二章");
    const before = await controller.listChapters(volume.id);
    const first = before[0];
    const firstPath = first.path;

    const result = await controller.moveChapter(first.id, volume.id, 1);

    const after = await controller.listChapters(volume.id);
    assert.equal(result.applied, true);
    assert.equal(after.length, 2);
    assert.equal(after[1].id, first.id);
    assert.equal((await controller.getChapter(first.id))?.path, firstPath);
    assert.equal(await exists(path.join(workspace, firstPath)), true);
  });

  test("deletes an empty volume without destructive confirmation", async () => {
    const book = (await controller.listBooks())[0];
    await controller.createVolume(book.id, "空卷");
    const volume = (await controller.listVolumes(book.id)).find((item) => item.title === "空卷")!;
    seenPlans = [];
    destructivePrompts = [];

    const result = await controller.deleteVolume(volume.id);

    assert.equal(result.applied, true);
    assert.equal((await controller.listVolumes(book.id)).some((item) => item.id === volume.id), false);
    assert.equal(destructivePrompts.length, 0);
    assert.equal(seenPlans[0].summary.includes("移入回收站"), true);
    assert.equal((await controller.listTrashItems()).some((item) => item.originalPath === volume.path), true);
  });

  test("moves a non-empty volume to trash with destructive confirmation", async () => {
    const volume = (await controller.listVolumes())[0];
    const chapter = (await controller.listChapters(volume.id))[0];
    const extraPath = path.join(workspace, volume.path, "research", "note.md");
    await fs.mkdir(path.dirname(extraPath), { recursive: true });
    await fs.writeFile(extraPath, "kept with volume", "utf8");

    const result = await controller.deleteVolume(volume.id);
    const trashItem = (await controller.listTrashItems()).find((item) => item.originalPath === volume.path);

    assert.equal(result.applied, true);
    assert.equal(destructivePrompts.length, 1);
    assert.equal(destructivePrompts[0].includes("包含 1 个章节"), true);
    assert.equal((await controller.listVolumes()).some((item) => item.id === volume.id), false);
    assert.equal((await controller.getChapter(chapter.id)), undefined);
    assert.equal(await exists(path.join(workspace, chapter.path)), false);
    assert.ok(trashItem);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath, path.basename(volume.path), path.basename(chapter.path))), true);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath, path.basename(volume.path), "research", "note.md")), true);

    const permanentResult = await controller.permanentlyDeleteTrashItem(trashItem.id);
    assert.equal(permanentResult.applied, true);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath)), false);
    assert.equal((await controller.listTrashItems()).some((item) => item.id === trashItem.id), false);
  });

  test("restores a deleted volume from trash", async () => {
    const book = (await controller.listBooks())[0];
    const volume = (await controller.listVolumes(book.id))[0];
    const chapter = (await controller.listChapters(volume.id))[0];
    const extraPath = path.join(workspace, volume.path, "research", "note.md");
    await fs.mkdir(path.dirname(extraPath), { recursive: true });
    await fs.writeFile(extraPath, "kept with volume", "utf8");

    await controller.deleteVolume(volume.id);
    const trashItem = (await controller.listTrashItems()).find((item) => item.originalPath === volume.path)!;
    const trashedVolumePath = path.join(workspace, trashItem.trashPath, path.basename(volume.path));

    assert.equal(await exists(trashedVolumePath), true);
    assert.equal((await controller.listVolumes(book.id)).some((item) => item.id === volume.id), false);

    const result = await controller.restoreTrashItem(trashItem.id);

    assert.equal(result.applied, true);
    assert.equal((await controller.listVolumes(book.id)).some((item) => item.id === volume.id), true);
    assert.equal((await controller.getChapter(chapter.id))?.path, chapter.path);
    assert.equal(await exists(path.join(workspace, chapter.path)), true);
    assert.equal(await exists(extraPath), true);
    assert.equal(await exists(trashedVolumePath), false);
    assert.equal((await controller.listTrashItems()).some((item) => item.id === trashItem.id), false);
  });

  test("restores a deleted chapter from trash", async () => {
    const volume = (await controller.listVolumes())[0];
    await controller.createChapter(volume.id, "第二章");
    const chapter = (await controller.listChapters(volume.id)).find((item) => item.title === "第二章")!;

    await controller.deleteChapter(chapter.id);
    const trashItem = (await controller.listTrashItems()).find((item) => item.originalPath === chapter.path)!;
    const trashFile = path.join(workspace, trashItem.trashPath, path.basename(chapter.path));

    assert.equal(await exists(path.join(workspace, chapter.path)), false);
    assert.equal(await exists(trashFile), true);

    const result = await controller.restoreTrashItem(trashItem.id);
    const restored = await controller.getChapter(chapter.id);

    assert.equal(result.applied, true);
    assert.equal(restored?.path, chapter.path);
    assert.equal(await exists(path.join(workspace, chapter.path)), true);
    assert.equal(await exists(trashFile), false);
    assert.equal((await controller.listTrashItems()).some((item) => item.id === trashItem.id), false);
  });

  test("rejects restore when trash payload is missing", async () => {
    const volume = (await controller.listVolumes())[0];
    const chapter = (await controller.listChapters(volume.id))[0];

    await controller.deleteChapter(chapter.id);
    const trashItem = (await controller.listTrashItems()).find((item) => item.originalPath === chapter.path)!;
    await fs.rm(path.join(workspace, trashItem.trashPath, path.basename(chapter.path)));

    await assert.rejects(() => controller.restoreTrashItem(trashItem.id), /回收站内容/);
    assert.equal(await controller.getChapter(chapter.id), undefined);
    assert.equal((await controller.listTrashItems()).some((item) => item.id === trashItem.id), true);
  });

  test("restores a deleted book from trash including agent and chapters", async () => {
    const book = (await controller.listBooks())[0];
    const volume = (await controller.listVolumes(book.id))[0];
    const chapter = (await controller.listChapters(volume.id))[0];
    const agentRelativePath = bookAgentPath(book.path);

    await controller.deleteBook(book.id);
    const trashItem = (await controller.listTrashItems()).find((item) => item.originalPath === book.path)!;
    const trashedBookPath = path.join(workspace, trashItem.trashPath, path.basename(book.path));

    assert.equal(await exists(trashedBookPath), true);
    assert.equal((await controller.listBooks()).some((item) => item.id === book.id), false);

    const result = await controller.restoreTrashItem(trashItem.id);

    assert.equal(result.applied, true);
    assert.equal((await controller.listBooks()).some((item) => item.id === book.id), true);
    assert.equal((await controller.listVolumes(book.id)).some((item) => item.id === volume.id), true);
    assert.equal((await controller.getChapter(chapter.id))?.path, chapter.path);
    assert.equal(await exists(path.join(workspace, agentRelativePath)), true);
    assert.equal(await exists(path.join(workspace, chapter.path)), true);
    assert.equal(await exists(trashedBookPath), false);
    assert.equal((await controller.listTrashItems()).some((item) => item.id === trashItem.id), false);
  });

  test("cancels non-empty volume deletion at destructive confirmation", async () => {
    const volume = (await controller.listVolumes())[0];
    const chapter = (await controller.listChapters(volume.id))[0];
    destructiveConfirmResult = false;

    const result = await controller.deleteVolume(volume.id);

    assert.equal(result.applied, false);
    assert.equal(destructivePrompts.length, 1);
    assert.equal((await controller.listVolumes()).some((item) => item.id === volume.id), true);
    assert.equal(await exists(path.join(workspace, chapter.path)), true);
  });

  test("moves a book with volumes to trash including agent and chapters", async () => {
    const book = (await controller.listBooks())[0];
    const volume = (await controller.listVolumes(book.id))[0];
    const chapter = (await controller.listChapters(volume.id))[0];
    const agentRelativePath = bookAgentPath(book.path);

    const result = await controller.deleteBook(book.id);
    const trashItem = (await controller.listTrashItems()).find((item) => item.originalPath === book.path);

    assert.equal(result.applied, true);
    assert.equal(destructivePrompts.length, 1);
    assert.equal((await controller.listBooks()).some((item) => item.id === book.id), false);
    assert.equal(await exists(path.join(workspace, chapter.path)), false);
    assert.equal(await exists(path.join(workspace, agentRelativePath)), false);
    assert.ok(trashItem);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath, path.basename(book.path), "agent.md")), true);
    assert.equal(
      await exists(
        path.join(
          workspace,
          trashItem.trashPath,
          path.basename(book.path),
          path.basename(volume.path),
          path.basename(chapter.path)
        )
      ),
      true
    );
  });

  test("sets and clears target word count", async () => {
    const chapter = (await controller.listChapters())[0];

    await controller.setChapterTargetWordCount(chapter.id, 3000);
    assert.equal((await controller.getChapter(chapter.id))?.targetWordCount, 3000);

    await controller.setChapterTargetWordCount(chapter.id, undefined);
    assert.equal((await controller.getChapter(chapter.id))?.targetWordCount, undefined);
  });

  test("rejects unsupported chapter statuses before writing", async () => {
    const chapter = (await controller.listChapters())[0];

    await assert.rejects(
      () => controller.setChapterStatus(chapter.id, "broken" as ManuscriptStatus),
      /不受支持/
    );

    assert.equal((await controller.getChapter(chapter.id))?.status, "draft");
  });

  test("validates damaged manifest and orphan files", async () => {
    const result = await readManuscriptManifest(workspace);
    assert.equal(result.status, "valid");

    const book = (await controller.listBooks())[0];
    const withAgent = await readManuscriptManifest(workspace);
    assert.equal(
      withAgent.diagnostics.some(
        (item) => item.code === "manuscript.orphanMarkdown" && item.relativePath === bookAgentPath(book.path)
      ),
      false
    );

    await fs.writeFile(path.join(workspace, "manuscript/orphan.md"), "orphan", "utf8");
    const withOrphan = await readManuscriptManifest(workspace);
    assert.equal(withOrphan.diagnostics.some((item) => item.code === "manuscript.orphanMarkdown"), true);

    const manifest = JSON.parse(await fs.readFile(path.join(workspace, MANUSCRIPT_MANIFEST_PATH), "utf8"));
    manifest.chapters[Object.keys(manifest.chapters)[0]].targetWordCount = 0;
    await fs.writeFile(path.join(workspace, MANUSCRIPT_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const damaged = await readManuscriptManifest(workspace);
    assert.equal(damaged.status, "degraded");
    assert.equal(
      damaged.diagnostics.some((item) => item.code === "manuscript.chapter.targetWordCount.invalid"),
      true
    );
  });

  test("reports missing notes and modified agent system rules", async () => {
    const book = (await controller.listBooks())[0];

    await fs.rm(path.join(workspace, "manuscript/notes.md"));
    let result = await readManuscriptManifest(workspace);
    assert.equal(result.diagnostics.some((item) => item.code === "manuscript.notes.missing"), true);

    await fs.writeFile(path.join(workspace, "manuscript/notes.md"), "# Notes\n\n", "utf8");
    await fs.writeFile(path.join(workspace, bookAgentPath(book.path)), "# Agent\n\n", "utf8");
    result = await readManuscriptManifest(workspace);
    assert.equal(result.status, "valid");
    const agentRulesDiagnostic = result.diagnostics.find(
      (item) => item.code === "manuscript.book.agent.systemRules.missing"
    );
    assert.ok(agentRulesDiagnostic);
    assert.equal(agentRulesDiagnostic.severity, "warning");
  });

  test("clears stale manuscript diagnostics on refresh", async () => {
    const orphanPath = path.join(workspace, "manuscript/orphan.md");
    await fs.writeFile(orphanPath, "orphan", "utf8");

    await controller.refreshDiagnostics();
    assert.equal(diagnostics.some((item) => item.code === "manuscript.orphanMarkdown"), true);

    await fs.rm(orphanPath);
    await controller.refreshDiagnostics();
    assert.equal(diagnostics.some((item) => item.code === "manuscript.orphanMarkdown"), false);
  });

  test("rejects chapter files that resolve outside the workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-manuscript-outside-"));
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(workspace, MANUSCRIPT_MANIFEST_PATH), "utf8"));
      const chapterId = Object.keys(manifest.chapters)[0] as ChapterId;
      const chapterPath = manifest.chapters[chapterId].path as string;
      const outsideFile = path.join(outside, "chapter.md");

      await fs.writeFile(outsideFile, "# Outside\n\nsecret", "utf8");
      await fs.rm(path.join(workspace, chapterPath));
      await fs.symlink(outsideFile, path.join(workspace, chapterPath));

      const result = await readManuscriptManifest(workspace);
      assert.equal(result.status, "degraded");
      assert.equal(result.diagnostics.some((item) => item.code === "manuscript.chapter.file.unsafePath"), true);

      const read = await controller.readChapterText(chapterId);
      assert.equal(read.ok, false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("counts mixed markdown text", () => {
    const result = countMarkdownWords(
      [
        "# 第一章 Title",
        "",
        "吴烬 opened the door.",
        "`ignored code`",
        "```",
        "ignored block",
        "```",
        "[visible text](https://example.com)"
      ].join("\n")
    );

    assert.equal(result.count, 11);
  });

  test("all write actions produce operation plans", async () => {
    const book = (await controller.listBooks())[0];
    await controller.createVolume(book.id, "番外卷");
    assert.equal(seenPlans.length > 0, true);
    assert.equal(seenPlans[seenPlans.length - 1].summary.includes("新建卷"), true);
  });

  test("shows localized setup actions in the manuscript tree", async () => {
    const emptyWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-empty-tree-"));
    try {
      const emptyTree = new ManuscriptTreeProvider(createWorkspaceFolder(emptyWorkspace));
      const emptyNodes = await emptyTree.getChildren();
      assert.equal(emptyNodes.some((node) => node.kind === "action" && node.title === "初始化项目"), true);

      await fs.mkdir(path.join(emptyWorkspace, ".loredock"));
      await fs.writeFile(path.join(emptyWorkspace, ".loredock/project.json"), "{}\n", "utf8");
      const missingManuscriptNodes = await emptyTree.getChildren();
      assert.equal(missingManuscriptNodes.some((node) => node.kind === "action" && node.title === "启用手稿"), true);

      await fs.mkdir(path.join(workspace, ".loredock"));
      await fs.writeFile(path.join(workspace, ".loredock/project.json"), "{}\n", "utf8");
      const activeTree = new ManuscriptTreeProvider(workspaceFolder);
      const activeNodes = await activeTree.getChildren();
      assert.equal(activeNodes.some((node) => node.kind === "notes" && node.title === "笔记"), true);

      const chapter = (await controller.listChapters())[0];
      await controller.deleteChapter(chapter.id);
      activeTree.toggleTrashMode();
      const trashNodes = await activeTree.getChildren();
      assert.equal(trashNodes.some((node) => node.kind === "trashItem" && node.title === chapter.title), true);
    } finally {
      await fs.rm(emptyWorkspace, { recursive: true, force: true });
    }
  });
});

async function writeInitialManuscript(workspace: string): Promise<void> {
  const manifest = createInitialManuscriptManifest(new Date("2026-06-29T00:00:00.000Z"));
  const book = manifest.books[manifest.bookIds[0] as BookId];
  const volume = manifest.volumes[book.volumeIds[0] as VolumeId];
  const chapter = manifest.chapters[volume.chapterIds[0]];

  await fs.mkdir(path.join(workspace, volume.path), { recursive: true });
  await fs.writeFile(path.join(workspace, MANUSCRIPT_MANIFEST_PATH), stringifyManuscriptManifest(manifest), "utf8");
  await fs.writeFile(path.join(workspace, "manuscript/notes.md"), "# Notes\n\n", "utf8");
  await fs.writeFile(path.join(workspace, bookAgentPath(book.path)), createBookAgentText(book.title, book.path), "utf8");
  await fs.writeFile(path.join(workspace, chapter.path), "# 第一章\n\n正文 starts here.\n", "utf8");
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

function createWorkspaceFolder(workspacePath: string): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.file(workspacePath),
    name: path.basename(workspacePath),
    index: 0
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
