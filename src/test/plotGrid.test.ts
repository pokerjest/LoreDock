import assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { createInitialManuscriptManifest, stringifyManuscriptManifest } from "../capabilities/manuscript/manifest";
import { ManuscriptController } from "../capabilities/manuscript/controller";
import { bookAgentPath, bookSystemAgentPath, createBookAgentText, createBookSystemAgentText } from "../capabilities/manuscript/bookAgent";
import { MANUSCRIPT_CAPABILITY_ID, MANUSCRIPT_MANIFEST_PATH, type ManuscriptService } from "../capabilities/manuscript/types";
import { OutlineSceneController } from "../capabilities/outlineScenes/controller";
import { OUTLINE_SCENES_CAPABILITY_ID, type OutlineSceneService } from "../capabilities/outlineScenes/types";
import { PlotGridController } from "../capabilities/plotGrid/controller";
import { buildPlotGridHtml } from "../capabilities/plotGrid/plotGridWebview";
import { PLOT_GRID_CAPABILITY_ID, PLOT_GRID_CONFIG_PATH, type PlotGridService } from "../capabilities/plotGrid/types";
import { StoryBibleController } from "../capabilities/storyBible/controller";
import { STORY_BIBLE_CAPABILITY_ID, type StoryBibleService } from "../capabilities/storyBible/types";
import { createDefaultManifest } from "../kernel/manifest";
import type { DiagnosticItem, OperationPlan } from "../kernel/types";

