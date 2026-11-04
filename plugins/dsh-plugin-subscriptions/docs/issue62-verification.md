# Issue #62: images in tool results

Confirmed on main at `1335947`: `resolveImages` only checked top-level blocks;
all three translators flattened tool results to text. A regression test with
two attachment-backed `read_image` results failed before the fix (`0 !== 2`
attachment reads).

The fix resolves attachments inside tool results without modifying persisted
history. Anthropic keeps text and images in native `tool_result.content`.
Responses and Chat Completions keep textual tool outputs and append a user
image message, labelled by tool-call ID, after the results. Images are deferred
across consecutive result messages so parallel calls are answered before the
follow-up, and flushed before the next assistant turn. Text-only result shapes
are unchanged. Codex, Grok, Claude and Copilot already use these shared paths.

Offline tests cover attachment reads and signal propagation, missing storage,
read failures, history immutability, PNG/JPEG payloads, mixed/image-only results,
multiple images, error flags, parallel results in separate messages, and turn
boundaries. Existing top-level image and text-only tests remain in the suite.
These are request-format regressions, not live provider acceptance or visual
recognition tests; no account quota is spent by them.
