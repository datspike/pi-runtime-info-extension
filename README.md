# @datspike/pi-runtime-info-extension

[![npm version](https://img.shields.io/npm/v/@datspike/pi-runtime-info-extension.svg)](https://www.npmjs.com/package/@datspike/pi-runtime-info-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Pi package that exposes the current runtime model, thinking level, and session metadata to agents. It is built for workflows that need reproducible artifacts, model-sensitive subagent orchestration, or reviewer-facing metadata such as `model_actual` and `thinking_actual`.

## Why this exists

Pi already lets the user select a model and a thinking level, but an agent writing a report cannot always prove which runtime settings were actually used. That becomes painful when you need to:

- write `model_actual` and `thinking_actual` into review, research, or handoff artifacts;
- compare requested subagent routing with the resolved runtime model;
- debug model picker and profile overrides;
- keep multi-model review output reproducible.

This extension keeps that check inside Pi, without patching Pi core.

## Features

- `runtime_info` tool for the current Pi session.
- `subagent_runtime_info` tool for checking an active `pi-subagents` run by `agent_id`.
- `runtime_artifact_fields` tool that returns ready-to-paste YAML/JSON artifact fields.
- `/runtime-info` command for a quick human-readable runtime summary.
- No external service and no network calls.

## Quick start

### 1. Install as a Pi package

```bash
pi install npm:@datspike/pi-runtime-info-extension
```

### 2. Reload Pi

```text
/reload
```

### 3. Ask the agent to verify runtime metadata

```text
Call runtime_info and print the JSON result.
```

Expected shape:

```json
{
  "scope": "current_session",
  "model": {
    "provider": "openai",
    "id": "gpt-5.5",
    "ref": "openai/gpt-5.5"
  },
  "thinking": {
    "level": "xhigh"
  },
  "session": {
    "id": "...",
    "file": "...",
    "cwd": "/path/to/project"
  },
  "confidence": "selected_model_from_extension_context"
}
```

## Tools

| Tool | Use it when | Output |
| --- | --- | --- |
| `runtime_info` | You need the current session runtime. | Model, thinking level, session id/file/cwd, last assistant message metadata. |
| `subagent_runtime_info` | You launched a subagent and need the resolved runtime by `agent_id`. | Subagent status, model, thinking level, session metadata, output file. |
| `runtime_artifact_fields` | You are about to write a report, review, plan, or handoff artifact. | Ready artifact fields plus a YAML block. |

Example artifact fields:

```yaml
model_requested: zai/glm-5.1
model_actual: openai/gpt-5.3-codex
thinking_requested: high
thinking_actual: xhigh
runtime_verified_at: 2026-05-04T12:00:00.000Z
runtime_info_source: pi-runtime-info
runtime_info_confidence: subagent_session_model_and_thinking
runtime_scope: subagent
runtime_agent_id: 57444cd3-fb66-4b7
```

## Command

```text
/runtime-info
/runtime-info <agent_id>
```

Without arguments, the command shows the current session model, thinking level, session id, and cwd. With an `agent_id`, it shows the same summary for a known subagent record.

## Installation options

### npm package

```bash
pi install npm:@datspike/pi-runtime-info-extension
```

### Git package

```bash
pi install git:github.com/datspike/pi-runtime-info-extension
```

### Local development path

```json
{
  "packages": [
    "/absolute/path/to/pi-runtime-info-extension"
  ]
}
```

The package entrypoint is declared in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Compatibility notes

The current-session tools use documented Pi extension APIs:

- `ctx.model`;
- `ctx.sessionManager`;
- `pi.getThinkingLevel()`;
- session assistant message metadata.

The `subagent_runtime_info` tool is intentionally narrower. It reads the active `pi-subagents` manager from `globalThis[Symbol.for("pi-subagents:manager")]`, which is a package-level integration seam rather than a Pi core API. If `pi-subagents` is not installed, not loaded, or changes that seam, current-session tools continue to work and the subagent tool reports a clear error.

## Verification

```bash
npm run check
npm pack --dry-run
```

For a live Pi smoke test:

```bash
pi --mode json -p 'Call runtime_info and print its JSON result.'
```

## Current limitations

- `runtime_info` reports the selected/effective session model. After at least one assistant response, `last_assistant_message` can also confirm provider-reported message metadata.
- `subagent_runtime_info` only sees subagents known to the active parent session and the loaded `pi-subagents` manager.
- If a subagent is started with extensions disabled, it cannot call `runtime_info` itself; the parent can still call `subagent_runtime_info` when the manager seam is available.

## License

MIT
