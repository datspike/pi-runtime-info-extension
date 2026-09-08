import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RUNTIME_INFO_SOURCE = "pi-runtime-info";

export interface RuntimeModelInfo {
  provider: string;
  id: string;
  name: string;
  ref: string;
  api?: string;
  reasoning?: boolean;
}

export interface RuntimeThinkingInfo {
  level: string;
}

export interface RuntimeSessionInfo {
  id: string | null;
  file: string | null;
  cwd: string;
}

export interface AssistantMessageInfo {
  provider: string;
  model: string;
  response_model?: string;
  api?: string;
  timestamp?: number;
}

export interface CurrentRuntimeInfo {
  scope: "current_session";
  model: RuntimeModelInfo | null;
  thinking: RuntimeThinkingInfo;
  session: RuntimeSessionInfo;
  last_assistant_message: AssistantMessageInfo | null;
  confidence: string;
}

export interface SubagentRuntimeInfo {
  scope: "subagent";
  agent_id: string;
  status: string;
  type: string;
  description: string;
  model: RuntimeModelInfo | null;
  model_actual: string | null;
  thinking: RuntimeThinkingInfo | null;
  thinking_actual: string | null;
  session: RuntimeSessionInfo | null;
  output_file: string | null;
  last_assistant_message: AssistantMessageInfo | null;
  confidence: string;
}

export interface RuntimeArtifactFields {
  model_requested: string | null;
  model_actual: string | null;
  thinking_requested: string | null;
  thinking_actual: string | null;
  runtime_verified_at: string;
  runtime_info_source: string;
  runtime_info_confidence: string;
  runtime_scope: "current_session" | "subagent";
  runtime_agent_id?: string;
}

export interface ArtifactFieldParams {
  model_requested?: string;
  thinking_requested?: string;
  verified_at?: string;
}

export interface RuntimeEventBus {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => (() => void) | void;
}

export interface SubagentRuntimeLookup {
  /** Публичная шина событий Pi для версионированного RPC seam pi-subagents. */
  events: RuntimeEventBus;
  /** Идентификатор родительской сессии, которой принадлежит async run. */
  parentSession: RuntimeSessionInfo;
  /** Индекс дочернего процесса для multi-child async run; без него допускается только один child. */
  index?: number;
  /** Короткий тестовый seam; рабочие вызовы используют таймаут по умолчанию. */
  timeoutMs?: number;
}

const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
const DEFAULT_RPC_TIMEOUT_MS = 2_000;

interface RecordLike {
  [key: string]: unknown;
}

interface AsyncStatusStep {
  index: number;
  agent: string;
  status: string;
  sessionFile: string | null;
}

interface AsyncStatusSnapshot {
  runId: string;
  sessionId: string;
  cwd: string;
  state: string;
  mode: string;
  outputFile: string | null;
  sessionFile: string | null;
  steps: AsyncStatusStep[];
}

interface SessionNode {
  id: string;
  parentId: string | null;
  type: string;
  model?: RuntimeModelInfo;
  thinking?: string;
  assistant?: AssistantMessageInfo;
}

interface SessionMetadata {
  available: boolean;
  file: string;
  id: string | null;
  cwd: string;
  branchComplete: boolean;
  model: RuntimeModelInfo | null;
  modelSource: "assistant_metadata" | "model_change" | null;
  thinking: string | null;
  lastAssistant: AssistantMessageInfo | null;
}

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function absolutePath(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && path.isAbsolute(text) ? text : undefined;
}

function modelInfoFromParts(provider: unknown, id: unknown, api?: unknown): RuntimeModelInfo | null {
  const providerText = nonEmptyString(provider);
  const idText = nonEmptyString(id);
  if (!providerText || !idText) return null;
  return {
    provider: providerText,
    id: idText,
    name: idText,
    ref: `${providerText}/${idText}`,
    api: nonEmptyString(api),
  };
}

/** Возвращает стабильное строковое имя модели provider/id. */
export function formatModelRef(model: RuntimeModelInfo | null | undefined): string | null {
  if (!model) return null;
  return `${model.provider}/${model.id}`;
}

/** Преобразует модель Pi в компактный JSON для артефактов. */
export function modelToInfo(model: Model<any> | undefined): RuntimeModelInfo | null {
  if (!model) return null;
  return {
    provider: String(model.provider),
    id: String(model.id),
    name: model.name ? String(model.name) : String(model.id),
    ref: `${String(model.provider)}/${String(model.id)}`,
    api: model.api ? String(model.api) : undefined,
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
  };
}

