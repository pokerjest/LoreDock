import assert from 'node:assert/strict';
import * as vscode from 'vscode';

export async function runExtensionSmokeTests(): Promise<void> {
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON?.name === 'loredock-vscode');
  assert.ok(extension, 'LoreDock extension should be present in the extension host');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'loredock.initProject',
    'loredock.openSettings',
    'loredock.showManuscriptActions',
    'loredock.showCodexActions',
    'loredock.createVolume',
    'loredock.deleteProject',
    'loredock.deleteVolume',
    'loredock.createChapter',
    'loredock.setChapterStatus',
    'loredock.deleteChapter',
    'loredock.createCharacter',
    'loredock.createLocation',
    'loredock.createWorldRule',
    'loredock.createForeshadowing',
    'loredock.createTimelineEvent',
    'loredock.createScene',
    'loredock.createBeat',
    'loredock.editCodexEntryForm',
    'loredock.filterCodexEntries',
    'loredock.deleteCodexEntry',
    'loredock.showForeshadowingBoard',
    'loredock.showTimelineBoard',
    'loredock.showSceneBeatBoard',
    'loredock.normalizeSceneOrder',
    'loredock.normalizeBeatOrder',
    'loredock.expandBeat',
    'loredock.reviewPendingCodexUpdates',
    'loredock.openCreativeAssistant',
    'loredock.openPlanView',
    'loredock.importOutlineToPlan',
    'loredock.rebuildReferenceIndex',
    'loredock.showReferenceIndex',
    'loredock.openPromptLibrary',
    'loredock.previewPromptTemplate',
    'loredock.showChatThreads',
    'loredock.saveSelectionAsSnippet',
    'loredock.exportCodexZip',
    'loredock.importCodexZip',
    'loredock.reviewPendingInferences',
    'loredock.configureAI',
    'loredock.configureOpenRouter',
    'loredock.configureFromClaudeCli',
    'loredock.selectAIModel',
    'loredock.showAIModelPicker',
    'loredock.diagnoseAIConfig',
    'loredock.preflightAIRequest',
    'loredock.testAIConnection',
    'loredock.openStyleGuide',
    'loredock.configureExportStyle',
    'loredock.setWritingGoals',
    'loredock.importManuscript',
    'loredock.exportManuscript',
    'loredock.showStats',
    'loredock.showAIHistory',
    'loredock.continueChapter',
    'loredock.polishSelection',
    'loredock.generateChapterSummary',
    'loredock.runLocalConsistencyCheck',
    'loredock.checkConsistency'
  ]) {
    assert.ok(commands.includes(command), `${command} should be registered`);
  }
}
