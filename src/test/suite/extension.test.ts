import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
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
    'loredock.openTimelineWorkbench',
    'loredock.showSceneBeatBoard',
    'loredock.normalizeSceneOrder',
    'loredock.normalizeBeatOrder',
    'loredock.reviewPendingCodexUpdates',
    'loredock.openPlanView',
    'loredock.openBlueprintOutline',
    'loredock.openBlueprintForOutline',
    'loredock.openOutlineSource',
    'loredock.importOutlineToPlan',
    'loredock.rebuildReferenceIndex',
    'loredock.showReferenceIndex',
    'loredock.showProjectHealth',
    'loredock.previewProjectHealthFixes',
    'loredock.fixProjectHealth',
    'loredock.saveProjectHealthBaseline',
    'loredock.clearProjectHealthBaseline',
    'loredock.exportCodexZip',
    'loredock.importCodexZip',
    'loredock.openStyleGuide',
    'loredock.configureExportStyle',
    'loredock.setWritingGoals',
    'loredock.importManuscript',
    'loredock.exportManuscript',
    'loredock.showStats',
    'loredock.showProjectDashboard',
    'loredock.runLocalConsistencyCheck'
  ]) {
    assert.ok(commands.includes(command), `${command} should be registered`);
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspaceRoot, 'integration test should have a workspace folder');
  await vscode.commands.executeCommand('loredock.initProject');
  await vscode.commands.executeCommand('loredock.openBlueprintOutline');
  const blueprintFiles = await fs.readdir(path.join(workspaceRoot, '.loredock', 'blueprints'));
  assert.ok(blueprintFiles.some((file) => file.endsWith('.json')), 'empty blueprint panel should create a blueprint document');
}
