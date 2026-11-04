# Interchange Conversion Guide (skill instructions for agents)

> Audience: an agent, or a script author, tasked with converting an "unrecognized" chat
> transcript into a format dsh-chat-import can import.
> This document is self-contained: you do not need to read anything else to finish the
> conversion. The full protocol specification (per-source capability matrix, degradation
> rules, portable bundle) lives in [INTERCHANGE.md](INTERCHANGE.md). This guide only covers
> how to turn an arbitrary format into an importable file.
> 中文版：[INTERCHANGE-GUIDE.zh-CN.md](INTERCHANGE-GUIDE.zh-CN.md)

## Your task

The source file is a chat export from some tool that none of the plugin's parsers
recognise. Convert it into an **interchange v1 session document** (a single JSON file),
write it to a new file, and hand it back to the user for re-import.

## Output requirements (hard rules)

1. **Strict JSON.** `JSON.parse` must succeed: no comments, no trailing commas, UTF-8.
2. The top-level object must carry `"interchange": "dsh-chat-import"` and `"version": 1`.
   This marker pair is the first-level detection criterion, and it **must appear within
   the first 64 KB of the file**. Putting it at the very top is enough.
3. `turns` must contain at least 1 valid turn. Empty turns, meaning no `prompt`, no
   `steps` and no `compaction`, are dropped and counted. If every turn is dropped, the
   whole file is rejected.
4. **Do not fabricate content.** Anything the source does not have (tool results,
   timestamps, token usage) is better left out than invented.
5. **Write a new file; never modify the source.** A suggested name is
   `<source-file-name>.interchange.json`.
6. Every timestamp is in **milliseconds** (Unix epoch ms).

## Minimal valid document

```json
{
  "interchange": "dsh-chat-import",
  "version": 1,
  "meta": { "id": "my-tool-session-1", "createdAt": 1710000000000 },
  "turns": [
    {
      "prompt": "Hello",
      "steps": [
        { "content": [{ "type": "text", "text": "Hi! How can I help?" }] }
      ]
    }
  ]
}
```

## Field reference

### Top level

| Field | Required | Notes |
| --- | --- | --- |
| `interchange` | ✅ | Always `"dsh-chat-import"` (content marker) |
| `version` | ✅ | Always `1`; any other value is rejected wholesale with the version named |
| `meta.id` / `meta.sourceId` | Recommended | Slug source for the session id (the plugin mints the final `import-<slug>`) |
| `meta.createdAt` | Recommended | Milliseconds; defaults to the import moment |
| `meta.cwd` | Optional | Working directory; without it the session lands in a dedicated import workspace |
| `title` | Optional | Session title; defaults to the first turn's `prompt` (whitespace-folded, truncated at 80 chars) |
| `provider` | Optional | Source name (default `generic`), shown in session metadata |
| `model` | Optional | Source model name |
| `turns` | ✅ | Array of turns |

### turn: one user prompt plus the assistant messages that follow it

| Field | Required | Notes |
| --- | --- | --- |
| `prompt` | Conditional | Prompt text. At least one of `prompt` / `steps` / `compaction` must be present, otherwise the turn is dropped |
| `promptBlocks` | Optional | Full content blocks when the prompt carries images (default: a single text block) |
| `steps` | Conditional | Array of steps (below) |
| `time` | Optional | Prompt time (ms) |
| `aborted` | Optional | `true` if the turn was interrupted |
| `compaction` | Optional | `{ "summary": "…", "provider"?, "model"?, "time"? }` — a context compaction happened before this turn |
| `shadowed` | Optional | The turn is shadowed by a later compaction |

### step: one assistant message (with its tool calls and results)

| Field | Required | Notes |
| --- | --- | --- |
| `content` | Recommended | Array of content blocks (types below) |
| `toolCalls` | Optional | `[{ "id", "name", "arguments" }]`; `arguments` may be a string or an object (objects are serialized) |
| `toolResults` | Optional | `[{ "toolCallId", "content": [...], "isError"?, "time"? }]` |
| `time` | Optional | Assistant message time (ms) |
| `model` | Optional | This step's own model (record per step when the model changed mid-session) |
| `usage` | Optional | `{ "inputTokens", "outputTokens", "cacheReadTokens"?, "cacheWriteTokens"?, "reasoningTokens"? }`, all non-negative integers |

**Content block types**: `text` (`{ "type": "text", "text" }`), `reasoning` (same shape),
`image` (see below), `tool-call` (`{ "type": "tool-call", "id", "name", "arguments" }`).

Tool results do not go into message content. Put them in the step's `toolResults` list:
`{ "toolCallId", "content": [...], "isError"? }`.

A `tool-result` block written into the same step's `content` also works: the plugin
normalises it into `toolResults`, de-duplicated by `toolCallId`, with the explicit list
winning. A `tool-result` block **anywhere else** has nowhere to go and is dropped, counted
as `skippedBlocks`. That covers `promptBlocks`, or a block nested inside another result's
`content`. Unknown block types are dropped the same way.

**Pairing invariant.** Every `toolResults[].toolCallId` must match the `id` of a tool call
in some step. Unpaired results are **dropped and counted as `droppedToolResults`**. The
other direction is safe: a call without a result gets a synthesized empty result. If the
source has the result, though, write it paired.

