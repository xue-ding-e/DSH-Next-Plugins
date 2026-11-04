# PR #66 verification

Verified on 2026-09-05 against the PR changes combined with main, including
the orphaned tool-call repair from #45. No live requests are part of the
automated test suite.

## Live endpoint comparison

Existing local subscription credentials were used without including them in
this report. Grok's expired session was refreshed through the existing OAuth
refresh implementation and saved through the auth store before testing.
Models were selected from each account's live model catalog.

| Provider / model | Old tool-less body | Fixed tool-less body | Fixed body with tools |
| --- | --- | --- | --- |
| Grok / `grok-4.20-0309-non-reasoning` | HTTP 400, `invalid-argument` | HTTP 200, `response.completed` | HTTP 200, `response.completed` |
| Codex / `gpt-5.6-luna` | HTTP 200, `response.completed` | HTTP 200, `response.completed` | HTTP 200, `response.completed` |

Requests used the provider request-body builders and the plugin's configured
HTTP/proxy transport, targeting `https://api.x.ai/v1/responses` and
`https://chatgpt.com/backend-api/codex/responses` respectively. Each request
used a 45-second timeout, `store: false`, `stream: true`, system instructions
`Reply with OK only. Do not call tools.`, and user text `Reply OK.`. Grok used
`max_output_tokens: 128`; Codex's builder omits that parameter.

The old tool-less body was reconstructed from the fixed body by adding only
`tool_choice: "auto"` and `parallel_tool_calls: true`, leaving `tools` absent.
The third variant declared an `echo` function with a required string `text`
argument; no tool was executed. The successful cases reached
`response.completed` without a stream error. This verifies acceptance of
requests declaring tools, not an end-to-end tool execution round trip.

These results establish the reported failure for the tested Grok model and
account. They do not establish that every xAI model rejects the old shape.
Codex accepted both shapes: its change is consistency, not a demonstrated
Codex bug fix. Live empty-array behavior was not separately tested because
the builders omit all three fields for both absent and empty tools; offline
tests cover both inputs through actual adapter dispatch.

## Automated validation

- Both adapters' stream paths are exercised with absent tools, an empty tools
  array, and a populated tools array. Tests assert the emitted endpoint,
  controls, input, system instructions, cache key, and other request fields.
- Codex tests combine each tools shape with an orphaned function call, checking
  that #45's unknown-outcome repair still runs without mutating history.
- `pnpm test`: 378 tests, 372 passed, 6 environment-dependent credential tests
  skipped, no failures or cancellations.
- `pnpm build`: TypeScript checking and bundle generation passed.

The mocked transport tests establish request construction, not server policy;
the live results above provide the separate server-acceptance evidence.
