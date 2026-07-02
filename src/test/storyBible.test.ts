import assert from "assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { deriveCardDraftFromSelection } from "../capabilities/storyBible/capability";
import { StoryBibleController } from "../capabilities/storyBible/controller";
import { readStoryBible } from "../capabilities/storyBible/files";
import { StoryBibleTreeProvider } from "../capabilities/storyBible/tree";
import {
  LORE_DIR,
  STORY_BIBLE_CAPABILITY_ID,
  STORY_BIBLE_CHARACTER_DIR,
  STORY_BIBLE_LOCATION_DIR,
  STORY_BIBLE_RULE_DIR,
  STORY_BIBLE_TAG_DIR,
  STORY_BIBLE_TRASH_METADATA,
  STORY_BIBLE_TRASH_DIR
} from "../capabilities/storyBible/types";
import type { DiagnosticItem, OperationPlan } from "../kernel/types";

suite("Story Bible", function () {
  this.timeout(10000);

  let workspace: string;
  let workspaceFolder: vscode.WorkspaceFolder;
  let seenPlans: OperationPlan[];
  let destructivePrompts: string[];
  let destructiveConfirmResult: boolean;
  let diagnostics: DiagnosticItem[];
  let controller: StoryBibleController;

  setup(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-story-bible-"));
    workspaceFolder = createWorkspaceFolder(workspace);
    seenPlans = [];
    destructivePrompts = [];
    destructiveConfirmResult = true;
    diagnostics = [];
    await writeStoryBibleDirectories(workspace);
    controller = createController(workspaceFolder, {
      seenPlans,
      destructivePrompts,
      get destructiveConfirmResult() {
        return destructiveConfirmResult;
      },
      diagnostics
    });
  });

  teardown(async () => {
    controller.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("creates character, location, and rule cards with tags[0] primary keywords", async () => {
    await controller.createCard("character", "Wu Jin");
    await controller.createCard("location", "Black Tower");
    await controller.createCard("rule", "Blood Magic");

    const cards = await controller.listCards();
    const character = cards.find((card) => card.type === "character")!;
    const location = cards.find((card) => card.type === "location")!;
    const rule = cards.find((card) => card.type === "rule")!;

    assert.equal(character.tags[0], "character/wu-jin");
    assert.equal(location.tags[0], "location/black-tower");
    assert.equal(rule.tags[0], "rule/blood-magic");
    assert.equal(character.keywordLabels[character.tags[0]], "Wu Jin");
    assert.equal(await exists(path.join(workspace, character.path)), true);
    assert.match((await controller.readCardText(character.id)).text ?? "", /^# Wu Jin\n\n## 角色定位/);
    assert.match((await controller.readCardText(location.id)).text ?? "", /^# Black Tower\n\n## 区域/);
    assert.match((await controller.readCardText(rule.id)).text ?? "", /^# Blood Magic\n\n## 分类/);
  });

  test("previews initial card frontmatter before creating a card", async () => {
    await controller.createCard("character", "Alex");

    const preview = seenPlans[0].fileContentPreviews?.[0];
    assert.equal(preview?.relativePath, "lore/characters/alex.md");
    assert.equal(preview?.title, "初始 frontmatter");
    assert.match(preview?.content ?? "", /^---\nschemaVersion: "0\.2\.0"/);
    assert.match(preview?.content ?? "", /type: "character"/);
    assert.match(preview?.content ?? "", /name: "Alex"/);
    assert.match(preview?.content ?? "", /tags:\n {2}- "character\/alex"/);
    assert.equal(preview?.content.includes("# Alex"), false);
  });

  test("uses deterministic hash fallback for Chinese names while display label remains name", async () => {
    await controller.createCard("character", "吴烬");
    const card = (await controller.listCards())[0];

    assert.match(card.tags[0], /^character\/u-[a-f0-9]{8}$/);
    assert.equal(card.keywordLabels[card.tags[0]], "吴烬");
  });

  test("adds monotonic keyword suffixes on slug conflicts", async () => {
    await controller.createCard("character", "Alex");
    await controller.createCard("character", "Alex");

    const tags = (await controller.listCards()).map((card) => card.tags[0]).sort();
    assert.deepEqual(tags, ["character/alex", "character/alex-2"]);
  });

  test("renames cards with historical object keywords and reuses old keyword when renamed back", async () => {
    await controller.createCard("character", "Alex");
    let card = (await controller.listCards())[0];

    await controller.renameCard(card.id, "Bob");
    card = (await controller.listCards())[0];
    assert.deepEqual(card.tags, ["character/bob", "character/alex"]);

    await controller.renameCard(card.id, "Alex");
    card = (await controller.listCards())[0];
    assert.deepEqual(card.tags, ["character/alex", "character/bob"]);
  });

  test("uses card name labels for historical hashed object keywords", async () => {
    await controller.createCard("character", "吴烬");
    let card = (await controller.listCards())[0];
    const oldPrimaryKeyword = card.primaryKeyword;

    await controller.renameCard(card.id, "烬王");

    card = (await controller.listCards())[0];
    const oldKeyword = (await controller.listKeywords()).find((item) => item.slug === oldPrimaryKeyword)!;
    assert.match(oldPrimaryKeyword, /^character\/u-[a-f0-9]{8}$/);
    assert.deepEqual(card.tags, [card.primaryKeyword, oldPrimaryKeyword]);
    assert.equal(card.keywordLabels[oldPrimaryKeyword], "烬王");
    assert.equal(oldKeyword.label, "烬王");
  });

  test("updates card name and metadata in one editor-style operation", async () => {
    await controller.createCard("character", "Alex");
    const card = (await controller.listCards())[0];

    await controller.updateCardMetadata(card.id, {
      name: "Bob",
      aliases: ["B"],
      tags: [card.primaryKeyword, "theme/rival"],
      summary: "Updated from editor",
      visibility: "spoiler",
      status: "canon"
    });

    const updated = (await controller.listCards())[0];
    assert.equal(updated.name, "Bob");
    assert.equal(updated.aliases[0], "B");
    assert.deepEqual(updated.tags, ["character/bob", "character/alex", "theme/rival"]);
    assert.equal(updated.summary, "Updated from editor");
    assert.equal(updated.visibility, "spoiler");
    assert.equal(updated.status, "canon");
  });

  test("defines ordinary keywords, counts usage, and searches slug label description", async () => {
    await controller.createCard("character", "Alex");
    let card = (await controller.listCards())[0];
    await controller.defineKeyword({
      slug: "theme/revenge",
      label: "复仇",
      description: "drives the revenge arc",
      category: "theme",
      appliesTo: ["character"]
    });
    await controller.updateCardMetadata(card.id, { tags: [card.primaryKeyword, "theme/revenge"] });

    const keyword = (await controller.listKeywords()).find((item) => item.slug === "theme/revenge")!;
    const keywordBody = await controller.readKeywordDefinitionText("theme/revenge");
    assert.equal(keyword.label, "复仇");
    assert.equal(keyword.description, "drives the revenge arc");
    assert.equal(keyword.category, "theme");
    assert.equal(keyword.usageCount, 1);
    assert.equal(keyword.source, "user-defined");
    assert.equal(keywordBody.text, "# 复仇\n\n");

    card = (await controller.searchCards({ text: "revenge arc" }))[0];
    assert.equal(card.name, "Alex");
    assert.equal((await controller.searchCards({ keyword: "theme/revenge" })).length, 1);
  });

  test("allows global cross-type object tags outside tags[0]", async () => {
    await controller.createCard("character", "Alex");
    await controller.createCard("location", "Old Dock");
    const character = (await controller.listCards({ type: "character" }))[0];
    const location = (await controller.listCards({ type: "location" }))[0];

    await controller.updateCardMetadata(character.id, { tags: [character.primaryKeyword, location.primaryKeyword] });

    const updated = (await controller.getCard(character.id))!;
    const result = await readStoryBible(workspace);
    assert.deepEqual(updated.tags, [character.primaryKeyword, location.primaryKeyword]);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.primaryKeyword.missing"), false);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.tag.reservedPrefixMismatch"), false);
  });

  test("deleting keyword definition removes the tag from cards and moves definition to resource trash", async () => {
    await controller.createCard("character", "Alex");
    const card = (await controller.listCards())[0];
    await controller.defineKeyword({ slug: "theme/revenge", label: "复仇" });
    await controller.updateCardMetadata(card.id, { tags: [card.primaryKeyword, "theme/revenge"] });

    await controller.deleteKeywordDefinition("theme/revenge");

    const after = (await controller.listCards())[0];
    const keyword = (await controller.listKeywords()).find((item) => item.slug === "theme/revenge");
    const trashItems = await controller.listTrashItems();

    assert.deepEqual(after.tags, [card.primaryKeyword]);
    assert.equal(keyword, undefined);
    assert.equal(destructivePrompts.length, 1);
    assert.match(destructivePrompts[0], /正在被 1 个条目使用/);
    assert.equal(trashItems[0].resourceType, "keyword-definition");
    assert.equal(await exists(path.join(workspace, STORY_BIBLE_TRASH_DIR)), true);
    assert.equal(await exists(path.join(workspace, ".loredock/trash/manuscript")), false);
  });

  test("deletes, restores, and permanently deletes cards through the Story Bible resource trash", async () => {
    await controller.createCard("character", "Alex");
    const card = (await controller.listCards())[0];
    const originalPath = card.path;

    await controller.deleteCard(card.id);
    let trashItem = (await controller.listTrashItems())[0];
    assert.equal((await controller.listCards()).length, 0);
    assert.equal(await exists(path.join(workspace, originalPath)), false);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath, path.basename(originalPath))), true);

    await controller.restoreTrashItem(trashItem.id);
    assert.equal((await controller.listCards()).length, 1);
    assert.equal(await exists(path.join(workspace, originalPath)), true);

    await controller.deleteCard(card.id);
    trashItem = (await controller.listTrashItems())[0];
    await controller.permanentlyDeleteTrashItem(trashItem.id);
    assert.equal(destructivePrompts.length, 1);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath)), false);
  });

  test("cancels permanent delete after second dangerous confirmation", async () => {
    await controller.createCard("character", "Alex");
    const card = (await controller.listCards())[0];
    await controller.deleteCard(card.id);
    const trashItem = (await controller.listTrashItems())[0];
    destructiveConfirmResult = false;

    const result = await controller.permanentlyDeleteTrashItem(trashItem.id);

    assert.equal(result.applied, false);
    assert.equal(await exists(path.join(workspace, trashItem.trashPath)), true);
  });

  test("preserves unknown frontmatter fields when metadata changes", async () => {
    await controller.createCard("character", "Alex");
    const card = (await controller.listCards())[0];
    const absolutePath = path.join(workspace, card.path);
    const text = await fs.readFile(absolutePath, "utf8");
    await fs.writeFile(absolutePath, text.replace("updatedAt:", "futureField: keep-me\nupdatedAt:"), "utf8");

    await controller.updateCardMetadata(card.id, { summary: "Updated summary" });

    const updated = await fs.readFile(absolutePath, "utf8");
    assert.match(updated, /futureField: keep-me/);
    assert.match(updated, /summary: "Updated summary"/);
  });

  test("searches Markdown H1 titles", async () => {
    await controller.createCard("character", "Alex");
    const card = (await controller.listCards())[0];
    const absolutePath = path.join(workspace, card.path);
    const text = await fs.readFile(absolutePath, "utf8");
    await fs.writeFile(absolutePath, text.replace("# Alex", "# Hidden Rival"), "utf8");

    const results = await controller.searchCards({ text: "Hidden Rival" });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, card.id);
  });

  test("derives safe card drafts from selected text", () => {
    const multiline = deriveCardDraftFromSelection("第一行名称\n第二行是摘要信息");
    const long = deriveCardDraftFromSelection("a".repeat(120));

    assert.equal(multiline.name, "第一行名称");
    assert.equal(multiline.summary, "第一行名称 第二行是摘要信息");
    assert.equal(long.name.length <= 80, true);
    assert.equal(long.summary, "a".repeat(120));
  });

  test("diagnoses damaged card frontmatter and duplicate primary keywords without hiding valid cards", async () => {
    await controller.createCard("character", "Alex");
    const valid = (await controller.listCards())[0];
    await fs.writeFile(
      path.join(workspace, STORY_BIBLE_CHARACTER_DIR, "broken.md"),
      [
        "---",
        'schemaVersion: "0.2.0"',
        'id: "story_broken"',
        'type: "character"',
        'name: "Broken"',
        "aliases: []",
        'tags: ["bad slug", "bad slug"]',
        'summary: ""',
        'visibility: "public"',
        'status: "draft"',
        'createdAt: "2026-06-29T00:00:00.000Z"',
        'updatedAt: "2026-06-29T00:00:00.000Z"',
        "---",
        "# Broken"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(workspace, STORY_BIBLE_CHARACTER_DIR, "duplicate.md"),
      (await fs.readFile(path.join(workspace, valid.path), "utf8"))
        .replace(valid.id, "story_duplicate")
        .replace(valid.name, "Duplicate"),
      "utf8"
    );

    const result = await readStoryBible(workspace);

    assert.equal(result.cards.some((item) => item.dto.id === valid.id), true);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.tagSlug.invalid"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.tags.duplicate"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.primaryKeyword.duplicate"), true);
  });

  test("repairs cards whose primary keyword uses the wrong object type", async () => {
    const cardPath = path.join(workspace, STORY_BIBLE_CHARACTER_DIR, "bad-hero.md");
    await fs.writeFile(
      cardPath,
      [
        "---",
        'schemaVersion: "0.2.0"',
        'id: "story_bad_hero"',
        'type: "character"',
        'name: "Bad Hero"',
        "aliases: []",
        "tags:",
        '  - "location/wrong-room"',
        'summary: "Has the wrong primary keyword."',
        'visibility: "public"',
        'status: "draft"',
        'createdAt: "2026-06-29T00:00:00.000Z"',
        'updatedAt: "2026-06-29T00:00:00.000Z"',
        "chapterRefs: []",
        "---",
        "# Bad Hero",
        ""
      ].join("\n"),
      "utf8"
    );

    let result = await readStoryBible(workspace);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.primaryKeyword.missing"), true);
    const card = (await controller.listCards()).find((item) => item.name === "Bad Hero")!;

    await controller.repairCardPrimaryKeyword(card.id);

    const repaired = (await controller.listCards()).find((item) => item.id === card.id)!;
    result = await readStoryBible(workspace);
    assert.equal(repaired.tags[0], "character/bad-hero");
    assert.equal(repaired.tags[1], "location/wrong-room");
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.primaryKeyword.missing"), false);
  });

  test("explains how to repair non ISO card timestamps", async () => {
    await controller.createCard("character", "Alex");
    const card = (await controller.listCards())[0];
    const absolutePath = path.join(workspace, card.path);
    const text = await fs.readFile(absolutePath, "utf8");
    await fs.writeFile(
      absolutePath,
      text
        .replace(/createdAt: ".+"/, 'createdAt: "今天"')
        .replace(/updatedAt: ".+"/, 'updatedAt: "刚才"'),
      "utf8"
    );

    const result = await readStoryBible(workspace);
    const timestampDiagnostics = result.diagnostics.filter(
      (item) =>
        item.code === "storyBible.card.createdAt.invalid" ||
        item.code === "storyBible.card.updatedAt.invalid"
    );

    assert.equal(timestampDiagnostics.length, 2);
    assert.equal(timestampDiagnostics.every((item) => item.message.includes("2026-07-01T12:00:00.000Z")), true);
    assert.equal(timestampDiagnostics.every((item) => item.message.includes("不要使用“今天”“刚才”")), true);
  });

  test("diagnoses orphan markdown duplicate labels and reserved keyword definitions", async () => {
    await controller.createCard("character", "Alex", { aliases: ["Ace"] });
    await controller.createCard("character", "Alex", { aliases: ["Ace"] });
    await fs.writeFile(path.join(workspace, LORE_DIR, "orphan.md"), "# Orphan\n", "utf8");
    await fs.mkdir(path.join(workspace, STORY_BIBLE_TAG_DIR, "character"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, STORY_BIBLE_TAG_DIR, "character/alex.md"),
      [
        "---",
        'schemaVersion: "0.2.0"',
        'schema: "story-bible.tag"',
        'slug: "character/alex"',
        'label: "Bad reserved keyword"',
        'description: ""',
        'category: "custom"',
        'appliesTo: ["any"]',
        'createdAt: "2026-06-29T00:00:00.000Z"',
        'updatedAt: "2026-06-29T00:00:00.000Z"',
        "---",
        "# Bad reserved keyword"
      ].join("\n"),
      "utf8"
    );

    const result = await readStoryBible(workspace);
    const keyword = result.keywords.find((item) => item.slug === "character/alex");

    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.orphanMarkdown"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.name.duplicate"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.card.alias.duplicate"), true);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.keyword.slug.reservedPrefix"), true);
    assert.equal(keyword?.source, "system-object");
    assert.equal(keyword?.definitionPath, undefined);
  });

  test("rejects trash metadata that points at the Story Bible trash root", async () => {
    await controller.createCard("character", "Alex");
    const card = (await controller.listCards())[0];
    await controller.deleteCard(card.id);
    const trashItem = (await controller.listTrashItems())[0];
    const metadataPath = path.join(workspace, trashItem.trashPath, STORY_BIBLE_TRASH_METADATA);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.trashPath = STORY_BIBLE_TRASH_DIR;
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const result = await readStoryBible(workspace);

    assert.equal(result.trashItems.length, 0);
    assert.equal(result.diagnostics.some((item) => item.code === "storyBible.trash.metadata.invalid"), true);
    await assert.rejects(() => controller.permanentlyDeleteTrashItem(trashItem.id), /未找到资源垃圾桶项目/);
    assert.equal(await exists(path.join(workspace, STORY_BIBLE_TRASH_DIR)), true);
  });

  test("classifies explicit file change notifications", () => {
    const events: string[] = [];
    const disposable = controller.onDidChange((event) => events.push(event.type));
    try {
      controller.notifyFileChanged("lore/characters/alex.md", "structure");
      controller.notifyFileChanged("lore/characters/alex.md");
      controller.notifyFileChanged(".loredock/trash/resources/story-bible/trash_test/trash-item.json");
    } finally {
      disposable.dispose();
    }

    assert.deepEqual(events, ["structure", "content", "structure"]);
  });

  test("tree shows setup and active Story Bible groups", async () => {
    const emptyWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "loredock-story-tree-"));
    try {
      const emptyTree = new StoryBibleTreeProvider(createWorkspaceFolder(emptyWorkspace));
      const emptyNodes = await emptyTree.getChildren();
      assert.equal(emptyNodes.some((node) => node.kind === "action" && node.title === "初始化项目"), true);

      await fs.mkdir(path.join(emptyWorkspace, ".loredock"));
      await fs.writeFile(path.join(emptyWorkspace, ".loredock/project.json"), "{}\n", "utf8");
      const missingNodes = await emptyTree.getChildren();
      assert.equal(missingNodes.some((node) => node.kind === "action" && node.title === "启用故事圣经"), true);

      await fs.mkdir(path.join(emptyWorkspace, LORE_DIR), { recursive: true });
      const partialNodes = await emptyTree.getChildren();
      assert.equal(partialNodes.some((node) => node.kind === "action" && node.title === "启用故事圣经"), true);

      await fs.mkdir(path.join(workspace, ".loredock"), { recursive: true });
      await writeProjectManifest(workspace, [STORY_BIBLE_CAPABILITY_ID]);
      await controller.createCard("character", "Alex");
      const activeTree = new StoryBibleTreeProvider(workspaceFolder);
      const activeNodes = await activeTree.getChildren();
      const characterGroup = activeNodes.find((node) => node.kind === "group" && node.group === "character");
      assert.ok(characterGroup);
      const children = await activeTree.getChildren(characterGroup);
      const cardNode = children.find((node) => node.kind === "card" && node.title === "Alex");
      assert.ok(cardNode);
      assert.equal(activeTree.getTreeItem(cardNode).command, undefined);
    } finally {
      await fs.rm(emptyWorkspace, { recursive: true, force: true });
    }
  });

  test("filters cards by type visibility status and keyword", async () => {
    await controller.createCard("character", "Alex", { visibility: "spoiler", status: "canon" });
    const card = (await controller.listCards())[0];
    await controller.updateCardMetadata(card.id, { tags: [card.primaryKeyword, "theme/revenge"] });

    assert.equal((await controller.listCards({ type: "character" })).length, 1);
    assert.equal((await controller.listCards({ visibility: "spoiler" })).length, 1);
    assert.equal((await controller.listCards({ status: "canon" })).length, 1);
    assert.equal((await controller.listCards({ keyword: "theme/revenge" })).length, 1);
    assert.equal((await controller.listCards({ type: "location" })).length, 0);
  });
});

