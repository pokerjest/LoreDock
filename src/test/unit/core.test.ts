import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LoreDockStorage } from '../../core/storage';
import { decodeTextBuffer, slugify } from '../../core/utils';
import { countWords } from '../../core/wordCount';
import type { BlueprintSyncPreview, ProjectHealthCategory, ProjectHealthReport, ProjectHealthSeverity } from '../../types';

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
  await createTimeline(storage);
  await storage.createTimelineEvent({ name: '旧城封锁' });
  await storage.createScene({ name: '城门冲突', chapterId: 'chapter-001' });
  await storage.createBeat({ name: '发现血迹', chapterId: 'chapter-001' });

  assert.equal((await storage.listCodexEntries('foreshadowing')).length, 1);
  assert.equal((await storage.readTimelineDocument()).events.length, 1);
  assert.equal((await storage.listCodexEntries()).some((entry) => (entry.card as { kind: string }).kind === 'timeline-event'), false);
  assert.equal((await storage.listCodexEntries('scene')).length, 1);
  assert.equal((await storage.listCodexEntries('beat')).length, 1);
});

test('requires creating a timeline before adding timeline events', async () => {
  const storage = await initializedStorage();
  const view = await storage.getTimelineResolvedView();

  assert.equal(view.hasTimeline, false);
  await assert.rejects(storage.createTimelineEvent({ name: '孤立事件' }), /请先创建时间线/);

  const document = await storage.createTimelineDocument({ title: '故事时间线' });
  await storage.createTimelineEvent({ name: '第一件事' }, document.id);

  assert.equal((await storage.readTimelineDocument(document.id)).events.length, 1);
});

test('resets legacy timeline files into an empty v3 timeline store', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  await fs.mkdir(storage.resolve('.loredock/timeline'), { recursive: true });
  await fs.writeFile(storage.resolve('.loredock/timeline/timeline.json'), JSON.stringify({ schemaVersion: 1, id: 'timeline-main', title: '旧时间线', events: [] }, null, 2), 'utf8');
  await fs.writeFile(storage.resolve('.loredock/timeline/child.json'), JSON.stringify({ schemaVersion: 1, id: 'child', title: '旧子线', events: [] }, null, 2), 'utf8');
  const legacyDir = storage.resolve('codex/timeline');
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'timeline-legacy.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'timeline-legacy',
    kind: 'timeline-event',
    name: '旧城封锁',
    aliases: [],
    tags: ['封锁'],
    allowInContext: true,
    sequence: 7,
    storyTime: '第一日夜',
    chapterId: 'chapter-001',
    location: '旧城',
    participants: ['吴烬'],
    result: '城门关闭',
    visibility: 'public',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }, null, 2), 'utf8');

  const view = await storage.getTimelineResolvedView();
  const characterEntry = await storage.findCodexEntryById(character.id);

  assert.equal(view.hasTimeline, false);
  assert.equal(view.index.timelines.length, 0);
  assert.equal(await exists(storage.resolve('.loredock/timeline/timelines.json')), true);
  assert.equal(await exists(storage.resolve('.loredock/timeline/timeline.json')), false);
  assert.equal(await exists(storage.resolve('.loredock/timeline/child.json')), false);
  assert.equal(await exists(legacyDir), false);
  assert.ok(characterEntry);
  assert.equal((await storage.listCodexEntries()).some((entry) => (entry.card as { kind: string }).kind === 'timeline-event'), false);
});

test('timeline events preserve free calendar start and end fields', async () => {
  const storage = await initializedStorage();
  await createTimeline(storage);
  const event = await storage.createTimelineEvent({ name: '创世余烬' });
  const document = await storage.readTimelineDocument();
  await storage.writeTimelineDocument({
    ...document,
    calendar: {
      worldCreatedAt: '太初之前',
      calendarName: '灰历',
      eraLabel: '灰纪',
      note: '自由日历'
    },
    events: document.events.map((item) => item.id === event.id ? {
      ...item,
      type: 'world',
      start: { label: '灰纪元年一月一日', sortValue: 1, era: '灰纪', year: '元年', month: '一月', day: '一日' },
      end: { label: '灰纪元年一月三日', sortValue: 3 },
      location: '世界边界',
      participants: ['造物者']
    } : item)
  });

  const updated = await storage.readTimelineDocument();

  assert.equal(updated.calendar.calendarName, '灰历');
  assert.equal(updated.events[0].type, 'world');
  assert.equal(updated.events[0].end?.label, '灰纪元年一月三日');
});

test('reports timeline invalid references and reversed event range', async () => {
  const storage = await initializedStorage();
  await createTimeline(storage);
  const event = await storage.createTimelineEvent({ name: '倒置事件' });
  const document = await storage.readTimelineDocument();
  await storage.writeTimelineDocument({
    ...document,
    events: document.events.map((item) => item.id === event.id ? {
      ...item,
      start: { label: '后日', sortValue: 30 },
      end: { label: '前日', sortValue: 20 },
      chapterId: 'chapter-missing',
      sceneId: 'scene-missing',
      beatId: 'beat-missing',
      locationId: 'location-missing',
      participantIds: ['character-missing'],
      location: '旧城',
      participants: ['吴烬']
    } : item)
  });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /开始晚于结束/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /关联章节不存在/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /关联场景不存在/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /关联 Beat 不存在/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /关联地点不存在/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /关联人物不存在/), true);
});

test('resolves timeline strong bindings from codex and plan sources', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  const location = await storage.createLocation({ name: '旧城门' });
  const scene = await storage.createScene({ name: '城门冲突' });
  const beat = await storage.createBeat({ name: '守卫盘问' });
  await createTimeline(storage);
  const event = await storage.createTimelineEvent({ name: '入城' });
  const document = await storage.readTimelineDocument();
  await storage.writeTimelineDocument({
    ...document,
    events: document.events.map((item) => item.id === event.id ? {
      ...item,
      type: 'character',
      laneType: 'character',
      participantIds: [character.id],
      locationId: location.id,
      chapterId: 'chapter-001',
      sceneId: scene.id,
      beatId: beat.id,
      start: { label: '第一夜', sortValue: 10 }
    } : item)
  });

  const view = await storage.getTimelineResolvedView();
  const resolved = view.events.find((item) => item.id === event.id);

  assert.equal(resolved?.resolvedParticipants[0], '吴烬');
  assert.equal(resolved?.resolvedLocation, '旧城门');
  assert.match(resolved?.resolvedChapter || '', /第一卷 \/ 第一章/);
  assert.equal(resolved?.resolvedScene, '城门冲突');
  assert.equal(resolved?.resolvedBeat, '守卫盘问');
  assert.equal(view.lanes.some((lane) => lane.type === 'character' && lane.refId === character.id), true);
  assert.equal(view.lanes.some((lane) => lane.type === 'location' && lane.refId === location.id), true);

  const entry = await storage.findCodexEntryById(character.id);
  assert.ok(entry);
  await storage.writeCodexEntry(entry.relativePath, { ...entry.card, name: '吴烬改名' });
  const renamed = await storage.getTimelineResolvedView();
  assert.equal(renamed.events.find((item) => item.id === event.id)?.resolvedParticipants[0], '吴烬改名');
});

test('moves timeline events by sort values without touching locked events', async () => {
  const storage = await initializedStorage();
  await createTimeline(storage);
  const movable = await storage.createTimelineEvent({ name: '可移动' });
  const locked = await storage.createTimelineEvent({ name: '锁定' });
  const document = await storage.readTimelineDocument();
  await storage.writeTimelineDocument({
    ...document,
    events: document.events.map((event) => event.id === locked.id ? { ...event, locked: true, start: { label: '旧时间', sortValue: 20 } } : event)
  });

  await storage.moveTimelineEvents([
    { id: movable.id, startSortValue: 42, endSortValue: 54 },
    { id: locked.id, startSortValue: 99 }
  ]);
  const moved = await storage.readTimelineDocument();

  assert.equal(moved.events.find((event) => event.id === movable.id)?.start.sortValue, 42);
  assert.equal(moved.events.find((event) => event.id === movable.id)?.end?.sortValue, 54);
  assert.equal(moved.events.find((event) => event.id === locked.id)?.start.sortValue, 20);
});

test('reports timeline strong binding conflicts after codex source deletion', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  const location = await storage.createLocation({ name: '旧城' });
  await createTimeline(storage);
  const event = await storage.createTimelineEvent({ name: '失效绑定' });
  const document = await storage.readTimelineDocument();
  await storage.writeTimelineDocument({
    ...document,
    events: document.events.map((item) => item.id === event.id ? {
      ...item,
      type: 'character',
      laneType: 'character',
      participantIds: [character.id],
      locationId: location.id,
      start: { label: '第一夜', sortValue: 10 }
    } : item)
  });
  const characterEntry = await storage.findCodexEntryById(character.id);
  const locationEntry = await storage.findCodexEntryById(location.id);
  assert.ok(characterEntry);
  assert.ok(locationEntry);
  await storage.deleteCodexEntry(characterEntry.relativePath);
  await storage.deleteCodexEntry(locationEntry.relativePath);

  const conflicts = await storage.analyzeTimelineConflicts();
  const report = await storage.buildProjectHealthReport();

  assert.equal(conflicts.some((conflict) => /关联人物不存在/.test(conflict.title)), true);
  assert.equal(conflicts.some((conflict) => /关联地点不存在/.test(conflict.title)), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /关联人物不存在/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /关联地点不存在/), true);
});

