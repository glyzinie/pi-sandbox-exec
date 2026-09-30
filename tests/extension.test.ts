import assert from "node:assert/strict";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { createBashToolDefinition, ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import sandboxExec from "../index.ts";
import { createFixture } from "./helpers.ts";

function createHost(cwd: string) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let tool!: ReturnType<typeof createBashToolDefinition>;
  sandboxExec({
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, handler);
    },
    registerTool: (registered: typeof tool) => { tool = registered; },
  } as unknown as ExtensionAPI);

  const ctx = {
    cwd,
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
    model: { provider: "test-provider", id: "test-model" },
    thinkingLevel: "low",
  } as unknown as ExtensionToolContext;

  return {
    tool,
    ctx,
    emit: async (event: string, context = ctx) => {
      await handlers.get(event)?.({ type: event }, context);
    },
    execute: (command: string) => tool.execute("test", { command }, undefined, undefined, ctx),
  };
}

describe("Pi registration", () => {
  it("registers the built-in definition, including renderers, without starting a session", async () => {
    const host = createHost(process.cwd());
    assert.equal(host.tool.name, "bash");
    assert.equal(host.tool.label, "bash (sandbox-exec)");
    assert.ok(host.tool.outputSchema);
    assert.equal(typeof host.tool.renderCall, "function");
    assert.equal(typeof host.tool.renderResult, "function");
    await assert.rejects(async () => host.execute("true"), /not initialized/);
    await host.emit("session_shutdown");
    await host.emit("session_shutdown");
  });
});

const describeMac = process.platform === "darwin" ? describe : describe.skip;

describeMac("Pi session integration", () => {
  let fixture: ReturnType<typeof createFixture>;
  let host: ReturnType<typeof createHost>;
  beforeEach(async () => {
    fixture = createFixture();
    host = createHost(fixture.workspace);
    await host.emit("session_start");
  });
  afterEach(async () => {
    await host.emit("session_shutdown");
    fixture.cleanup();
  });

  it("forwards the live execution context to the built-in tool", async () => {
    const result = await host.execute(
      'printf "%s:%s:%s:%s" "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"',
    );
    assert.equal((result.structuredContent as { output: string }).output,
      "test-session:test-provider:test-model:low");
  });

  it("fails closed after initialization fails instead of reusing an old policy", async () => {
    const ctx = { ...host.ctx, cwd: homedir() };
    await assert.rejects(host.emit("session_start", ctx), /dedicated project directory/);
    await assert.rejects(async () => host.execute("true"), /dedicated project directory/);
    await host.emit("session_start");
    const result = await host.execute("printf recovered");
    assert.equal((result.structuredContent as { output: string }).output, "recovered");
  });

  it("aborts active tools during shutdown and requires reinitialization", async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const running = host.tool.execute("test", { command: "printf ready; sleep 30" },
      undefined, (update) => {
        if (update.content.some((item) => item.type === "text" && item.text.includes("ready"))) ready();
      }, host.ctx);
    const rejected = assert.rejects(running, /Command aborted/);
    await started;
    await host.emit("session_shutdown");
    await rejected;
    await assert.rejects(async () => host.execute("true"), /session has stopped/);
  });
});