Tool calls may appear either as `tool-call` content blocks or in the explicit `toolCalls`
list. Tool results likewise: either as `tool-result` content blocks or in the explicit
`toolResults` list. Both placements are equivalent and de-duplicated by id (`toolCallId`
for results).

**Image blocks.** With bytes, a block looks like
`{ "type": "image", "data": "<base64>", "mediaType": "image/png", "name"? }`, and
PNG / JPEG / WebP / GIF are accepted. When the source only has an image URL or a local path,
read the bytes and base64-encode them if you can. **If you cannot get the bytes, leave the
block out entirely; never fabricate `data`.** Invalid images degrade to an `[image]`
placeholder text and count as `imagesDegraded`.

## Full example (tool calls + image + usage + compaction)

```json
{
  "interchange": "dsh-chat-import",
  "version": 1,
  "meta": { "id": "tool-x-2026-10-03", "createdAt": 1759478400000, "cwd": "C:\\work" },
  "title": "Fix the login page style",
  "provider": "tool-x",
  "model": "tool-x-pro",
  "turns": [
    {
      "prompt": "See this screenshot — the login button is off",
      "promptBlocks": [
        { "type": "text", "text": "See this screenshot — the login button is off" },
        { "type": "image", "data": "<base64>", "mediaType": "image/png", "name": "shot.png" }
      ],
      "time": 1759478400000,
      "steps": [
        {
          "content": [
            { "type": "reasoning", "text": "Check the stylesheet first" },
            { "type": "text", "text": "Let me inspect the login styles." },
            { "type": "tool-call", "id": "call-1", "name": "read", "arguments": "{\"path\":\"login.css\"}" }
          ],
          "toolCalls": [
            { "id": "call-1", "name": "read", "arguments": "{\"path\":\"login.css\"}" }
          ],
          "toolResults": [
            { "toolCallId": "call-1", "content": [{ "type": "text", "text": ".login-btn { margin: 0 }" }], "isError": false }
          ],
          "time": 1759478405000,
          "usage": { "inputTokens": 1200, "outputTokens": 180 }
        }
      ]
    },
    {
      "prompt": "Center it",
      "compaction": { "summary": "Earlier context compacted: user is styling the login page", "provider": "tool-x" },
      "steps": [
        { "content": [{ "type": "text", "text": "Done — margin: 0 auto." }] }
      ]
    }
  ]
}
```

## Conversion procedure

1. Read the source file and identify each message's role (user, assistant, tool) and their order.
2. Each user prompt opens a `turn`, written into `prompt`. Every assistant message after it,
   until the next user prompt, becomes that turn's `steps`, in order.
3. Pair tool calls with their results by id and place them in the **same step**'s
   `toolCalls` / `toolResults`.
4. Convert every timestamp to milliseconds. Numbers in `usage` must be non-negative
   integers; otherwise omit the whole `usage` object.
5. Write the JSON file and walk the checklist below.
6. Hand the new file path back to the user and ask them to preview and import again.

## Pre-delivery checklist

- [ ] `JSON.parse` succeeds (no comments, no trailing commas)
- [ ] `"interchange": "dsh-chat-import"` and `"version": 1` sit at the very top
- [ ] Every `toolResults[].toolCallId` has a matching `toolCalls[].id`
- [ ] No empty turns (each turn has at least one of prompt, steps, compaction)
- [ ] `usage.inputTokens` and `usage.outputTokens` are non-negative integers
- [ ] All timestamps are milliseconds
- [ ] Nothing was fabricated beyond the source content

## Import and verify

- **Panel.** Paste the new file path into "Import from file" and press Enter for a
  read-only preview. Success looks like this: detection shows `generic · file marker`, the
  turn, message and tool-call counts match the source, and the degradation counters
  (malformed turns and steps, skipped blocks, dropped tool results, dropped usage, images)
  are all 0 or individually explainable. Then press "Import".
- **Command**: `/import auto <path>`, which is the same as `local-jsonl`.
- **Tool**: `import_chat({ format: "local-jsonl", path })`. Do a dry-run preview first,
  then import for real.

If the preview says "Every conversation-format parser failed", expand the failure list and
read the `generic` row. It states exactly what is wrong with the document: not valid JSON,
an unsupported version, or no importable turns.

## Common mistakes → consequences

| Mistake | Consequence |
| --- | --- |
| Comments or trailing commas in JSON | Wholesale rejection: "not valid JSON" |
| The marker sits beyond the first 64 KB | Not detected; treated as an unknown format |
| A `version` other than `1` | Wholesale rejection, with the version named |
| A tool result with no matching call | The result is dropped and counted as `droppedToolResults` |
| A `tool-result` block outside a step's `content` (in `promptBlocks`, or nested in a result) | Dropped and counted as `skippedBlocks` |
| A non-integer `usage` | That usage object is dropped and counted as `usageDropped` |
| An empty turn | Dropped and counted as `malformedTurns`; if every turn is empty the file is rejected |
| An image without valid `data` | Degraded to `[image]` text, counted as `imagesDegraded` |
| An unknown content block type | Dropped and counted as `skippedBlocks` |
