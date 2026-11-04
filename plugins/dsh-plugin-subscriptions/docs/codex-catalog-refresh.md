# Codex catalog refresh verification

## Confirmed cause (2026-09-05)

Two read-only GETs to `https://chatgpt.com/backend-api/codex/models` used
the same existing, unexpired Codex subscription session and identical auth
headers. Only `client_version` changed:

| Version | Status | Visible GPT-6 Astra |
| --- | --- | --- |
| `0.147.0` (previous plugin default) | 200 | absent |
| `0.153.4` (npm `@openai/codex` stable at verification time) | 200 | `gpt-6-astra`, visibility `list` |

This confirms version-gated catalog visibility for the tested account, not
universal account access or successful model inference. No generation request,
token refresh, credential write or user cache deletion was needed for this
comparison. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)
also describes a staged rollout; never synthesize access by adding a static row.

## Changes

- By default the plugin automatically reads the stable version from public
  `https://registry.npmjs.org/@openai%2fcodex/latest` metadata. No subscription
  headers are sent and no code is downloaded or executed. Redirects are refused.
  Successful results are cached in memory for six hours, failures for five
  minutes. A 1.5-second deadline bounds lookup and response parsing; concurrent
  accounts share the request. Invalid/prerelease/regressed metadata is ignored.
  Failures retain the last known version or the verified `0.153.4` fallback.
- Optional plugin config `codexClientVersion` overrides automatic lookup, with
  validation; the version is sent only to the catalog endpoint. A manual model
  refresh also expires the version lookup cache. No CLI installation is needed.
- Settings → Subscriptions → Default reasoning effort now has **Refresh model
  lists (all subscriptions)**. Unlike a normal read, it invalidates all account
  catalog caches, invalidates pool membership, and re-announces routes so the
  conversation model picker also re-queries. It does not clear usage, health,
  credentials or Copilot reasoning replay.
- Ordinary reads retain the five-minute discovery cache. Existing non-empty
  `models.<provider>` configurations still intentionally disable discovery.

## Tests

Offline regressions exercise the version-gated GPT-6 response, explicit version
overrides, malformed-version rejection before fetch, all-account cache refresh
within the TTL, and real plugin RPC wiring (force validation, adapter cache
invalidation and picker re-announcement). They do not claim live model execution
or browser interaction coverage.

Automatic-version tests cover lookup coalescing, cache expiry, manual refresh,
failure retry, last-good fallback, malformed/prerelease/regressed metadata,
credential-free headers, stalled transports, late responses, and explicit
configuration taking precedence over automatic lookup.
