import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

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

interface SessionLike {
  sessionId?: string;
  sessionFile?: string;
  thinkingLevel?: string;
  model?: Model<any>;
  messages?: readonly unknown[];
  sessionManager?: {
    getCwd?: () => string;
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    getHeader?: () => { id?: string; cwd?: string } | null;
  };
}

interface SubagentRecord {
  id: string;
  type: string;
  description: string;
  status: string;
  outputFile?: string;
  session?: SessionLike;
}

interface SubagentManagerApi {
  getRecord: (id: string) => SubagentRecord | undefined;
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
function getCurrentSessionInfo(ctx: ExtensionContext): RuntimeSessionInfo {
  const header = ctx.sessionManager.getHeader();
  return {
    id: ctx.sessionManager.getSessionId() ?? header?.id ?? null,
    file: ctx.sessionManager.getSessionFile() ?? null,
    cwd: ctx.cwd,
  };
}

/** Считывает сведения о сессии сабагента из AgentSession. */
function getSubagentSessionInfo(session: SessionLike | undefined): RuntimeSessionInfo | null {
  if (!session) return null;
  const header = session.sessionManager?.getHeader?.();
  return {
    id: session.sessionId ?? session.sessionManager?.getSessionId?.() ?? header?.id ?? null,
    file: session.sessionFile ?? session.sessionManager?.getSessionFile?.() ?? null,
    cwd: session.sessionManager?.getCwd?.() ?? header?.cwd ?? "",
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

/** Возвращает глобальный manager активного pi-subagents, если он подключён. */
export function getSubagentManager(): SubagentManagerApi | null {
  const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  if (!manager || typeof manager !== "object") return null;
  const candidate = manager as { getRecord?: unknown };
  if (typeof candidate.getRecord !== "function") return null;
  return candidate as SubagentManagerApi;
}

/** Собирает runtime-info по записи сабагента. */
export function createSubagentRuntimeInfo(agentId: string, record: SubagentRecord): SubagentRuntimeInfo {
  const session = record.session;
  const model = modelToInfo(session?.model);
  const thinkingLevel = session?.thinkingLevel ? String(session.thinkingLevel) : null;
  const lastAssistant = assistantMessageToInfo(findLastAssistantMessage(session?.messages ?? []));

  return {
    scope: "subagent",
    agent_id: agentId,
    status: String(record.status),
    type: String(record.type),
    description: String(record.description),
    model,
    model_actual: formatModelRef(model),
    thinking: thinkingLevel ? { level: thinkingLevel } : null,
    thinking_actual: thinkingLevel,
    session: getSubagentSessionInfo(session),
    output_file: record.outputFile ?? null,
    last_assistant_message: lastAssistant,
    confidence: session
      ? "subagent_session_model_and_thinking"
      : "subagent_record_without_session",
  };
}

/** Загружает runtime-info сабагента из активного manager. */
export function getSubagentRuntimeInfo(agentId: string, manager = getSubagentManager()): SubagentRuntimeInfo {
  if (!manager) {
    throw new Error("pi-subagents manager недоступен: проверь, что пакет pi-subagents подключён и загружен раньше runtime-info.");
  }

  const record = manager.getRecord(agentId);
  if (!record) {
    throw new Error(`Сабагент с id ${agentId} не найден в активной сессии.`);
  }

  return createSubagentRuntimeInfo(agentId, record);
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