suite("Plot Grid", function () {
  this.timeout(10000);

  let workspace: string;
  let workspaceFolder: vscode.WorkspaceFolder;
  let seenPlans: OperationPlan[];
  let destructivePrompts: string[];
  let confirmResult: boolean;
  let destructiveConfirmResult: boolean;
  let diagnostics: DiagnosticItem[];
  let manuscript: ManuscriptController;
  let storyBible: StoryBibleController;
  let outlineScenes: OutlineSceneController;
  let plotGrid: PlotGridController;

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-plot-grid-"));
    workspaceFolder = createWorkspaceFolder(workspace);
    seenPlans = [];
    destructivePrompts = [];
    confirmResult = true;
    destructiveConfirmResult = true;
    diagnostics = [];
    await writeInitialManuscript(workspace);
    await writeProjectManifest(workspace, [MANUSCRIPT_CAPABILITY_ID, STORY_BIBLE_CAPABILITY_ID, OUTLINE_SCENES_CAPABILITY_ID, PLOT_GRID_CAPABILITY_ID]);
    await fs.mkdir(path.join(workspace, "outlines"), { recursive: true });
    await fs.mkdir(path.join(workspace, "scenes"), { recursive: true });
    manuscript = createManuscriptController();
    storyBible = createStoryBibleController();
    outlineScenes = createOutlineSceneController();
    plotGrid = createPlotGridController();
  });

  teardown(async () => {
    plotGrid.dispose();
    outlineScenes.dispose();
    storyBible.dispose();
    manuscript.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("creates config, diagnoses invalid config, and preserves unknown fields", async () => {
    assert.equal((await plotGrid.getConfig()).tracks.length, 0);

    await plotGrid.enablePlotGrid();
    assert.equal(await exists(path.join(workspace, PLOT_GRID_CONFIG_PATH)), true);
    assert.equal(seenPlans[0].filesToCreate.includes(PLOT_GRID_CONFIG_PATH), true);

    await fs.writeFile(
      path.join(workspace, PLOT_GRID_CONFIG_PATH),
      JSON.stringify({
        schemaVersion: "0.4.0",
        futureTopLevel: "keep",
        tracks: [
          {
            id: "main/revenge",
            label: "旧复仇线",
            color: "#C86464",
            order: 1,
            visible: true,
            futureTrackField: "keep-track"
          }
        ],
        view: {
          rowMode: "scene",
          visibleColumns: ["status", "characters"],
          showEmptyTracks: true,
          compact: true,
          futureViewField: "keep-view"
        },
        updatedAt: "2026-07-02T00:00:00.000Z"
      }, null, 2),
      "utf8"
    );

    await plotGrid.upsertTrack({ id: "main/revenge", label: "复仇主线" });
    const updated = JSON.parse(await fs.readFile(path.join(workspace, PLOT_GRID_CONFIG_PATH), "utf8"));
    assert.equal(updated.futureTopLevel, "keep");
    assert.equal(updated.tracks[0].futureTrackField, "keep-track");
    assert.equal(updated.view.futureViewField, "keep-view");
    assert.equal(updated.tracks[0].label, "复仇主线");

    await fs.writeFile(path.join(workspace, PLOT_GRID_CONFIG_PATH), "{ bad json", "utf8");
    const invalid = await plotGrid.validateConfig();
    assert.equal(invalid.some((item) => item.code === "plotGrid.config.json.invalid"), true);
  });

  test("builds scene and chapter projections with inferred tracks and Story Bible labels", async () => {
    const chapter = (await manuscript.listChapters())[0];
    await storyBible.createCard("character", "Wu Jin", { summary: "黑塔幸存者" });
    await storyBible.createCard("location", "Black Tower");
    const character = (await storyBible.listCards({ type: "character" }))[0];
    const location = (await storyBible.listCards({ type: "location" }))[0];
    const locationPath = path.join(workspace, location.path);
    const locationText = await fs.readFile(locationPath, "utf8");
    await fs.writeFile(
      locationPath,
      locationText.replace("- 所属地域或空间范围：", "- 所属地域或空间范围：黑塔核心区域，所有叛徒都会被审问。"),
      "utf8"
    );
    await fs.writeFile(path.join(workspace, chapter.path), "# 第一章\n\n吴烬进入黑塔。\n", "utf8");

    await plotGrid.upsertTrack({ id: "main/revenge", label: "复仇主线" });
    await plotGrid.upsertTrack({ id: "side/hidden", label: "隐藏线", visible: false });
    await outlineScenes.createSceneCard({
      title: "屋顶谈判",
      chapterId: chapter.id,
      characterRefs: [character.primaryKeyword],
      locationRefs: [location.primaryKeyword],
      plotlineRefs: ["main/revenge", "subplot/trust"],
      conflict: "吴烬必须决定是否暴露能力。",
      turn: "林凛发现他说谎。"
    });
    await outlineScenes.createSceneCard({
      title: "未绑定线索",
      chapterRefs: [],
      plotlineRefs: ["orphan/only"]
    });

    const projection = await plotGrid.getProjection();
    const chapterRow = projection.rows.find((row) => row.type === "chapter" && row.chapterId === chapter.id);
    const sceneRow = projection.rows.find((row) => row.type === "scene" && row.title === "屋顶谈判");
    const inferred = projection.tracks.find((track) => track.id === "subplot/trust");

    assert.ok(chapterRow);
    assert.ok(sceneRow);
    assert.equal(chapterRow.wordCount !== undefined && chapterRow.wordCount > 0, true);
    assert.equal(sceneRow.characterRefs.includes(character.primaryKeyword), true);
    assert.equal(projection.entities[character.primaryKeyword].label, "Wu Jin");
    assert.equal(projection.entities[character.primaryKeyword].summary, "黑塔幸存者");
    assert.equal(projection.entities[character.primaryKeyword].intro, "黑塔幸存者");
    assert.equal(projection.entities[location.primaryKeyword].label, "Black Tower");
    assert.equal(projection.entities[location.primaryKeyword].intro, "黑塔核心区域，所有叛徒都会被审问。");
    assert.equal(inferred?.source, "inferred");
    assert.equal((await plotGrid.listTracks()).some((track) => track.id === "side/hidden" && track.visible === false), true);
    assert.equal(projection.tracks.some((track) => track.id === "side/hidden"), false);
    assert.equal(projection.rows.some((row) => row.title === "未绑定线索"), false);
    assert.equal(projection.tracks.some((track) => track.id === "orphan/only"), false);
    assert.equal(projection.filters.characters.some((item) => item.label === "Wu Jin"), true);

    const sceneTextFiltered = await plotGrid.getProjection({ text: "暴露能力" });
    assert.deepEqual(sceneTextFiltered.rows.map((row) => row.type), ["chapter", "scene"]);
    assert.equal(sceneTextFiltered.rows[0].chapterId, chapter.id);
    assert.equal(sceneTextFiltered.rows[1].title, "屋顶谈判");

    await plotGrid.updateViewPreferences({ rowMode: "chapter" });
    const chapterOnlyProjection = await plotGrid.getProjection();
    assert.equal(chapterOnlyProjection.rows.every((row) => row.type === "chapter"), true);
  });

  test("updates tracks, assigns scene plotlines, and delegates same-chapter reorder", async () => {
    const volume = (await manuscript.listVolumes())[0];
    const firstChapter = (await manuscript.listChapters())[0];
    await manuscript.createChapter(volume.id, "第二章");
    const secondChapter = (await manuscript.listChapters()).find((chapter) => chapter.title === "第二章")!;

    await outlineScenes.createSceneCard({ title: "第一场", chapterId: firstChapter.id, order: 1 });
    await outlineScenes.createSceneCard({ title: "第二场", chapterId: firstChapter.id, order: 2 });
    await outlineScenes.createSceneCard({ title: "异章场景", chapterId: secondChapter.id, order: 1 });
    let scenes = await outlineScenes.listScenes();
    const firstScene = scenes.find((scene) => scene.title === "第一场")!;
    const secondScene = scenes.find((scene) => scene.title === "第二场")!;
    const otherScene = scenes.find((scene) => scene.title === "异章场景")!;

    await plotGrid.upsertTrack({ id: "main/revenge", label: "复仇主线" });
    await plotGrid.assignSceneTrack(firstScene.id, "main/revenge", true);
    assert.equal((await outlineScenes.getScene(firstScene.id))?.plotlineRefs.includes("main/revenge"), true);

    await plotGrid.deleteTrack("main/revenge");
    const projection = await plotGrid.getProjection();
    assert.equal(projection.tracks.find((track) => track.id === "main/revenge")?.source, "inferred");

    await plotGrid.assignSceneTrack(firstScene.id, "main/revenge", false);
    assert.equal((await outlineScenes.getScene(firstScene.id))?.plotlineRefs.includes("main/revenge"), false);

    await plotGrid.reorderChapterScenes(firstChapter.id, [secondScene.id, firstScene.id]);
    scenes = await outlineScenes.listScenes({ chapterId: firstChapter.id });
    assert.deepEqual(scenes.map((scene) => scene.title), ["第二场", "第一场"]);

    await assert.rejects(
      () => plotGrid.reorderChapterScenes(firstChapter.id, [firstScene.id, otherScene.id]),
      /同一章节/
    );
  });

  test("updates scene table fields through plot grid and persists markdown", async () => {
    const chapter = (await manuscript.listChapters())[0];
    await storyBible.createCard("character", "Wu Jin");
    await storyBible.createCard("location", "Black Tower");
    const character = (await storyBible.listCards({ type: "character" }))[0];
    const location = (await storyBible.listCards({ type: "location" }))[0];
    await outlineScenes.createSceneCard({ title: "旧场景", chapterId: chapter.id });
    const scene = (await outlineScenes.listScenes())[0];

    await plotGrid.updateSceneMetadata(scene.id, {
      title: "黑塔谈判",
      status: "draft",
      pov: "吴烬",
      characterRefs: [character.primaryKeyword],
      locationRefs: [location.primaryKeyword],
      conflict: "是否暴露能力",
      turn: "林凛识破谎言",
      outcome: "暂时结盟"
    });

    const updated = await outlineScenes.getScene(scene.id);
    assert.equal(updated?.title, "黑塔谈判");
    assert.equal(updated?.status, "draft");
    assert.deepEqual(updated?.characterRefs, [character.primaryKeyword]);
    assert.deepEqual(updated?.locationRefs, [location.primaryKeyword]);
    assert.equal(updated?.conflict, "是否暴露能力");
    assert.equal(seenPlans.some((plan) => plan.summary.includes("更新场景卡") && plan.filesToModify.includes(scene.path)), true);

    const text = await fs.readFile(path.join(workspace, scene.path), "utf8");
    assert.match(text, /title: "黑塔谈判"/);
    assert.match(text, /status: "draft"/);
    assert.match(text, /characterRefs:/);
    assert.match(text, /locationRefs:/);
    assert.match(text, /conflict: "是否暴露能力"/);
  });

  test("plot grid webview exposes editable scene table fields", () => {
    const html = buildPlotGridHtml({ cspSource: "vscode-test" } as vscode.Webview, "test-nonce");

    assert.match(html, /sceneInput\('title'/);
    assert.match(html, /tagEditor\('characterRefs'/);
    assert.match(html, /tagEditor\('locationRefs'/);
    assert.doesNotMatch(html, /id="rowMode"/);
    assert.match(html, /data-toggle-chapter/);
    assert.match(html, /data-toggle-all-chapters/);
    assert.match(html, /toggleChapter/);
    assert.match(html, /toggleAllChapters/);
    assert.match(html, /visibleRows/);
    assert.match(html, /chapterSceneCounts/);
    assert.match(html, /collapseSnapshot/);
    assert.match(html, /复原到上次展开状态/);
    assert.match(html, /全部收起章节/);
    assert.match(html, /structureHeaderHtml/);
    assert.match(html, /collapse-all/);
    assert.match(html, /tree-toggle/);
    assert.match(html, /--tree-line/);
    assert.match(html, /data-add-tag/);
    assert.match(html, /data-remove-tag/);
    assert.match(html, /data-preview-ref/);
    assert.match(html, /user-select: none/);
    assert.match(html, /user-select: text/);
    assert.match(html, /tbody tr:hover > td\.sticky/);
    assert.match(html, /background: var\(--row-hover\) !important/);
    assert.match(html, /tr\.focus-row \.sticky/);
    assert.match(html, /addTagFromInput/);
    assert.match(html, /saveSceneField\(hidden\)/);
    assert.match(html, /preview-card/);
    assert.match(html, /\.preview-backdrop\[hidden\]/);
    assert.match(html, /showPreview/);
    assert.match(html, /previewRow\('简介'/);
    assert.match(html, /entityTypeLabel/);
    assert.match(html, /scene-structure/);
    assert.match(html, /data-suggest-key/);
    assert.match(html, /suggestionCatalog/);
    assert.match(html, /视角人物/);
    assert.match(html, /pov: '视角'/);
    assert.match(html, /insertValue: value/);
    assert.match(html, /data-suggestion-insert/);
    assert.match(html, /sceneStatusLabel/);
    assert.match(html, /draft: '草稿'/);
    assert.match(html, /outline: '大纲'/);
    assert.match(html, /isObjectKeywordRef/);
    assert.match(html, /suggestionDetail\(option\)/);
    assert.doesNotMatch(html, /\.\.\.characterOptions\.map\(entity => entity\.value\)\.filter\(Boolean\)/);
    assert.match(html, /showSuggestions/);
    assert.match(html, /focusSceneId/);
    assert.match(html, /scrollIntoView/);
    assert.match(html, /updateSceneMetadata/);
  });

  test("package manifest exposes plot grid commands and activation", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(__dirname, "../../package.json"), "utf8"));
    const activationEvents = packageJson.activationEvents as string[];
    const titleCommands = packageJson.contributes.menus["view/title"]
      .filter((item: { command: string; when?: string }) => item.when?.includes("loredock.outlineScenes.tree"))
      .map((item: { command: string }) => item.command);

    assert.equal(packageJson.version, "0.4.0");
    assert.equal(activationEvents.includes("onCommand:loredock.enablePlotGrid"), true);
    assert.equal(activationEvents.includes("onCommand:loredock.plotGrid.open"), true);
    assert.equal(packageJson.contributes.commands.some((command: { command: string }) => command.command === "loredock.enablePlotGrid"), true);
    assert.equal(packageJson.contributes.commands.some((command: { command: string }) => command.command === "loredock.plotGrid.open"), true);
    assert.equal(titleCommands.includes("loredock.enablePlotGrid"), true);
    assert.equal(titleCommands.includes("loredock.plotGrid.open"), true);
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

  function createStoryBibleController(): StoryBibleController {
    return new StoryBibleController({
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
      getManuscriptReader: () => manuscript.reader,
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
      getStoryBibleReader: () => storyBible.reader,
      now: () => new Date("2026-07-02T00:00:00.000Z")
    });
  }

  function createPlotGridController(): PlotGridController {
    return new PlotGridController({
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
      getManuscriptService: () => manuscript as ManuscriptService,
      getOutlineSceneService: () => outlineScenes as OutlineSceneService,
      getStoryBibleService: () => storyBible as StoryBibleService,
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
