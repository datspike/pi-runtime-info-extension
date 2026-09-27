import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildArtifactFields,
  createCurrentRuntimeInfo,
  formatArtifactFieldsYaml,
  formatRuntimeSummary,
  getCurrentSessionInfo,
  getSubagentRuntimeInfo,
} from "./runtime.js";

/** Возвращает JSON-результат для LLM tool. */
function jsonToolResult(details: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

/** Считывает runtime-info текущей сессии из контекста расширения. */
function readCurrentRuntimeInfo(pi: ExtensionAPI, ctx: ExtensionContext) {
  return createCurrentRuntimeInfo(ctx, pi.getThinkingLevel());
}

function parseSubagentCommandArgs(args: string): { agentId: string; index?: number } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) throw new Error("Использование: /runtime-info <run_id> [child_index]");
  if (parts.length === 1) return { agentId: parts[0]! };
  const index = Number(parts[1]);
  if (!Number.isInteger(index) || index < 0) throw new Error("child_index должен быть неотрицательным целым числом.");
  return { agentId: parts[0]!, index };
}

function subagentLookup(pi: ExtensionAPI, ctx: ExtensionContext, index?: number) {
  return {
    events: pi.events,
    parentSession: getCurrentSessionInfo(ctx),
    ...(index === undefined ? {} : { index }),
  };
}

/** Регистрирует инструменты и команду runtime-info. */
export default function runtimeInfoExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "runtime_info",
    label: "Runtime Info",
    description: "Возвращает фактическую модель, thinking level и session metadata текущей Pi-сессии.",
    promptSnippet: "Возвращает фактические model/thinking/session metadata текущей Pi-сессии.",
    promptGuidelines: [
      "Use runtime_info when an artifact must include verified model_actual or thinking_actual for the current Pi session.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return jsonToolResult(readCurrentRuntimeInfo(pi, ctx));
    },
  });

  pi.registerTool({
    name: "subagent_runtime_info",
    label: "Subagent Runtime Info",
    description: "Возвращает подтверждённые session metadata, модель и thinking async-сабагента по run_id.",
    promptSnippet: "Проверяет подтверждённые model/thinking/status сабагента по run_id.",
    promptGuidelines: [
      "Use subagent_runtime_info after spawning an async subagent when an artifact must include verified subagent model_actual or thinking_actual.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "ID async run из subagent tool или status output." }),
      index: Type.Optional(Type.Integer({ minimum: 0, description: "Явный индекс ребёнка для multi-child async run." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return jsonToolResult(await getSubagentRuntimeInfo(params.agent_id, subagentLookup(pi, ctx, params.index)));
    },
  });

  pi.registerTool({
    name: "runtime_artifact_fields",
    label: "Runtime Artifact Fields",
    description: "Возвращает готовые YAML/JSON-поля runtime model/thinking для артефакта.",
    promptSnippet: "Готовит поля model_requested/model_actual/thinking_requested/thinking_actual для артефактов.",
    promptGuidelines: [
      "Use runtime_artifact_fields before writing review, research, handoff, or plan artifacts that need verified runtime metadata.",
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(Type.String({ description: "Если задан, поля строятся по async runtime-info сабагента." })),
      index: Type.Optional(Type.Integer({ minimum: 0, description: "Явный индекс ребёнка для multi-child async run." })),
      model_requested: Type.Optional(Type.String({ description: "Запрошенная модель, если её нужно отличить от фактической." })),
      thinking_requested: Type.Optional(Type.String({ description: "Запрошенный thinking level, если его нужно отличить от фактического." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const info = params.agent_id
        ? await getSubagentRuntimeInfo(params.agent_id, subagentLookup(pi, ctx, params.index))
        : readCurrentRuntimeInfo(pi, ctx);
      const fields = buildArtifactFields(info, {
        model_requested: params.model_requested,
        thinking_requested: params.thinking_requested,
      });
      return jsonToolResult({ fields, yaml: formatArtifactFieldsYaml(fields) });
    },
  });

  pi.registerCommand("runtime-info", {
    description: "Показать фактическую модель, thinking level и session metadata",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const info = trimmed
        ? (() => {
          const parsed = parseSubagentCommandArgs(trimmed);
          return getSubagentRuntimeInfo(parsed.agentId, subagentLookup(pi, ctx, parsed.index));
        })()
        : Promise.resolve(readCurrentRuntimeInfo(pi, ctx));
      const summary = formatRuntimeSummary(await info);
      if (!ctx.hasUI) {
        console.log(summary);
        return;
      }
      ctx.ui.notify(summary, "info");
    },
  });
}
