import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  buildArtifactFields,
  createCurrentRuntimeInfo,
  findLastAssistantMessage,
  formatArtifactFieldsYaml,
  getSubagentRuntimeInfo,
  modelToInfo,
  type RuntimeSessionInfo,
  type SubagentRuntimeLookup,
} from "../src/runtime.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const parentSession: RuntimeSessionInfo = {
  id: "parent-session-id",
  file: "/tmp/parent-session.jsonl",
  cwd: "/tmp/project",
};
const tempRoots: string[] = [];

test.after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Создаёт assistant message с нужной provider/model парой. */
function assistant(provider: string, model: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "SECRET MESSAGE BODY" }],
    api: "openai-responses",
    provider,
    model,
    usage,
    stopReason: "stop",
    timestamp: 123,
  };
}

class FakeEventBus {
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

interface RunFixtureOptions {
  runId?: string;
  owner?: string;
  mode?: string;
  state?: string;
  steps?: Array<{ agent: string; sessionFile?: string; status?: string; model?: string; thinking?: string }>;
  sessionLines?: string[];
  sessionFile?: string;
  statusReply?: { text?: string; structuredAsyncDir?: boolean; structuredDetailsAsyncDir?: boolean; crlfDirSpacing?: boolean };
}

async function makeRun(options: RunFixtureOptions = {}): Promise<{
  events: FakeEventBus;
  runId: string;
  asyncDir: string;
  sessionFile: string;
  lookup: (index?: number, owner?: RuntimeSessionInfo) => SubagentRuntimeLookup;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-info-test-"));
  tempRoots.push(root);
  const runId = options.runId ?? "run-owned-1";
  const asyncDir = path.join(root, runId);
  await mkdir(asyncDir, { recursive: true });
  const sessionFile = options.sessionFile ?? path.join(root, "child-session.jsonl");
  const steps = options.steps ?? [{ agent: "worker", sessionFile, status: options.state ?? "complete" }];
  const status = {
    runId,
    sessionId: options.owner ?? parentSession.file,
    cwd: "/tmp/project",
    state: options.state ?? "complete",
    mode: options.mode ?? "single",
    outputFile: path.join(root, "output.md"),
    steps,
  };
  await writeFile(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf8");
  if (options.sessionLines !== undefined) {
    await writeFile(sessionFile, options.sessionLines.join("\n"), "utf8");
  }

  const replyText = options.statusReply?.text
    ?? (options.statusReply?.crlfDirSpacing
      ? `Status target: run ${runId}\r\nRun: ${runId}\r\nState: ${status.state}\r\nDir:  ${asyncDir}  `
      : `Status target: run ${runId}\nRun: ${runId}\nState: ${status.state}\nDir: ${asyncDir}`);
  const events = new FakeEventBus();
  events.on("subagents:rpc:v1:request", (raw) => {
    const request = raw as { requestId: string; method?: string };
    if (request.method !== "status") return;
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      method: "status",
      success: true,
      data: {
        text: replyText,
        ...(options.statusReply?.structuredAsyncDir ? { asyncDir } : {}),
        ...(options.statusReply?.structuredDetailsAsyncDir ? { details: { asyncDir } } : {}),
      },
    });
  });

  return {
    events,
    runId,
    asyncDir,
    sessionFile,
    lookup(index, owner = parentSession) {
      return { events, parentSession: owner, ...(index === undefined ? {} : { index }), timeoutMs: 100 };
    },
  };
}

function sessionEntry(type: string, id: string, parentId: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, id, parentId, timestamp: new Date().toISOString(), ...extra });
}

function sessionHeader(id = "child-session-id", cwd = "/tmp/project"): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd });
}

test("modelToInfo returns stable provider model ref", () => {
  const info = modelToInfo({
    provider: "openai",
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100,
    maxTokens: 10,
  });

  assert.equal(info?.ref, "openai/gpt-5.5");
  assert.equal(info?.reasoning, true);
});

test("findLastAssistantMessage scans entries and raw messages", () => {
  const first = assistant("openai", "gpt-5.4");
  const last = assistant("zai", "glm-5.1");

  assert.equal(findLastAssistantMessage([
    { type: "message", message: first },
    { type: "message", message: { role: "user", content: "hello" } },
    last,
  ]), last);
});

test("createCurrentRuntimeInfo reads context model thinking and session", () => {
  const ctx = {
    cwd: "/tmp/project",
    model: {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100,
      maxTokens: 10,
    },
    sessionManager: {
      getHeader: () => ({ id: "header-id", cwd: "/tmp/project" }),
      getSessionId: () => "session-id",
      getSessionFile: () => "/tmp/session.jsonl",
      getBranch: () => [{ type: "message", message: assistant("openai", "gpt-5.5") }],
    },
  } as any;

  const info = createCurrentRuntimeInfo(ctx, "xhigh");

  assert.equal(info.model?.ref, "openai/gpt-5.5");
  assert.equal(info.thinking.level, "xhigh");
  assert.equal(info.session.id, "session-id");
  assert.equal(info.last_assistant_message?.model, "gpt-5.5");
});

