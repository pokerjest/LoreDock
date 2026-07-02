import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/**/*.test.js",
  launchArgs: [
    "--disable-gpu",
    "--disable-updates",
    "--disable-workspace-trust",
    "--skip-release-notes",
    "--skip-welcome"
  ],
  mocha: {
    timeout: 30000
  }
});
