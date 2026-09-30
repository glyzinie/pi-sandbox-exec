import {
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createSandboxOperations, type SandboxOperations } from "./src/operations.ts";
import { resolveSandboxPaths } from "./src/paths.ts";

export default function sandboxExec(pi: ExtensionAPI) {
  const baseBash = createBashToolDefinition(process.cwd());
  let bash: typeof baseBash | undefined;
  let operations: SandboxOperations | undefined;
  let unavailableReason = "Sandbox is not initialized";

  const dispose = async () => {
    const previous = operations;
    operations = undefined;
    bash = undefined;
    unavailableReason = "Sandbox session has stopped";
    await previous?.dispose();
  };

  pi.on("session_start", async (_event, ctx) => {
    await dispose();
    unavailableReason = "Sandbox initialization failed";
    try {
      const paths = resolveSandboxPaths(ctx.cwd);
      operations = createSandboxOperations(paths);
      bash = createBashToolDefinition(paths.workspaceRoot, { operations });
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
      await operations?.dispose();
      operations = undefined;
      throw error;
    }
  });

  pi.on("session_shutdown", dispose);

  pi.registerTool({
    ...baseBash,
    label: "bash (sandbox-exec)",
    execute(id, params, signal, onUpdate, ctx) {
      if (!bash) throw new Error(unavailableReason);
      return bash.execute(id, params, signal, onUpdate, ctx);
    },
  });
}