test("owned async run uses session metadata, not status model/thinking or message bodies", async () => {
  const run = await makeRun({
    sessionLines: [
      sessionHeader(),
      sessionEntry("model_change", "entry-1", null, { provider: "openai", modelId: "requested-but-confirmed" }),
      sessionEntry("thinking_level_change", "entry-2", "entry-1", { thinkingLevel: "high" }),
      sessionEntry("message", "entry-3", "entry-2", { message: assistant("cliproxyapi", "gpt-5.6-luna") }),
    ],
    steps: [{ agent: "worker", sessionFile: undefined, status: "complete", model: "wrong/status-model", thinking: "wrong/status-thinking" }],
  });
  // В этом fixture status намеренно сначала не содержит sessionFile; ниже добавляется реальный путь дочерней сессии.
  await writeFile(path.join(run.asyncDir, "status.json"), JSON.stringify({
    runId: run.runId,
    sessionId: parentSession.file,
    cwd: "/tmp/project",
    state: "complete",
    mode: "single",
    outputFile: path.join(run.asyncDir, "output.md"),
    steps: [{ agent: "worker", sessionFile: run.sessionFile, status: "complete", model: "wrong/status-model", thinking: "wrong/status-thinking" }],
  }), "utf8");

  const info = await getSubagentRuntimeInfo(run.runId, run.lookup());

  assert.equal(info.status, "complete");
  assert.equal(info.model_actual, "cliproxyapi/gpt-5.6-luna");
  assert.equal(info.thinking_actual, "high");
  assert.equal(info.last_assistant_message?.provider, "cliproxyapi");
  assert.equal(info.session?.id, "child-session-id");
  assert.equal(JSON.stringify(info).includes("SECRET MESSAGE BODY"), false);
});

test("uses a structured async directory when status projection provides one", async () => {
  const run = await makeRun({
    statusReply: { text: "Run: run-owned-1\\nState: complete", structuredAsyncDir: true },
    sessionLines: [sessionHeader()],
  });
  const info = await getSubagentRuntimeInfo(run.runId, run.lookup());
  assert.equal(info.status, "complete");
  assert.equal(info.session?.id, "child-session-id");
  assert.match(info.confidence, /insufficient/);
});

test("accepts CRLF status text and ignores surrounding path whitespace", async () => {
  const run = await makeRun({
    statusReply: { crlfDirSpacing: true },
    sessionLines: [sessionHeader()],
  });
  const info = await getSubagentRuntimeInfo(run.runId, run.lookup());
  assert.equal(info.status, "complete");
});

test("multi-child run requires an explicit index and then selects that child", async () => {
  const run = await makeRun({
    mode: "parallel",
    steps: [
      { agent: "first", sessionFile: path.join(tmpdir(), "missing-first.jsonl"), status: "complete" },
      { agent: "second", status: "running" },
    ],
  });
  await assert.rejects(() => getSubagentRuntimeInfo(run.runId, run.lookup()), /явный child index/);
  const indexed = await getSubagentRuntimeInfo("run-owned", run.lookup(1));
  assert.equal(indexed.description, "second");
  assert.equal(indexed.agent_id, run.runId);
  assert.equal(indexed.status, "running");
  assert.equal(indexed.model_actual, null);
  assert.match(indexed.confidence, /insufficient/);
});

test("empty run rejects an explicit child index", async () => {
  const run = await makeRun({ steps: [], sessionLines: [] });
  await assert.rejects(() => getSubagentRuntimeInfo(run.runId, run.lookup(0)), /Child index 0 отсутствует/);
});

test("foreign owner is rejected even when status points at a valid run directory", async () => {
  const run = await makeRun({ owner: "/tmp/foreign-parent.jsonl", sessionLines: [sessionHeader()] });
  await assert.rejects(
    () => getSubagentRuntimeInfo(run.runId, run.lookup(undefined, parentSession)),
    /не принадлежит текущей родительской Pi-сессии/,
  );
});

test("missing actual metadata remains unknown instead of copying status fields", async () => {
  const run = await makeRun({
    sessionLines: [sessionHeader()],
    steps: [{ agent: "worker", sessionFile: undefined, status: "running", model: "requested-model", thinking: "requested-thinking" }],
  });
  const info = await getSubagentRuntimeInfo(run.runId, run.lookup());
  assert.equal(info.model, null);
  assert.equal(info.model_actual, null);
  assert.equal(info.thinking, null);
  assert.equal(info.thinking_actual, null);
  assert.match(info.confidence, /insufficient/);
});