/** Проверяет, что значение похоже на assistant message из Pi-сессии. */
function isAssistantMessage(value: unknown): value is AssistantMessage {
  return Boolean(value && typeof value === "object" && (value as { role?: unknown }).role === "assistant");
}

/** Достаёт message из session entry или возвращает сам message. */
function unwrapMessage(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const maybeEntry = value as { type?: unknown; message?: unknown };
  if (maybeEntry.type === "message" && maybeEntry.message) return maybeEntry.message;
  return value;
}

/** Находит последний assistant message в списке entries или messages. */
export function findLastAssistantMessage(values: readonly unknown[]): AssistantMessage | null {
  for (let index = values.length - 1; index >= 0; index--) {
    const message = unwrapMessage(values[index]);
    if (isAssistantMessage(message)) return message;
  }
  return null;
}

/** Преобразует assistant message в безопасную краткую форму. */
export function assistantMessageToInfo(message: AssistantMessage | null): AssistantMessageInfo | null {
  if (!message) return null;
  return {
    provider: String(message.provider),
    model: String(message.model),
    response_model: message.responseModel ? String(message.responseModel) : undefined,
    api: message.api ? String(message.api) : undefined,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
  };
}

/** Считывает сведения о текущей сессии из ExtensionContext. */
export function getCurrentSessionInfo(ctx: ExtensionContext): RuntimeSessionInfo {
  const header = ctx.sessionManager.getHeader();
  return {
    id: ctx.sessionManager.getSessionId() ?? header?.id ?? null,
    file: ctx.sessionManager.getSessionFile() ?? null,
    cwd: ctx.cwd,
  };
}

/** Возвращает уровень thinking, выбранный в текущей Pi-сессии. */
function getCurrentThinkingLevel(piThinkingLevel: string | undefined): RuntimeThinkingInfo {
  return { level: piThinkingLevel ?? "unknown" };
}

/** Вычисляет уровень доверия для текущей сессии. */
function getCurrentConfidence(lastAssistant: AssistantMessageInfo | null): string {
  return lastAssistant
    ? "selected_model_from_extension_context_with_last_assistant_message"
    : "selected_model_from_extension_context";
}

/** Собирает runtime-info для текущей сессии. */
export function createCurrentRuntimeInfo(ctx: ExtensionContext, thinkingLevel: string | undefined): CurrentRuntimeInfo {
  const lastAssistant = assistantMessageToInfo(findLastAssistantMessage(ctx.sessionManager.getBranch()));
  return {
    scope: "current_session",
    model: modelToInfo(ctx.model),
    thinking: getCurrentThinkingLevel(thinkingLevel),
    session: getCurrentSessionInfo(ctx),
    last_assistant_message: lastAssistant,
    confidence: getCurrentConfidence(lastAssistant),
  };
}

function rpcReplyEvent(requestId: string): string {
  return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

function rpcFailureMessage(value: unknown): string {
  const reply = asRecord(value);
  const error = asRecord(reply?.error);
  const code = nonEmptyString(error?.code);
  const message = nonEmptyString(error?.message) ?? "pi-subagents RPC request failed.";
  return code ? `${code}: ${message}` : message;
}

async function requestSubagentStatus(agentId: string, lookup: SubagentRuntimeLookup): Promise<string> {
  const requestId = randomUUID();
  const timeoutMs = lookup.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const replyChannel = rpcReplyEvent(requestId);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => finish(new Error("pi-subagents RPC недоступен: не получен ответ status.")), timeoutMs);
    const finish = (error?: Error, text?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      if (error) reject(error);
      else resolve(text ?? "");
    };

    try {
      unsubscribe = lookup.events.on(replyChannel, (raw) => {
        const reply = asRecord(raw);
        if (reply?.success === true) {
          const data = asRecord(reply.data);
          const text = nonEmptyString(data?.text);
          if (!text) {
            finish(new Error("pi-subagents RPC вернул status без текстового результата."));
            return;
          }
          finish(undefined, text);
          return;
        }
        finish(new Error(rpcFailureMessage(raw)));
      }) ?? undefined;
      const params: RecordLike = { id: agentId };
      lookup.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        method: "status",
        params,
        source: { extension: RUNTIME_INFO_SOURCE },
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function statusLine(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`^${escaped}: (.+)$`, "m"))?.[1];
}

