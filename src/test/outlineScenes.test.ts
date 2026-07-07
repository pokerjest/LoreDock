import assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { bookAgentPath, bookSystemAgentPath, createBookAgentText, createBookSystemAgentText } from "../capabilities/manuscript/bookAgent";
import { ManuscriptController } from "../capabilities/manuscript/controller";
import { createInitialManuscriptManifest, stringifyManuscriptManifest } from "../capabilities/manuscript/manifest";
import { MANUSCRIPT_MANIFEST_PATH, type ManuscriptService } from "../capabilities/manuscript/types";
import { OutlineSceneController } from "../capabilities/outlineScenes/controller";
import { parseSceneText } from "../capabilities/outlineScenes/files";
import { parseOutlineMarkdown, resolveOutlineMarkdown } from "../capabilities/outlineScenes/outlineParser";
import { OutlineScenesTreeProvider, type OutlineScenesTreeNode } from "../capabilities/outlineScenes/tree";
import { OUTLINE_SCENES_CAPABILITY_ID, SCENES_DIR } from "../capabilities/outlineScenes/types";
import { PLOT_GRID_CAPABILITY_ID } from "../capabilities/plotGrid/types";
import { createDefaultManifest } from "../kernel/manifest";
import type { DiagnosticItem, OperationPlan } from "../kernel/types";

