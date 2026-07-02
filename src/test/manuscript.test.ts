import assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  bookAgentPath,
  bookSystemAgentPath,
  createBookAgentText,
  createBookSystemAgentText
} from "../capabilities/manuscript/bookAgent";
import { ManuscriptController } from "../capabilities/manuscript/controller";
import {
  createInitialManuscriptManifest,
  readManuscriptManifest,
  stringifyManuscriptManifest
} from "../capabilities/manuscript/manifest";
import { ManuscriptTreeProvider } from "../capabilities/manuscript/tree";
import {
  MANUSCRIPT_MANIFEST_PATH,
  MANUSCRIPT_SCHEMA_VERSION,
  type ChapterId,
  type ManuscriptStatus
} from "../capabilities/manuscript/types";
import { countMarkdownWords } from "../capabilities/manuscript/wordCount";
import { createDefaultManifest } from "../kernel/manifest";
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
    workspaceFolder = createWorkspaceFolder(workspace);
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

  test("creates a single-book manifest rooted at the workspace folder", async () => {
    const result = await readManuscriptManifest(workspace);

    assert.equal(result.status, "valid");
    assert.equal(result.status === "valid" ? result.manifest.schemaVersion : undefined, MANUSCRIPT_SCHEMA_VERSION);
    assert.equal(result.status === "valid" ? result.manifest.book.title : undefined, "第一本书");
    assert.equal(result.status === "valid" ? result.manifest.volumeIds.length : undefined, 1);
    assert.equal(await exists(path.join(workspace, "manuscript/volume-001/chapter-001.md")), true);
    assert.equal(await exists(path.join(workspace, "agent.system.md")), true);
    assert.equal(await exists(path.join(workspace, "agent.md")), true);
  });

  test("marks legacy multi-book manifests as degraded", async () => {
    const legacyWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-legacy-manuscript-"));
    try {
      await fs.mkdir(path.join(legacyWorkspace, "manuscript"), { recursive: true });
      await fs.writeFile(
        path.join(legacyWorkspace, MANUSCRIPT_MANIFEST_PATH),
        `${JSON.stringify(
          {
            schemaVersion: "0.1.0",
            bookIds: ["book_legacy"],
            books: {},
            volumes: {},
            chapters: {},
            nextBookNumber: 2,
            createdAt: "2026-06-29T00:00:00.000Z",
            updatedAt: "2026-06-29T00:00:00.000Z",
            trash: { itemIds: [], items: {} }
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const result = await readManuscriptManifest(legacyWorkspace);

      assert.equal(result.status, "degraded");
      assert.equal(
        result.diagnostics.some((item) => item.code === "manuscript.manifest.legacyMultiBook.unsupported"),
        true
      );
    } finally {
      await fs.rm(legacyWorkspace, { recursive: true, force: true });
    }
  });

  test("keeps root agent files valid and explicit for external AI", async () => {
    const systemText = await fs.readFile(path.join(workspace, bookSystemAgentPath()), "utf8");
    const userText = await fs.readFile(path.join(workspace, bookAgentPath()), "utf8");

    assert.match(systemText, /第一本书 系统 Agent 规则（只读）/);
    assert.match(systemText, /一个工作区文件夹只对应一本书/);
    assert.match(systemText, /故事圣经是这本书的字典 \+ 百科全书/);
    assert.match(systemText, /必须创建合法的 `lore\/characters\/\*\.md` 卡片文件/);
    assert.match(systemText, /LoreDock：新建人物/);
    assert.match(systemText, /loredock\.storyBible\.createCharacter/);
    assert.match(systemText, /直接创建人物卡片文件/);
    assert.match(systemText, /id: "story_550e8400-e29b-41d4-a716-446655440000"/);
    assert.match(systemText, /createdAt.*ISO 时间字符串/);
    assert.match(systemText, /故事圣经诊断修复速查/);
    assert.match(userText, /第一本书 用户 Agent 规则（可编辑）/);
    assert.match(userText, /工作区根目录的 `agent\.system\.md`/);

    const result = await readManuscriptManifest(workspace);
    assert.equal(result.diagnostics.some((item) => item.relativePath === bookAgentPath()), false);
    assert.equal(result.diagnostics.some((item) => item.relativePath === bookSystemAgentPath()), false);
    assert.equal(result.diagnostics.some((item) => item.code === "manuscript.orphanMarkdown"), false);
  });

  test("refreshes root agent files while preserving user rules", async () => {
    await fs.rm(path.join(workspace, bookSystemAgentPath()));
    await fs.writeFile(path.join(workspace, bookAgentPath()), combinedLegacyAgentText("- 保留我的协作偏好。"), "utf8");

    const result = await controller.refreshBookAgentGuide();
    const systemText = await fs.readFile(path.join(workspace, bookSystemAgentPath()), "utf8");
    const userText = await fs.readFile(path.join(workspace, bookAgentPath()), "utf8");

    assert.equal(result.applied, true);
    assert.deepEqual(result.plan.filesToCreate, [bookSystemAgentPath()]);
    assert.deepEqual(result.plan.filesToModify, [bookAgentPath()]);
    assert.match(systemText, /工作区根目录 `agent\.md`/);
    assert.match(systemText, /直接创建人物卡片文件/);
    assert.match(userText, /- 保留我的协作偏好。/);
    assert.doesNotMatch(userText, /旧系统规则/);
    assert.doesNotMatch(userText, /LOREDOCK_AGENT_SYSTEM_RULES_START/);
  });

  test("syncs root system agent on startup without overwriting user-only rules", async () => {
    await fs.writeFile(path.join(workspace, bookSystemAgentPath()), "# stale\n", "utf8");
    await fs.writeFile(path.join(workspace, bookAgentPath()), "- 用户自己的规则。\n", "utf8");
    seenPlans = [];

    const result = await controller.syncBookAgentGuides();
    const systemText = await fs.readFile(path.join(workspace, bookSystemAgentPath()), "utf8");
    const userText = await fs.readFile(path.join(workspace, bookAgentPath()), "utf8");

    assert.deepEqual(result.filesCreated, []);
    assert.deepEqual(result.filesModified, [bookSystemAgentPath()]);
    assert.deepEqual(result.filesSkipped, []);
    assert.equal(seenPlans.length, 0);
    assert.match(systemText, /故事圣经是这本书的字典 \+ 百科全书/);
    assert.equal(userText, "- 用户自己的规则。\n");
  });

  test("syncs book and project titles to the workspace folder name on startup", async () => {
    await fs.mkdir(path.join(workspace, ".loredock"), { recursive: true });
    const oldProject = {
      ...createDefaultManifest(workspace, new Date("2026-06-28T00:00:00.000Z")),
      title: "旧书名"
    };
    await fs.writeFile(
      path.join(workspace, ".loredock/project.json"),
      `${JSON.stringify(oldProject, null, 2)}\n`,
      "utf8"
    );
    seenPlans = [];

    const changed = await controller.syncBookTitleWithWorkspaceFolder();
    const manifest = await readManuscriptManifest(workspace);
    const project = JSON.parse(await fs.readFile(path.join(workspace, ".loredock/project.json"), "utf8"));

    assert.equal(changed, true);
    assert.equal(manifest.status === "valid" ? manifest.manifest.book.title : undefined, path.basename(workspace));
    assert.equal(project.title, path.basename(workspace));
    assert.equal(project.updatedAt, "2026-06-29T00:00:00.000Z");
    assert.equal(seenPlans.length, 0);
  });

  test("creates chapters with monotonic filenames after delete", async () => {
    const volume = (await controller.listVolumes())[0];

    await controller.createChapter(volume.id, "第二章");
    const second = (await controller.listChapters(volume.id)).find((chapter) => chapter.title === "第二章");
    assert.equal(second?.path.endsWith("chapter-002.md"), true);

    await controller.deleteChapter(second!.id);
    await controller.createChapter(volume.id, "第三章");
    const third = (await controller.listChapters(volume.id)).find((chapter) => chapter.title === "第三章");
    const trashItem = (await controller.listTrashItems()).find((item) => item.originalPath === second!.path);

    assert.equal(third?.path.endsWith("chapter-003.md"), true);
    assert.equal(await exists(path.join(workspace, volume.path, "chapter-002.md")), false);
    assert.ok(trashItem);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath, "chapter-002.md")), true);
  });

  test("creates volumes at the workspace manuscript root", async () => {
    await controller.createVolume("第二卷");
    const volumes = await controller.listVolumes();
    const created = volumes.find((volume) => volume.title === "第二卷");

    assert.ok(created);
    assert.equal(created.path, "manuscript/volume-002");
    assert.equal(await exists(path.join(workspace, "manuscript/volume-002")), true);
  });

  test("moves chapters across volumes without overwriting filename conflicts", async () => {
    const sourceVolume = (await controller.listVolumes())[0];
    await controller.createVolume("第二卷");
    const targetVolume = (await controller.listVolumes()).find((volume) => volume.title === "第二卷")!;
    await controller.createChapter(targetVolume.id, "目标卷第一章");

    const sourceChapter = (await controller.listChapters(sourceVolume.id))[0];
    await controller.moveChapter(sourceChapter.id, targetVolume.id);

    const moved = await controller.getChapter(sourceChapter.id);
    assert.equal(moved?.volumeId, targetVolume.id);
    assert.equal(moved?.path, `${targetVolume.path}/chapter-002.md`);
    assert.equal(await exists(path.join(workspace, `${targetVolume.path}/chapter-001.md`)), true);
    assert.equal(await exists(path.join(workspace, `${targetVolume.path}/chapter-002.md`)), true);
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
    assert.equal(after[1].id, first.id);
    assert.equal((await controller.getChapter(first.id))?.path, firstPath);
    assert.equal(await exists(path.join(workspace, firstPath)), true);
  });

  test("deletes empty volumes without destructive confirmation", async () => {
    await controller.createVolume("空卷");
    const volume = (await controller.listVolumes()).find((item) => item.title === "空卷")!;
    seenPlans = [];
    destructivePrompts = [];

    const result = await controller.deleteVolume(volume.id);

    assert.equal(result.applied, true);
    assert.equal((await controller.listVolumes()).some((item) => item.id === volume.id), false);
    assert.equal(destructivePrompts.length, 0);
    assert.equal(seenPlans[0].summary.includes("移入回收站"), true);
    assert.equal((await controller.listTrashItems()).some((item) => item.originalPath === volume.path), true);
  });

  test("moves non-empty volumes to trash with confirmation and supports permanent delete", async () => {
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
    assert.equal(await controller.getChapter(chapter.id), undefined);
    assert.equal(await exists(path.join(workspace, trashItem!.trashPath, path.basename(volume.path), "research", "note.md")), true);

    const permanentResult = await controller.permanentlyDeleteTrashItem(trashItem!.id);
    assert.equal(permanentResult.applied, true);
    assert.equal(await exists(path.join(workspace, trashItem!.trashPath)), false);
  });

  test("restores deleted volumes and chapters from trash", async () => {
    const volume = (await controller.listVolumes())[0];
    const chapter = (await controller.listChapters(volume.id))[0];

    await controller.deleteVolume(volume.id);
    const volumeTrashItem = (await controller.listTrashItems()).find((item) => item.originalPath === volume.path)!;
    await controller.restoreTrashItem(volumeTrashItem.id);

    assert.equal((await controller.listVolumes()).some((item) => item.id === volume.id), true);
    assert.equal((await controller.getChapter(chapter.id))?.path, chapter.path);
    assert.equal(await exists(path.join(workspace, chapter.path)), true);

    await controller.deleteChapter(chapter.id);
    const chapterTrashItem = (await controller.listTrashItems()).find((item) => item.originalPath === chapter.path)!;
    await controller.restoreTrashItem(chapterTrashItem.id);

    assert.equal((await controller.getChapter(chapter.id))?.path, chapter.path);
    assert.equal(await exists(path.join(workspace, chapter.path)), true);
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

  test("sets and clears target word count and rejects bad statuses", async () => {
    const chapter = (await controller.listChapters())[0];

    await controller.setChapterTargetWordCount(chapter.id, 3000);
    assert.equal((await controller.getChapter(chapter.id))?.targetWordCount, 3000);

    await controller.setChapterTargetWordCount(chapter.id, undefined);
    assert.equal((await controller.getChapter(chapter.id))?.targetWordCount, undefined);

    await assert.rejects(() => controller.setChapterStatus(chapter.id, "broken" as ManuscriptStatus), /不受支持/);
    assert.equal((await controller.getChapter(chapter.id))?.status, "draft");
  });

  test("validates damaged manifest, orphan files, and damaged root agents", async () => {
    let result = await readManuscriptManifest(workspace);
    assert.equal(result.status, "valid");

    await fs.writeFile(path.join(workspace, "manuscript/orphan.md"), "orphan", "utf8");
    result = await readManuscriptManifest(workspace);
    assert.equal(result.diagnostics.some((item) => item.code === "manuscript.orphanMarkdown"), true);

    const manifest = JSON.parse(await fs.readFile(path.join(workspace, MANUSCRIPT_MANIFEST_PATH), "utf8"));
    manifest.chapters[Object.keys(manifest.chapters)[0]].targetWordCount = 0;
    await fs.writeFile(path.join(workspace, MANUSCRIPT_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    result = await readManuscriptManifest(workspace);
    assert.equal(result.status, "degraded");
    assert.equal(result.diagnostics.some((item) => item.code === "manuscript.chapter.targetWordCount.invalid"), true);

    await writeInitialManuscript(workspace);
    await fs.writeFile(path.join(workspace, bookSystemAgentPath()), "# Agent\n\n", "utf8");
    result = await readManuscriptManifest(workspace);
    assert.equal(result.status, "valid");
    assert.equal(result.diagnostics.some((item) => item.code === "manuscript.book.agent.system.modified"), true);

    await fs.rm(path.join(workspace, bookAgentPath()));
    result = await readManuscriptManifest(workspace);
    assert.equal(result.diagnostics.some((item) => item.code === "manuscript.book.agent.user.missing"), true);
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
    await controller.createVolume("番外卷");
    assert.equal(seenPlans.length > 0, true);
    assert.equal(seenPlans[seenPlans.length - 1].summary.includes("新建卷"), true);
  });

  test("shows localized setup actions and the single current book in the manuscript tree", async () => {
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
      assert.equal(activeNodes.some((node) => node.kind === "book" && node.title === "第一本书"), true);
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
  const volume = manifest.volumes[manifest.volumeIds[0]];
  const chapter = manifest.chapters[volume.chapterIds[0]];

  await fs.mkdir(path.join(workspace, volume.path), { recursive: true });
  await fs.writeFile(path.join(workspace, MANUSCRIPT_MANIFEST_PATH), stringifyManuscriptManifest(manifest), "utf8");
  await fs.writeFile(path.join(workspace, "manuscript/notes.md"), "# Notes\n\n", "utf8");
  await fs.writeFile(path.join(workspace, bookSystemAgentPath()), createBookSystemAgentText(manifest.book.title), "utf8");
  await fs.writeFile(path.join(workspace, bookAgentPath()), createBookAgentText(manifest.book.title), "utf8");
  await fs.writeFile(path.join(workspace, chapter.path), "# 第一章\n\n正文 starts here.\n", "utf8");
}

function combinedLegacyAgentText(userRule: string): string {
  return [
    "# 旧 AI Agent 使用说明",
    "",
    "<!-- LOREDOCK_AGENT_SYSTEM_RULES_START -->",
    "",
    "## 系统规则（只读）",
    "",
    "- 旧系统规则。",
    "",
    "<!-- LOREDOCK_AGENT_SYSTEM_RULES_END -->",
    "",
    "<!-- LOREDOCK_AGENT_USER_RULES_START -->",
    "",
    "## 用户自定义规则（可编辑）",
    "",
    userRule,
    "",
    "<!-- LOREDOCK_AGENT_USER_RULES_END -->",
    ""
  ].join("\n");
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
