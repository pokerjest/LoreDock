import { runExtensionSmokeTests } from './extension.test';

export async function run(): Promise<void> {
  try {
    await runExtensionSmokeTests();
    console.log('LoreDock integration smoke tests passed.');
  } catch (error) {
    console.error('LoreDock integration smoke tests failed.');
    console.error(error);
    throw error;
  }
}