suite("Outline Scenes", function () {
  this.timeout(10000);

  let workspace: string;
  let workspaceFolder: vscode.WorkspaceFolder;
  let seenPlans: OperationPlan[];
  let destructivePrompts: string[];
  let confirmResult: boolean;
  let destructiveConfirmResult: boolean;
  let diagnostics: DiagnosticItem[];
  let manuscript: ManuscriptController;
  let controller: OutlineSceneController;

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-outline-scenes-"));
    workspaceFolder = createWorkspaceFolder(workspace);
    seenPlans = [];
    destructivePrompts = [];
    confirmResult = true;
    destructiveConfirmResult = true;
    diagnostics = [];
    await writeInitialManuscript(workspace);
    await writeProjectManifest(workspace, ["manuscript.core", OUTLINE_SCENES_CAPABILITY_ID]);
    await fs.mkdir(path.join(workspace, "outlines"), { recursive: true });
    await fs.mkdir(path.join(workspace, SCENES_DIR), { recursive: true });
    manuscript = createManuscriptController();
    controller = createOutlineSceneController();
  });

  teardown(async () => {
    controller.dispose();
    manuscript.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("parses outline headings and beats while skipping frontmatter and fenced code", () => {
    const result = parseOutlineMarkdown(
      workspace,
      "outlines/main.md",
      [
        "---",
        "title: ignored",
        "---",
        "# 第一卷",
        "## 第一章",
        "### 屋顶谈判",
        "- 吴烬试探林凛",
        "```",
        "### not a scene",
        "```",
        "###",
        "- 空标题场景的 beat"
      ].join("\n")
    );

    assert.equal(result.outline.volumes.length, 1);
    assert.equal(result.outline.volumes[0].chapters[0].scenes.length, 2);
    assert.equal(result.outline.volumes[0].chapters[0].scenes[0].beats[0].title, "吴烬试探林凛");
    assert.equal(result.outline.volumes[0].chapters[0].scenes[1].title, "未命名场景");
    assert.equal(result.diagnostics.some((item) => item.code === "outline.heading.empty"), true);
  });

  test("parses scoped outline fragments with relative heading semantics", () => {
    const oldBook = parseOutlineMarkdown(workspace, "outlines/legacy.md", "# 第一卷\n\n## 第一章\n\n### 第一场\n");
    assert.equal(oldBook.outline.scope, "book");
    assert.equal(oldBook.outline.volumes[0].title, "第一卷");

    const volume = parseOutlineMarkdown(workspace, "outlines/volume-frag.md", "@scope 卷\n\n## 第一章\n\n### 第一场\n");
    assert.equal(volume.outline.scope, "volume");
    assert.equal(volume.outline.volumes[0].title, "volume-frag");
    assert.equal(volume.outline.volumes[0].chapters[0].title, "第一章");
    assert.equal(volume.outline.volumes[0].chapters[0].scenes[0].title, "第一场");
    assert.equal(volume.diagnostics.some((item) => item.code === "outline.volume.virtual"), false);

    const chapter = parseOutlineMarkdown(workspace, "outlines/chapter-frag.md", "@scope chapter\n\n# 第一章\n\n## 第一场\n\n### 备注\n- Beat\n");
    assert.equal(chapter.outline.scope, "chapter");
    assert.equal(chapter.outline.volumes[0].chapters[0].title, "第一章");
    assert.equal(chapter.outline.volumes[0].chapters[0].scenes[0].title, "第一场");
    assert.equal(chapter.outline.volumes[0].chapters[0].scenes[0].beats.length, 2);

    const scene = parseOutlineMarkdown(workspace, "outlines/scene-frag.md", "@scope scene\n\n# 第一场\n\n## 备注\n- Beat\n");
    assert.equal(scene.outline.scope, "scene");
    assert.equal(scene.outline.volumes[0].chapters[0].scenes[0].title, "第一场");
    assert.deepEqual(scene.outline.volumes[0].chapters[0].scenes[0].beats.map((beat) => beat.title), ["Beat"]);
  });

  test("resolves outline includes and reports invalid include branches", async () => {
    await fs.writeFile(path.join(workspace, "outlines/book.md"), "@scope book\n@include ./volume.md\n@include ./missing.md\n", "utf8");
    await fs.writeFile(path.join(workspace, "outlines/volume.md"), "@scope volume\n# 第二卷\n\n## 第二章\n\n### 门口交锋\n", "utf8");

    const resolved = await resolveOutlineMarkdown(workspace, "outlines/book.md");
    assert.equal(resolved.outline.includes.find((item) => item.rawPath === "./volume.md")?.status, "resolved");
    assert.equal(resolved.outline.includes.find((item) => item.rawPath === "./missing.md")?.status, "missing");
    assert.equal(resolved.outline.volumes.some((volume) => volume.title === "第二卷"), true);
    assert.equal(resolved.diagnostics.some((item) => item.code === "outline.include.missing"), true);

    await fs.writeFile(path.join(workspace, "outlines/cycle-a.md"), "@scope book\n@include ./cycle-b.md\n", "utf8");
    await fs.writeFile(path.join(workspace, "outlines/cycle-b.md"), "@scope volume\n@include ./cycle-a.md\n# 循环卷\n", "utf8");
    const cycle = await resolveOutlineMarkdown(workspace, "outlines/cycle-a.md");
    assert.equal(cycle.diagnostics.some((item) => item.code === "outline.include.cycle"), true);

    const invalid = parseOutlineMarkdown(workspace, "outlines/bad.md", "# 标题\n@scope scene\n@include ../escape.md\n");
    assert.equal(invalid.diagnostics.some((item) => item.code === "outline.directive.misplaced"), true);
    const unsafe = parseOutlineMarkdown(workspace, "outlines/unsafe.md", "@scope book\n@include ../escape.md\n");
    assert.equal(unsafe.outline.includes[0].status, "unsafe");
    assert.equal(unsafe.diagnostics.some((item) => item.code === "outline.include.unsafe"), true);

    const absolute = parseOutlineMarkdown(workspace, "outlines/absolute.md", `@scope book\n@include ${path.join(workspace, "outlines/volume.md")}\n`);
    assert.equal(absolute.outline.includes[0].status, "unsafe");

    await fs.writeFile(path.join(workspace, "outlines/backslash.md"), "@scope book\n@include .\\volume.md\n", "utf8");
    const backslash = await resolveOutlineMarkdown(workspace, "outlines/backslash.md");
    assert.equal(backslash.outline.includes[0].status, "resolved");

    try {
      await fs.symlink(path.join(workspace, "manuscript/notes.md"), path.join(workspace, "outlines/linked.md"));
      await fs.writeFile(path.join(workspace, "outlines/symlink.md"), "@scope book\n@include ./linked.md\n", "utf8");
      const symlink = await resolveOutlineMarkdown(workspace, "outlines/symlink.md");
      assert.equal(symlink.outline.includes[0].status, "unsafe");
      assert.equal(symlink.diagnostics.some((item) => item.code === "outline.include.unsafe"), true);
    } catch (error) {
      if (!isSymlinkPermissionError(error)) {
        throw error;
      }
    }
  });

  test("creates guided outline templates and deletes outline drafts", async () => {
    await controller.createOutlineTemplate("main");

    const outlinePath = path.join(workspace, "outlines/main.md");
    const text = await fs.readFile(outlinePath, "utf8");
    assert.match(text, /规划草稿写法/);
    assert.match(text, /预览导入大纲到结构骨架/);

    const parsed = parseOutlineMarkdown(workspace, "outlines/main.md", text);
    assert.equal(parsed.outline.volumes.length, 1);
    assert.equal(parsed.outline.volumes[0].chapters.length, 2);
    assert.equal(parsed.outline.volumes[0].chapters[0].scenes.length, 1);
    assert.equal(parsed.outline.volumes[0].chapters[0].scenes[0].beats.length, 3);

    await controller.deleteOutline("outlines/main.md");

    assert.equal(await exists(outlinePath), false);
    assert.equal(seenPlans.some((plan) => plan.summary.includes("删除规划草稿") && plan.filesToDelete?.includes("outlines/main.md")), true);
  });

  test("creates scene cards and preserves unknown frontmatter on metadata update", async () => {
    const chapter = (await manuscript.listChapters())[0];

    await controller.createSceneCard({
      title: "屋顶谈判",
      chapterId: chapter.id,
      characterRefs: ["character/wu-jin"],
      locationRefs: ["location/black-tower"]
    });

    let scene = (await controller.listScenes())[0];
    assert.equal(scene.title, "屋顶谈判");
    assert.equal(scene.order, 1);
    assert.deepEqual(scene.chapterRefs, [chapter.id]);
    assert.match(await fs.readFile(path.join(workspace, scene.path), "utf8"), /chapterRefs:/);
    assert.match(await fs.readFile(path.join(workspace, scene.path), "utf8"), /order: 1/);

    await fs.writeFile(
      path.join(workspace, scene.path),
      (await fs.readFile(path.join(workspace, scene.path), "utf8")).replace("updatedAt:", "futureField: keep-me\nupdatedAt:"),
      "utf8"
    );
    await controller.updateSceneMetadata(scene.id, { conflict: "必须决定是否暴露能力。" });

    scene = (await controller.listScenes())[0];
    const text = await fs.readFile(path.join(workspace, scene.path), "utf8");
    assert.equal(scene.conflict, "必须决定是否暴露能力。");
    assert.match(text, /futureField: keep-me/);
  });

  test("deletes, restores, and permanently deletes scene cards through outline scenes trash", async () => {
    const chapter = (await manuscript.listChapters())[0];
    await controller.createSceneCard({ title: "黑塔追逃", chapterId: chapter.id });
    const scene = (await controller.listScenes())[0];

    await controller.deleteSceneCard(scene.id);
    let trashItem = (await controller.listTrashItems())[0];
    assert.equal((await controller.listScenes()).length, 0);
    assert.equal(await exists(path.join(workspace, scene.path)), false);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath, path.basename(scene.path))), true);

    await controller.restoreTrashItem(trashItem.id);
    assert.equal((await controller.listScenes()).length, 1);
    assert.equal(await exists(path.join(workspace, scene.path)), true);

    await controller.deleteSceneCard(scene.id);
    trashItem = (await controller.listTrashItems())[0];
    await controller.permanentlyDeleteTrashItem(trashItem.id);
    assert.equal(destructivePrompts.length, 1);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath)), false);
  });

  test("imports an outline with one preview and skips repeated source scenes", async () => {
    await fs.writeFile(
      path.join(workspace, "outlines/main.md"),
      ["# 第一卷", "", "## 第一章", "", "### 屋顶谈判", "", "- 吴烬试探林凛", ""].join("\n"),
      "utf8"
    );

    const result = await controller.importOutline("outlines/main.md");
    const scenes = await controller.listScenes();
    const chapters = await manuscript.listChapters();

    assert.equal(result.applied, true);
    assert.equal(seenPlans.length, 1);
    assert.equal(seenPlans[0].filesToModify.includes(MANUSCRIPT_MANIFEST_PATH), true);
    assert.equal(seenPlans[0].filesToCreate.some((file) => file.startsWith("scenes/scene-")), true);
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0].sourceOutline, "outlines/main.md");
    assert.equal(chapters.some((chapter) => chapter.title === "第一章" && chapter.status === "outline"), true);

    seenPlans = [];
    const repeated = await controller.importOutline("outlines/main.md");
    assert.equal(repeated.applied, false);
    assert.equal(seenPlans.length, 0);
    assert.equal((await controller.listScenes()).length, 1);
  });

  test("imports scoped fragments by reusing selected manuscript parents", async () => {
    const volume = (await manuscript.listVolumes())[0];
    const firstChapter = (await manuscript.listChapters())[0];
    await fs.writeFile(
      path.join(workspace, "outlines/volume-frag.md"),
      ["@scope volume", "", "## 第二章", "", "### 门口交锋", "", "- 误会升级", ""].join("\n"),
      "utf8"
    );

    await controller.importOutline("outlines/volume-frag.md", {
      target: { volumeId: volume.id, volumeTitle: volume.title }
    });
    let volumes = await manuscript.listVolumes();
    let chapters = await manuscript.listChapters();
    let scenes = await controller.listScenes();

    assert.equal(volumes.length, 1);
    assert.equal(chapters.some((chapter) => chapter.title === "第二章"), true);
    assert.equal(scenes.some((scene) => scene.title === "门口交锋"), true);
    assert.equal(seenPlans[0].fileContentPreviews?.[0].content.includes("复用卷：第一卷"), true);

    seenPlans = [];
    await fs.writeFile(
      path.join(workspace, "outlines/scene-frag.md"),
      ["@scope scene", "", "# 屋顶谈判", "", "## 备注", "", "- 吴烬试探林凛", ""].join("\n"),
      "utf8"
    );
    await controller.importOutline("outlines/scene-frag.md", {
      target: { chapterId: firstChapter.id, chapterTitle: firstChapter.title }
    });
    volumes = await manuscript.listVolumes();
    chapters = await manuscript.listChapters();
    scenes = await controller.listScenes();
    const scene = scenes.find((item) => item.title === "屋顶谈判")!;

    assert.equal(volumes.length, 1);
    assert.equal(chapters.filter((chapter) => chapter.title === firstChapter.title).length, 1);
    assert.deepEqual(scene.chapterRefs, [firstChapter.id]);
    assert.equal(seenPlans[0].fileContentPreviews?.[0].content.includes("复用章节：第一章"), true);
  });

  test("cancels outline import without writing manuscript or scene files", async () => {
    confirmResult = false;
    await fs.writeFile(path.join(workspace, "outlines/main.md"), "# 第一卷\n\n## 第一章\n\n### 场景\n", "utf8");

    const beforeChapters = await manuscript.listChapters();
    const result = await controller.importOutline("outlines/main.md");

    assert.equal(result.applied, false);
    assert.equal((await manuscript.listChapters()).length, beforeChapters.length);
    assert.equal((await controller.listScenes()).length, 0);
  });

  test("builds skeleton and scene projection from manuscript chapters and scene cards", async () => {
    const chapter = (await manuscript.listChapters())[0];
    const volume = (await manuscript.listVolumes())[0];
    await manuscript.createChapter(volume.id, "第二章");
    const secondChapter = (await manuscript.listChapters()).find((item) => item.title === "第二章")!;
    await controller.createSceneCard({ title: "第二场", chapterId: chapter.id, order: 2 });
    await controller.createSceneCard({ title: "第一场", chapterId: chapter.id, order: 1 });
    await controller.createSceneCard({ title: "跨章余波", chapterRefs: [chapter.id, secondChapter.id], order: 3 });

    const skeleton = await controller.getStructureSkeleton();
    const projection = await controller.getSceneProjection();

    assert.equal(skeleton.volumes[0].chapters[0].scenes[0].title, "第一场");
    assert.equal(skeleton.volumes[0].chapters[0].scenes[1].title, "第二场");
    assert.equal(projection.chapters[0].scenes.length, 3);
    assert.equal(projection.chapters[1].scenes.some((scene) => scene.title === "跨章余波"), true);
  });

  test("binds existing scene cards to chapters and can create a chapter before binding", async () => {
    const volume = (await manuscript.listVolumes())[0];
    const firstChapter = (await manuscript.listChapters())[0];
    await manuscript.createChapter(volume.id, "第二章");
    const secondChapter = (await manuscript.listChapters()).find((chapter) => chapter.title === "第二章")!;

    await controller.createSceneCard({ title: "未绑定线索", chapterRefs: [] });
    await controller.createSceneCard({ title: "第一章线索", chapterRefs: [firstChapter.id] });
    const scenes = await controller.listScenes();
    const unboundScene = scenes.find((scene) => scene.title === "未绑定线索")!;
    const firstScene = scenes.find((scene) => scene.title === "第一章线索")!;

    await controller.bindScenesToChapter([unboundScene.id], secondChapter.id);
    assert.deepEqual((await controller.getScene(unboundScene.id))?.chapterRefs, [secondChapter.id]);

    await controller.bindSceneToChapters(firstScene.id, [secondChapter.id]);
    assert.deepEqual((await controller.getScene(firstScene.id))?.chapterRefs, [firstChapter.id, secondChapter.id]);

    await controller.createChapterAndBindScene(unboundScene.id, volume.id, "新章节");
    const newChapter = (await manuscript.listChapters()).find((chapter) => chapter.title === "新章节")!;
    assert.equal((await controller.getScene(unboundScene.id))?.chapterRefs.includes(newChapter.id), true);
    assert.equal(seenPlans.some((plan) => plan.summary.includes("新建章节") && plan.filesToModify.some((file) => file.startsWith("scenes/"))), true);
  });

  test("tree provider and package manifest expose outline scenes wiring", async () => {
    const chapter = (await manuscript.listChapters())[0];
    await controller.createSceneCard({ title: "屋顶谈判", chapterId: chapter.id });
    await controller.createSceneCard({ title: "未安排谈话", chapterRefs: [] });
    await fs.writeFile(
      path.join(workspace, "outlines/main.md"),
      ["# 第二卷", "", "## 第二章", "", "### 门口交锋", ""].join("\n"),
      "utf8"
    );

    const tree = new OutlineScenesTreeProvider(workspaceFolder);
    const readerRegistration = tree.registerReaderProvider(workspaceFolder, () => controller);

    try {
      const rootNodes = await tree.getChildren();
      const skeletonGroup = rootNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "group" }> =>
        node.kind === "group" && node.group === "skeleton"
      );
      const scenesGroup = rootNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "group" }> =>
        node.kind === "group" && node.group === "scenes"
      );
      const outlinesGroup = rootNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "group" }> =>
        node.kind === "group" && node.group === "outlines"
      );
      const plotGridAction = rootNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "action" }> =>
        node.kind === "action" && node.command === "loredock.enablePlotGrid"
      );

      assert.ok(skeletonGroup);
      assert.ok(plotGridAction);
      assert.equal(plotGridAction.title, "启用剧情矩阵");
      assert.equal(tree.getTreeItem(plotGridAction).command?.command, "loredock.enablePlotGrid");
      assert.equal(rootNodes.some((node) => node.kind === "group" && node.title === "未落地规划"), false);
      assert.equal(tree.getTreeItem(skeletonGroup).description, "已落地");
      const skeletonNodes = await tree.getChildren(skeletonGroup);
      assert.equal(skeletonNodes.some((node) => node.kind === "volume" && node.volume.title === "第一卷"), true);
      assert.equal(skeletonNodes.some((node) => node.kind === "empty" && node.title === "暂无场景卡"), false);

      const volumeNode = skeletonNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "volume" }> =>
        node.kind === "volume"
      );
      assert.ok(volumeNode);
      assert.ok(volumeNode.id);
      const chapterNodes = await tree.getChildren(volumeNode);
      assert.equal(chapterNodes.some((node) => node.kind === "chapter" && node.title === "第一章"), true);
      const chapterNode = chapterNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "chapter" }> =>
        node.kind === "chapter"
      );
      assert.ok(chapterNode);
      assert.equal(chapterNode.id, chapterNode.chapterId);
      const chapterSceneNodes = await tree.getChildren(chapterNode);
      const chapterSceneNode = chapterSceneNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "scene" }> =>
        node.kind === "scene" && node.title === "屋顶谈判"
      );
      assert.ok(chapterSceneNode);
      const chapterSceneTreeItem = tree.getTreeItem(chapterSceneNode);
      assert.equal(chapterSceneTreeItem.command?.command, "loredock.plotGrid.open");
      assert.deepEqual(chapterSceneTreeItem.command?.arguments, [{ workspaceFolder, sceneId: chapterSceneNode.id }]);

      assert.ok(scenesGroup);
      const sceneNodes = await tree.getChildren(scenesGroup);
      const unboundSceneNode = sceneNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "scene" }> =>
        node.kind === "scene" && node.title === "未安排谈话"
      );
      assert.ok(unboundSceneNode);
      assert.equal(String(tree.getTreeItem(unboundSceneNode).description).includes("未绑定章节"), true);
      assert.equal(sceneNodes.some((node) => node.kind === "scene" && node.title === "屋顶谈判"), false);

      assert.ok(outlinesGroup);
      assert.equal(tree.getTreeItem(outlinesGroup).description, "导入源");
      const outlineNodes = await tree.getChildren(outlinesGroup);
      const outlineNode = outlineNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "outline" }> =>
        node.kind === "outline" && node.title === "main"
      );
      assert.ok(outlineNode);
      assert.equal(String(tree.getTreeItem(outlineNode).description), "书籍大纲 · 1 卷 1 章 1 场");
      assert.equal(tree.getTreeItem(outlineNode).command?.command, "vscode.open");
      const outlineChildren = await tree.getChildren(outlineNode);
      assert.equal(outlineChildren.length, 0);

      await writeProjectManifest(workspace, ["manuscript.core", OUTLINE_SCENES_CAPABILITY_ID, PLOT_GRID_CAPABILITY_ID]);
      const plotGridEnabledNodes = await tree.getChildren();
      const openPlotGridAction = plotGridEnabledNodes.find((node): node is Extract<OutlineScenesTreeNode, { kind: "action" }> =>
        node.kind === "action" && node.command === "loredock.plotGrid.open"
      );
      assert.ok(openPlotGridAction);
      assert.equal(openPlotGridAction.title, "打开剧情矩阵");
      assert.equal(tree.getTreeItem(openPlotGridAction).command?.command, "loredock.plotGrid.open");
    } finally {
      readerRegistration.dispose();
    }

    const packageJson = JSON.parse(await fs.readFile(path.join(__dirname, "../../package.json"), "utf8"));
    const activationEvents = packageJson.activationEvents as string[];
    const outlineTitleCommands = packageJson.contributes.menus["view/title"]
      .filter((item: { command: string; when?: string }) => item.when?.includes("loredock.outlineScenes.tree"))
      .map((item: { command: string }) => item.command);
    const outlineItemCommands = packageJson.contributes.menus["view/item/context"]
      .filter((item: { command: string; when?: string }) => item.when?.includes("loredock.outlineScenes.tree"))
      .map((item: { command: string; when?: string }) => item);
    const createOutlineCommand = packageJson.contributes.commands.find((command: { command: string }) =>
      command.command === "loredock.outlineScenes.createOutline"
    );
    const importOutlineCommand = packageJson.contributes.commands.find((command: { command: string }) =>
      command.command === "loredock.outlineScenes.importOutline"
    );
    const deleteOutlineCommand = packageJson.contributes.commands.find((command: { command: string }) =>
      command.command === "loredock.outlineScenes.deleteOutline"
    );
    const createSceneFromChapterCommand = packageJson.contributes.commands.find((command: { command: string }) =>
      command.command === "loredock.outlineScenes.createSceneCardFromChapter"
    );
    const bindScenesToChapterCommand = packageJson.contributes.commands.find((command: { command: string }) =>
      command.command === "loredock.outlineScenes.bindScenesToChapter"
    );

    assert.equal(packageJson.version, "0.4.0");
    assert.equal(packageJson.contributes.views.loredock.some((view: { id: string }) => view.id === "loredock.outlineScenes.tree"), true);
    assert.equal(packageJson.contributes.commands.some((command: { command: string }) => command.command === "loredock.enableOutlineScenes"), true);
    for (const command of [
      "loredock.outlineScenes.createOutline",
      "loredock.outlineScenes.importOutline",
      "loredock.outlineScenes.createSceneCardFromChapter",
      "loredock.outlineScenes.openSceneCard",
      "loredock.outlineScenes.editSceneMetadata",
      "loredock.outlineScenes.deleteSceneCard",
      "loredock.outlineScenes.restoreTrashItem",
      "loredock.outlineScenes.permanentlyDeleteTrashItem",
      "loredock.outlineScenes.refreshTree",
      "loredock.outlineScenes.toggleTrash"
    ]) {
      assert.equal(activationEvents.includes(`onCommand:${command}`), true);
    }
    assert.equal(createOutlineCommand?.icon, "$(new-file)");
    assert.equal(createOutlineCommand?.title, "LoreDock：新建规划草稿");
    assert.equal(importOutlineCommand?.title, "LoreDock：预览导入大纲到结构骨架");
    assert.equal(deleteOutlineCommand?.title, "LoreDock：删除规划草稿");
    assert.equal(createSceneFromChapterCommand?.title, "LoreDock：新建场景卡并绑定此章节");
    assert.equal(bindScenesToChapterCommand?.title, "LoreDock：绑定已有场景卡到此章节");
    assert.equal(outlineTitleCommands.includes("loredock.outlineScenes.createOutline"), true);
    assert.equal(outlineTitleCommands.includes("loredock.outlineScenes.createSceneCard"), false);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string }) =>
      item.command === "loredock.outlineScenes.createOutline" &&
      item.when?.includes("viewItem == loredock.outlineScenes.group.outlines")
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string; group?: string }) =>
      item.command === "loredock.outlineScenes.deleteOutline" &&
      item.when?.includes("viewItem == loredock.outlineScenes.outline") &&
      item.group === "inline@1"
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string }) =>
      item.command === "loredock.outlineScenes.createSceneCard" &&
      item.when?.includes("viewItem == loredock.outlineScenes.group.scenes")
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string; group?: string }) =>
      item.command === "loredock.manuscript.createChapter" &&
      item.when?.includes("viewItem == loredock.outlineScenes.volume") &&
      item.group === "inline"
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string }) =>
      item.command === "loredock.manuscript.deleteVolume" &&
      item.when?.includes("viewItem == loredock.outlineScenes.volume")
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string; group?: string }) =>
      item.command === "loredock.outlineScenes.bindScenesToChapter" &&
      item.when?.includes("viewItem == loredock.outlineScenes.chapter") &&
      item.group === "inline@2"
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string; group?: string }) =>
      item.command === "loredock.manuscript.openChapter" &&
      item.when?.includes("viewItem == loredock.outlineScenes.chapter") &&
      item.group === "inline@1"
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string }) =>
      item.command === "loredock.manuscript.deleteChapter" &&
      item.when?.includes("viewItem == loredock.outlineScenes.chapter")
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string; group?: string }) =>
      item.command === "loredock.outlineScenes.createSceneCardFromChapter" &&
      item.when?.includes("viewItem == loredock.outlineScenes.chapter") &&
      item.group === "inline"
    ), false);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string }) =>
      item.command === "loredock.outlineScenes.bindSceneToChapters" &&
      item.when?.includes("viewItem == loredock.outlineScenes.scene")
    ), true);
    assert.equal(outlineItemCommands.some((item: { command: string; when?: string }) =>
      item.command === "loredock.outlineScenes.createChapterAndBindScene" &&
      item.when?.includes("viewItem == loredock.outlineScenes.scene")
    ), true);
  });

  test("parses scene text diagnostics for invalid frontmatter", async () => {
    const result = await parseSceneText(workspace, "scenes/bad.md", "---\nid: \"scene_x\"\n---\n", manuscript.reader);

    assert.equal(result.scene, undefined);
    assert.equal(result.diagnostics.some((item) => item.code === "outlineScenes.scene.title.invalid"), true);

    const invalidRefs = await parseSceneText(
      workspace,
      "scenes/bad-refs.md",
      [
        "---",
        "schemaVersion: \"0.3.0\"",
        "id: \"scene_bad_refs\"",
        "title: \"坏绑定\"",
        "chapterRefs: bad",
        "order: 1",
        "status: \"outline\"",
        "createdAt: \"2026-07-02T00:00:00.000Z\"",
        "updatedAt: \"2026-07-02T00:00:00.000Z\"",
        "---",
        ""
      ].join("\n"),
      manuscript.reader
    );
    assert.equal(invalidRefs.diagnostics.some((item) => item.code === "outlineScenes.scene.chapterRefs.invalid"), true);
  });

  function createManuscriptController(): ManuscriptController {
    return new ManuscriptController({
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
        return confirmResult;
      },
      confirmDestructiveDelete: async (message) => {
        destructivePrompts.push(message);
        return destructiveConfirmResult;
      },
      now: () => new Date("2026-07-02T00:00:00.000Z")
    });
  }

  function createOutlineSceneController(): OutlineSceneController {
    return new OutlineSceneController({
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
        return confirmResult;
      },
      confirmDestructiveDelete: async (message) => {
        destructivePrompts.push(message);
        return destructiveConfirmResult;
      },
      getManuscriptService: () => manuscript as ManuscriptService,
      now: () => new Date("2026-07-02T00:00:00.000Z")
    });
  }
});

