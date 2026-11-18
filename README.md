# DSH Next plugins

[中文](README.zh.md)

This repository maintains extension packages consumed by [DSH-Next-Profile](https://github.com/xue-ding-e/DSH-Next-Profile). It contains plugin code and build inputs, independently of the Harness application.

## Install

Install a supported DeepSeek Harness or DSH Next desktop release first. Use the Profile repository's release installer to install the extension collection. Plugin source archives in this repository are development inputs; the Profile installer consumes versioned package archives.

## Packages

The collection contains browser control, navigation buttons, input guard, whale boot, BrowserSkill bridge, retry settings, subscription providers, Qoder Connect, and chat import. Each package retains its own package name, version and license. Account authorization and computer-specific integration settings remain on the user's computer.

## Sources and updates

The initial seven Next extensions come from DSH-Next commit `1813d72421df0a0675df18f219d3a28cae640da7`. Qoder Connect and chat import preserve the installed plugin revisions collected for the separate extension distribution. Source notices and package licenses are retained in each directory.

This distribution modifies BrowserSkill bridge 0.1.1 to require explicit browser selection, Qoder Connect 0.6.1 to admit the verified 0.2.1-rc.3 and 0.2.2-rc.1 host APIs, and chat import 0.26.4-fix.2 to append through the host's exclusive write handle. Incremental import refuses a conversation still loaded by an Agent; restart Harness and import before opening it. These changes retain each package's original license.

Update a package and its compiled browser/Host files together, run its relevant tests, and publish a new version before updating the Profile recipe. The Profile release builder verifies package inputs, creates portable archives, and locks their hashes. A Profile release must not depend on a developer checkout path.

## Independent chat relay

`plugins/dsh-session-relay` is an opt-in Host plugin for Harness **0.2.2-rc.1**. It is independent of the nine packages locked by the existing Profile release. It adds `list_sessions`, `read_session`, `send_message_to_session`, and `get_session_delivery` for ordinary chats, including separately created chats and ordinary forks. Subagents continue using the native tree controls.

Install the absolute plugin directory with the Host's `plugin_manager` tool using `action: "install_bundle"` and `target: "<absolute path>/plugins/dsh-session-relay"`. The result reports whether activation applied or requires a restart. To prepare a portable package, run `npm pack --ignore-scripts` in that plugin directory. The archive contains the Host implementation, bundle patch, manifest and MIT license; its only package import is the Host's public `@deepseek-ai/dsh-session` export. The shipped patch selects the same-directory scope and context delivery.

The model can coordinate an existing chat with:

```javascript
list_sessions({ query: "Shop" })
send_message_to_session({
  session_id: "<id returned by list_sessions>",
  request_id: "shop-build-update-1",
  message: "The Shop build passed. Check the regression results in your task.",
  delivery: "steer"
})
get_session_delivery({ session_id: "<destination id>", request_id: "shop-build-update-1" })
read_session({ session_id: "<destination id>", max_chars: 12000 })
```

`context` adds next-step input without waking an idle Agent; `queue` starts a separate follow-up turn; `steer` joins the next step and wakes an idle Agent. The default is `context`. Receipts confirm durable acceptance, not a reply or successful work. Status is `pending`, `claimed`, `consumed`, `cancelled`, or `not-found`; `consumed` means the native conversation admitted the input. Normal Agent disposal or explicit cancellation can cancel unprocessed input. Retrying a cancelled request reports `DELIVERY_CANCELLED`; intentional resends need a new request id. Reusing a request id with different text or delivery reports `REQUEST_CONFLICT`.

By default, discovery and delivery admit ordinary chats in the same recorded working directory and honor native Remote access. Set `scope: all` in the bundle configuration to admit other directories. Archived destinations require restoration before a new delivery. Source identity is taken from the exact live calling Agent and stored as the native `agent-message` / `relay` source. The plugin uses the existing Host activation controller, inbox, exclusive writer and flush; it never edits source logs or databases directly.

`read_session` returns the latest 20 user, agent-message and assistant text messages from the current model context surface. Runtime instructions, tools, recorded reasoning and image bytes are excluded. This is not a full pre-compaction transcript export. `max_chars` bounds the complete rendered JSON; oversized messages return fragments with `id`, UTF-16 `char_offset`, `complete` and an opaque `next_cursor`. Concatenate by id. A changed Session invalidates the cursor; start a fresh read. Listing cursors are best-effort offsets over a mutable list. Message limits count complete serialized UTF-8 input, including source attribution.

Run `node --test plugins/dsh-session-relay/tests/*.test.mjs` from this repository. For the four native integration cases, set `DSH_RELAY_TEST_HOST` to an already-built Harness checkout before running the same command. Without it, those four cases are explicitly skipped. Set `DSH_RELAY_TEST_PACKAGE` to an unpacked package directory to validate the archive instead of the source entry. Native cases use temporary JSONL homes, a real Cordis Loader, production AgentLoop/inbox/Session query and the production ordinary-Session activation controller. Owner/default-model/workspace inputs and the list carrier are fixtures; the model returns fixed chunks. They cover native model tool execution, busy-recipient steering, model-visible errors, cold resume, recorded source, cancellation, retry deduplication and registration teardown. They do not verify live desktop installation, visual rendering, cross-profile messaging or real provider behavior. No user history or credentials are accessed. New library code is plain ESM JavaScript and requires no build step.

## Licenses

Packages under `plugins/` retain the license declared in their `package.json` and accompanying `LICENSE` file. The collection does not replace those licenses. The subscription and chat-import packages retain their upstream attribution and notices.
