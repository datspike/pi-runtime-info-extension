import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import runtimeInfoExtension from "../src/index.js";
import type { RuntimeEventBus } from "../src/runtime.js";

class FakeEvents implements RuntimeEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(channel: string, handler: (data: unknown) => void): () => void {
    const listeners = this.handlers.get(channel) ?? new Set();
    listeners.add(handler);
    this.handlers.set(channel, listeners);
    return () => listeners.delete(handler);
  }

  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }
}

test("extension registers current, subagent, artifact tools and command on the new lookup path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-info-extension-test-"));
  try {
    const runId = "registration-run";
    const asyncDir = path.join(root, runId);
    const sessionFile = path.join(root, "child-session.jsonl");
    await mkdir(asyncDir, { recursive: true });
    await writeFile(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: "/tmp/project" }),
      JSON.stringify({ type: "model_change", id: "model", parentId: null, provider: "cliproxyapi", modelId: "gpt-5.6-luna" }),
      JSON.stringify({ type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "xhigh" }),
    ].join("\n"), "utf8");
    await writeFile(path.join(asyncDir, "status.json"), JSON.stringify({
      runId,
      sessionId: "/tmp/parent-session.jsonl",
      cwd: "/tmp/project",
      state: "complete",
      mode: "single",
      steps: [{ agent: "worker", sessionFile, status: "complete" }],
    }), "utf8");

    const events = new FakeEvents();
    events.on("subagents:rpc:v1:request", (raw) => {
      const request = raw as { requestId: string; method?: string };
      if (request.method !== "status") return;
      events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: { text: `Run: ${runId}\nDir: ${asyncDir}\nState: complete` },
      });
    });

    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const pi = {
      events,
      getThinkingLevel: () => "xhigh",
      registerTool(definition: any) { tools.set(definition.name, definition); },
      registerCommand(name: string, definition: any) { commands.set(name, definition); },
    } as any;
    runtimeInfoExtension(pi);

    assert.deepEqual([...tools.keys()], ["runtime_info", "subagent_runtime_info", "runtime_artifact_fields"]);
    assert.equal(typeof commands.get("runtime-info")?.handler, "function");

    const ctx = {
      cwd: "/tmp/project",
      hasUI: true,
      ui: { notify() {} },
      model: { provider: "cliproxyapi", id: "gpt-5.6-luna", name: "GPT 5.6 Luna", api: "openai-responses" },
      sessionManager: {
        getHeader: () => ({ id: "parent-header", cwd: "/tmp/project" }),
        getSessionId: () => "parent-session-id",
        getSessionFile: () => "/tmp/parent-session.jsonl",
        getBranch: () => [],
      },
    } as any;

    const subagentResult = await tools.get("subagent_runtime_info").execute("call", { agent_id: runId }, undefined, undefined, ctx);
    const subagentInfo = JSON.parse(subagentResult.content[0].text);
    assert.equal(subagentInfo.model_actual, "cliproxyapi/gpt-5.6-luna");
    assert.equal(subagentInfo.thinking_actual, "xhigh");

    const artifactResult = await tools.get("runtime_artifact_fields").execute("call", { agent_id: runId }, undefined, undefined, ctx);
    const artifact = JSON.parse(artifactResult.content[0].text);
    assert.equal(artifact.fields.runtime_scope, "subagent");
    assert.equal(artifact.fields.model_actual, "cliproxyapi/gpt-5.6-luna");

    await commands.get("runtime-info").handler(`${runId} 0`, ctx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
