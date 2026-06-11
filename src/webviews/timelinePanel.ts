import * as vscode from 'vscode';
import { LoreDockStorage } from '../core/storage';
import { TimelineDocument, TimelineResolvedView } from '../types';
import { renderTimelineHtml, TimelineWorkbenchState } from './timelinePanelView';

interface TimelineUiState {
  selectedEventId?: string;
  hiddenEventIds?: string[];
}

type TimelineMessage = TimelineUiState & (
  | { command: 'refresh' }
  | { command: 'createEvent'; title?: string; currentDocument?: TimelineDocument }
  | { command: 'switchTimeline'; timelineId: string; currentDocument?: TimelineDocument }
  | { command: 'createRootTimeline'; title: string; calendarName?: string; currentDocument?: TimelineDocument }
  | { command: 'createChildTimeline'; title: string; calendarName?: string; parentTimelineId: string; originEventId: string; currentDocument?: TimelineDocument }
  | { command: 'reanchorTimeline'; timelineId: string; parentTimelineId: string; originEventId: string; currentDocument?: TimelineDocument }
  | { command: 'syncTimelineOrigin'; timelineId: string; currentDocument?: TimelineDocument }
  | { command: 'deleteTimeline'; timelineId: string; currentDocument?: TimelineDocument }
  | { command: 'saveDocument'; document?: TimelineDocument }
  | { command: 'deleteEvent'; eventId: string; timelineId?: string; currentDocument?: TimelineDocument }
  | { command: 'duplicateEvent'; eventId: string; timelineId?: string; currentDocument?: TimelineDocument }
  | { command: 'moveEvents'; timelineId: string; updates: Array<{ id: string; startSortValue: number; endSortValue?: number }>; currentDocument?: TimelineDocument }
);

