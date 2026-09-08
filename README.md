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
- `subagent_runtime_info` tool for checking an owned `pi-subagents` async run by `agent_id`, including completed and resumed runs.
- Multi-child runs require the optional `index` parameter (or the command's second argument).
- Tested subagent integration with nicobailon `pi-subagents` 0.66.x through its versioned in-process RPC seam.
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
| `subagent_runtime_info` | You launched an async subagent and need confirmed runtime metadata by run id. | Run status, session metadata, model/thinking evidence, output file. |
| `runtime_artifact_fields` | You are about to write a report, review, plan, or handoff artifact. | Ready artifact fields plus a YAML block. |

Example artifact fields:

```yaml
model_requested: zai/glm-5.1
model_actual: openai/gpt-5.3-codex
thinking_requested: high
thinking_actual: xhigh
runtime_verified_at: 2026-05-04T12:00:00.000Z
runtime_info_source: pi-runtime-info
runtime_info_confidence: subagent_session_assistant_metadata_and_thinking_level_change
runtime_scope: subagent
runtime_agent_id: 57444cd3-fb66-4b7
```

## Command

```text
/runtime-info
/runtime-info <run_id> [child_index]
```

Without arguments, the command shows the current session model, thinking level, session id, and cwd. With a run id it uses the parent-owned async status path; pass `child_index` for multi-child runs.

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

The `subagent_runtime_info` tool is intentionally narrower. It is tested against nicobailon `pi-subagents` 0.66.x:

```bash
pi install git:github.com/nicobailon/pi-subagents
```

It sends a targeted `status` request over `subagents:rpc:v1:request` and accepts only a run whose `status.json.sessionId` matches the current parent session. The adapter reads package-owned run metadata and a snapshot of the latest saved branch in the child session JSONL, not a live parent-side runtime; `status.model` and `status.thinking` are not treated as actual values. If `pi-subagents` is not installed, not loaded, or does not expose this RPC seam, current-session tools continue to work and the subagent tool reports a clear error.

## Where to read current Pi docs

For questions about Pi APIs and usage examples, start with the locally installed `@earendil-works/pi-coding-agent` package.
Prefer this read order inside that package: `README.md`, then `docs/`, then `examples/`.

In practice, that means:

- first find your local Pi install directory through your global npm root or Pi install location;
- then read `@earendil-works/pi-coding-agent/README.md`, `docs/`, and `examples/`;
- use this extension's code as an integration example, not as the source of truth for Pi APIs.

Important: the published `@earendil-works/pi-coding-agent` package does not include `src/`.
If you need Pi core implementation details or the exact internal behavior, use a source checkout of `earendil-works/pi-mono`, not only the installed npm package.

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
- `subagent_runtime_info` only sees async runs accepted by the loaded `pi-subagents` RPC bridge and belonging to the active parent session.
- The child runtime is read as a snapshot of its latest saved branch, not as live parent-side state. If `sessionFile` is not written yet, or metadata is missing/partially written, actuals remain `null` with an insufficient-confidence value.
- Malformed status/tree data, an ambiguous multi-child run without `index`, a run belonging to another parent session, or an invalid run id fails closed; message bodies and transcripts are never returned.

## License

MIT
