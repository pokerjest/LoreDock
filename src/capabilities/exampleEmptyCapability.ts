import type { Capability } from "../kernel/types";

export const exampleEmptyCapability: Capability = {
  id: "example.empty",
  activate(context) {
    const disposable = context.registerCommand("loredock.exampleEmpty.noop", () => {
      context.output.appendLine("example.empty noop command invoked.");
    });

    return [disposable];
  }
};
