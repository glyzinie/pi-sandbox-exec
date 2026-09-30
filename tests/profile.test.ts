import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSandboxProfile } from "../src/profile.ts";

describe("Seatbelt profile", () => {
  it("denies by default and grants writes only to the supplied roots", () => {
    const profile = buildSandboxProfile({
      workspaceRoot: "/work/project",
      writableRoots: ["/work/project", "/private/tmp"],
    });
    assert.ok(profile.includes("(deny default)"));
    assert.ok(profile.includes('(import "bsd.sb")'));
    assert.ok(profile.includes("(allow file-read*)"));
    assert.ok(profile.includes("(allow network*)"));
    assert.ok(profile.includes("(deny process-info*)"));
    assert.equal((profile.match(/\(subpath /g) ?? []).length, 2);
    assert.ok(profile.includes('(subpath "/work/project")'));
    assert.ok(profile.includes('(subpath "/private/tmp")'));
    assert.ok(!profile.includes(".pi"));
    assert.ok(!profile.includes(".codex"));
    assert.ok(!profile.includes("(regex"));
  });

  it("quotes paths as string literals, not regular expressions or profile code", () => {
    const root = '/work/日本語 [x]+.$ "quoted" \\ folder';
    const profile = buildSandboxProfile({ workspaceRoot: root, writableRoots: [root] });
    assert.ok(profile.includes(`(subpath ${JSON.stringify(root)})`));
  });
});
