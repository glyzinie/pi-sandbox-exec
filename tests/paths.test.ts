import assert from "node:assert/strict";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { canonicalDirectory, isInside, resolveSandboxPaths } from "../src/paths.ts";
import { buildSandboxProfile } from "../src/profile.ts";
import { createFixture } from "./helpers.ts";

describe("sandbox paths", () => {
  let fixture: ReturnType<typeof createFixture>;
  beforeEach(() => { fixture = createFixture(); });
  afterEach(() => { fixture.cleanup(); });

  const paths = (cwd = fixture.workspace, temporaryRoots = [fixture.temporary]) =>
    resolveSandboxPaths(cwd, { home: fixture.home, temporaryRoots });

  it("allows only the workspace and explicit temporary roots", () => {
    const resolved = paths();
    assert.equal(resolved.workspaceRoot, fixture.workspace);
    assert.deepEqual(resolved.writableRoots, [fixture.workspace, fixture.temporary]);
    assert.ok(Object.isFrozen(resolved));
    assert.ok(Object.isFrozen(resolved.writableRoots));
  });

  it("uses path components, not string prefixes, for containment", () => {
    assert.ok(isInside(fixture.workspace, fixture.workspace));
    assert.ok(isInside(join(fixture.workspace, "child"), fixture.workspace));
    assert.ok(!isInside(fixture.workspace + "-other", fixture.workspace));
    assert.ok(!isInside(fixture.home, fixture.workspace));
  });

  it("rejects the home directory, its ancestors, and aliases to them", () => {
    for (const path of [fixture.home, fixture.root, parse(fixture.root).root]) {
      assert.throws(() => paths(path), /dedicated project directory/);
    }
    const alias = join(fixture.root, "home-alias");
    symlinkSync(fixture.home, alias);
    assert.throws(() => paths(alias), /dedicated project directory/);
  });

  it("rejects temporary roots that expose the home directory", () => {
    for (const path of [fixture.home, fixture.root, dirname(fixture.root)]) {
      assert.throws(() => paths(fixture.workspace, [path]), /expose the home directory/);
    }
  });

  it("canonicalizes symlinks and deduplicates temporary roots", () => {
    const alias = join(fixture.root, "workspace-alias");
    symlinkSync(fixture.workspace, alias);
    assert.equal(paths(alias).workspaceRoot, fixture.workspace);
    assert.deepEqual(paths(alias, [fixture.temporary, fixture.temporary]).writableRoots, [
      fixture.workspace,
      fixture.temporary,
    ]);
  });

  it("does not re-resolve frozen roots when the profile is generated", () => {
    const resolved = paths();
    const before = buildSandboxProfile(resolved);
    renameSync(fixture.workspace, fixture.workspace + "-original");
    symlinkSync(fixture.home, fixture.workspace);
    assert.equal(buildSandboxProfile(resolved), before);
  });

  it("rejects missing paths, files, and control characters", () => {
    assert.throws(() => paths(join(fixture.home, "missing")), /ENOENT/);
    const file = join(fixture.home, "file");
    writeFileSync(file, "");
    assert.throws(() => canonicalDirectory(file), /not a directory/);
    const newline = join(fixture.home, "line\nbreak");
    mkdirSync(newline);
    assert.throws(() => paths(newline), /control characters/);
  });
});
