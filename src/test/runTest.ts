import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite');
  const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'loredock-vscode-test-'));

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      testWorkspace,
      '--disable-extensions',
      '--disable-gpu',
      '--disable-workspace-trust',
      '--skip-welcome'
    ]
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
