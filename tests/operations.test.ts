import assert from "node:assert/strict";
import { existsSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSandboxOperations, type SandboxOperations } from "../src/operations.ts";
import { resolveSandboxPaths } from "../src/paths.ts";
import { createFixture, run, shellQuote } from "./helpers.ts";

const describeMac = process.platform === "darwin" ? describe : describe.skip;

describeMac("sandbox process lifecycle", () => {
  let fixture: ReturnType<typeof createFixture>;
  let operations: SandboxOperations;
  beforeEach(() => {
    fixture = createFixture();
    operations = createSandboxOperations(resolveSandboxPaths(fixture.workspace, {
      home: fixture.home,
      temporaryRoots: [fixture.temporary],
    }));
  });
  afterEach(async () => {
    await operations.dispose();
    fixture.cleanup();
  });

  it("streams stdout and stderr and forwards the supplied environment", async () => {
    const result = await run(operations, fixture.workspace,
      'printf "%s" "$SANDBOX_TEST"; printf stderr >&2',
      { env: { PATH: process.env.PATH, SANDBOX_TEST: "stdout" } });
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("stdout"));
    assert.ok(result.output.includes("stderr"));
  });

  it("preserves nonzero exits and normalizes signal termination", async () => {
    assert.equal((await run(operations, fixture.workspace, "exit 7")).exitCode, 7);
    assert.equal((await run(operations, fixture.workspace, "kill -TERM $$")).exitCode, 143);
  });

  it("rejects invalid timeouts rather than overflowing or silently disabling them", async () => {
    for (const timeout of [0, -1, NaN, Infinity, 2_147_484]) {
      await assert.rejects(run(operations, fixture.workspace, "true", { timeout }), /Invalid timeout/);
    }
  });

  it("times out and kills the command's process group", async () => {
    const marker = join(fixture.workspace, "timeout-marker");
    const command = `(sleep 0.4; printf alive > ${shellQuote(marker)}) & wait`;
    await assert.rejects(run(operations, fixture.workspace, command, { timeout: 0.1 }), /timeout:0.1/);
    await delay(450);
    assert.ok(!existsSync(marker));
  });

  it("does not spawn an already aborted command", async () => {
    const marker = join(fixture.workspace, "aborted-marker");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(run(operations, fixture.workspace, `touch ${shellQuote(marker)}`, {
      signal: controller.signal,
    }), /aborted/);
    assert.ok(!existsSync(marker));
  });

  it("aborts a running command", async () => {
    const controller = new AbortController();
    await assert.rejects(run(operations, fixture.workspace, "printf ready; sleep 30", {
      signal: controller.signal,
      onData: () => controller.abort(),
    }), /aborted/);
  });

  it("finishes without waiting for a quiet descendant holding stdout open", async () => {
    const marker = join(fixture.workspace, "background-marker");
    const start = performance.now();
    const result = await run(operations, fixture.workspace,
      `(sleep 0.6; printf alive > ${shellQuote(marker)}) & printf done`);
    assert.equal(result.output, "done");
    assert.ok(performance.now() - start < 2_500);
    await delay(650);
    assert.ok(!existsSync(marker));
  });

  it("preserves trailing output while a descendant is still writing", async () => {
    const result = await run(operations, fixture.workspace,
      "(for i in 1 2 3 4 5; do sleep 0.04; printf tail; done) & printf head");
    assert.equal(result.output, "head" + "tail".repeat(5));
  });

  it("bounds output draining even for continuously writing descendants", async () => {
    const start = performance.now();
    const result = await run(operations, fixture.workspace,
      "(while :; do printf x; sleep 0.02; done) &");
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.length > 0);
    assert.ok(performance.now() - start < 2_500);
  });

  it("rejects an out-of-workspace cwd and a swapped workspace symlink", async () => {
    await assert.rejects(run(operations, fixture.home, "true"), /outside sandbox workspace/);
    renameSync(fixture.workspace, fixture.workspace + "-original");
    symlinkSync(fixture.home, fixture.workspace);
    await assert.rejects(run(operations, fixture.workspace, "true"), /outside sandbox workspace/);
  });

  it("disposes active commands, remains idempotent, and rejects future commands", async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const running = run(operations, fixture.workspace, "printf ready; sleep 30", { onData: ready });
    const rejected = assert.rejects(running, /aborted/);
    await started;
    await operations.dispose();
    await rejected;
    await operations.dispose();
    await assert.rejects(run(operations, fixture.workspace, "true"), /aborted/);
  });

  it("isolates cancellation between concurrent commands", async () => {
    const controller = new AbortController();
    const cancelled = run(operations, fixture.workspace, "printf ready; sleep 30", {
      signal: controller.signal,
      onData: () => controller.abort(),
    });
    const rejected = assert.rejects(cancelled, /aborted/);
    const other = run(operations, fixture.workspace, "sleep 0.1; printf success");
    await rejected;
    assert.equal((await other).output, "success");
  });

  it("turns output callback failures into command failures", async () => {
    await assert.rejects(run(operations, fixture.workspace, "printf ready; sleep 30", {
      onData: () => { throw new Error("output failed"); },
    }), /output failed/);
  });
});

if (process.platform !== "darwin") {
  it("fails closed on unsupported platforms", () => {
    assert.throws(() => createSandboxOperations({
      workspaceRoot: process.cwd(),
      writableRoots: [process.cwd()],
    }), /macOS only/);
  });
}
