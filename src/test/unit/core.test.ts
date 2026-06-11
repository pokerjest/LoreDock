import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildContextPackage, filterContextPackage } from '../../core/contextBuilder';
import { LoreDockStorage } from '../../core/storage';
import { decodeTextBuffer, slugify } from '../../core/utils';
import { countWords } from '../../core/wordCount';
import { anthropicEndpoint, buildChatCompletionPayload, buildClaudePayload, buildGeminiPayload, normalizeApiKey, validateBaseUrl } from '../../services/aiClient';
import { AISettings, CharacterCard } from '../../types';

test('initializes a local LoreDock project and prevents accidental re-init', async () => {
  const root = await tempRoot();
  const storage = new LoreDockStorage(root);

  const manifest = await storage.initializeProject({
    title: '测试小说',
    author: '作者',
    genre: '奇幻',
    language: 'zh-CN',
    defaultStyle: '冷静克制。',
    createSamples: false
  });

  assert.equal(manifest.title, '测试小说');
  assert.equal(manifest.volumes.length, 1);
  assert.equal(manifest.volumes[0].chapters.length, 1);
  assert.ok(await exists(path.join(root, '.loredock', 'project.json')));
  assert.ok(await exists(path.join(root, 'manuscript', 'volume-001', 'chapter-001.md')));

  await assert.rejects(
    storage.initializeProject({
      title: '重复',
      author: '',
      genre: '',
      language: 'zh-CN',
      defaultStyle: '',
      createSamples: false
    }),
    /already exists/
  );
});

test('resolves workspace-relative paths with Windows separators', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  const chapterPath = storage.resolve('manuscript\\volume-001\\chapter-001.md');

  assert.equal(chapterPath, path.join(storage.workspaceRoot, 'manuscript', 'volume-001', 'chapter-001.md'));
  assert.equal((await storage.getChapterRefByFilePath(chapterPath))?.chapter.id, chapter.id);
  if (process.platform === 'win32') {
    assert.equal((await storage.getChapterRefByFilePath(chapterPath.toUpperCase()))?.chapter.id, chapter.id);
  }
  assert.throws(() => storage.resolve('..\\outside'), /Invalid LoreDock workspace path/);
});

test('rejects traversal and absolute workspace-relative paths', async () => {
  const storage = await initializedStorage();

  assert.throws(() => storage.resolve('manuscript/../outside.md'), /Invalid LoreDock workspace path/);
  assert.throws(() => storage.resolve('/outside.md'), /Invalid LoreDock workspace path/);
  assert.throws(() => storage.resolve('C:outside.md'), /Invalid LoreDock workspace path/);
  assert.throws(() => storage.resolve('C:\\outside.md'), /Invalid LoreDock workspace path/);
  await assert.rejects(storage.deleteCodexEntry('codex/characters/../../outside.json'), /Invalid LoreDock workspace path/);
});

test('uses portable names for imported sources and exported files', async () => {
  const storage = await initializedStorage();
  await storage.importManuscript('C:\\drafts\\old.md', '# 旧章\n\n第一段。');
  const manifest = await storage.requireManifest();

  assert.equal(manifest.volumes.some((volume) => volume.title.endsWith('old')), true);
  assert.equal(slugify('CON'), 'con-file');

  manifest.title = 'CON';
  await storage.writeManifest(manifest);
  const exported = await storage.exportManuscript('markdown');

  assert.equal(path.basename(storage.resolve(exported)), 'con-file.md');
});

test('decodes BOM text and reads BOM-prefixed local files', async () => {
  assert.equal(decodeTextBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x69])), 'Hi');
  assert.equal(decodeTextBuffer(Buffer.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])), 'Hi');
  assert.equal(decodeTextBuffer(Buffer.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69])), 'Hi');

  const storage = await initializedStorage();
  await storage.ensureAIConfigFile();
  await fs.writeFile(storage.resolve('.loredock/ai.env'), '\uFEFFOPENROUTER_API_KEY=sk-router-test\n', 'utf8');
  assert.equal((await storage.readAIEnv()).OPENROUTER_API_KEY, 'sk-router-test');

  const config = await storage.readAIConfig();
  await fs.writeFile(storage.resolve('.loredock/ai.local.jsonc'), `\uFEFF${JSON.stringify(config, null, 2)}\n`, 'utf8');
  assert.equal((await storage.readAIConfig()).activeProvider, config.activeProvider);

  const stylePath = await storage.ensureExportStyleFile();
  await fs.writeFile(storage.resolve(stylePath), '\uFEFF{"fontSize": 14}\n', 'utf8');
  assert.equal((await storage.readExportStyle()).fontSize, 14);

  const card = await storage.createCharacter({ name: 'BOM Card' });
  const entry = await storage.findCodexEntryById(card.id);
  assert.ok(entry);
  await fs.writeFile(storage.resolve(entry.relativePath), `\uFEFF${JSON.stringify(card, null, 2)}\n`, 'utf8');
  assert.equal((await storage.readCodexEntry(entry.relativePath)).card.id, card.id);
});

