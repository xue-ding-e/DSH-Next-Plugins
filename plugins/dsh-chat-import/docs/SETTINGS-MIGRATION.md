# DSH 0.1.5 → 0.1.7 plugin settings migration

English | [中文](SETTINGS-MIGRATION.zh-CN.md)

This collects every settings-page difference we hit while migrating from DSH 0.1.5 to 0.1.7,
each with the verbatim error we measured. You can forward it to other plugin authors as-is.

## In one line

**0.1.7 removed `settings.register()`.** On 0.1.5 a plugin could open a settings namespace
**by name**. On 0.1.7, the namespace *is* a profile entry id, and the schema *is* that
entry's Config. The migration is therefore not an API change but a change to **the plugin's
identity in the profile**.

## Side by side

| | 0.1.5 and earlier | 0.1.7 |
|---|---|---|
| Where the namespace comes from | the plugin calls `settings.register('my-plugin', schema)` | the profile entry id (the `- id: …` row in [`cordis.patch.yml`](../cordis.patch.yml)) |
| Where the schema comes from | passed at registration | the entry's `config` field, validated by the host against the plugin's exported `Config` |
| How the client reads and writes | the api-proxy settings channel | the same, except the **namespace must be in the host's list** |

## Three traps, in the order we hit them

### Trap 1: `settings.register` is no longer a function

**Symptom**, in the startup log. Without a guard, the plugin fails to load:

```
[modsearch] settings namespace skipped:
  TypeError: scope.settings.register is not a function
```

**Fix**: stop calling it. Export the schema as the plugin's `Config` and read and write
through the host settings service by **entry id**.

### Trap 2: the entry id carries a **kind prefix**, the settings service only knows the **bare id**

This is the worst one, because the error gives no hint of the real cause:

```
POST /my-plugin/prefs
409 settings-conflict
No configurable plugin entry "include:ui-skin-claude-style"
```

**Root cause**: the 0.1.7 loader reports the entry id as **`<kind>:<id>`**. A plugin in a
profile is usually an **`include` or `insert` entry**, so `ctx.fiber.entry.id` yields
`include:ui-skin-claude-style`. The **settings service indexes namespaces by the bare id**,
though: its list literally contains `ui-skin-claude-style`.

Write with the prefixed name and the host cannot find the entry, so **every save returns 409**.

**Fix**, one line:

```js
// 0.1.7 reports "<kind>:<id>"; the settings service wants the bare id; no-op without a prefix
function entryIdOf(ctx) {
  const id = ctx?.fiber?.entry?.id
  if (typeof id === 'string' && id !== '') {
    const colon = id.lastIndexOf(':')
    return colon === -1 ? id : id.slice(colon + 1)
  }
  return ENTRY_ID_FALLBACK   // the id declared in the patch
}
```

**Measured**: before the fix, `namespaceState = configured:include:ui-skin-claude-style` and writes returned 409. After it, `configured:ui-skin-claude-style` and writes return `200 {"ok":true,…,"revision":1,"available":true}`.

### Trap 3: `schemastery` does not resolve from the plugin's own location

**Symptom**: Config validation cannot get the schema, so the namespace never registers.
Reads survive on defaults, but writes always fail.

**Cause**: plugins are often installed into a profile as a **symlink or local link**, and
there is no `@deepseek-ai/schemastery` under its own `require` anchor.

**Fix**: point the resolution anchor at the **running harness bin**, which always ships
schemastery, and fall back to normal resolution afterwards:

```js
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const anchor = pathToFileURL(process.argv[1]).href   // e.g. <npm global>/@deepseek-ai/dsh/lib/bin.js
const factory = createRequire(anchor)('@deepseek-ai/schemastery')
// on failure, await import('@deepseek-ai/schemastery')
```

There is also a **load-time** trap. `.volatile()` only exists on 0.1.7; an older host ships a
schemastery without it. Building a volatile `Config` at module top level then throws
`volatile is not a function` at load time, which **takes the whole plugin down**. Detect
first:

```js
function supportsVolatile(S) {
  try { return typeof S.boolean().volatile === 'function' } catch { return false }
}
export const Config = supportsVolatile(Schema) ? Schema.object({ /* … */ }) : undefined
```

## Self-check on any host

Add a read-only self-check route that dumps these fields. When something is wrong, this one
response tells you where:

```json
{
  "ok": true,
  "value": { /* current settings value */ },
  "revision": 1,
  "available": true,
  "probe": {
    "hasSettings": true,
    "hasDescribe": true,
    "count": 17,
    "ns": "agent-default-model,llm-pi-ai,…,ui-theme,locale,ui-settings,ui-conversation,…,ui-skin-claude-style",
    "namespaceState": "configured:ui-skin-claude-style",
    "error": null
  }
}
```

Read it in this order:

1. Is your **bare id** in `probe.ns`? If not, it is trap 2 or trap 3.
2. Is `namespaceState` the **bare id**? A prefix like `include:` means trap 2.
3. Look at `hasSettings` and `hasDescribe`: does the host have this service at all? 0.1.5 does not, so take the legacy path.
4. Send `revision` on writes for optimistic concurrency. A mismatch returns `409 settings-conflict`, which is normal conflict semantics, not a bug.

## Compatibility recipe (one codebase, both versions)

- Detect at startup. If the host has a settings service **and your bare id is in its list**, take the **0.1.7 path** and read and write by entry id.
- Otherwise take the **0.1.5 legacy path**, with the plugin owning the namespace.
- Both paths converge on the same in-memory "value + revision" model. The client only ever sees that one model, so "reads fine but cannot save" cannot happen.

0.1.7 also removed the old `scope.watch`. To follow changes, subscribe to the host's
`settings/document-updated` event (its argument is the namespace id), or read the volatile
`Config` field's `.get()` directly. You can also call
`settings.configure({ auto: false }, ctx.fiber)` to declare "this plugin has its own settings
page, do not generate a host page". That call returns a disposer, so register it with
`ctx.effect(() => settings.configure(...))` instead of leaving the policy behind in the service.

## Also worth knowing (not the settings page, but hit in the same migration)

- **The 0.1.7 plugin inventory reads `package.json` `icon`.** It must be a path relative to the manifest, inside the package, and no larger than 256 KiB. Absolute paths and URLs are rejected. Icons render as `<img>` and **never receive `currentColor`**, so a dark icon disappears on the warm-black canvas. Prefer a coloured one.
- **Localized metadata lives in `locale/<lang>.json` as `meta.title` and `meta.description`.** The host resolves it **file by file through the package `exports`**: if any single locale file is not exported, the **entire metadata, icon included, degrades to `meta.error`**. Use a wildcard `"./locale/*"` in `exports` instead of listing the files one by one.

## How this repository applies it

`dsh-chat-import` has been migrated this way, with one codebase in `lib/import-prefs.mjs`:

- `Config` is exported from the plugin entry (`lib/index.mjs`) with all three fields marked `.volatile()`. 0.1.7 only projects volatile fields into editable forms.
- The namespace is the bare entry id. `entryIdOf()` strips the `<kind>:` prefix and falls back to the patch-declared `import-claude`.
- Binding detection: if the `describe()` list contains the bare id, use `forms` (0.1.7); if only `register` and `get` exist, use `legacy` (0.1.5, namespace `chat-import`); if neither exists, use `none` (read defaults, writes are not persisted).
- The panel route `/api-import/prefs` returns a `probe` self-check block.