test('creates child timelines from parent event origins with ancestor references', async () => {
  const storage = await initializedStorage();
  const parent = await createTimeline(storage);
  const parentEvent = await storage.createTimelineEvent({ name: '立国' }, parent.id);
  const currentParent = await storage.readTimelineDocument(parent.id);
  const alignedParent = await storage.writeTimelineDocument({
    ...currentParent,
    events: currentParent.events.map((event) => event.id === parentEvent.id ? {
      ...event,
      start: { label: '大陆历 300 年', sortValue: 300 },
      location: '大陆',
      participants: ['建国者']
    } : event)
  });

  const child = await storage.createTimelineDocument({
    title: '王国历',
    calendarName: '王国历',
    parentTimelineId: parent.id,
    originEventId: parentEvent.id
  });
  const view = await storage.getTimelineResolvedView(child.id);

  assert.equal(child.parentId, parent.id);
  assert.equal(child.origin?.parentEventId, parentEvent.id);
  assert.equal(child.events.length, 0);
  assert.equal(view.activeTimelineOffset, 300);
  assert.equal(view.originStatus.status, 'ok');
  assert.equal(view.events.some((event) => event.id === parentEvent.id && event.isReference && event.absoluteStartSortValue === 300), true);
  assert.equal(view.events.some((event) => event.timelineId === child.id && !event.isReference), false);
});

test('syncs and reanchors child timeline origins', async () => {
  const storage = await initializedStorage();
  const parent = await createTimeline(storage);
  const firstOrigin = await storage.createTimelineEvent({ name: '王国建立' }, parent.id);
  const secondOrigin = await storage.createTimelineEvent({ name: '迁都' }, parent.id);
  const currentParent = await storage.readTimelineDocument(parent.id);
  const alignedParentForReanchor = await storage.writeTimelineDocument({
    ...currentParent,
    events: currentParent.events.map((event) => event.id === firstOrigin.id
      ? { ...event, start: { label: '大陆 100 年', sortValue: 100 } }
      : event.id === secondOrigin.id
        ? { ...event, start: { label: '大陆 150 年', sortValue: 150 } }
        : event)
  });
  const child = await storage.createTimelineDocument({
    title: '王国历',
    parentTimelineId: parent.id,
    originEventId: firstOrigin.id
  });
  await storage.writeTimelineDocument({
    ...alignedParentForReanchor,
    events: alignedParentForReanchor.events.map((event) => event.id === firstOrigin.id ? { ...event, start: { label: '大陆 120 年', sortValue: 120 } } : event)
  });

  const drifted = await storage.getTimelineResolvedView(child.id);
  assert.equal(drifted.originStatus.status, 'drifted');
  assert.equal(drifted.originStatus.currentParentSortValue, 120);

  await storage.syncTimelineOrigin(child.id);
  const synced = await storage.getTimelineResolvedView(child.id);
  assert.equal(synced.originStatus.status, 'ok');
  assert.equal(synced.activeTimelineOffset, 120);

  await storage.reanchorTimeline(child.id, parent.id, secondOrigin.id);
  const reanchored = await storage.getTimelineResolvedView(child.id);
  assert.equal(reanchored.originStatus.parentEventId, secondOrigin.id);
  assert.equal(reanchored.activeTimelineOffset, 150);
});

test('deletes child timeline documents and falls back to the parent timeline', async () => {
  const storage = await initializedStorage();
  const parent = await createTimeline(storage);
  const origin = await storage.createTimelineEvent({ name: 'origin' }, parent.id);
  const child = await storage.createTimelineDocument({
    title: 'child timeline',
    parentTimelineId: parent.id,
    originEventId: origin.id
  });

  const index = await storage.deleteTimelineDocument(child.id);

  assert.equal(index.activeTimelineId, parent.id);
  assert.equal(index.timelines.some((timeline) => timeline.id === child.id), false);
  assert.equal(await storage.readTimelineDocumentIfExists(child.id), undefined);
  assert.equal(await exists(path.join(storage.workspaceRoot, '.loredock', 'timeline', `${child.id}.json`)), false);
});

test('deletes a root timeline after other timelines exist and promotes children', async () => {
  const storage = await initializedStorage();
  const root = await createTimeline(storage);
  const origin = await storage.createTimelineEvent({ name: 'origin' }, root.id);
  const child = await storage.createTimelineDocument({
    title: 'child timeline',
    parentTimelineId: root.id,
    originEventId: origin.id
  });
  await storage.setActiveTimeline(root.id);

  const index = await storage.deleteTimelineDocument(root.id);
  const promoted = await storage.readTimelineDocument(child.id);
  const refreshed = await storage.readTimelineIndex();
  const view = await storage.getTimelineResolvedView(child.id);

  assert.equal(index.activeTimelineId, child.id);
  assert.equal(promoted.parentId, undefined);
  assert.equal(promoted.origin, undefined);
  assert.equal(refreshed.timelines.some((timeline) => timeline.id === root.id), false);
  assert.equal(view.originStatus.status, 'root');
  assert.equal(await exists(path.join(storage.workspaceRoot, '.loredock', 'timeline', 'timeline.json')), false);
});

test('allows deleting the last timeline and promotes children from any deleted timeline', async () => {
  const storage = await initializedStorage();

  const root = await storage.createTimelineDocument({ title: 'temporary root timeline' });
  const emptyIndex = await storage.deleteTimelineDocument(root.id);
  const emptyView = await storage.getTimelineResolvedView();

  assert.equal(emptyIndex.activeTimelineId, undefined);
  assert.equal(emptyIndex.timelines.length, 0);
  assert.equal(emptyView.hasTimeline, false);
  assert.equal(emptyView.events.length, 0);
  assert.equal(await storage.readTimelineDocumentIfExists(), undefined);
  assert.equal(await exists(path.join(storage.workspaceRoot, '.loredock', 'timeline', `${root.id}.json`)), false);

  const parent = await createTimeline(storage);
  const origin = await storage.createTimelineEvent({ name: 'origin' }, parent.id);
  const child = await storage.createTimelineDocument({
    title: 'child timeline',
    parentTimelineId: parent.id,
    originEventId: origin.id
  });
  const childOrigin = await storage.createTimelineEvent({ name: 'child origin' }, child.id);
  await storage.createTimelineDocument({
    title: 'grandchild timeline',
    parentTimelineId: child.id,
    originEventId: childOrigin.id
  });

  const promotedIndex = await storage.deleteTimelineDocument(child.id);
  const grandchild = (await storage.listTimelineDocuments()).find((document) => document.title === 'grandchild timeline');
  assert.ok(grandchild);
  assert.equal(grandchild.parentId, undefined);
  assert.equal(grandchild.origin, undefined);
  assert.equal(promotedIndex.timelines.some((timeline) => timeline.id === child.id), false);
});

test('reports timeline hierarchy structure issues', async () => {
  const storage = await initializedStorage();
  const parent = await createTimeline(storage);
  const parentEvent = await storage.createTimelineEvent({ name: '纪元起点' }, parent.id);
  const child = await storage.createTimelineDocument({
    title: '破损子线',
    parentTimelineId: parent.id,
    originEventId: parentEvent.id
  });
  await storage.writeTimelineDocument({
    ...child,
    parentId: 'timeline-missing',
    origin: {
      parentTimelineId: parent.id,
      parentEventId: 'event-missing',
      parentSortValue: 99,
      childSortValue: 0,
      label: '失效锚点'
    }
  });
  const cycleA = await storage.createTimelineDocument({ title: '循环 A' });
  const cycleB = await storage.createTimelineDocument({ title: '循环 B' });
  await storage.writeTimelineDocument({ ...cycleA, parentId: cycleB.id });
  await storage.writeTimelineDocument({ ...cycleB, parentId: cycleA.id });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /时间线父级不存在/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /时间线起点事件不存在/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /时间线父级与起点来源不一致/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /时间线形成循环/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /时间线起点事件缺失/), false);
});

