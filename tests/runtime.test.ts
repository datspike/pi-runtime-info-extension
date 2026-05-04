import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  buildArtifactFields,
  createCurrentRuntimeInfo,
  createSubagentRuntimeInfo,
  findLastAssistantMessage,
  formatArtifactFieldsYaml,
  getSubagentManager,
  getSubagentRuntimeInfo,
  modelToInfo,
} from "../src/runtime.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

/** Создаёт assistant message с нужной provider/model парой. */
function assistant(provider: string, model: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-responses",
    provider,
    model,
    usage,
    stopReason: "stop",
    timestamp: 123,
  };
}

test("modelToInfo returns stable provider model ref", () => {
  "Проверяет стабильное имя модели для YAML-артефактов.";
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
  "Проверяет поиск последнего assistant message в session entries.";
  const first = assistant("openai", "gpt-5.4");
  const last = assistant("zai", "glm-5.1");

  assert.equal(findLastAssistantMessage([
    { type: "message", message: first },
    { type: "message", message: { role: "user", content: "hello" } },
    last,
  ]), last);
});

test("createCurrentRuntimeInfo reads context model thinking and session", () => {
  "Проверяет сбор текущей модели, thinking и session id из ExtensionContext.";
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

test("createSubagentRuntimeInfo reads model and thinking from subagent session", () => {
  "Проверяет внешний runtime-info для записи сабагента.";
  const info = createSubagentRuntimeInfo("agent-1", {
    id: "agent-1",
    type: "reviewer",
    description: "review task",
    status: "completed",
    outputFile: "/tmp/out.txt",
    session: {
      sessionId: "sub-session",
      sessionFile: undefined,
      thinkingLevel: "high",
      model: {
        provider: "openai",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        api: "openai-responses",
        baseUrl: "https://example.test",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100,
        maxTokens: 10,
      },
      messages: [assistant("openai", "gpt-5.3-codex")],
      sessionManager: { getCwd: () => "/tmp/project" },
    },
  });

  assert.equal(info.model_actual, "openai/gpt-5.3-codex");
  assert.equal(info.thinking_actual, "high");
  assert.equal(info.session?.cwd, "/tmp/project");
  assert.equal(info.output_file, "/tmp/out.txt");
});

test("buildArtifactFields preserves requested values", () => {
  "Проверяет различение requested и actual полей для артефакта.";
  const info = createSubagentRuntimeInfo("agent-1", {
    id: "agent-1",
    type: "reviewer",
    description: "review task",
    status: "running",
    session: {
      thinkingLevel: "xhigh",
      model: {
        provider: "openai",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        api: "openai-responses",
        baseUrl: "https://example.test",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100,
        maxTokens: 10,
      },
    },
  });

  const fields = buildArtifactFields(info, {
    model_requested: "zai/glm-5.1",
    thinking_requested: "high",
    verified_at: "2026-05-04T00:00:00.000Z",
  });

  assert.equal(fields.model_requested, "zai/glm-5.1");
  assert.equal(fields.model_actual, "openai/gpt-5.3-codex");
  assert.equal(fields.thinking_requested, "high");
  assert.equal(fields.thinking_actual, "xhigh");
  assert.equal(fields.runtime_agent_id, "agent-1");
  assert.match(formatArtifactFieldsYaml(fields), /model_requested: zai\/glm-5\.1/);
});

test("getSubagentManager detects global manager symbol", () => {
  "Проверяет совместимость с pi-subagents global manager.";
  const key = Symbol.for("pi-subagents:manager");
  const previous = (globalThis as Record<symbol, unknown>)[key];
  (globalThis as Record<symbol, unknown>)[key] = { getRecord: () => undefined };

  try {
    assert.equal(typeof getSubagentManager()?.getRecord, "function");
  } finally {
    if (previous === undefined) {
      delete (globalThis as Record<symbol, unknown>)[key];
    } else {
      (globalThis as Record<symbol, unknown>)[key] = previous;
    }
  }
});

test("getSubagentRuntimeInfo reports missing manager clearly", () => {
  "Проверяет понятную ошибку без активного pi-subagents manager.";
  assert.throws(
    () => getSubagentRuntimeInfo("agent-1", null),
    /pi-subagents manager недоступен/,
  );
});
