import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export function createFixture(base = tmpdir()) {
  const root = realpathSync(mkdtempSync(join(base, ".pi-sandbox-exec-test-")));
  const home = join(root, "home");
  const workspace = join(home, "workspace");
  const temporary = join(root, "temporary");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(temporary);
  return {
    root,
    home,
    workspace,
    temporary,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export async function run(
  operations: BashOperations,
  cwd: string,
  command: string,
  options: Partial<Parameters<BashOperations["exec"]>[2]> = {},
) {
  let output = "";
  const result = await operations.exec(command, cwd, {
    ...options,
    onData(data) {
      output += data.toString();
      options.onData?.(data);
    },
  });
  return { ...result, output };
}