async function readAsyncStatus(asyncDir: string, fallbackCwd: string): Promise<AsyncStatusSnapshot> {
  const statusPath = path.join(asyncDir, "status.json");
  let parsed: RecordLike;
  try {
    const raw = await readFile(statusPath, "utf8");
    const value = JSON.parse(raw);
    const record = asRecord(value);
    if (!record) throw new Error("status.json must contain an object");
    parsed = record;
  } catch (error) {
    throw new Error(`Не удалось прочитать metadata async run: ${error instanceof Error ? error.message : String(error)}`);
  }

  const runId = nonEmptyString(parsed.runId);
  const sessionId = nonEmptyString(parsed.sessionId);
  if (!runId || !sessionId) throw new Error("status.json не содержит runId или sessionId.");
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.flatMap((value, offset): AsyncStatusStep[] => {
      const step = asRecord(value);
      if (!step) return [];
      return [{
        index: typeof step.index === "number" && Number.isInteger(step.index) && step.index >= 0 ? step.index : offset,
        agent: nonEmptyString(step.agent) ?? "unknown",
        status: nonEmptyString(step.status) ?? "unknown",
        sessionFile: absolutePath(step.sessionFile) ?? null,
      }];
    })
    : [];
  const topSessionFile = absolutePath(parsed.sessionFile) ?? null;
  if (steps.length === 0 && topSessionFile) {
    steps.push({ index: 0, agent: "unknown", status: nonEmptyString(parsed.state) ?? "unknown", sessionFile: topSessionFile });
  }
  if (new Set(steps.map((step) => step.index)).size !== steps.length) {
    throw new Error("status.json содержит неоднозначные child indexes.");
  }
  return {
    runId,
    sessionId,
    cwd: nonEmptyString(parsed.cwd) ?? fallbackCwd,
    state: nonEmptyString(parsed.state) ?? "unknown",
    mode: nonEmptyString(parsed.mode) ?? "async",
    outputFile: absolutePath(parsed.outputFile) ?? null,
    sessionFile: topSessionFile,
    steps,
  };
}

function assistantMetadataToInfo(message: RecordLike): AssistantMessageInfo | null {
  if (message.role !== "assistant") return null;
  const provider = nonEmptyString(message.provider);
  const model = nonEmptyString(message.model);
  if (!provider || !model) return null;
  return {
    provider,
    model,
    response_model: nonEmptyString(message.responseModel),
    api: nonEmptyString(message.api),
    timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
  };
}

function parseSessionNode(value: unknown): SessionNode | null {
  const entry = asRecord(value);
  if (!entry || entry.type === "session") return null;
  const id = nonEmptyString(entry.id);
  const parentIdValue = entry.parentId === null ? null : nonEmptyString(entry.parentId);
  if (!id || (entry.parentId !== null && !parentIdValue)) return null;
  const node: SessionNode = {
    id,
    parentId: parentIdValue ?? null,
    type: nonEmptyString(entry.type) ?? "unknown",
  };
  if (node.type === "model_change") {
    node.model = modelInfoFromParts(entry.provider, entry.modelId) ?? undefined;
  } else if (node.type === "thinking_level_change") {
    node.thinking = nonEmptyString(entry.thinkingLevel);
  } else if (node.type === "message") {
    const message = asRecord(entry.message);
    node.assistant = message ? assistantMetadataToInfo(message) ?? undefined : undefined;
  }
  return node;
}