async function writeInitialManuscript(workspace: string): Promise<void> {
  const manifest = createInitialManuscriptManifest(new Date("2026-07-02T00:00:00.000Z"));
  const volume = manifest.volumes[manifest.volumeIds[0]];
  const chapter = manifest.chapters[volume.chapterIds[0]];

  await fs.mkdir(path.join(workspace, volume.path), { recursive: true });
  await fs.writeFile(path.join(workspace, MANUSCRIPT_MANIFEST_PATH), stringifyManuscriptManifest(manifest), "utf8");
  await fs.writeFile(path.join(workspace, "manuscript/notes.md"), "# Notes\n\n", "utf8");
  await fs.writeFile(path.join(workspace, bookSystemAgentPath()), createBookSystemAgentText(manifest.book.title), "utf8");
  await fs.writeFile(path.join(workspace, bookAgentPath()), createBookAgentText(manifest.book.title), "utf8");
  await fs.writeFile(path.join(workspace, chapter.path), "# 第一章\n\n", "utf8");
}

async function writeProjectManifest(workspace: string, capabilities: string[]): Promise<void> {
  await fs.mkdir(path.join(workspace, ".loredock"), { recursive: true });
  const manifest = { ...createDefaultManifest(workspace, new Date("2026-07-02T00:00:00.000Z")), capabilities };
  await fs.writeFile(path.join(workspace, ".loredock/project.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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

function isSymlinkPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES")
  );
}
