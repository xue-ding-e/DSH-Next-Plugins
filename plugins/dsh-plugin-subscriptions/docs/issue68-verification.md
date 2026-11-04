# Issue #68: host-managed proxy

The screenshot's upstream change is real:

- [DSH v0.1.3-alpha.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)
- [Host proxy installation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/packages/util/http-proxy/src/install.ts)
- [Network proxy guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/docs/user/guide/network-proxy.md)

The host installs an undici global dispatcher before plugins mount. This
plugin already calls global `fetch` when its own override is disabled or
bypassed, including connection probes. Its explicit override uses its own
`ProxyAgent`. A MockAgent regression verifies the disabled/bypassed routes and
probes use the host dispatcher without replacing it; this is not a full DSH
launcher or live external proxy test.

Removing the setting unconditionally is not justified: package peer ranges
still support older DSH versions, existing proxy settings require an explicit
migration, and subscription-only routing is not identical to a process-wide
environment proxy. Credentials in host environment variables are also visible
to child commands, unlike credentials held only in the plugin config.

Keep the optional override for compatibility; recommend host routing on the
verified DSH release, document migration and credential boundaries, and correct
English/Chinese status, bypass, probe and save messages. "No plugin proxy"
must not claim "direct": use host `NO_PROXY` when direct routing is required.
No proxy configuration, credentials, dependency ranges or user files are
automatically migrated or deleted.