async function readSessionMetadata(sessionFile: string, fallbackCwd: string): Promise<SessionMetadata> {
  let stream;
  try {
    stream = createReadStream(sessionFile, { encoding: "utf8" });
  } catch {
    return {
      available: false,
      file: sessionFile,
      id: null,
      cwd: fallbackCwd,
      branchComplete: false,
      model: null,
      modelSource: null,
      thinking: null,
      lastAssistant: null,
    };
  }
  let sessionId: string | null = null;
  let cwd = fallbackCwd;
  const nodes: SessionNode[] = [];
  const byId = new Map<string, SessionNode>();
  let malformedTreeEntry = false;
  const processLine = (line: string, complete: boolean): void => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (complete) malformedTreeEntry = true;
      return;
    }
    const entry = asRecord(value);
    if (!entry) {
      if (complete) malformedTreeEntry = true;
      return;
    }
    if (entry.type === "session") {
      sessionId = nonEmptyString(entry.id) ?? sessionId;
      cwd = nonEmptyString(entry.cwd) ?? cwd;
      return;
    }
    const node = parseSessionNode(entry);
    if (!node) {
      malformedTreeEntry = true;
      return;
    }
    if (byId.has(node.id)) malformedTreeEntry = true;
    byId.set(node.id, node);
    nodes.push(node);
  };
  try {
    let buffer = "";
    for await (const chunk of stream) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        processLine(buffer.slice(0, newlineIndex).replace(/\r$/, ""), true);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer) processLine(buffer, false);
  } catch {
    return {
      available: false,
      file: sessionFile,
      id: sessionId,
      cwd,
      branchComplete: false,
      model: null,
      modelSource: null,
      thinking: null,
      lastAssistant: null,
    };
  }

  let branchComplete = !malformedTreeEntry;
  const activePath: SessionNode[] = [];
  const leaf = nodes.at(-1);
  const seen = new Set<string>();
  let current = leaf;
  while (current) {
    if (seen.has(current.id)) {
      branchComplete = false;
      break;
    }
    seen.add(current.id);
    activePath.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
    if (!current && activePath.at(-1)?.parentId !== null) branchComplete = false;
  }
  activePath.reverse();

  let model: RuntimeModelInfo | null = null;
  let modelSource: SessionMetadata["modelSource"] = null;
  let thinking: string | null = null;
  let lastAssistant: AssistantMessageInfo | null = null;
  if (branchComplete) {
    for (const node of activePath) {
      if (node.model) {
        model = node.model;
        modelSource = "model_change";
      }
      if (node.assistant) {
        lastAssistant = node.assistant;
        model = modelInfoFromParts(node.assistant.provider, node.assistant.model, node.assistant.api);
        modelSource = model ? "assistant_metadata" : modelSource;
      }
      if (node.thinking) thinking = node.thinking;
    }
  }

  return {
    available: true,
    file: sessionFile,
    id: sessionId,
    cwd,
    branchComplete,
    model,
    modelSource,
    thinking,
    lastAssistant,
  };
}

function sessionConfidence(metadata: SessionMetadata, hasSessionFile: boolean): string {
  if (!hasSessionFile || !metadata.available) return "subagent_session_metadata_insufficient_session_file_unavailable";
  if (!metadata.branchComplete) return "subagent_session_metadata_insufficient_branch_incomplete";
  const sources = [metadata.modelSource, metadata.thinking ? "thinking_level_change" : null].filter((value): value is string => Boolean(value));
  if (!metadata.model || !metadata.thinking) {
    return `subagent_session_metadata_insufficient${sources.length ? `_${sources.join("_and_")}` : ""}`;
  }
  return `subagent_session_${sources.join("_and_")}`;
}

function createSubagentRuntimeInfo(
  agentId: string,
  status: AsyncStatusSnapshot,
  step: AsyncStatusStep,
  metadata: SessionMetadata,
): SubagentRuntimeInfo {
  const hasSessionFile = Boolean(step.sessionFile);
  const model = metadata.model;
  const thinking = metadata.thinking ? { level: metadata.thinking } : null;
  const session = hasSessionFile
    ? { id: metadata.id, file: metadata.file, cwd: metadata.cwd || status.cwd }
    : null;
  return {
    scope: "subagent",
    agent_id: agentId,
    status: step.status,
    type: status.mode,
    description: step.agent,
    model,
    model_actual: formatModelRef(model),
    thinking,
    thinking_actual: metadata.thinking,
    session,
    output_file: status.outputFile,
    last_assistant_message: metadata.lastAssistant,
    confidence: sessionConfidence(metadata, hasSessionFile),
  };
}

