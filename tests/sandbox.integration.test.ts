import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSandboxOperations, type SandboxOperations } from "../src/operations.ts";
import { isInside, resolveSandboxPaths } from "../src/paths.ts";
import { createFixture, run, shellQuote } from "./helpers.ts";

const describeMac = process.platform === "darwin" ? describe : describe.skip;

describeMac("macOS write boundary", () => {
  let fixture: ReturnType<typeof createFixture>;
  let operations: SandboxOperations;
  beforeEach(() => {
    // Do not put denied targets in /tmp: production policy allows that whole tree.
    // All files are synthetic and are removed after the test.
    fixture = createFixture(homedir());
    operations = createSandboxOperations(resolveSandboxPaths(fixture.workspace, { home: fixture.home }));
  });
  afterEach(async () => {
    await operations.dispose();
    fixture.cleanup();
  });

  it("allows workspace writes and rejects outside writes after cd", async () => {
    const inside = join(fixture.workspace, "allowed");
    const outside = join(fixture.home, "denied");
    assert.equal((await run(operations, fixture.workspace, `printf ok > ${shellQuote(inside)}`)).exitCode, 0);
    assert.equal(readFileSync(inside, "utf8"), "ok");
    const result = await run(operations, fixture.workspace,
      `cd ${shellQuote(fixture.home)} && printf no > ${shellQuote(outside)}`);
    assert.notEqual(result.exitCode, 0);
    assert.ok(!existsSync(outside));
  });

  it("allows cd and reads outside the workspace, not writes", async () => {
    const outside = join(fixture.home, "readable");
    writeFileSync(outside, "read allowed");
    const result = await run(operations, fixture.workspace,
      `cd ${shellQuote(fixture.home)} && /bin/cat readable`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "read allowed");
  });

  it("does not implicitly allow agent configuration or home dotfiles", async () => {
    for (const relativePath of [".pi/agent/auth.json", ".codex/config.toml", ".zshrc", ".gitconfig"]) {
      const target = join(fixture.home, relativePath);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "unchanged");
      const result = await run(operations, fixture.workspace, `printf changed > ${shellQuote(target)}`);
      assert.notEqual(result.exitCode, 0, relativePath);
      assert.equal(readFileSync(target, "utf8"), "unchanged");
    }
  });

  it("rejects symlink writes from the workspace to an outside file", async () => {
    const outside = join(fixture.home, "outside");
    writeFileSync(outside, "unchanged");
    const alias = join(fixture.workspace, "alias");
    symlinkSync(outside, alias);
    const result = await run(operations, fixture.workspace, `printf changed > ${shellQuote(alias)}`);
    assert.notEqual(result.exitCode, 0);
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
  });

  it("supports spaces, quotes, backslashes, Unicode, and regex metacharacters", async () => {
    const workspace = join(fixture.home, '日本語 [x]+.$ work "quoted" \\ \'single\'');
    mkdirSync(workspace);
    await operations.dispose();
    operations = createSandboxOperations(resolveSandboxPaths(workspace, { home: fixture.home }));
    const result = await run(operations, workspace, "printf ok > result");
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(readFileSync(join(workspace, "result"), "utf8"), "ok");
  });

  it("allows the canonical system temporary directories", async () => {
    const paths = resolveSandboxPaths(fixture.workspace, { home: fixture.home });
    assert.ok(paths.writableRoots.every((root) => !isInside(fixture.home, root)));
    // A separate fixture under the system temp directory is outside the workspace.
    const temporary = createFixture();
    try {
      const target = join(temporary.root, "allowed");
      const result = await run(operations, fixture.workspace, `printf ok > ${shellQuote(target)}`);
      assert.equal(result.exitCode, 0);
      assert.equal(readFileSync(target, "utf8"), "ok");
    } finally {
      temporary.cleanup();
    }
  });
});