test('timeline workbench html keeps simplified default controls and advanced manager controls', async () => {
  const panelSource = await fs.readFile(path.join(process.cwd(), 'src', 'webviews', 'timelinePanel.ts'), 'utf8');
  const viewSource = await fs.readFile(path.join(process.cwd(), 'src', 'webviews', 'timelinePanelView.ts'), 'utf8');
  const source = `${panelSource}\n${viewSource}`;

  for (const id of ['newEvent', 'save', 'refresh', 'timelineSelect', 'openCreateTimeline', 'openTimelineManager', 'emptyTimeline', 'newRootTimeline']) {
    assert.match(source, new RegExp(`id="${id}"`));
  }
  for (const id of ['managerModal', 'newChildTimeline', 'deleteTimeline', 'parentTimelineId', 'originEventId', 'reanchorTimeline', 'syncOrigin', 'originSummary', 'showReferenceEvents', 'referenceEvents']) {
    assert.match(source, new RegExp(`id="${id}"`));
  }
  assert.match(source, /还没有时间线/);
  assert.match(source, /时间线管理/);
  assert.match(source, /\.emptyHero\[hidden\]/);
  assert.match(source, /id="refresh" class="iconButton"/);
  assert.match(source, /postWithCurrent/);
  assert.match(source, /function svgEvents\(\)/);
  assert.match(source, /addEventListener\('pointerdown'/);
  assert.match(source, /classList\?\.contains\('resizeHandle'\)/);
  assert.match(source, /width="16" height="40"/);
  assert.match(source, /id="eventCategories"/);
  assert.match(source, /eventEye/);
  assert.match(source, /hiddenEventIds/);
  assert.match(source, /toggleEventVisibility/);
  assert.match(source, /selectedEventId/);
  assert.match(source, /categoryIcon/);
  assert.match(source, /buildLanesFromEvents\(events\)/);
  assert.match(source, /character-name:/);
  assert.match(source, /participantIds/);
  assert.match(source, /checkboxGroupField\('participantIds'/);
  assert.match(source, /class="checkboxItem"/);
  assert.match(source, /querySelectorAll\('input\[type="checkbox"\]:checked'\)/);
  assert.match(source, /locationId/);
  assert.doesNotMatch(source, /id="resources"/);
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

test('builds reference index across manuscript and plan cards while respecting doNotTrack', async () => {
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
  await storage.createScene({ name: '钟楼相遇', detail: '吴烬在钟楼下等待。', chapterId: chapter.id });
  await storage.createBeat({ name: '旧称刺痛', detail: '灰烬这个别名让吴烬停顿。', chapterId: chapter.id });

  const index = await storage.buildReferenceIndex();
  const names = index.occurrences.map((occurrence) => occurrence.cardName);
  const kinds = index.occurrences.filter((occurrence) => occurrence.cardName === '吴烬').map((occurrence) => occurrence.sourceKind);

  assert.ok(names.includes('吴烬'));
  assert.ok(kinds.includes('chapter'));
  assert.ok(kinds.includes('scene'));
  assert.ok(kinds.includes('beat'));
  assert.equal(names.includes('王都'), false);
  assert.equal((await storage.readReferenceIndex())?.occurrences.length, index.occurrences.length);
});

test('imports outline as independent plan without creating manuscript chapters', async () => {
  const storage = await initializedStorage();
  const beforeManifest = await storage.requireManifest();
  const beforeChapterCount = beforeManifest.volumes.reduce((count, volume) => count + volume.chapters.length, 0);
  const beforeManuscriptFiles = await listFiles(storage.resolve('manuscript'));

  const result = await storage.importOutlineToPlan('# 第一卷\n## 第一章：入城\n### 城门冲突\n- 吴烬被拦下\n- 守卫提到旧案\n');
  const afterManifest = await storage.requireManifest();
  const afterChapterCount = afterManifest.volumes.reduce((count, volume) => count + volume.chapters.length, 0);
  const afterManuscriptFiles = await listFiles(storage.resolve('manuscript'));
  const scenes = await storage.listCodexEntries('scene');
  const beats = await storage.listCodexEntries('beat');

  assert.equal(result.volumes, 1);
  assert.equal(result.outlineChapters, 1);
  assert.equal(result.scenes, 1);
  assert.equal(result.beats, 2);
  assert.equal(afterChapterCount, beforeChapterCount);
  assert.deepEqual(afterManuscriptFiles.sort(), beforeManuscriptFiles.sort());
  assert.equal((await storage.listOutlines()).length, 1);
  assert.equal(scenes.some((entry) => entry.card.kind === 'scene' && !!entry.card.outlineId && !entry.card.chapterId), true);
  assert.equal(beats.some((entry) => entry.card.kind === 'beat' && !!entry.card.outlineId && !entry.card.chapterId), true);
});

test('creates blueprint documents without changing manuscript or manifest', async () => {
  const storage = await initializedStorage();
  const beforeManifest = await storage.requireManifest();
  const beforeManuscriptFiles = await listFiles(storage.resolve('manuscript'));

  const blueprint = await storage.createBlueprint('第一卷蓝图');
  const afterManifest = await storage.requireManifest();
  const afterManuscriptFiles = await listFiles(storage.resolve('manuscript'));

  assert.equal(blueprint.title, '第一卷蓝图');
  assert.ok(blueprint.outlineId);
  assert.ok(blueprint.outlinePath?.startsWith('.loredock/outlines/'));
  assert.deepEqual(afterManifest, beforeManifest);
  assert.deepEqual(afterManuscriptFiles.sort(), beforeManuscriptFiles.sort());
  assert.equal((await storage.listBlueprints()).some((item) => item.id === blueprint.id), true);
  assert.equal((await storage.listOutlines()).some((item) => item.id === blueprint.outlineId), true);
});

test('deletes blueprint documents and their bound outline only', async () => {
  const storage = await initializedStorage();
  const imported = await storage.importOutlineToPlan('# 第一卷\n## 第一章\n### 旧城相遇\n');
  const blueprint = await storage.createBlueprint('临时蓝图');
  const boundOutlineId = blueprint.outlineId;
  const beforeManifest = await storage.requireManifest();
  const beforeManuscriptFiles = await listFiles(storage.resolve('manuscript'));

  await storage.deleteBlueprint(blueprint.id);

  assert.equal((await storage.listBlueprints()).some((item) => item.id === blueprint.id), false);
  assert.equal((await storage.listOutlines()).some((item) => item.id === boundOutlineId), false);
  assert.equal((await storage.listOutlines()).some((item) => item.id === imported.document.id), true);
  assert.deepEqual(await storage.requireManifest(), beforeManifest);
  assert.deepEqual((await listFiles(storage.resolve('manuscript'))).sort(), beforeManuscriptFiles.sort());
});

test('creates blueprint nodes from independent outline without creating manuscript chapters', async () => {
  const storage = await initializedStorage();
  const beforeManifest = await storage.requireManifest();
  const beforeChapterCount = beforeManifest.volumes.reduce((count, volume) => count + volume.chapters.length, 0);
  const beforeManuscriptFiles = await listFiles(storage.resolve('manuscript'));
  const imported = await storage.importOutlineToPlan('# 第一卷\n## 第一章：入城\n### 城门冲突\n- 吴烬被拦下\n- 守卫提到旧案\n');

  const blueprint = await storage.createBlueprintFromOutline(imported.document.id);
  const afterManifest = await storage.requireManifest();
  const afterChapterCount = afterManifest.volumes.reduce((count, volume) => count + volume.chapters.length, 0);
  const afterManuscriptFiles = await listFiles(storage.resolve('manuscript'));

  assert.equal(blueprint.nodes.length, imported.document.nodes.length);
  assert.equal(blueprint.outlineId, imported.document.id);
  assert.ok(blueprint.nodes.every((node) => node.refKind === 'outline-node'));
  assert.ok(blueprint.nodes.every((node) => node.refId?.startsWith(`${imported.document.id}:`)));
  assert.ok(blueprint.nodes.every((node) => node.refPath?.startsWith('.loredock/outlines/')));
  assert.ok(blueprint.edges.length > 0);
  assert.equal(afterChapterCount, beforeChapterCount);
  assert.deepEqual(afterManuscriptFiles.sort(), beforeManuscriptFiles.sort());
});

test('keeps one blueprint per outline document', async () => {
  const storage = await initializedStorage();
  const imported = await storage.importOutlineToPlan('# 第一卷\n## 第一章\n### 旧城相遇\n');

  const first = await storage.createBlueprintFromOutline(imported.document.id);
  const second = await storage.createBlueprintFromOutline(imported.document.id);
  const blueprints = await storage.listBlueprints();

  assert.equal(second.id, first.id);
  assert.equal(blueprints.filter((blueprint) => blueprint.outlineId === imported.document.id).length, 1);
});

test('backfills outline bindings for legacy blueprints', async () => {
  const storage = await initializedStorage();
  await fs.mkdir(storage.resolve('.loredock/blueprints'), { recursive: true });
  await fs.writeFile(
    storage.resolve('.loredock/blueprints/legacy-blueprint.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      id: 'legacy-blueprint',
      title: '旧蓝图',
      nodes: [],
      edges: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }, null, 2)}\n`,
    'utf8'
  );
  assert.equal((await storage.listOutlines()).some((outline) => outline.title === '旧蓝图'), false);

  const state = await storage.getBlueprintPanelState('legacy-blueprint');
  const outlines = await storage.listOutlines();

  assert.equal(state.current.id, 'legacy-blueprint');
  assert.ok(state.current.outlineId);
  assert.equal(outlines.some((outline) => outline.id === state.current.outlineId && outline.title === '旧蓝图'), true);
});

test('adds codex cards to blueprint as reference nodes', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  const entry = await storage.findCodexEntryById(character.id);
  assert.ok(entry);
  const blueprint = await storage.createBlueprint('人物关系蓝图');

  const updated = await storage.addCodexNodeToBlueprint(blueprint.id, entry, { x: 120, y: 240 });
  const node = updated.nodes.find((candidate) => candidate.refId === character.id);

  assert.ok(node);
  assert.equal(node.kind, 'codex');
  assert.equal(node.refKind, 'character');
  assert.equal(node.refPath, entry.relativePath);
  assert.equal(node.x, 120);
  assert.equal(node.y, 240);
});

test('syncs blueprint canvas nodes into its bound outline', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  const entry = await storage.findCodexEntryById(character.id);
  assert.ok(entry);
  const blueprint = await storage.createBlueprint('同步大纲蓝图');
  let updated = await storage.addCodexNodeToBlueprint(blueprint.id, entry, { x: 120, y: 240 });
  updated = await storage.addNoteNodeToBlueprint(updated.id, { x: 20, y: 10 }, '开局提示');
  const outline = (await storage.listOutlines()).find((candidate) => candidate.id === updated.outlineId);

  assert.ok(outline);
  assert.equal(outline.nodes.length, 2);
  assert.deepEqual(outline.nodes.map((node) => node.title), ['开局提示', '吴烬']);
  assert.equal(outline.nodes.every((node) => node.type === 'note'), true);
  assert.match(outline.rawText, /开局提示/);
  assert.match(outline.rawText, /吴烬/);
});

test('persists blueprint node layout and edge metadata', async () => {
  const storage = await initializedStorage();
  const blueprint = await storage.createBlueprint('流程蓝图');

  await storage.writeBlueprint({
    ...blueprint,
    nodes: [
      {
        id: 'node-a',
        kind: 'note',
        title: '开场',
        x: 10,
        y: 20,
        width: 210,
        height: 100,
        note: '先给读者一个钩子。',
        color: '#4e9aef'
      },
      {
        id: 'node-b',
        kind: 'note',
        title: '转折',
        x: 330,
        y: 260,
        width: 240,
        height: 130,
        note: '关系反转。',
        color: '#d77922'
      }
    ],
    edges: [
      {
        id: 'edge-a-b',
        fromNodeId: 'node-a',
        toNodeId: 'node-b',
        type: 'conflicts',
        label: '升级'
      }
    ]
  });

  const saved = await storage.readBlueprint(blueprint.id);

  assert.ok(saved);
  assert.equal(saved.nodes[0].x, 10);
  assert.equal(saved.nodes[1].height, 130);
  assert.equal(saved.nodes[0].note, '先给读者一个钩子。');
  assert.equal(saved.nodes[1].color, '#d77922');
  assert.equal(saved.edges[0].type, 'conflicts');
  assert.equal(saved.edges[0].label, '升级');
});

test('deletes blueprint nodes with connected edges without touching manuscript or outlines', async () => {
  const storage = await initializedStorage();
  const imported = await storage.importOutlineToPlan('# 第一卷\n## 第一章\n### 旧城相遇\n');
  const blueprint = await storage.createBlueprint('删除节点蓝图');
  const beforeManifest = await storage.requireManifest();
  const beforeManuscriptFiles = await listFiles(storage.resolve('manuscript'));
  await storage.writeBlueprint({
    ...blueprint,
    nodes: [
      { id: 'node-a', kind: 'note', title: 'A', x: 0, y: 0, width: 220, height: 104 },
      { id: 'node-b', kind: 'note', title: 'B', x: 260, y: 0, width: 220, height: 104 },
      { id: 'node-c', kind: 'note', title: 'C', x: 520, y: 0, width: 220, height: 104 }
    ],
    edges: [
      { id: 'edge-a-b', fromNodeId: 'node-a', toNodeId: 'node-b', type: 'flow' },
      { id: 'edge-b-c', fromNodeId: 'node-b', toNodeId: 'node-c', type: 'flow' },
      { id: 'edge-a-c', fromNodeId: 'node-a', toNodeId: 'node-c', type: 'supports' }
    ]
  });

  const updated = await storage.deleteBlueprintNodes(blueprint.id, ['node-b']);

  assert.deepEqual(updated.nodes.map((node) => node.id), ['node-a', 'node-c']);
  assert.deepEqual(updated.edges.map((edge) => edge.id), ['edge-a-c']);
  assert.equal((await storage.listOutlines()).some((outline) => outline.id === imported.document.id), true);
  assert.deepEqual(await storage.requireManifest(), beforeManifest);
  assert.deepEqual((await listFiles(storage.resolve('manuscript'))).sort(), beforeManuscriptFiles.sort());
});

test('duplicates blueprint nodes with new ids and offset layout', async () => {
  const storage = await initializedStorage();
  const blueprint = await storage.createBlueprint('复制节点蓝图');
  await storage.writeBlueprint({
    ...blueprint,
    nodes: [
      { id: 'node-a', kind: 'note', title: '开场', x: 10, y: 20, width: 230, height: 120, note: '备注', color: '#4e9aef' }
    ],
    edges: []
  });

  const updated = await storage.duplicateBlueprintNodes(blueprint.id, ['node-a']);
  const copy = updated.nodes.find((node) => node.id !== 'node-a');

  assert.ok(copy);
  assert.equal(copy.title, '开场');
  assert.equal(copy.note, '备注');
  assert.equal(copy.color, '#4e9aef');
  assert.equal(copy.width, 230);
  assert.equal(copy.height, 120);
  assert.equal(copy.x, 46);
  assert.equal(copy.y, 56);
});

test('auto-layouts blueprint flow graph deterministically', async () => {
  const storage = await initializedStorage();
  const blueprint = await storage.createBlueprint('自动布局蓝图');
  await storage.writeBlueprint({
    ...blueprint,
    nodes: [
      { id: 'node-c', kind: 'note', title: 'C', x: 900, y: 900, width: 220, height: 104 },
      { id: 'node-a', kind: 'note', title: 'A', x: 700, y: 700, width: 220, height: 104 },
      { id: 'node-b', kind: 'note', title: 'B', x: 800, y: 800, width: 220, height: 104 }
    ],
    edges: [
      { id: 'edge-a-b', fromNodeId: 'node-a', toNodeId: 'node-b', type: 'flow' },
      { id: 'edge-b-c', fromNodeId: 'node-b', toNodeId: 'node-c', type: 'flow' }
    ]
  });

  const first = await storage.autoLayoutBlueprint(blueprint.id);
  const second = await storage.autoLayoutBlueprint(blueprint.id);
  const byId = new Map(first.nodes.map((node) => [node.id, node]));

  assert.equal(byId.get('node-a')?.x, 80);
  assert.equal(byId.get('node-b')?.x, 380);
  assert.equal(byId.get('node-c')?.x, 680);
  assert.deepEqual(second.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })), first.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })));
});

test('previews blueprint sync pull push conflict and missing states', async () => {
  const storage = await initializedStorage();
  const pullCard = await storage.createCharacter({ name: '拉取人物' });
  const pushCard = await storage.createCharacter({ name: '推送人物' });
  const conflictCard = await storage.createCharacter({ name: '冲突人物' });
  const pullEntry = await storage.findCodexEntryById(pullCard.id);
  const pushEntry = await storage.findCodexEntryById(pushCard.id);
  const conflictEntry = await storage.findCodexEntryById(conflictCard.id);
  assert.ok(pullEntry);
  assert.ok(pushEntry);
  assert.ok(conflictEntry);
  const blueprint = await storage.createBlueprint('同步状态蓝图');
  let updated = await storage.addCodexNodeToBlueprint(blueprint.id, pullEntry, { x: 0, y: 0 });
  updated = await storage.addCodexNodeToBlueprint(updated.id, pushEntry, { x: 260, y: 0 });
  updated = await storage.addCodexNodeToBlueprint(updated.id, conflictEntry, { x: 520, y: 0 });
  const pullNode = updated.nodes.find((node) => node.refId === pullCard.id);
  const pushNode = updated.nodes.find((node) => node.refId === pushCard.id);
  const conflictNode = updated.nodes.find((node) => node.refId === conflictCard.id);
  assert.ok(pullNode);
  assert.ok(pushNode);
  assert.ok(conflictNode);
  await storage.writeCodexEntry(pullEntry.relativePath, { ...pullEntry.card, name: '来源更新人物', summary: '来源更新' });
  await storage.writeCodexEntry(conflictEntry.relativePath, { ...conflictEntry.card, name: '来源冲突人物', summary: '来源冲突' });
  await storage.writeBlueprint({
    ...updated,
    nodes: [
      { ...pullNode },
      { ...pushNode, title: '蓝图更新人物', note: '蓝图更新' },
      { ...conflictNode, title: '蓝图冲突人物', note: '蓝图冲突' },
      {
        id: 'missing-node',
        kind: 'codex',
        title: '缺失人物',
        refKind: 'character',
        refId: 'missing-card',
        x: 780,
        y: 0,
        width: 220,
        height: 104
      }
    ],
    edges: []
  });

  const preview = await storage.previewBlueprintSync(blueprint.id);

  assert.equal(syncStatusForNode(preview, pullNode.id), 'pull');
  assert.equal(syncStatusForNode(preview, pushNode.id), 'push');
  assert.equal(syncStatusForNode(preview, conflictNode.id), 'conflict');
  assert.equal(syncStatusForNode(preview, 'missing-node'), 'missing');
});

test('applies blueprint sync to codex name and summary only', async () => {
  const storage = await initializedStorage();
  const location = await storage.createLocation({ name: '旧城', detail: '古城' });
  const entry = await storage.findCodexEntryById(location.id);
  assert.ok(entry);
  if (entry.card.kind !== 'location') {
    assert.fail('expected a location card');
  }
  await storage.writeCodexEntry(entry.relativePath, { ...entry.card, region: '北境', summary: '旧摘要' });
  const refreshedEntry = await storage.findCodexEntryById(location.id);
  assert.ok(refreshedEntry);
  const blueprint = await storage.createBlueprint('资料同步蓝图');
  const withNode = await storage.addCodexNodeToBlueprint(blueprint.id, refreshedEntry, { x: 0, y: 0 });
  const node = withNode.nodes[0];
  await storage.writeBlueprint({
    ...withNode,
    nodes: [{ ...node, title: '新城', note: '新摘要' }]
  });
  const preview = await storage.previewBlueprintSync(blueprint.id);
  const item = preview.items.find((candidate) => candidate.nodeId === node.id);
  assert.ok(item);

  await storage.applyBlueprintSync(blueprint.id, [{ itemId: item.id, action: 'push' }]);
  const written = await storage.findCodexEntryById(location.id);

  assert.ok(written);
  assert.equal(written.card.name, '新城');
  assert.equal(written.card.summary, '新摘要');
  assert.equal(written.card.kind === 'location' ? written.card.region : '', '北境');
});

test('applies blueprint sync pull and skips conflicts by default', async () => {
  const storage = await initializedStorage();
  const pullCard = await storage.createCharacter({ name: '源人物' });
  const conflictCard = await storage.createCharacter({ name: '冲突源' });
  const pullEntry = await storage.findCodexEntryById(pullCard.id);
  const conflictEntry = await storage.findCodexEntryById(conflictCard.id);
  assert.ok(pullEntry);
  assert.ok(conflictEntry);
  const blueprint = await storage.createBlueprint('拉取同步蓝图');
  let withNodes = await storage.addCodexNodeToBlueprint(blueprint.id, pullEntry, { x: 0, y: 0 });
  withNodes = await storage.addCodexNodeToBlueprint(blueprint.id, conflictEntry, { x: 260, y: 0 });
  const pullNode = withNodes.nodes.find((node) => node.refId === pullCard.id);
  const conflictNode = withNodes.nodes.find((node) => node.refId === conflictCard.id);
  assert.ok(pullNode);
  assert.ok(conflictNode);
  await storage.writeCodexEntry(pullEntry.relativePath, { ...pullEntry.card, name: '源人物更新', summary: '源摘要' });
  await storage.writeCodexEntry(conflictEntry.relativePath, { ...conflictEntry.card, name: '冲突源更新', summary: '源冲突' });
  await storage.writeBlueprint({
    ...withNodes,
    nodes: [
      { ...pullNode },
      { ...conflictNode, title: '蓝图冲突更新', note: '蓝图冲突' }
    ]
  });
  const preview = await storage.previewBlueprintSync(blueprint.id);
  const pullItem = preview.items.find((item) => item.nodeId === pullNode.id);
  assert.ok(pullItem);

  const synced = await storage.applyBlueprintSync(blueprint.id, [{ itemId: pullItem.id, action: 'pull' }]);
  const syncedPullNode = synced.nodes.find((node) => node.id === pullNode.id);
  const skippedConflictNode = synced.nodes.find((node) => node.id === conflictNode.id);

  assert.equal(syncedPullNode?.title, '源人物更新');
  assert.equal(syncedPullNode?.note, '源摘要');
  assert.equal(skippedConflictNode?.title, '蓝图冲突更新');
  assert.equal(skippedConflictNode?.note, '蓝图冲突');
});

test('deletes codex resource and removes all blueprint references', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '待删人物' });
  const entry = await storage.findCodexEntryById(character.id);
  assert.ok(entry);
  const firstBlueprint = await storage.createBlueprint('第一蓝图');
  const secondBlueprint = await storage.createBlueprint('第二蓝图');
  const first = await storage.addCodexNodeToBlueprint(firstBlueprint.id, entry, { x: 0, y: 0 });
  const second = await storage.addCodexNodeToBlueprint(secondBlueprint.id, entry, { x: 0, y: 0 });
  await storage.writeBlueprint({
    ...first,
    nodes: [
      ...first.nodes,
      { id: 'local-node', kind: 'note', title: '保留', x: 260, y: 0, width: 220, height: 104 }
    ],
    edges: [{ id: 'edge-to-card', fromNodeId: 'local-node', toNodeId: first.nodes[0].id, type: 'uses' }]
  });

  const removed = await storage.deleteCodexEntryAndBlueprintReferences(character.id);
  const cleanedFirst = await storage.readBlueprint(firstBlueprint.id);
  const cleanedSecond = await storage.readBlueprint(secondBlueprint.id);

  assert.equal(removed, 2);
  assert.equal(await storage.findCodexEntryById(character.id), undefined);
  assert.equal(cleanedFirst?.nodes.some((node) => node.refId === character.id), false);
  assert.equal(cleanedFirst?.edges.length, 0);
  assert.equal(cleanedFirst?.nodes.some((node) => node.id === 'local-node'), true);
  assert.equal(cleanedSecond?.nodes.some((node) => node.refId === character.id), false);
});

test('deletes outline resource and removes blueprint outline references', async () => {
  const storage = await initializedStorage();
  const imported = await storage.importOutlineToPlan('# 第一卷\n## 第一章\n### 入城\n- 盘问\n');
  const blueprint = await storage.createBlueprintFromOutline(imported.document.id);
  assert.ok(blueprint.nodes.length > 0);

  const removed = await storage.deleteOutlineAndBlueprintReferences(imported.document.id);
  const cleaned = await storage.readBlueprint(blueprint.id);
  const outlines = await storage.listOutlines();

  assert.equal(removed, blueprint.nodes.length);
  assert.equal(outlines.some((outline) => outline.id === imported.document.id), false);
  assert.equal(cleaned?.nodes.some((node) => node.refId?.startsWith(`${imported.document.id}:`) || node.refId === imported.document.id), false);
  assert.equal(cleaned?.edges.length, 0);
});

test('applies blueprint sync delete-source for codex nodes', async () => {
  const storage = await initializedStorage();
  const location = await storage.createLocation({ name: '待同步删除地点' });
  const entry = await storage.findCodexEntryById(location.id);
  assert.ok(entry);
  const blueprint = await storage.createBlueprint('删除同步蓝图');
  const withNode = await storage.addCodexNodeToBlueprint(blueprint.id, entry, { x: 0, y: 0 });
  const node = withNode.nodes[0];
  const preview = await storage.previewBlueprintSync(blueprint.id);
  const item = preview.items.find((candidate) => candidate.nodeId === node.id);
  assert.ok(item);

  const synced = await storage.applyBlueprintSync(blueprint.id, [{ itemId: item.id, action: 'delete-source' }]);

  assert.equal(await storage.findCodexEntryById(location.id), undefined);
  assert.equal(synced.nodes.some((candidate) => candidate.refId === location.id), false);
});

test('applies blueprint sync delete-source for outline nodes', async () => {
  const storage = await initializedStorage();
  const imported = await storage.importOutlineToPlan('# 第一卷\n## 第一章\n### 入城\n- 盘问\n');
  const blueprint = await storage.createBlueprintFromOutline(imported.document.id);
  const node = blueprint.nodes[0];
  const preview = await storage.previewBlueprintSync(blueprint.id);
  const item = preview.items.find((candidate) => candidate.nodeId === node.id);
  assert.ok(item);

  const synced = await storage.applyBlueprintSync(blueprint.id, [{ itemId: item.id, action: 'delete-source' }]);

  assert.equal((await storage.listOutlines()).some((outline) => outline.id === imported.document.id), false);
  assert.equal(synced.nodes.some((candidate) => candidate.refId?.startsWith(`${imported.document.id}:`)), false);
  assert.equal(synced.edges.length, 0);
});

test('syncs blueprint outline node changes back to outline document', async () => {
  const storage = await initializedStorage();
  const imported = await storage.importOutlineToPlan('# 第一卷\n## 第一章\n### 旧城相遇\n- 发现暗门\n');
  const blueprint = await storage.createBlueprintFromOutline(imported.document.id);
  const sceneNode = blueprint.nodes.find((node) => node.title === '旧城相遇');
  assert.ok(sceneNode);
  await storage.writeBlueprint({
    ...blueprint,
    nodes: blueprint.nodes.map((node) => node.id === sceneNode.id ? { ...node, title: '新城相遇', note: '改成雨夜。' } : node)
  });
  const preview = await storage.previewBlueprintSync(blueprint.id);
  const item = preview.items.find((candidate) => candidate.nodeId === sceneNode.id);
  assert.ok(item);

  await storage.applyBlueprintSync(blueprint.id, [{ itemId: item.id, action: 'push' }]);
  const outline = (await storage.listOutlines()).find((candidate) => candidate.id === imported.document.id);
  const outlineNode = outline?.nodes.find((node) => node.id === sceneNode.refId?.split(':')[1]);

  assert.equal(outlineNode?.title, '新城相遇');
  assert.equal(outlineNode?.content, '改成雨夜。');
  assert.match(outline?.rawText || '', /新城相遇/);
});

test('old blueprint nodes without sync snapshots require conflict confirmation', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '源人物' });
  const entry = await storage.findCodexEntryById(character.id);
  assert.ok(entry);
  const blueprint = await storage.createBlueprint('旧蓝图');
  await storage.writeBlueprint({
    ...blueprint,
    nodes: [
      {
        id: 'legacy-node',
        kind: 'codex',
        title: '旧节点标题',
        note: '旧节点备注',
        refKind: 'character',
        refId: character.id,
        refPath: entry.relativePath,
        x: 0,
        y: 0,
        width: 220,
        height: 104
      }
    ],
    edges: []
  });

  const preview = await storage.previewBlueprintSync(blueprint.id);

  assert.equal(syncStatusForNode(preview, 'legacy-node'), 'conflict');
});

test('builds semantic summaries for blueprint nodes from codex and outlines', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  const location = await storage.createLocation({ name: '旧城' });
  const rule = await storage.createWorldRule({ name: '禁火令' });
  const foreshadowing = await storage.createForeshadowing({ name: '灰烬钥匙' });
  const scene = await storage.createScene({ name: '城门冲突' });
  const beat = await storage.createBeat({ name: '守卫盘问' });
  const entries = await Promise.all([
    storage.findCodexEntryById(character.id),
    storage.findCodexEntryById(location.id),
    storage.findCodexEntryById(rule.id),
    storage.findCodexEntryById(foreshadowing.id),
    storage.findCodexEntryById(scene.id),
    storage.findCodexEntryById(beat.id)
  ]);
  assert.ok(entries.every(Boolean));
  const [characterEntry, locationEntry, ruleEntry, foreshadowingEntry, sceneEntry, beatEntry] = entries;
  assert.ok(characterEntry?.card.kind === 'character');
  assert.ok(locationEntry?.card.kind === 'location');
  assert.ok(ruleEntry?.card.kind === 'world-rule');
  assert.ok(foreshadowingEntry?.card.kind === 'foreshadowing');
  assert.ok(sceneEntry?.card.kind === 'scene');
  assert.ok(beatEntry?.card.kind === 'beat');
  await storage.writeCodexEntry(characterEntry.relativePath, { ...characterEntry.card, identity: '失忆旅人', currentState: '进城', goals: '查明旧案', secrets: '真名' });
  await storage.writeCodexEntry(locationEntry.relativePath, { ...locationEntry.card, type: '城门', region: '北境', currentState: '戒严' });
  await storage.writeCodexEntry(ruleEntry.relativePath, { ...ruleEntry.card, category: '律法', importance: 'absolute', content: '夜间不得点火', hidden: true });
  await storage.writeCodexEntry(foreshadowingEntry.relativePath, { ...foreshadowingEntry.card, status: 'seeded', expectedResolveChapterId: 'chapter-999', publicHint: '灰烬发亮' });
  await storage.writeCodexEntry(sceneEntry.relativePath, { ...sceneEntry.card, location: '旧城门', conflict: '身份被怀疑', turn: '旧识出现', outcome: '暂时入城' });
  await storage.writeCodexEntry(beatEntry.relativePath, { ...beatEntry.card, status: 'planned', purpose: '制造压力', content: '守卫盘问' });
  const blueprint = await storage.createBlueprint('语义蓝图');
  let current = blueprint;
  for (const id of [character.id, location.id, rule.id, foreshadowing.id, scene.id, beat.id]) {
    const entry = await storage.findCodexEntryById(id);
    assert.ok(entry);
    current = await storage.addCodexNodeToBlueprint(current.id, entry, { x: current.nodes.length * 260, y: 0 });
  }

  const semantics = await storage.getBlueprintNodeSemantics(blueprint.id);
  const allLines = Object.values(semantics).flatMap((summary) => summary.lines);

  assert.equal(Object.values(semantics).some((summary) => summary.badge === '人物' && summary.lines.includes('身份：失忆旅人')), true);
  assert.equal(allLines.includes('区域：北境'), true);
  assert.equal(allLines.includes('隐藏规则'), true);
  assert.equal(allLines.includes('预计回收：chapter-999'), true);
  assert.equal(allLines.includes('冲突：身份被怀疑'), true);
  assert.equal(allLines.includes('目的：制造压力'), true);
});

test('analyzes blueprint edge semantics without blocking save', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  const location = await storage.createLocation({ name: '旧城' });
  const characterEntry = await storage.findCodexEntryById(character.id);
  const locationEntry = await storage.findCodexEntryById(location.id);
  assert.ok(characterEntry);
  assert.ok(locationEntry);
  const blueprint = await storage.createBlueprint('连线语义蓝图');
  let current = await storage.addCodexNodeToBlueprint(blueprint.id, characterEntry, { x: 0, y: 0 });
  current = await storage.addCodexNodeToBlueprint(current.id, locationEntry, { x: 260, y: 0 });
  const [first, second] = current.nodes;
  await storage.writeBlueprint({
    ...current,
    edges: [
      { id: 'flow-bad', fromNodeId: first.id, toNodeId: second.id, type: 'flow' },
      { id: 'foreshadow-bad', fromNodeId: first.id, toNodeId: second.id, type: 'foreshadows' },
      { id: 'conflict-self', fromNodeId: first.id, toNodeId: first.id, type: 'conflicts' },
      { id: 'conflict-self-dup', fromNodeId: first.id, toNodeId: first.id, type: 'conflicts' }
    ]
  });

  const issues = await storage.analyzeBlueprintEdgeSemantics(blueprint.id);
  const saved = await storage.readBlueprint(blueprint.id);

  assert.ok(saved?.edges.some((edge) => edge.id === 'foreshadow-bad'));
  assert.equal(issues.some((issue) => /剧情流连接了非剧情节点/.test(issue.title)), true);
  assert.equal(issues.some((issue) => /伏笔关系未连接伏笔节点/.test(issue.title)), true);
  assert.equal(issues.some((issue) => /冲突\/阻碍连线自环/.test(issue.title)), true);
  assert.equal(issues.some((issue) => /重复语义连线/.test(issue.title)), true);
});

test('returns field-level diffs in blueprint sync preview', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '源人物' });
  const entry = await storage.findCodexEntryById(character.id);
  assert.ok(entry);
  const blueprint = await storage.createBlueprint('同步差异蓝图');
  const withNode = await storage.addCodexNodeToBlueprint(blueprint.id, entry, { x: 0, y: 0 });
  const node = withNode.nodes[0];
  await storage.writeBlueprint({
    ...withNode,
    nodes: [{ ...node, title: '蓝图人物', note: '蓝图摘要' }]
  });

  const preview = await storage.previewBlueprintSync(blueprint.id);
  const item = preview.items.find((candidate) => candidate.nodeId === node.id);

  assert.ok(item);
  assert.equal(item.fieldDiffs.length, 2);
  assert.equal(item.fieldDiffs.some((diff) => diff.field === 'title' && diff.nodeValue === '蓝图人物' && diff.sourceValue === '源人物' && diff.changed), true);
  assert.equal(item.fieldDiffs.some((diff) => diff.field === 'note' && diff.nodeValue === '蓝图摘要' && diff.sourceValue === '' && diff.changed), true);
});

test('reports blueprint dangling references and bad edges in project health', async () => {
  const storage = await initializedStorage();
  const blueprint = await storage.createBlueprint('坏引用蓝图');
  await storage.writeBlueprint({
    ...blueprint,
    nodes: [
      {
        id: 'missing-card-node',
        kind: 'codex',
        title: '不存在人物',
        refKind: 'character',
        refId: 'missing-character',
        refPath: 'codex/characters/missing-character.json',
        x: 0,
        y: 0,
        width: 220,
        height: 104
      },
      {
        id: 'missing-outline-node',
        kind: 'outline',
        title: '不存在大纲',
        refKind: 'outline',
        refId: 'missing-outline',
        refPath: '.loredock/outlines/missing-outline.json',
        x: 260,
        y: 0,
        width: 220,
        height: 104
      }
    ],
    edges: [
      {
        id: 'bad-edge',
        fromNodeId: 'missing-card-node',
        toNodeId: 'ghost-node',
        type: 'uses'
      }
    ]
  });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'references', 'warning', /蓝图节点资料卡引用不存在/), true);
  assert.equal(hasHealthIssue(report, 'references', 'warning', /蓝图节点大纲引用不存在/), true);
  assert.equal(hasHealthIssue(report, 'references', 'warning', /蓝图同步来源缺失/), true);
  assert.equal(hasHealthIssue(report, 'plan', 'warning', /蓝图连线指向不存在节点/), true);
});

test('reports blueprint edge semantic issues in project health', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  const location = await storage.createLocation({ name: '旧城' });
  const characterEntry = await storage.findCodexEntryById(character.id);
  const locationEntry = await storage.findCodexEntryById(location.id);
  assert.ok(characterEntry);
  assert.ok(locationEntry);
  const blueprint = await storage.createBlueprint('健康连线蓝图');
  let current = await storage.addCodexNodeToBlueprint(blueprint.id, characterEntry, { x: 0, y: 0 });
  current = await storage.addCodexNodeToBlueprint(current.id, locationEntry, { x: 260, y: 0 });
  await storage.writeBlueprint({
    ...current,
    edges: [
      { id: 'bad-flow', fromNodeId: current.nodes[0].id, toNodeId: current.nodes[1].id, type: 'flow' },
      { id: 'bad-foreshadow', fromNodeId: current.nodes[0].id, toNodeId: current.nodes[1].id, type: 'foreshadows' }
    ]
  });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'plan', 'info', /蓝图剧情流连接了非剧情节点/), true);
  assert.equal(hasHealthIssue(report, 'plan', 'info', /蓝图伏笔关系未连接伏笔节点/), true);
});

test('reports blueprint sync conflicts and stale snapshots in project health', async () => {
  const storage = await initializedStorage();
  const pullCard = await storage.createCharacter({ name: '拉取人物' });
  const conflictCard = await storage.createCharacter({ name: '冲突人物' });
  const pullEntry = await storage.findCodexEntryById(pullCard.id);
  const conflictEntry = await storage.findCodexEntryById(conflictCard.id);
  assert.ok(pullEntry);
  assert.ok(conflictEntry);
  const blueprint = await storage.createBlueprint('同步健康蓝图');
  let withNodes = await storage.addCodexNodeToBlueprint(blueprint.id, pullEntry, { x: 0, y: 0 });
  withNodes = await storage.addCodexNodeToBlueprint(blueprint.id, conflictEntry, { x: 260, y: 0 });
  const pullNode = withNodes.nodes.find((node) => node.refId === pullCard.id);
  const conflictNode = withNodes.nodes.find((node) => node.refId === conflictCard.id);
  assert.ok(pullNode);
  assert.ok(conflictNode);
  await storage.writeCodexEntry(pullEntry.relativePath, { ...pullEntry.card, name: '来源更新', summary: '来源摘要' });
  await storage.writeCodexEntry(conflictEntry.relativePath, { ...conflictEntry.card, name: '来源冲突', summary: '来源冲突摘要' });
  await storage.writeBlueprint({
    ...withNodes,
    nodes: [
      { ...pullNode },
      { ...conflictNode, title: '蓝图冲突', note: '蓝图冲突摘要' }
    ]
  });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'plan', 'info', /蓝图同步快照过期/), true);
  assert.equal(hasHealthIssue(report, 'plan', 'warning', /蓝图同步存在未处理冲突/), true);
});

test('lists blueprint panel resources from codex cards only', async () => {
  const storage = await initializedStorage();
  const imported = await storage.importOutlineToPlan('# 第一卷\n## 第一章\n### 旧城相遇\n');
  const location = await storage.createLocation({ name: '旧城' });

  const state = await storage.getBlueprintPanelState();

  assert.ok(state.current.id);
  assert.equal(state.resources.some((resource) => resource.kind === 'outline' && resource.id === imported.document.id), false);
  assert.equal(state.resources.some((resource) => resource.kind === 'location' && resource.id === location.id), true);
});

test('builds a healthy project report without writing project files', async () => {
  const storage = await initializedStorage();

  const report = await storage.buildProjectHealthReport();

  assert.equal(report.projectTitle, '测试小说');
  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.warning, 0);
  assert.equal(report.summary.info, 0);
  assert.equal(report.issues.length, 0);
  assert.equal(await exists(storage.resolve('.loredock/reference-index.json')), false);
});

test('reports missing manuscript chapter files as manuscript errors', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.rm(storage.resolve(chapter.filePath));

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'manuscript', 'error', /章节文件缺失/), true);
});

test('reports invalid scene and beat references as plan warnings', async () => {
  const storage = await initializedStorage();
  await storage.createScene({ name: '失联场景', chapterId: 'missing-chapter' });
  const beat = await storage.createBeat({ name: '失联 Beat', chapterId: 'missing-chapter' });
  const beatEntry = await storage.findCodexEntryById(beat.id);
  assert.ok(beatEntry);
  await storage.writeCodexEntry(beatEntry.relativePath, { ...beat, sceneId: 'missing-scene' });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'plan', 'warning', /场景关联章节不存在/), true);
  assert.equal(hasHealthIssue(report, 'plan', 'warning', /Beat 关联章节不存在/), true);
  assert.equal(hasHealthIssue(report, 'plan', 'warning', /Beat 关联场景不存在/), true);
});

test('reports duplicate codex names and alias collisions as codex warnings', async () => {
  const storage = await initializedStorage();
  await storage.createCharacter({ name: '同名人物' });
  await storage.createCharacter({ name: '同名人物' });
  const source = await storage.createLocation({ name: '别名地点甲' });
  const target = await storage.createLocation({ name: '别名地点乙' });
  const targetEntry = await storage.findCodexEntryById(target.id);
  assert.ok(targetEntry);
  await storage.writeCodexEntry(targetEntry.relativePath, { ...target, aliases: [source.name] });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'codex', 'warning', /同类型资料卡名称重复/), true);
  assert.equal(hasHealthIssue(report, 'codex', 'warning', /资料卡名称\/别名冲突/), true);
});

test('reports timeline participant conflicts across locations', async () => {
  const storage = await initializedStorage();
  await createTimeline(storage);
  const first = await storage.createTimelineEvent({ name: '吴烬在旧城' });
  const second = await storage.createTimelineEvent({ name: '吴烬在码头' });
  const document = await storage.readTimelineDocument();
  await storage.writeTimelineDocument({
    ...document,
    events: document.events.map((event) => event.id === first.id ? {
    ...first,
    start: { label: '第一日夜', sortValue: 10 },
    location: '旧城',
    participants: ['吴烬']
  } : event.id === second.id ? {
    ...second,
    start: { label: '第一日夜', sortValue: 10 },
    location: '码头',
    participants: ['吴烬']
  } : event)
  });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /同一人物同一时间多地点/), true);
});

test('reports unreferenced trackable codex cards as reference info', async () => {
  const storage = await initializedStorage();
  await storage.createLocation({ name: '无人提及的密室' });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'references', 'info', /资料卡暂无引用/), true);
});

test('saves and clears project health baseline fingerprints', async () => {
  const storage = await initializedStorage();
  await storage.createLocation({ name: '暂不处理地点' });

  const before = await storage.buildProjectHealthReport();
  assert.ok(before.newCount > 0);

  const baseline = await storage.saveCurrentProjectHealthBaseline();
  const ignored = await storage.buildProjectHealthReport();

  assert.ok(baseline.fingerprints.length >= before.issues.length);
  assert.equal(ignored.ignoredCount, ignored.issues.length);
  assert.equal(ignored.newCount, 0);

  await storage.clearProjectHealthBaseline();
  const afterClear = await storage.buildProjectHealthReport();
  assert.equal(afterClear.ignoredCount, 0);
  assert.ok(afterClear.newCount > 0);
});

test('previews safe health fixes without mutating files', async () => {
  const storage = await initializedStorage();
  const manifest = await storage.requireManifest();
  const chapter = manifest.volumes[0].chapters[0];
  chapter.summaryId = 'missing-summary';
  await storage.writeManifest(manifest);

  const preview = await storage.previewProjectHealthBasicsFixes();

  assert.equal(preview.actions.some((action) => action.willChange), true);
  assert.equal((await storage.requireManifest()).volumes[0].chapters[0].summaryId, 'missing-summary');
});

test('reports weak plan, timeline, and character structure quality', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await storage.createScene({ name: '弱场景', chapterId: chapter.id });
  await storage.createBeat({ name: '弱 Beat', chapterId: chapter.id });
  await createTimeline(storage);
  await storage.createTimelineEvent({ name: '弱事件' });
  await storage.createCharacter({ name: '弱人物' });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'plan', 'info', /场景规划偏弱/), true);
  assert.equal(hasHealthIssue(report, 'plan', 'info', /Beat 规划偏弱/), true);
  assert.equal(hasHealthIssue(report, 'timeline', 'warning', /时间线事件信息不足/), true);
  assert.equal(hasHealthIssue(report, 'codex', 'info', /人物卡信息偏弱/), true);
});

test('filters noisy reference names and card-level ignored reference terms', async () => {
  const storage = await initializedStorage();
  const chapter = (await storage.requireManifest()).volumes[0].chapters[0];
  await fs.writeFile(storage.resolve(chapter.filePath), '# 第一章\n\n主角穿过旧城。\n', 'utf8');
  await storage.createCharacter({ name: '主角' });
  const location = await storage.createLocation({ name: '旧城' });
  const locationEntry = await storage.findCodexEntryById(location.id);
  assert.ok(locationEntry);
  await storage.writeCodexEntry(locationEntry.relativePath, { ...location, ignoredReferenceTerms: ['旧城'] });

  const index = await storage.buildReferenceIndex();

  assert.equal(index.occurrences.some((occurrence) => occurrence.cardName === '主角'), false);
  assert.equal(index.occurrences.some((occurrence) => occurrence.cardName === '旧城'), false);
});

test('reports schema warnings and unknown codex fields', async () => {
  const storage = await initializedStorage();
  const location = await storage.createLocation({ name: '旧字段地点' });
  const locationEntry = await storage.findCodexEntryById(location.id);
  assert.ok(locationEntry);
  await fs.writeFile(
    storage.resolve(locationEntry.relativePath),
    `${JSON.stringify({ ...location, legacyField: 'old', schemaVersion: 2 }, null, 2)}\n`,
    'utf8'
  );

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'codex', 'warning', /资料卡 schemaVersion 不受支持/), true);
  assert.equal(hasHealthIssue(report, 'codex', 'info', /资料卡存在未知字段/), true);
});

test('builds a project dashboard snapshot', async () => {
  const storage = await initializedStorage();
  await storage.createForeshadowing({ name: '重要伏笔' });

  const dashboard = await storage.getProjectDashboard();

  assert.equal(dashboard.projectTitle, '测试小说');
  assert.equal(dashboard.stats.chapterCount, 1);
  assert.ok(dashboard.health.issues.length > 0);
  assert.ok(dashboard.topIssues.length > 0);
});

test('reports dangling codex source and relationship references', async () => {
  const storage = await initializedStorage();
  const character = await storage.createCharacter({ name: '吴烬' });
  const characterEntry = await storage.findCodexEntryById(character.id);
  assert.ok(characterEntry);
  await storage.writeCodexEntry(characterEntry.relativePath, {
    ...character,
    nestedRefs: ['missing-card'],
    sourceRefs: [
      { kind: 'chapter', id: 'missing-chapter' },
      { kind: 'location', name: '不存在地点' }
    ],
    relationships: [
      {
        target: '不存在人物',
        description: '旧识'
      }
    ]
  });

  const location = await storage.createLocation({ name: '旧城' });
  const locationEntry = await storage.findCodexEntryById(location.id);
  assert.ok(locationEntry);
  await storage.writeCodexEntry(locationEntry.relativePath, {
    ...location,
    relatedCharacters: ['不存在人物'],
    relatedEvents: ['不存在事件']
  });

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'references', 'warning', /嵌套引用不存在/), true);
  assert.equal(hasHealthIssue(report, 'references', 'warning', /来源引用不存在/), true);
  assert.equal(hasHealthIssue(report, 'references', 'warning', /人物关系目标不存在/), true);
  assert.equal(hasHealthIssue(report, 'references', 'warning', /关联事件不存在/), true);
});

test('reports codex files whose directory and kind disagree', async () => {
  const storage = await initializedStorage();
  const location = await storage.createLocation({ name: '错放地点' });
  const locationEntry = await storage.findCodexEntryById(location.id);
  assert.ok(locationEntry);
  await fs.writeFile(
    storage.resolve(locationEntry.relativePath),
    `${JSON.stringify({ ...location, kind: 'character' }, null, 2)}\n`,
    'utf8'
  );

  const report = await storage.buildProjectHealthReport();

  assert.equal(hasHealthIssue(report, 'codex', 'warning', /资料卡目录与类型不一致/), true);
});

test('safely fixes missing summary ids and duplicate scene and beat order', async () => {
  const storage = await initializedStorage();
  const manifest = await storage.requireManifest();
  const chapter = manifest.volumes[0].chapters[0];
  chapter.summaryId = 'missing-summary';
  await storage.writeManifest(manifest);

  const firstScene = await storage.createScene({ name: '第一场', chapterId: chapter.id });
  const secondScene = await storage.createScene({ name: '第二场', chapterId: chapter.id });
  const firstBeat = await storage.createBeat({ name: '第一拍', chapterId: chapter.id });
  const secondBeat = await storage.createBeat({ name: '第二拍', chapterId: chapter.id });
  const secondSceneEntry = await storage.findCodexEntryById(secondScene.id);
  const secondBeatEntry = await storage.findCodexEntryById(secondBeat.id);
  assert.ok(secondSceneEntry);
  assert.ok(secondBeatEntry);
  await storage.writeCodexEntry(secondSceneEntry.relativePath, { ...secondScene, order: firstScene.order });
  await storage.writeCodexEntry(secondBeatEntry.relativePath, { ...secondBeat, order: firstBeat.order });

  const before = await storage.buildProjectHealthReport();
  assert.equal(hasHealthIssue(before, 'manuscript', 'warning', /章节摘要引用缺失/), true);
  assert.equal(hasHealthIssue(before, 'plan', 'warning', /场景顺序重复/), true);
  assert.equal(hasHealthIssue(before, 'plan', 'warning', /Beat顺序重复/), true);

  const fixReport = await storage.fixProjectHealthBasics();
  const after = await storage.buildProjectHealthReport();

  assert.equal(fixReport.actions.some((action) => action.changed), true);
  assert.equal((await storage.requireManifest()).volumes[0].chapters[0].summaryId, undefined);
  assert.equal(hasHealthIssue(after, 'manuscript', 'warning', /章节摘要引用缺失/), false);
  assert.equal(hasHealthIssue(after, 'plan', 'warning', /场景顺序重复/), false);
  assert.equal(hasHealthIssue(after, 'plan', 'warning', /Beat顺序重复/), false);
});

test('round-trips codex zip exports', async () => {
  const storage = await initializedStorage();
  await storage.createCharacter({ name: '吴烬', detail: '主角' });

  const zipPath = await storage.exportCodexZip();
  const zipBuffer = await fs.readFile(storage.resolve(zipPath));
  const target = await initializedStorage();
  const importedCount = await target.importCodexZip(zipBuffer);

  assert.ok(importedCount >= 1);
  assert.equal((await target.listCodexEntries('character')).some((entry) => entry.card.name === '吴烬'), true);
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
    allowRevealInContext: false
  });

  const issues = await storage.runDeterministicConsistencyCheck(chapter.id);
  const titles = issues.map((issue) => issue.title).join('\n');
  assert.match(titles, /隐藏真相提前出现/);
  assert.match(titles, /状态需要复核/);
  assert.match(titles, /可能违反绝对世界规则/);
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

async function createTimeline(storage: LoreDockStorage, title = '故事时间线') {
  return storage.createTimelineDocument({ title, calendarName: '自由日历' });
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'loredock-test-'));
}

function hasHealthIssue(
  report: ProjectHealthReport,
  category: ProjectHealthCategory,
  severity: ProjectHealthSeverity,
  title: RegExp
): boolean {
  return report.issues.some((issue) => issue.category === category && issue.severity === severity && title.test(issue.title));
}

function syncStatusForNode(preview: BlueprintSyncPreview, nodeId: string): string | undefined {
  return preview.items.find((item) => item.nodeId === nodeId)?.status;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute).replace(/\\/g, '/'));
      }
    }
  }
  await visit(root);
  return files;
}
