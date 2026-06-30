import * as vscode from "vscode";

// Tracks live VS Code command registrations across all kernel/capability
// instances in this extension host. Registering an id disposes any prior
// registration for the same id first, so vscode.commands.registerCommand never
// throws "command already exists" when instances are recreated (e.g. in tests
// or after deactivate/reactivate).
const activeCommandRegistrations = new Map<string, vscode.Disposable>();

export function registerExclusiveCommand(
  command: string,
  callback: (...args: unknown[]) => unknown
): vscode.Disposable {
  const previous = activeCommandRegistrations.get(command);
  if (previous) {
    previous.dispose();
    activeCommandRegistrations.delete(command);
  }

  const registration = vscode.commands.registerCommand(command, callback);
  activeCommandRegistrations.set(command, registration);

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      registration.dispose();
      if (activeCommandRegistrations.get(command) === registration) {
        activeCommandRegistrations.delete(command);
      }
    }
  };
}
