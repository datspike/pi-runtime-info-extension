import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  buildArtifactFields,
  createCurrentRuntimeInfo,
  formatArtifactFieldsYaml,
  formatRuntimeSummary,
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
    description: "Возвращает фактическую модель, thinking level и статус сабагента по agent_id.",
    promptSnippet: "Проверяет фактические model/thinking/status сабагента по agent_id.",
    promptGuidelines: [
      "Use subagent_runtime_info after spawning a subagent when an artifact must include verified subagent model_actual or thinking_actual.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "ID сабагента из Agent tool или Agent started output." }),
    }),
    async execute(_toolCallId, params) {
      return jsonToolResult(getSubagentRuntimeInfo(params.agent_id));
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
      agent_id: Type.Optional(Type.String({ description: "Если задан, поля строятся по runtime-info сабагента." })),
      model_requested: Type.Optional(Type.String({ description: "Запрошенная модель, если её нужно отличить от фактической." })),
      thinking_requested: Type.Optional(Type.String({ description: "Запрошенный thinking level, если его нужно отличить от фактического." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const info = params.agent_id
        ? getSubagentRuntimeInfo(params.agent_id)
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
      const agentId = args.trim();
      const info = agentId ? getSubagentRuntimeInfo(agentId) : readCurrentRuntimeInfo(pi, ctx);
      const summary = formatRuntimeSummary(info);
      if (!ctx.hasUI) {
        console.log(summary);
        return;
      }
      ctx.ui.notify(summary, "info");
    },
  });
}
