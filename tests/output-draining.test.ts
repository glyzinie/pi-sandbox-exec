import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { createSandboxOperations } from "../src/operations.ts";
import { resolveSandboxPaths } from "../src/paths.ts";
import { createFixture, run } from "./helpers.ts";

const describeMac = process.platform === "darwin" ? describe : describe.skip;
const MOCK_PID = 12345;

function createMockExecution(t: TestContext) {
  const fixture = createFixture();
  const child = new childProcess.ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  Object.defineProperty(child, "pid", { value: MOCK_PID });

  t.mock.method(childProcess, "spawn", () => child);
  const kill = t.mock.method(process, "kill", () => true);
  // operations.ts imports spawn as a named ESM binding.
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const operations = createSandboxOperations(resolveSandboxPaths(fixture.workspace, {
    home: fixture.home,
    temporaryRoots: [fixture.temporary],
  }));
  t.after(async () => {
    try {
      // Settle an unfinished execution even if an assertion fails with time frozen.
      child.emit("close", 0, null);
      await operations.dispose();
      fixture.cleanup();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  const running = run(operations, fixture.workspace, "mock command");
  stdout.emit("data", Buffer.from("head"));
  return { child, stdout, stderr, kill, running };
}

describeMac("sandbox output draining", () => {
  it("preserves trailing stdout and stderr and resets the idle deadline", async (t) => {
    const { child, stdout, stderr, kill, running } = createMockExecution(t);
    child.emit("exit", 0, null);

    // Advance virtual time, not real sleep: CI scheduling cannot widen these gaps.
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(40);
      (i % 2 === 0 ? stdout : stderr).emit("data", Buffer.from("tail"));
    }
    t.mock.timers.tick(99);
    assert.equal(kill.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal(kill.mock.callCount(), 1);
    assert.deepEqual(await running, { exitCode: 0, output: "head" + "tail".repeat(5) });
    assert.deepEqual(kill.mock.calls[0]?.arguments, [-MOCK_PID, "SIGKILL"]);
  });

  it("finishes as soon as both output streams end after the shell exits", async (t) => {
    const { child, stdout, stderr, kill, running } = createMockExecution(t);
    child.emit("exit", 7, null);
    stdout.emit("data", Buffer.from("tail"));
    stdout.emit("end");
    t.mock.timers.tick(99);
    assert.equal(kill.mock.callCount(), 0);

    stderr.emit("data", Buffer.from("stderr"));
    stderr.emit("end");
    assert.equal(kill.mock.callCount(), 1);
    assert.deepEqual(await running, { exitCode: 7, output: "headtailstderr" });
  });

  it("stops a quiet descendant at the 100 ms idle deadline", async (t) => {
    const { child, stdout, stderr, kill, running } = createMockExecution(t);
    child.emit("exit", 0, null);
    t.mock.timers.tick(99);
    assert.equal(kill.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal(kill.mock.callCount(), 1);
    assert.deepEqual(await running, { exitCode: 0, output: "head" });
    assert.ok(stdout.destroyed);
    assert.ok(stderr.destroyed);
    assert.equal(stdout.listenerCount("data"), 0);
    assert.equal(stderr.listenerCount("data"), 0);

    t.mock.timers.tick(1_000);
    assert.equal(kill.mock.callCount(), 1);
  });

  it("enforces the one-second drain limit even while output continues", async (t) => {
    const { child, stdout, kill, running } = createMockExecution(t);
    child.emit("exit", 7, null);
    for (let i = 0; i < 19; i++) {
      t.mock.timers.tick(50);
      stdout.emit("data", Buffer.from("tail"));
    }
    t.mock.timers.tick(49);
    assert.equal(kill.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal(kill.mock.callCount(), 1);
    assert.deepEqual(await running, { exitCode: 7, output: "head" + "tail".repeat(19) });
    assert.deepEqual(kill.mock.calls[0]?.arguments, [-MOCK_PID, "SIGKILL"]);

    t.mock.timers.tick(1_000);
    assert.equal(kill.mock.callCount(), 1);
  });
});