/** Загружает runtime-info async-сабагента через RPC нового pi-subagents с проверкой владельца. */
export async function getSubagentRuntimeInfo(agentId: string, lookup: SubagentRuntimeLookup): Promise<SubagentRuntimeInfo> {
  const normalizedId = nonEmptyString(agentId);
  if (!normalizedId) throw new Error("ID сабагента должен быть непустой строкой.");
  if (!lookup.parentSession.id && !lookup.parentSession.file) {
    throw new Error("Текущая родительская Pi-сессия не имеет проверяемого идентификатора.");
  }

  const statusText = await requestSubagentStatus(normalizedId, lookup);
  const asyncDir = absolutePath(statusLine(statusText, "Dir"));
  if (!asyncDir) throw new Error("pi-subagents status не вернул безопасный путь async run.");
  const status = await readAsyncStatus(asyncDir, lookup.parentSession.cwd);
  if (path.basename(asyncDir) !== status.runId || !(status.runId === normalizedId || status.runId.startsWith(normalizedId))) {
    throw new Error(`Async run '${normalizedId}' не совпал с подтверждённым runId.`);
  }

  const owners = new Set([lookup.parentSession.id, lookup.parentSession.file].filter((value): value is string => Boolean(value)));
  if (!owners.has(status.sessionId)) {
    throw new Error(`Async run '${status.runId}' не принадлежит текущей родительской Pi-сессии.`);
  }

  const steps = status.steps;
  if (lookup.index !== undefined && (!Number.isInteger(lookup.index) || lookup.index < 0)) {
    throw new Error(`Child index ${String(lookup.index)} отсутствует в async run '${status.runId}'.`);
  }
  if (steps.length === 0) {
    if (lookup.index !== undefined) {
      throw new Error(`Child index ${String(lookup.index)} отсутствует в async run '${status.runId}'.`);
    }
    return createSubagentRuntimeInfo(status.runId, status, { index: 0, agent: "unknown", status: status.state, sessionFile: null }, {
      available: false,
      file: "",
      id: null,
      cwd: status.cwd,
      branchComplete: false,
      model: null,
      modelSource: null,
      thinking: null,
      lastAssistant: null,
    });
  }
  if (lookup.index !== undefined && !steps.some((step) => step.index === lookup.index)) {
    throw new Error(`Child index ${String(lookup.index)} отсутствует в async run '${status.runId}'.`);
  }
  if (lookup.index === undefined && steps.length > 1) {
    throw new Error(`Async run '${status.runId}' содержит ${steps.length} детей; укажите явный child index.`);
  }
  const index = lookup.index ?? steps[0]!.index;
  const step = steps.find((candidate) => candidate.index === index) ?? steps[0]!;
  const metadata = step.sessionFile
    ? await readSessionMetadata(step.sessionFile, status.cwd)
    : {
      available: false,
      file: "",
      id: null,
      cwd: status.cwd,
      branchComplete: false,
      model: null,
      modelSource: null,
      thinking: null,
      lastAssistant: null,
    } satisfies SessionMetadata;
  return createSubagentRuntimeInfo(status.runId, status, step, metadata);
}

/** Возвращает фактическую модель для runtime-info любого scope. */
function getActualModel(info: CurrentRuntimeInfo | SubagentRuntimeInfo): string | null {
  return info.scope === "current_session" ? formatModelRef(info.model) : info.model_actual;
}

/** Возвращает фактический thinking для runtime-info любого scope. */
function getActualThinking(info: CurrentRuntimeInfo | SubagentRuntimeInfo): string | null {
  return info.scope === "current_session" ? info.thinking.level : info.thinking_actual;
}

/** Формирует поля frontmatter/run artifact из runtime-info. */
export function buildArtifactFields(
  info: CurrentRuntimeInfo | SubagentRuntimeInfo,
  params: ArtifactFieldParams = {},
): RuntimeArtifactFields {
  const modelActual = getActualModel(info);
  const thinkingActual = getActualThinking(info);
  const fields: RuntimeArtifactFields = {
    model_requested: params.model_requested ?? modelActual,
    model_actual: modelActual,
    thinking_requested: params.thinking_requested ?? thinkingActual,
    thinking_actual: thinkingActual,
    runtime_verified_at: params.verified_at ?? new Date().toISOString(),
    runtime_info_source: RUNTIME_INFO_SOURCE,
    runtime_info_confidence: info.confidence,
    runtime_scope: info.scope,
  };

  if (info.scope === "subagent") {
    fields.runtime_agent_id = info.agent_id;
  }
  return fields;
}

/** Экранирует простое значение для YAML-блока артефакта. */
function formatYamlValue(value: string | null | undefined): string {
  if (value == null) return "null";
  if (/^[A-Za-z0-9_.\/-]+:[A-Za-z0-9_.\/-]+$/.test(value)) return JSON.stringify(value);
  if (/^[A-Za-z0-9_.\/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/** Форматирует поля артефакта в YAML без frontmatter-разделителей. */
export function formatArtifactFieldsYaml(fields: RuntimeArtifactFields): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${formatYamlValue(value)}`)
    .join("\n");
}

/** Форматирует runtime-info для команды /runtime-info. */
export function formatRuntimeSummary(info: CurrentRuntimeInfo | SubagentRuntimeInfo): string {
  const model = getActualModel(info) ?? "unknown";
  const thinking = getActualThinking(info) ?? "unknown";
  const session = info.session;
  const sessionId = session?.id ?? "none";
  const cwd = session?.cwd || "unknown";
  const suffix = info.scope === "subagent" ? `\nagent_id: ${info.agent_id}\nstatus: ${info.status}` : "";
  return `model: ${model}\nthinking: ${thinking}\nsession: ${sessionId}\ncwd: ${cwd}${suffix}`;
}