export async function showTimelineWorkbench(context: vscode.ExtensionContext, storage: LoreDockStorage): Promise<void> {
  await storage.requireManifest();
  const panel = vscode.window.createWebviewPanel('loredock.timelineWorkbench', 'LoreDock 时间线', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  const render = async (timelineId?: string, uiState?: TimelineUiState) => {
    const state = await buildTimelineState(storage, timelineId, uiState);
    panel.webview.html = renderTimelineHtml(state);
  };

  panel.webview.onDidReceiveMessage(async (message: TimelineMessage) => {
    try {
      if ('currentDocument' in message && message.currentDocument?.id) {
        await storage.writeTimelineDocument(message.currentDocument);
      }

      if (message.command === 'refresh') {
        await render(undefined, message);
        return;
      }

      if (message.command === 'switchTimeline') {
        await storage.setActiveTimeline(message.timelineId);
        await render(message.timelineId, { hiddenEventIds: message.hiddenEventIds });
        return;
      }

      if (message.command === 'createRootTimeline') {
        const document = await storage.createTimelineDocument({
          title: message.title,
          calendarName: message.calendarName
        });
        await render(document.id, message);
        return;
      }

      if (message.command === 'createChildTimeline') {
        const document = await storage.createTimelineDocument({
          title: message.title,
          calendarName: message.calendarName,
          parentTimelineId: message.parentTimelineId,
          originEventId: message.originEventId
        });
        await render(document.id, message);
        return;
      }

      if (message.command === 'reanchorTimeline') {
        const document = await storage.reanchorTimeline(message.timelineId, message.parentTimelineId, message.originEventId);
        await render(document.id, message);
        return;
      }

      if (message.command === 'syncTimelineOrigin') {
        const document = await storage.syncTimelineOrigin(message.timelineId);
        await render(document.id, message);
        return;
      }

      if (message.command === 'deleteTimeline') {
        const document = await storage.readTimelineDocument(message.timelineId);
        const childCount = (await storage.listTimelineDocuments()).filter((candidate) => candidate.parentId === document.id || candidate.origin?.parentTimelineId === document.id).length;
        const choice = await vscode.window.showWarningMessage(
          `删除时间线“${document.title}”？${childCount > 0 ? ` ${childCount} 条子时间线会提升为普通根线。` : ''}`,
          { modal: true },
          '删除'
        );
        if (choice !== '删除') {
          await render(document.id, message);
          return;
        }
        const index = await storage.deleteTimelineDocument(document.id);
        await render(index.activeTimelineId, { hiddenEventIds: message.hiddenEventIds });
        return;
      }

      if (message.command === 'createEvent') {
        const document = await storage.readTimelineDocumentIfExists();
        if (!document) {
          await vscode.window.showInformationMessage('请先新建一条时间线。');
          await render(undefined, message);
          return;
        }
        const event = await storage.createTimelineEvent({ name: message.title?.trim() || `未命名事件 ${document.events.length + 1}` }, document.id);
        await render(document.id, { ...message, selectedEventId: event.id });
        return;
      }

      if (message.command === 'saveDocument') {
        if (message.document?.id) {
          await storage.writeTimelineDocument(message.document);
          await render(message.document.id, message);
        } else {
          await render(undefined, message);
        }
        return;
      }

      if (message.command === 'moveEvents') {
        await storage.moveTimelineEvents(message.updates, message.timelineId);
        await render(message.timelineId, message);
        return;
      }

      if (message.command === 'duplicateEvent') {
        const document = await storage.readTimelineDocument(message.timelineId);
        const source = document.events.find((event) => event.id === message.eventId);
        let nextSelectedEventId = message.selectedEventId;
        if (source) {
          const id = `${source.id}-copy-${Date.now().toString(36)}`;
          nextSelectedEventId = id;
          await storage.updateTimelineEvents([{
            ...source,
            id,
            title: `${source.title} 副本`,
            locked: false,
            status: 'planned'
          }], document.id);
        }
        await render(document.id, { ...message, selectedEventId: nextSelectedEventId });
        return;
      }

      if (message.command === 'deleteEvent') {
        const document = await storage.readTimelineDocument(message.timelineId);
        const choice = await vscode.window.showWarningMessage('确定删除这个时间线事件吗？', { modal: true }, '删除');
        if (choice === '删除') {
          await storage.deleteTimelineEvent(message.eventId, document.id);
        }
        await render(document.id, {
          ...message,
          selectedEventId: message.selectedEventId === message.eventId ? undefined : message.selectedEventId,
          hiddenEventIds: message.hiddenEventIds?.filter((id) => id !== message.eventId)
        });
      }
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      await render(undefined, message);
    }
  }, undefined, context.subscriptions);

  await render();
}

async function buildTimelineState(storage: LoreDockStorage, timelineId?: string, uiState: TimelineUiState = {}): Promise<TimelineWorkbenchState> {
  const [view, entries, chapters, timelineDocuments] = await Promise.all([
    storage.getTimelineResolvedView(timelineId),
    storage.listCodexEntries(),
    storage.getFlatChapterRefs(),
    storage.listTimelineDocuments()
  ]);
  return {
    ...view,
    characters: entries.filter((entry) => entry.card.kind === 'character').map((entry) => ({ id: entry.card.id, name: entry.card.name })),
    locations: entries.filter((entry) => entry.card.kind === 'location').map((entry) => ({ id: entry.card.id, name: entry.card.name })),
    chapters: chapters.map((ref) => ({ id: ref.chapter.id, title: `${ref.volume.title} / ${ref.chapter.title}` })),
    scenes: entries.filter((entry) => entry.card.kind === 'scene').map((entry) => ({ id: entry.card.id, name: entry.card.name })),
    beats: entries.filter((entry) => entry.card.kind === 'beat').map((entry) => ({ id: entry.card.id, name: entry.card.name })),
    timelineEventOptions: timelineDocuments.flatMap((document) => document.events.map((event) => ({
      timelineId: document.id,
      timelineTitle: document.title,
      eventId: event.id,
      title: event.title,
      sortValue: event.start.sortValue
    }))),
    selectedEventId: uiState.selectedEventId,
    hiddenEventIds: uiState.hiddenEventIds ?? []
  };
}

export type { TimelineResolvedView };