test('creates chapters and refreshes word count metadata', async () => {
  const storage = await initializedStorage();
  const chapter = await storage.createChapter('volume-001', '第二章');
  await fs.writeFile(storage.resolve(chapter.filePath), '# 第二章\n\n吴烬走进旧城。A test line.\n', 'utf8');

  const manifest = await storage.refreshChapterStats();
  const created = manifest?.volumes[0].chapters.find((candidate) => candidate.id === chapter.id);

  assert.equal(created?.title, '第二章');
  assert.equal(created?.wordCount, countWords('# 第二章\n\n吴烬走进旧城。A test line.\n'));
});

test('deletes volumes and their manuscript folder', async () => {
  const storage = await initializedStorage();
  const volume = await storage.createVolume('第二卷');
  const chapter = await storage.createChapter(volume.id, '第二卷第一章');

  assert.ok(await exists(storage.resolve(chapter.filePath)));

  await storage.deleteVolume(volume.id);
  const manifest = await storage.requireManifest();

  assert.equal(manifest.volumes.some((candidate) => candidate.id === volume.id), false);
  assert.equal(await exists(storage.resolve(path.join('manuscript', volume.id))), false);
});

test('deletes codex cards', async () => {
  const storage = await initializedStorage();
  await storage.createCharacter({ name: '临时人物' });
  const [entry] = await storage.listCodexEntries('character');

  assert.ok(entry);
  assert.ok(await exists(storage.resolve(entry.relativePath)));

  await storage.deleteCodexEntry(entry.relativePath);

  assert.equal(await exists(storage.resolve(entry.relativePath)), false);
});

test('creates extended codex cards', async () => {
  const storage = await initializedStorage();
  await storage.createForeshadowing({ name: '锁门声' });
  await storage.createTimelineEvent({ name: '旧城封锁' });
  await storage.createScene({ name: '城门冲突', chapterId: 'chapter-001' });
  await storage.createBeat({ name: '发现血迹', chapterId: 'chapter-001' });

  assert.equal((await storage.listCodexEntries('foreshadowing')).length, 1);
  assert.equal((await storage.listCodexEntries('timeline-event')).length, 1);
  assert.equal((await storage.listCodexEntries('scene')).length, 1);
  assert.equal((await storage.listCodexEntries('beat')).length, 1);
});

test('deletes the LoreDock book project folders without deleting workspace root', async () => {
  const storage = await initializedStorage();
  await storage.createCharacter({ name: '临时人物' });

  await storage.deleteProject();

  assert.equal(await exists(storage.resolve('.loredock')), false);
  assert.equal(await exists(storage.resolve('manuscript')), false);
  assert.equal(await exists(storage.resolve('codex')), false);
  assert.equal(await exists(storage.workspaceRoot), true);
});

test('updates chapter status and computes writing stats', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(storage.resolve(chapter.filePath), '# 第一章\n\n吴烬醒来。\n', 'utf8');
  await storage.updateChapterStatus(chapter.id, 'draft-complete');

  const stats = await storage.getWritingStats();

  assert.equal(stats.chapterCount, 1);
  assert.equal(stats.totalWordCount, countWords('# 第一章\n\n吴烬醒来。\n'));
  assert.equal(stats.statusCounts['draft-complete'], 1);
});