test("resumed run reads the active branch from the same child history", async () => {
  const run = await makeRun({
    runId: "resume-run-2",
    sessionLines: [
      sessionHeader("resumed-child"),
      sessionEntry("model_change", "root-model", null, { provider: "openai", modelId: "old-model" }),
      sessionEntry("message", "root-assistant", "root-model", { message: assistant("openai", "old-model") }),
      sessionEntry("model_change", "abandoned-model", "root-assistant", { provider: "openai", modelId: "abandoned-model" }),
      sessionEntry("message", "abandoned-assistant", "abandoned-model", { message: assistant("openai", "abandoned-model") }),
      sessionEntry("model_change", "resume-model", "root-assistant", { provider: "cliproxyapi", modelId: "gpt-5.6-luna" }),
      sessionEntry("thinking_level_change", "resume-thinking", "resume-model", { thinkingLevel: "xhigh" }),
      sessionEntry("message", "resume-assistant", "resume-thinking", { message: assistant("cliproxyapi", "gpt-5.6-luna") }),
    ],
  });
  const info = await getSubagentRuntimeInfo(run.runId, run.lookup());
  assert.equal(info.model_actual, "cliproxyapi/gpt-5.6-luna");
  assert.equal(info.thinking_actual, "xhigh");
  assert.equal(info.last_assistant_message?.model, "gpt-5.6-luna");
});

test("partially written JSONL keeps complete metadata and reports missing fields as unknown", async () => {
  const run = await makeRun({
    sessionLines: [
      sessionHeader(),
      sessionEntry("model_change", "entry-1", null, { provider: "openai", modelId: "gpt-5.5" }),
      '{"type":"thinking_level_change","id":"entry-2","parentId":"entry-1"',
    ],
  });
  const info = await getSubagentRuntimeInfo(run.runId, run.lookup());
  assert.equal(info.model_actual, "openai/gpt-5.5");
  assert.equal(info.thinking_actual, null);
  assert.match(info.confidence, /insufficient/);
});

test("damaged completed JSONL records invalidate branch evidence", async () => {
  const run = await makeRun({
    sessionLines: [
      sessionHeader(),
      sessionEntry("model_change", "root-model", null, { provider: "openai", modelId: "old-model" }),
      '{"type":"message","id":"broken","parentId":"root-model","message":',
      sessionEntry("thinking_level_change", "thinking", "root-model", { thinkingLevel: "high" }),
    ],
  });
  const info = await getSubagentRuntimeInfo(run.runId, run.lookup());
  assert.equal(info.model_actual, null);
  assert.equal(info.thinking_actual, null);
  assert.match(info.confidence, /branch_incomplete/);
});

test("missing parent chain invalidates branch evidence", async () => {
  const run = await makeRun({
    sessionLines: [
      sessionHeader(),
      sessionEntry("model_change", "orphan", "missing-parent", { provider: "openai", modelId: "old-model" }),
      sessionEntry("message", "leaf", "orphan", { message: assistant("openai", "old-model") }),
    ],
  });
  const info = await getSubagentRuntimeInfo(run.runId, run.lookup());
  assert.equal(info.model_actual, null);
  assert.equal(info.last_assistant_message, null);
  assert.match(info.confidence, /branch_incomplete/);
});

test("invalid RPC id is surfaced without reading arbitrary paths", async () => {
  const events = new FakeEventBus();
  events.on("subagents:rpc:v1:request", (raw) => {
    const request = raw as { requestId: string };
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: false,
      error: { code: "not_found", message: "Async run was not found." },
    });
  });
  await assert.rejects(
    () => getSubagentRuntimeInfo("wrong-id", { events, parentSession, timeoutMs: 100 }),
    /not_found: Async run was not found/,
  );
});

test("buildArtifactFields preserves requested values and unknown actuals", () => {
  const info = {
    scope: "subagent",
    agent_id: "agent-1",
    status: "running",
    type: "single",
    description: "worker",
    model: null,
    model_actual: null,
    thinking: null,
    thinking_actual: null,
    session: null,
    output_file: null,
    last_assistant_message: null,
    confidence: "subagent_session_metadata_insufficient",
  } as const;
  const fields = buildArtifactFields(info, {
    model_requested: "zai/glm-5.1",
    thinking_requested: "high",
    verified_at: "2026-05-04T00:00:00.000Z",
  });

  assert.equal(fields.model_requested, "zai/glm-5.1");
  assert.equal(fields.model_actual, null);
  assert.equal(fields.thinking_requested, "high");
  assert.equal(fields.thinking_actual, null);
  assert.equal(fields.runtime_agent_id, "agent-1");
  assert.match(formatArtifactFieldsYaml(fields), /model_requested: zai\/glm-5\.1/);
});

test("missing RPC bridge fails clearly", async () => {
  const events = new FakeEventBus();
  await assert.rejects(
    () => getSubagentRuntimeInfo("agent-1", { events, parentSession, timeoutMs: 5 }),
    /pi-subagents RPC недоступен/,
  );
});

test("corrupted status metadata fails closed", async () => {
  const run = await makeRun({ sessionLines: [sessionHeader()] });
  await writeFile(path.join(run.asyncDir, "status.json"), "{\"runId\":", "utf8");
  await assert.rejects(
    () => getSubagentRuntimeInfo(run.runId, run.lookup()),
    /Не удалось прочитать metadata async run/,
  );
});