async function writeStoryBibleDirectories(workspace: string): Promise<void> {
  for (const directory of [
    LORE_DIR,
    STORY_BIBLE_CHARACTER_DIR,
    STORY_BIBLE_LOCATION_DIR,
    STORY_BIBLE_RULE_DIR,
    STORY_BIBLE_TAG_DIR
  ]) {
    await fs.mkdir(path.join(workspace, directory), { recursive: true });
  }
}

async function writeProjectManifest(workspace: string, capabilities: string[] = []): Promise<void> {
  await fs.mkdir(path.join(workspace, ".loredock"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, ".loredock/project.json"),
    `${JSON.stringify(
      {
        schemaVersion: "0.0.0",
        projectId: "loredock-project_test",
        title: path.basename(workspace),
        createdAt: "2026-06-29T00:00:00.000Z",
        updatedAt: "2026-06-29T00:00:00.000Z",
        capabilities
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function createController(
  workspaceFolder: vscode.WorkspaceFolder,
  state: {
    seenPlans: OperationPlan[];
    destructivePrompts: string[];
    destructiveConfirmResult: boolean;
    diagnostics: DiagnosticItem[];
  }
): StoryBibleController {
  return new StoryBibleController({
    workspaceFolder,
    output: createOutputChannel(),
    diagnostics: {
      add(item) {
        state.diagnostics.push(item);
      },
      clearMatching(workspaceFolderPath, predicate) {
        state.diagnostics = state.diagnostics.filter(
          (item) => item.workspaceFolder !== workspaceFolderPath || !predicate(item)
        );
      }
    },
    confirmOperationPlan: async (plan) => {
      state.seenPlans.push(plan);
      return true;
    },
    confirmDestructiveDelete: async (message) => {
      state.destructivePrompts.push(message);
      return state.destructiveConfirmResult;
    },
    now: () => new Date("2026-06-29T00:00:00.000Z")
  });
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
