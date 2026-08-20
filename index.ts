import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  BashOperations,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function canonical(path: string): string {
  return realpathSync(resolve(path));
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function profile(workspace: string): string {
  const temp = canonical(tmpdir());

  return `
(version 1)
(deny default)
(import "bsd.sb")

(allow process-fork)
(allow process-exec)
(allow signal (target self))
(deny process-info*)
(allow process-info* (target self))

(allow file-read*)
(allow network*)

(allow file-write*
  (subpath ${JSON.stringify(workspace)})
  (subpath ${JSON.stringify(temp)})
  (subpath "/private/tmp")
  (subpath "/private/var/tmp"))
`;
}

function createSandboxOperations(workspace: string): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout, env }) {
      if (process.platform !== "darwin") {
        return Promise.reject(new Error("pi-sandbox-exec supports macOS only"));
      }

      const current = canonical(cwd);
      if (!isInside(current, workspace)) {
        return Promise.reject(
          new Error(`bash cwd is outside workspace: ${current}`),
        );
      }

      return new Promise((resolvePromise, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        const child = spawn(
          SANDBOX_EXEC,
          ["-p", profile(workspace), "/bin/bash", "-c", command],
          {
            cwd: current,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let settled = false;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", kill);
        };

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };

        const kill = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // Process already exited.
            }
          }
        };

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        if (signal?.aborted) kill();
        else signal?.addEventListener("abort", kill, { once: true });

        if (timeout !== undefined && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout * 1000);
        }

        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (code) => {
          finish(() => {
            if (signal?.aborted) reject(new Error("aborted"));
            else if (timedOut) reject(new Error(`timeout:${timeout}`));
            else resolvePromise({ exitCode: code });
          });
        });
      });
    },
  };
}

export default function sandboxExec(pi: ExtensionAPI) {
  let workspace: string | undefined;
  const baseBash = createBashTool(process.cwd());

  pi.on("session_start", (_event, ctx) => {
    workspace = canonical(ctx.cwd);
  });

  pi.registerTool({
    ...baseBash,
    label: "bash (sandbox-exec)",
    execute(id, params, signal, onUpdate, ctx) {
      if (!workspace) {
        throw new Error("sandbox workspace is not initialized");
      }

      return createBashTool(ctx.cwd, {
        operations: createSandboxOperations(workspace),
      }).execute(id, params, signal, onUpdate);
    },
  });
}