test('persists writing goals and export style settings', async () => {
  const storage = await initializedStorage();

  const defaultGoals = await storage.readWritingGoals();
  assert.equal(defaultGoals.dailyWordTarget, 0);
  assert.equal(defaultGoals.totalWordTarget, 0);

  await storage.writeWritingGoals({
    schemaVersion: 1,
    dailyWordTarget: 1200,
    totalWordTarget: 200000,
    updatedAt: new Date().toISOString()
  });

  const stats = await storage.getWritingStats();
  assert.equal(stats.goals?.dailyWordTarget, 1200);
  assert.equal(stats.goals?.totalWordTarget, 200000);

  const stylePath = await storage.ensureExportStyleFile();
  await fs.writeFile(
    storage.resolve(stylePath),
    '{\n  // test override\n  "includeAuthor": false,\n  "includeVolumeTitles": false,\n  "fontSize": 16\n}\n',
    'utf8'
  );
  const style = await storage.readExportStyle();
  assert.equal(style.includeAuthor, false);
  assert.equal(style.includeVolumeTitles, false);
  assert.equal(style.fontSize, 16);
  assert.equal(style.lineHeight, 1.7);
});

test('exports manuscript in multiple formats', async () => {
  const storage = await initializedStorage();
  const first = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(storage.resolve(first.filePath), '# 第一章\n\n吴烬醒来。\n', 'utf8');
  const second = await storage.createChapter('volume-001', '第二章');
  await fs.writeFile(storage.resolve(second.filePath), '# 第二章\n\n他走进旧城。\n', 'utf8');

  const markdownPath = await storage.exportManuscript('markdown');
  const txtPath = await storage.exportManuscript('txt');
  const docxPath = await storage.exportManuscript('docx');
  const epubPath = await storage.exportManuscript('epub');
  const pdfPath = await storage.exportManuscript('pdf');

  const markdown = await fs.readFile(storage.resolve(markdownPath), 'utf8');
  const txt = await fs.readFile(storage.resolve(txtPath), 'utf8');
  const docx = await fs.readFile(storage.resolve(docxPath));
  const epub = await fs.readFile(storage.resolve(epubPath));
  const pdf = await fs.readFile(storage.resolve(pdfPath));

  assert.match(markdown, /^# 测试小说/);
  assert.match(markdown, /## 第一章\n\n吴烬醒来。/);
  assert.match(markdown, /## 第二章\n\n他走进旧城。/);
  assert.match(txt, /^测试小说/);
  assert.match(txt, /第一章\n\n吴烬醒来。/);
  assert.match(txt, /第二章\n\n他走进旧城。/);
  assert.equal(docx.subarray(0, 2).toString('utf8'), 'PK');
  assert.equal(epub.subarray(0, 2).toString('utf8'), 'PK');
  assert.equal(pdf.subarray(0, 5).toString('utf8'), '%PDF-');
});

test('updates codex cards and normalizes scene and beat order', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  const lateScene = await storage.createScene({ name: '后场景', chapterId: chapter.id });
  const earlyScene = await storage.createScene({ name: '前场景', chapterId: chapter.id });
  const lateBeat = await storage.createBeat({ name: '后 Beat', chapterId: chapter.id });
  const earlyBeat = await storage.createBeat({ name: '前 Beat', chapterId: chapter.id });

  const lateSceneEntry = await storage.findCodexEntryById(lateScene.id);
  const earlySceneEntry = await storage.findCodexEntryById(earlyScene.id);
  const lateBeatEntry = await storage.findCodexEntryById(lateBeat.id);
  const earlyBeatEntry = await storage.findCodexEntryById(earlyBeat.id);
  assert.ok(lateSceneEntry);
  assert.ok(earlySceneEntry);
  assert.ok(lateBeatEntry);
  assert.ok(earlyBeatEntry);

  await storage.writeCodexEntry(lateSceneEntry.relativePath, { ...lateScene, order: 9, conflict: '后发生' });
  await storage.writeCodexEntry(earlySceneEntry.relativePath, { ...earlyScene, order: 2, conflict: '先发生' });
  await storage.writeCodexEntry(lateBeatEntry.relativePath, { ...lateBeat, order: 5 });
  await storage.writeCodexEntry(earlyBeatEntry.relativePath, { ...earlyBeat, order: 1 });

  assert.equal(await storage.normalizeSceneOrders(chapter.id), 2);
  assert.equal(await storage.normalizeBeatOrders(chapter.id), 2);

  const scenes = await storage.listCodexEntries('scene');
  const beats = await storage.listCodexEntries('beat');
  assert.equal((scenes.find((entry) => entry.card.id === earlyScene.id)?.card as { order?: number })?.order, 1);
  assert.equal((scenes.find((entry) => entry.card.id === lateScene.id)?.card as { order?: number })?.order, 2);
  assert.equal((beats.find((entry) => entry.card.id === earlyBeat.id)?.card as { order?: number })?.order, 1);
  assert.equal((beats.find((entry) => entry.card.id === lateBeat.id)?.card as { order?: number })?.order, 2);
  assert.equal((await storage.readCodexEntry(lateSceneEntry.relativePath)).card.name, '后场景');
});

test('imports markdown manuscript into a new volume', async () => {
  const storage = await initializedStorage();
  const imported = await storage.importManuscript('old.md', '# 旧章一\n\n第一段。\n\n# 旧章二\n\n第二段。');
  const manifest = await storage.requireManifest();

  assert.equal(imported.length, 2);
  assert.equal(manifest.volumes.some((volume) => volume.title === '导入：old'), true);
  assert.match(await fs.readFile(storage.resolve(imported[0].filePath), 'utf8'), /# 旧章一\n\n第一段。/);
});

test('imports DOCX manuscript text through the local parser', async () => {
  const storage = await initializedStorage();
  const first = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(storage.resolve(first.filePath), '# 第一章\n\n吴烬醒来。\n', 'utf8');
  const exported = await storage.exportManuscript('docx');
  const buffer = await fs.readFile(storage.resolve(exported));

  const imported = await storage.importDocxManuscript('book.docx', buffer);

  assert.ok(imported.length >= 1);
  assert.match((await Promise.all(imported.map((chapter) => fs.readFile(storage.resolve(chapter.filePath), 'utf8')))).join('\n'), /吴烬醒来/);
});

test('builds reference index across manuscript, chat and snippets while respecting doNotTrack', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(storage.resolve(chapter.filePath), '# 第一章\n\n吴烬在王都遇见灰烬这个旧称。\n', 'utf8');
  const character = await storage.createCharacter({ name: '吴烬', detail: '主角' });
  const characterEntry = await storage.findCodexEntryById(character.id);
  assert.ok(characterEntry);
  await storage.writeCodexEntry(characterEntry.relativePath, { ...character, aliases: ['灰烬'], memoryStatus: 'confirmed' });
  const location = await storage.createLocation({ name: '王都' });
  const locationEntry = await storage.findCodexEntryById(location.id);
  assert.ok(locationEntry);
  await storage.writeCodexEntry(locationEntry.relativePath, { ...location, doNotTrack: true });
  await storage.saveChatThread({
    schemaVersion: 1,
    id: 'chat-reference',
    title: '设定讨论',
    pinned: false,
    messages: [{ role: 'user', content: '灰烬这个别名会在第一卷频繁出现。' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await storage.saveSnippet({
    schemaVersion: 1,
    id: 'snippet-reference',
    title: '人物片段',
    content: '吴烬总是避开钟楼。',
    tags: [],
    sourceRefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const index = await storage.buildReferenceIndex();
  const names = index.occurrences.map((occurrence) => occurrence.cardName);
  const kinds = index.occurrences.filter((occurrence) => occurrence.cardName === '吴烬').map((occurrence) => occurrence.sourceKind);

  assert.ok(names.includes('吴烬'));
  assert.ok(kinds.includes('chapter'));
  assert.ok(kinds.includes('chat'));
  assert.ok(kinds.includes('snippet'));
  assert.equal(names.includes('王都'), false);
  assert.equal((await storage.readReferenceIndex())?.occurrences.length, index.occurrences.length);
});

test('applies confirmed progressions only after their effective chapter', async () => {
  const storage = await initializedStorage();
  const manifest = await storage.requireManifest();
  const first = manifest.volumes[0].chapters[0];
  const second = await storage.createChapter(manifest.volumes[0].id, '第二章');
  await fs.writeFile(storage.resolve(first.filePath), '# 第一章\n\n吴烬研究灵能登记制度。\n', 'utf8');
  await fs.writeFile(storage.resolve(second.filePath), '# 第二章\n\n吴烬回到王都，灵能登记制度开始变化。\n', 'utf8');
  const rule = await storage.createWorldRule({ name: '灵能登记制度', detail: '三阶以上灵能者必须登记。' });
  const entry = await storage.findCodexEntryById(rule.id);
  assert.ok(entry);
  await storage.writeCodexEntry(entry.relativePath, {
    ...rule,
    memoryStatus: 'confirmed',
    progressions: [
      {
        id: 'progression-lockdown',
        title: '王都戒严',
        content: '第二章后，王都开始按街区封锁未登记灵能者。',
        effectiveFromChapterId: second.id,
        sourceRefs: [{ kind: 'chapter', id: second.id, name: '第二章' }],
        status: 'confirmed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'progression-pending',
        title: '未确认改革',
        content: '登记制度将在第三章废除。',
        effectiveFromChapterId: first.id,
        sourceRefs: [],
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });

  const firstContext = await buildContextPackage({ storage, chapterId: first.id, taskType: 'continue', userInstruction: '' });
  const secondContext = await buildContextPackage({ storage, chapterId: second.id, taskType: 'continue', userInstruction: '' });

  assert.doesNotMatch(firstContext.assembledText, /王都开始按街区封锁/);
  assert.match(secondContext.assembledText, /王都开始按街区封锁/);
  assert.doesNotMatch(secondContext.assembledText, /第三章废除/);
});

test('creates prompt library and round-trips codex zip exports', async () => {
  const storage = await initializedStorage();
  const prompts = await storage.ensurePromptLibrary();
  await storage.createCharacter({ name: '吴烬', detail: '主角' });

  const zipPath = await storage.exportCodexZip();
  const zipBuffer = await fs.readFile(storage.resolve(zipPath));
  const target = await initializedStorage();
  const importedCount = await target.importCodexZip(zipBuffer);

  assert.ok(prompts.some((prompt) => prompt.kind === 'continue'));
  assert.equal((await storage.listPromptTemplates()).length, prompts.length);
  assert.ok(importedCount >= 1);
  assert.equal((await target.listCodexEntries('character')).some((entry) => entry.card.name === '吴烬'), true);
});

test('lists and clears AI history', async () => {
  const storage = await initializedStorage();
  await storage.appendHistory({
    schemaVersion: 1,
    id: 'history-one',
    taskType: 'continue',
    model: 'test-model',
    provider: 'openai-compatible',
    userInstruction: 'test',
    contextPreview: 'context',
    output: 'output',
    action: 'append',
    createdAt: new Date().toISOString(),
    latencyMs: 10
  });

  assert.equal((await storage.listHistory()).length, 1);

  await storage.clearHistory();

  assert.equal((await storage.listHistory()).length, 0);
});

test('creates local AI config file and updates selected model', async () => {
  const storage = await initializedStorage();
  const relativePath = await storage.ensureAIConfigFile();

  assert.equal(relativePath, '.loredock/ai.local.jsonc');
  assert.ok(await exists(storage.resolve(relativePath)));
  assert.ok(await exists(storage.resolve('.loredock/ai.env')));
  const localIgnore = await fs.readFile(storage.resolve('.loredock/.gitignore'), 'utf8');
  assert.match(localIgnore, /ai\.local\.jsonc/);
  assert.match(localIgnore, /ai\.env/);

  await fs.writeFile(storage.resolve('.loredock/ai.env'), 'export ANTHROPIC_API_KEY=sk-ant-test\nOPENROUTER_API_KEY="sk-router-test"\n', 'utf8');
  const envValues = await storage.readAIEnv();
  assert.equal(envValues.ANTHROPIC_API_KEY, 'sk-ant-test');
  assert.equal(envValues.OPENROUTER_API_KEY, 'sk-router-test');

  const config = await storage.readAIConfig();
  assert.equal(config.providers.gpt?.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.providers.claude?.apiKeyEnv, 'ANTHROPIC_API_KEY');
  config.activeProvider = 'gpt';
  config.providers.gpt = {
    ...config.providers.gpt,
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    apiKey: 'test-key'
  };
  await storage.writeAIConfig(config);
  await storage.updateActiveAIModel('gpt-test-model');

  assert.equal((await storage.readAIConfig()).providers.gpt?.model, 'gpt-test-model');
});

test('normalizes API keys copied from env and bearer examples', async () => {
  const storage = await initializedStorage();
  await storage.ensureAIConfigFile();
  await fs.writeFile(
    storage.resolve('.loredock/ai.env'),
    'OPENROUTER_API_KEY=Bearer sk-or-v1-test # copied from docs\nANTHROPIC_API_KEY=\"sk-ant-test\"\n',
    'utf8'
  );

  const envValues = await storage.readAIEnv();

  assert.equal(envValues.OPENROUTER_API_KEY, 'Bearer sk-or-v1-test');
  assert.equal(normalizeApiKey(envValues.OPENROUTER_API_KEY), 'sk-or-v1-test');
  assert.equal(normalizeApiKey(' "Bearer sk-test" '), 'sk-test');
  assert.equal(envValues.ANTHROPIC_API_KEY, 'sk-ant-test');
});

test('configures OpenRouter profile for multi-model router keys', async () => {
  const storage = await initializedStorage();
  const config = await storage.readAIConfig();
  config.providers['openai-compatible'] = {
    ...config.providers['openai-compatible'],
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    apiKey: 'sk-router-test'
  };
  await storage.writeAIConfig(config);

  const updated = await storage.configureOpenRouterProfile();

  assert.equal(updated.activeProvider, 'openrouter');
  assert.equal(updated.providers.openrouter?.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(updated.providers.openrouter?.apiKey, 'sk-router-test');
});

test('saves pending codex update suggestions from summaries', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  const saved = await storage.saveSummary({
    schemaVersion: 1,
    id: 'chapter-001-summary',
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    oneLineSummary: '吴烬醒来。',
    majorEvents: [],
    characterChanges: ['吴烬开始寻找线索'],
    locationChanges: [],
    newSettings: ['旧城有封锁线'],
    newForeshadowing: [],
    resolvedForeshadowing: [],
    unresolvedQuestions: ['谁封锁了旧城？'],
    nextChapterHooks: [],
    facts: [],
    inferences: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const relativePath = await storage.savePendingCodexUpdates(saved);

  assert.ok(relativePath);
  assert.match(await fs.readFile(storage.resolve(relativePath), 'utf8'), /吴烬开始寻找线索/);
});

test('context assembly includes relevant public codex and excludes hidden secrets', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(storage.resolve(chapter.filePath), '# 第一章\n\n吴烬在旧城低声说话。\n', 'utf8');

  const character = await storage.createCharacter({ name: '吴烬', detail: '主角' });
  const [entry] = await storage.listCodexEntries('character');
  const edited: CharacterCard = {
    ...character,
    speechStyle: '短句，少解释。',
    currentState: '正在寻找线索。',
    secrets: '他知道幕后真相。',
    hiddenSecrets: '真正身份不能发送。'
  };
  await fs.writeFile(storage.resolve(entry.relativePath), `${JSON.stringify(edited, null, 2)}\n`, 'utf8');

  const context = await buildContextPackage({
    storage,
    chapterId: chapter.id,
    taskType: 'continue',
    userInstruction: '保持悬念。'
  });

  assert.match(context.assembledText, /吴烬/);
  assert.match(context.assembledText, /短句，少解释/);
  assert.doesNotMatch(context.assembledText, /幕后真相/);
  assert.doesNotMatch(context.assembledText, /真正身份/);

  const filtered = filterContextPackage(context, ['task', 'project', 'style', 'chapter-tail']);
  assert.doesNotMatch(filtered.assembledText, /短句，少解释/);
  assert.match(filtered.omitted.join('\n'), /用户排除/);
});

test('context includes foreshadowing without hidden truth by default', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(storage.resolve(chapter.filePath), '# 第一章\n\n吴烬听见锁门声。\n', 'utf8');
  const card = await storage.createForeshadowing({ name: '锁门声', detail: '反复出现的门锁声。' });
  const [entry] = await storage.listCodexEntries('foreshadowing');
  await fs.writeFile(
    storage.resolve(entry.relativePath),
    `${JSON.stringify({ ...card, status: 'seeded', publicHint: '门锁声会反复出现', hiddenTruth: '幕后黑手正在隔壁房间', allowRevealToAI: false }, null, 2)}\n`,
    'utf8'
  );

  const context = await buildContextPackage({
    storage,
    chapterId: chapter.id,
    taskType: 'continue',
    userInstruction: ''
  });

  assert.match(context.assembledText, /锁门声/);
  assert.match(context.assembledText, /门锁声会反复出现/);
  assert.doesNotMatch(context.assembledText, /幕后黑手/);
});

test('context includes structured world memory, relationships, timeline causality and pending inferences', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(storage.resolve(chapter.filePath), '# 第一章\n\n林凛在王都调查灵能登记制度，吴烬提到旧钟塔爆炸。\n', 'utf8');

  const character = await storage.createCharacter({ name: '林凛', detail: '调查者' });
  const characterEntry = await storage.findCodexEntryById(character.id);
  assert.ok(characterEntry);
  await storage.writeCodexEntry(characterEntry.relativePath, {
    ...character,
    memoryStatus: 'confirmed',
    relationships: [
      {
        target: '吴烬',
        type: '盟友',
        status: '不稳定',
        description: '目标一致，但互相隐瞒关键情报。',
        knownBy: ['林凛']
      }
    ],
    knows: ['监察院隐藏过旧钟塔事故'],
    doesNotKnow: ['吴烬真实身份'],
    secrets: '她知道监察院密档编号。',
    hiddenSecrets: '她本人曾被监察院实验过。',
    inferences: [
      {
        subject: '林凛',
        field: 'personality',
        value: '她对官方机构保持戒备。',
        basis: ['灵能登记制度要求三阶以上必须登记', '旧钟塔爆炸被监察院压下'],
        confidence: 'high',
        status: 'pending',
        sourceRefs: [{ kind: 'world-rule', name: '灵能登记制度' }]
      }
    ]
  });

  const rule = await storage.createWorldRule({ name: '灵能登记制度', detail: '三阶以上灵能者必须登记。' });
  const ruleEntry = await storage.findCodexEntryById(rule.id);
  assert.ok(ruleEntry);
  await storage.writeCodexEntry(ruleEntry.relativePath, {
    ...rule,
    memoryStatus: 'confirmed',
    category: '力量体系 / 政治制度',
    rules: ['三阶以上必须登记', '未登记灵能者不得进入王都'],
    scope: ['王国'],
    relatedCharacters: ['林凛'],
    relatedFactions: ['王国监察院'],
    importance: 'absolute'
  });

  const event = await storage.createTimelineEvent({ name: '旧钟塔爆炸' });
  const eventEntry = await storage.findCodexEntryById(event.id);
  assert.ok(eventEntry);
  await storage.writeCodexEntry(eventEntry.relativePath, {
    ...event,
    memoryStatus: 'confirmed',
    sequence: 12,
    storyTime: '第一日夜',
    location: '王都旧钟塔',
    participants: ['林凛', '王国监察院'],
    causes: ['监察院非法实验'],
    consequences: ['王都加强登记制度'],
    knownBy: ['林凛', '监察院高层'],
    unknownBy: ['吴烬'],
    result: '事故被压下，只留下公开谣言。',
    visibility: 'character-unknown'
  });

  const context = await buildContextPackage({
    storage,
    chapterId: chapter.id,
    taskType: 'continue',
    userInstruction: '参考旧钟塔爆炸，但不要让吴烬知道真相。'
  });

  assert.match(context.assembledText, /力量体系 \/ 政治制度/);
  assert.match(context.assembledText, /未登记灵能者不得进入王都/);
  assert.match(context.assembledText, /林凛 -> 吴烬/);
  assert.match(context.assembledText, /吴烬真实身份/);
  assert.match(context.assembledText, /AI 推测层/);
  assert.match(context.assembledText, /她对官方机构保持戒备/);
  assert.match(context.assembledText, /原因：监察院非法实验/);
  assert.match(context.assembledText, /不知情者：吴烬/);
  assert.doesNotMatch(context.assembledText, /密档编号/);
  assert.doesNotMatch(context.assembledText, /曾被监察院实验/);
});

test('runs deterministic consistency checks against codex facts', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(
    storage.resolve(chapter.filePath),
    '# 第一章\n\n吴烬已经死亡，却在旧城直接复活且毫无代价。幕后黑手正在隔壁房间。\n',
    'utf8'
  );

  const character = await storage.createCharacter({ name: '吴烬' });
  const characterEntry = await storage.findCodexEntryById(character.id);
  assert.ok(characterEntry);
  await storage.writeCodexEntry(characterEntry.relativePath, { ...character, currentState: '已死' });

  const rule = await storage.createWorldRule({ name: '死亡规则', detail: '直接复活' });
  const ruleEntry = await storage.findCodexEntryById(rule.id);
  assert.ok(ruleEntry);
  await storage.writeCodexEntry(ruleEntry.relativePath, { ...rule, importance: 'absolute' });

  const foreshadowing = await storage.createForeshadowing({ name: '隔壁房间', detail: '门后有人。' });
  const foreshadowingEntry = await storage.findCodexEntryById(foreshadowing.id);
  assert.ok(foreshadowingEntry);
  await storage.writeCodexEntry(foreshadowingEntry.relativePath, {
    ...foreshadowing,
    status: 'seeded',
    hiddenTruth: '幕后黑手正在隔壁房间',
    allowRevealToAI: false
  });

  const firstEvent = await storage.createTimelineEvent({ name: '吴烬在旧城' });
  const secondEvent = await storage.createTimelineEvent({ name: '吴烬在码头' });
  const firstEventEntry = await storage.findCodexEntryById(firstEvent.id);
  const secondEventEntry = await storage.findCodexEntryById(secondEvent.id);
  assert.ok(firstEventEntry);
  assert.ok(secondEventEntry);
  await storage.writeCodexEntry(firstEventEntry.relativePath, {
    ...firstEvent,
    storyTime: '第一日夜',
    location: '旧城',
    participants: ['吴烬']
  });
  await storage.writeCodexEntry(secondEventEntry.relativePath, {
    ...secondEvent,
    storyTime: '第一日夜',
    location: '码头',
    participants: ['吴烬']
  });

  const issues = await storage.runDeterministicConsistencyCheck(chapter.id);
  const titles = issues.map((issue) => issue.title).join('\n');
  assert.match(titles, /隐藏真相提前出现/);
  assert.match(titles, /状态需要复核/);
  assert.match(titles, /可能违反绝对世界规则/);
  assert.match(titles, /同一时间出现在多个地点/);
});

test('builds OpenAI-compatible chat completion payload', () => {
  const settings: AISettings = {
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    model: 'test-model',
    temperature: 0.4,
    maxOutputTokens: 512,
    timeoutMs: 10000,
    defaultLanguage: 'zh-CN'
  };

  const payload = buildChatCompletionPayload(settings, {
    taskType: 'continue',
    messages: [{ role: 'user', content: '续写' }]
  });

  assert.equal(payload.model, 'test-model');
  assert.equal(payload.temperature, 0.4);
  assert.equal(payload.max_tokens, 512);
});

test('builds Claude and Gemini payloads', () => {
  const settings: AISettings = {
    provider: 'claude',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-test',
    temperature: 0.2,
    maxOutputTokens: 256,
    timeoutMs: 10000,
    defaultLanguage: 'zh-CN'
  };
  const request = {
    taskType: 'continue' as const,
    messages: [
      { role: 'system' as const, content: '系统规则' },
      { role: 'user' as const, content: '正文' }
    ]
  };

  const claude = buildClaudePayload(settings, request);
  assert.equal(claude.model, 'claude-test');
  assert.equal(claude.system, '系统规则');

  const gemini = buildGeminiPayload({ ...settings, provider: 'gemini' }, request);
  assert.deepEqual(gemini.systemInstruction, { parts: [{ text: '系统规则' }] });
});

test('builds Anthropic endpoints without duplicating /v1', () => {
  assert.equal(anthropicEndpoint('https://api.anthropic.com', 'messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropicEndpoint('https://api.anthropic.com/v1', 'models'), 'https://api.anthropic.com/v1/models');
});

test('validates AI baseUrl before fetch', () => {
  assert.doesNotThrow(() => validateBaseUrl('https://openrouter.ai/api/v1'));
  assert.doesNotThrow(() => validateBaseUrl('http://localhost:1234/v1'));
  assert.throws(() => validateBaseUrl('openrouter.ai/api/v1'), /完整 URL/);
  assert.throws(() => validateBaseUrl('ftp://example.com'), /http/);
});

async function initializedStorage(): Promise<LoreDockStorage> {
  const storage = new LoreDockStorage(await tempRoot());
  await storage.initializeProject({
    title: '测试小说',
    author: '',
    genre: '',
    language: 'zh-CN',
    defaultStyle: '第三人称。',
    createSamples: false
  });
  return storage;
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'loredock-test-'));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
