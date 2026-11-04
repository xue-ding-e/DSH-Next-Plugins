# Codex session header verification

PR #63 now only changes Codex's `session-id` header. A non-empty session ID
produces a stable header; existing UUIDs are preserved and arbitrary IDs map
to SHA-256-derived UUIDv8 values. Missing/empty IDs retain fresh random UUIDs.
The request body's existing `prompt_cache_key` behavior is unchanged.

Grok's proposed additional headers were removed: its Responses requests
already send `prompt_cache_key`, which xAI documents as equivalent to
`x-grok-conv-id` for cache routing. This change does not assume gateway UUID
validation or promise a particular cache hit rate.

## Live comparison, 2026-09-05

Eight requests used one existing Codex subscription account and the live
catalog's `gpt-5.6-luna`. Both arms used a stable `prompt_cache_key` and a
repeated synthetic prefix. Each arm had a distinct experiment marker and key
to limit cross-arm cache reuse. Request order alternated each round. Only the
session-header policy differed: a random UUID on each request versus the
helper's stable UUIDv8. All eight requests returned HTTP 200 and reached
`response.completed` without stream errors; each reported 2934 input tokens.

| Round | Random header: cached tokens | Stable header: cached tokens |
| --- | ---: | ---: |
| 1 | 0 | 0 |
| 2 | 2816 | 2816 |
| 3 | 0 | 2816 |
| 4 | 0 | 2816 |

After the first request, the stable arm hit cache on 3/3 requests and the
random arm on 1/3. This small sample supports stable session identity but
does not establish a general hit-rate improvement or prove the cause of any
reported near-zero cache rate. Each policy had only one prefix/key group;
server load, routing variability, and group differences remain confounders.
In particular, the random-header arm also achieved a cache hit.

## Reproduce

Run `pnpm test` to compile the current sources, then explicitly run:

```sh
node scripts/verify-codex-session-cache.mjs
```

This is an opt-in live experiment, not part of CI. It spends subscription
quota on eight small-output requests and reads an unexpired Codex session
from the plugin's auth store. It does not refresh or modify credentials,
execute tools, or send project files. Output contains model/status/timing and
token counts, never credentials or account identifiers. Each request has a
45-second timeout. A missing session/model or transport failure means the
comparison is incomplete, not evidence of a cache miss.

## Automated validation

- Tests are registered in `test/index.ts` and run under `pnpm test`.
- Helper tests cover deterministic mapping, distinct IDs, existing UUIDs,
  and fresh IDs for missing/empty input.
- Adapter dispatch tests cover repeat/different/missing/empty session IDs,
  unchanged body cache keys, and absence of extra Grok headers.
- Full suite: 382 tests, 376 passed, 6 environment-dependent skips, no
  failures or cancellations. `pnpm build` passed.

Reference: [xAI cache routing documentation](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits).
