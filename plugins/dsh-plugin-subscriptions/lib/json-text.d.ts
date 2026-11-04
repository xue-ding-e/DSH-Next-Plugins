/**
 * BOM-tolerant JSON reading for every file this plugin owns.
 *
 * `JSON.parse` rejects a leading U+FEFF, but ordinary Windows tools prepend one
 * whenever they rewrite a file: PowerShell 5.1's `Set-Content -Encoding UTF8`
 * and `Out-File -Encoding utf8` both emit a BOM, and Notepad's default save is
 * "UTF-8 with BOM". The plugin stores its proxy config, auth store, model cache,
 * model defaults and provider settings as JSON in the user's home directory,
 * which is exactly the kind of file a user or a script may edit by hand, so a
 * BOM must never turn into a silent feature failure.
 *
 * This was a real outage: a BOM in `proxy.json` threw during the single lazy
 * config load, which disabled the proxy for the process lifetime, so every
 * request left on a raw connection and failed far away as
 * `codex API request failed` / `TRANSPORT`.
 */
/**
 * Drop a leading UTF-8 BOM.
 * @param text - file contents read as utf8.
 * @returns the same text without a leading BOM.
 */
export declare function stripBom(text: string): string;
/**
 * `JSON.parse` after dropping a leading BOM.
 * @param text - file contents read as utf8.
 * @returns the parsed value.
 */
export declare function parseJsonText<T = unknown>(text: string): T;
