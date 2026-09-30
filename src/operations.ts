import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { canonicalDirectory, isInside, type SandboxPaths } from "./paths.ts";
import { buildSandboxProfile } from "./profile.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_TIMEOUT_MS = 2_147_483_647;
const OUTPUT_IDLE_MS = 100;
const OUTPUT_DRAIN_MS = 1_000;

export interface SandboxOperations extends BashOperations {
  dispose(): Promise<void>;
}

function timeoutMilliseconds(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS / 1000) {
    throw new Error(`Invalid timeout: expected seconds between 0 and ${MAX_TIMEOUT_MS / 1000} (exclusive of 0)`);
  }
  return timeout * 1000;
}

function killProcessGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process has already exited.
    }
  }
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal ? 128 + osConstants.signals[signal] : 1);
}

export function createSandboxOperations(paths: SandboxPaths): SandboxOperations {
  if (process.platform !== "darwin") {
    throw new Error("pi-sandbox-exec supports macOS only");
  }
  accessSync(SANDBOX_EXEC, fsConstants.X_OK);
  const sandboxProfile = buildSandboxProfile(paths);
  const shutdown = new AbortController();
  const running = new Set<Promise<{ exitCode: number }>>();

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const combinedSignal = signal
        ? AbortSignal.any([signal, shutdown.signal])
        : shutdown.signal;
      if (combinedSignal.aborted) throw new Error("aborted");
      const timeoutMs = timeoutMilliseconds(timeout);
      const current = canonicalDirectory(cwd);
      if (!isInside(current, paths.workspaceRoot)) {
        throw new Error(`bash cwd is outside sandbox workspace: ${current}`);
      }

      const task = new Promise<{ exitCode: number }>((resolve, reject) => {
        const child = spawn(SANDBOX_EXEC, ["-p", sandboxProfile, "/bin/bash", "-c", command], {
          cwd: current,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let settled = false;
        let exited = false;
        let status = 1;
        let timedOut = false;
        let failure: Error | undefined;
        let stdoutEnded = false;
        let stderrEnded = false;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let idleTimer: NodeJS.Timeout | undefined;
        let drainTimer: NodeJS.Timeout | undefined;
        let stopTimer: NodeJS.Timeout | undefined;

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          clearTimeout(idleTimer);
          clearTimeout(drainTimer);
          clearTimeout(stopTimer);
          combinedSignal.removeEventListener("abort", stop);
          child.stdout?.removeListener("data", handleData);
          child.stderr?.removeListener("data", handleData);

          // A completed tool call must not leave its background process group running.
          killProcessGroup(child);
          child.stdout?.destroy();
          child.stderr?.destroy();

          if (combinedSignal.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else if (failure) reject(failure);
          else resolve({ exitCode: status });
        };

        const stop = () => {
          killProcessGroup(child);
          // Detached descendants can retain pipes even after the shell is killed.
          stopTimer ??= setTimeout(finish, OUTPUT_DRAIN_MS);
        };

        const armIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(finish, OUTPUT_IDLE_MS);
        };

        const handleData = (data: Buffer) => {
          if (settled) return;
          try {
            onData(data);
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            stop();
          }
          if (exited) armIdleTimer();
        };

        const finishIfDrained = () => {
          if (exited && stdoutEnded && stderrEnded) finish();
        };

        child.stdout?.on("data", handleData);
        child.stderr?.on("data", handleData);
        child.stdout?.once("end", () => {
          stdoutEnded = true;
          finishIfDrained();
        });
        child.stderr?.once("end", () => {
          stderrEnded = true;
          finishIfDrained();
        });
        child.once("error", (error) => {
          failure = error;
          finish();
        });
        child.once("exit", (code, exitSignal) => {
          if (settled) return;
          exited = true;
          status = exitStatus(code, exitSignal);
          finishIfDrained();
          if (!settled) {
            // Preserve trailing output, but neither quiet nor chatty descendants
            // may keep a completed shell's tool call alive indefinitely.
            armIdleTimer();
            drainTimer = setTimeout(finish, OUTPUT_DRAIN_MS);
          }
        });
        child.once("close", (code, exitSignal) => {
          status = exitStatus(code, exitSignal);
          finish();
        });

        if (timeoutMs !== undefined) {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs);
        }
        if (combinedSignal.aborted) stop();
        else combinedSignal.addEventListener("abort", stop, { once: true });
      });

      running.add(task);
      try {
        return await task;
      } finally {
        running.delete(task);
      }
    },

    async dispose() {
      shutdown.abort();
      await Promise.allSettled(running);
    },
  };
}
