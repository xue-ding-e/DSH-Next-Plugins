/**
 * Reuses Magpie's local privacy-filter process for Qoder requests.
 *
 * Magpie keeps the model behind `pf-serve`, a small binary protocol over
 * stdin/stdout. This module owns that process, keeps the placeholder map in
 * memory, and fails closed when an enabled filter cannot classify a request.
 * The caller still stores and receives the original DSH values; only the
 * Qoder wire body contains placeholders.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MODEL_FILE = "privacy-filter-q8-80efc1803eda.gguf";
const DEFAULT_CHUNK_BYTES = 12 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 180000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_THRESHOLD = 0.5;
const MAX_LABEL_LENGTH = 48;
const MAX_SPANS_PER_TEXT = 100000;
const PLACEHOLDER_RE = /\{\{MAGPIE_[A-Z0-9_]+_[0-9A-F]{16}\}\}/gi;
const PLACEHOLDER_BODY_RE = /\bMAGPIE_[A-Z0-9_]+_[0-9A-F]{16}\b/i;
const PLACEHOLDER_START = "{{MAGPIE_";
const MAX_PLACEHOLDER_LENGTH = PLACEHOLDER_START.length + MAX_LABEL_LENGTH + 19;
const URL_ALIAS_HOST_START = "magpie-url-";
const URL_ALIAS_START = `https://${URL_ALIAS_HOST_START}`;
const URL_ALIAS_SUFFIX = ".invalid/";
const URL_ALIAS_LENGTH = URL_ALIAS_START.length + 16 + URL_ALIAS_SUFFIX.length;
const URL_ALIAS_RE = /(?<![\w./:@-])(?:https?:\/\/)?magpie-url-([0-9a-f]{16})\.invalid\/?(?![\w./?#:%@&=+-])/giu;
const URL_ALIAS_HINT_RE = /magpie-url-[^\s<>"'`\\{}]*\.invalid\b/iu;
const RESPONSE_MARKERS_RE = new RegExp(`${URL_ALIAS_RE.source}|${PLACEHOLDER_RE.source}`, "giu");
const PROTECTED_RE = /\{\{MAGPIE_[A-Z0-9_]+_[0-9A-F]{16}\}\}|\bhttps?:\/\/[^\s<>"'`\\{}]+/giu;

/** Whether text still contains a Magpie placeholder, including without braces. */
export function hasPrivacyPlaceholder(text) {
  return PLACEHOLDER_BODY_RE.test(text) || URL_ALIAS_HINT_RE.test(text);
}

/**
 * A stable failure from the local privacy-filter integration.
 *
 * @extends Error
 */
export class PrivacyFilterError extends Error {
  /**
   * @param {string} code Machine-readable failure code.
   * @param {string} message Safe diagnostic text.
   * @param {unknown} [cause] Underlying failure.
   */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PrivacyFilterError";
    this.code = code;
  }
}

/**
 * Create a Magpie privacy-filter client.
 *
 * `enabled: true` requires Magpie's model and `pf-serve` to be present. A
 * classification failure rejects `maskBody()` before a network request is
 * made. Placeholder values live only in this process and are deterministic
 * for the same value, so a restarted Harness can remask a stored session.
 *
 * @param {Record<string, unknown> | undefined} config Filter configuration.
 * @param {{ spawn?: Function, existsSync?: Function }} [dependencies] Test
 *   seams for the process launcher and asset checks.
 * @returns {object} Filter with request-local restoration and process cleanup.
 */
export function createPrivacyFilter(config = {}, dependencies = {}) {
  const enabled = config.enabled === true;
  if (!enabled) return disabledFilter();

  const fsExists = typeof dependencies.existsSync === "function" ? dependencies.existsSync : existsSync;
  const spawn = dependencies.spawn ?? defaultPrivacyFilterSpawn;
  const threshold = finiteNumber(config.threshold, DEFAULT_THRESHOLD);
  const startupTimeoutMs = finitePositive(config.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const requestTimeoutMs = finitePositive(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const chunkBytes = finitePositive(config.chunkBytes, DEFAULT_CHUNK_BYTES);
  const preserveUrls = config.preserveUrls === true;
  const cache = new Map();
  let processState;
  let forceCpu = false;
  let stopped = false;
  let queue = Promise.resolve();

  const serial = (task) => {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  };

  const classifyLocked = async (texts) => {
    const result = texts.map(() => []);
    const misses = [];
    const missIndex = new Map();
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index];
      const cached = cache.get(text);
      if (cached !== undefined) {
        result[index] = cached;
        continue;
      }
      let uniqueIndex = missIndex.get(text);
      if (uniqueIndex === undefined) {
        uniqueIndex = misses.length;
        missIndex.set(text, uniqueIndex);
        misses.push(text);
      }
      result[index] = { uniqueIndex };
    }
    if (misses.length === 0) return result;

    const classified = [];
    for (let start = 0; start < misses.length;) {
      const batch = [];
      let size = 0;
      while (start < misses.length) {
        const text = misses[start];
        const bytes = Buffer.byteLength(text, "utf8");
        if (batch.length > 0 && size + bytes > chunkBytes) break;
        batch.push(text);
        size += bytes;
        start += 1;
      }
      const spans = await classifyBatch(batch);
      classified.push(...spans);
    }

    for (let index = 0; index < misses.length; index += 1) {
      const spans = classified[index] ?? [];
      cache.set(misses[index], spans);
      while (cache.size > 20000) cache.delete(cache.keys().next().value);
    }
    return result.map((entry) => Array.isArray(entry) ? entry : classified[entry.uniqueIndex] ?? []);
  };

  const classifyBatch = async (texts) => {
    if (texts.length === 0) return [];
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const state = processState ?? await startProcess();
        processState = state;
        return await classifyProcess(state, texts, requestTimeoutMs);
      } catch (error) {
        lastError = error;
        await stopProcess(processState);
        processState = undefined;
        forceCpu = true;
      }
    }
    if (lastError instanceof PrivacyFilterError) throw lastError;
    throw asPrivacyError("PRIVACY_FILTER_CLASSIFY_FAILED", "Magpie privacy-filter could not classify the Qoder request", lastError ?? new Error("unknown classifier failure"));
  };

  /**
   * Mask every model-visible text field in one JSON request.
   *
   * HTTP(S) URLs in text and serialized tool arguments use reserved .invalid
   * aliases so the model can pass them as URL arguments. `preserveUrls: true`
   * sends those URLs verbatim. Image input stays in its original field.
   *
   * @param {unknown} body Qoder request body.
   * @returns {Promise<object>} Masked body and its local response restorers.
   */
  async function maskBody(body) {
    const placeholderToValue = new Map();
    const prepare = (masked) => ({
      body: masked,
      restoreArgument: (text) => restoreArgument(text, placeholderToValue),
      createResponseRestorer: () => createResponseRestorer(placeholderToValue),
    });
    if (body === null || typeof body !== "object") return prepare(body);
    return serial(async () => {
      if (stopped) throw new PrivacyFilterError("PRIVACY_FILTER_CLOSED", "Magpie privacy-filter is already closed");
      const clone = JSON.parse(JSON.stringify(body));
      const slots = [];
      const toolArguments = [];
      for (const message of clone.messages ?? []) {
        for (const call of message.tool_calls ?? []) {
          const fn = call.function;
          if (typeof fn?.arguments !== "string" || fn.arguments === "") continue;
          let holder;
          try {
            holder = [JSON.parse(fn.arguments)];
          } catch (error) {
            throw new PrivacyFilterError("PRIVACY_FILTER_TOOL_JSON", "Cannot mask invalid tool arguments in the Qoder request", error);
          }
          collectSlots(holder, slots, false, true);
          toolArguments.push({ fn, holder });
          fn.arguments = undefined;
        }
      }
      collectSlots(clone, slots);
      const texts = [];
      const textIndex = new Map();
      for (const slot of slots) {
        for (const piece of slot.pieces) {
          if (piece.kind !== "text") continue;
          let index = textIndex.get(piece.value);
          if (index === undefined) {
            index = texts.length;
            textIndex.set(piece.value, index);
            texts.push(piece.value);
          }
          piece.textIndex = index;
        }
      }
      const spans = await classifyLocked(texts);
      for (const slot of slots) {
        slot.owner[slot.key] = slot.pieces.map((piece) => {
          if (piece.kind === "placeholder") return piece.value;
          if (piece.kind === "url") {
            return rememberUrl(placeholderToValue, piece.value);
          }
          return replaceSpans(piece.value, spans[piece.textIndex] ?? [], (label, value) =>
            rememberPlaceholder(placeholderToValue, normalizeLabel(label), value));
        }).join("");
      }
      for (const { fn, holder } of toolArguments) fn.arguments = JSON.stringify(holder[0]);
      if (typeof clone.chat_context?.text === "string" && typeof clone.business?.name === "string") {
        clone.business.name = clone.chat_context.text.slice(0, 30).replace(/\{\{[^}]*$/u, "");
      }
      return prepare(clone);
    });
  }

  /**
   * Restore values in a model response fragment.
   *
   * @param {string} text Response text or a tool-call JSON fragment.
   * @param {Map<string, string>} values Placeholders from this request.
   * @returns {string} Restored response text.
   */
  function restoreText(text, values) {
    // The replacements run in one pass. An original value can itself contain
    // text that resembles a different marker.
    return text.replace(RESPONSE_MARKERS_RE, (match, urlHash) => values.get(
      urlHash === undefined ? match.toUpperCase() : `{{MAGPIE_PRIVATE_URL_${urlHash.toUpperCase()}}}`,
    ) ?? match);
  }

  function restoreArgument(text, values) {
    // Qoder may add a scheme or omit the braces when it echoes a URL marker.
    const urlMarker = /^(?:https?:\/\/)?\{{0,2}(MAGPIE_(?:PRIVATE_)?URL_[0-9A-F]{16})\}{0,2}$/iu.exec(text);
    if (urlMarker !== null) {
      const url = values.get(`{{${urlMarker[1].toUpperCase()}}}`);
      if (url !== undefined) return url;
    }
    const bareMarker = /^\{{0,2}(MAGPIE_[A-Z0-9_]+_[0-9A-F]{16})\}{0,2}$/iu.exec(text);
    if (bareMarker !== null) {
      const value = values.get(`{{${bareMarker[1].toUpperCase()}}}`);
      if (value !== undefined) return value;
    }
    return restoreText(text, values);
  }

  /**
   * Create a small buffering restorer for streamed response fields.
   *
   * @param {Map<string, string>} values Placeholders from this request.
   * @returns {{ restore: Function, flush: () => Map<string, string> }} Stream restorer.
   */
  function createResponseRestorer(values) {
    const pending = new Map();
    return {
      restore(key, text) {
        const combined = (pending.get(key) ?? "") + text;
        pending.delete(key);
        const upper = combined.replace(/[a-z]/g, (letter) => letter.toUpperCase());
        let holdFrom = combined.length;
        const start = upper.lastIndexOf(PLACEHOLDER_START);
        if (start >= 0 && combined.length - start < MAX_PLACEHOLDER_LENGTH
          && !upper.includes("}}", start + PLACEHOLDER_START.length)) {
          holdFrom = start;
        }
        // A chunk may end before even the marker prefix is complete.
        for (const prefix of [PLACEHOLDER_START, URL_ALIAS_START.toUpperCase(), URL_ALIAS_HOST_START.toUpperCase()]) {
          for (let size = prefix.length - 1; size > 0; size -= 1) {
            if (!upper.endsWith(prefix.slice(0, size))) continue;
            holdFrom = Math.min(holdFrom, combined.length - size);
            break;
          }
        }
        const hostAt = upper.lastIndexOf(URL_ALIAS_HOST_START.toUpperCase());
        if (hostAt >= 0 && combined.length - hostAt < URL_ALIAS_LENGTH) {
          const tail = upper.slice(hostAt + URL_ALIAS_HOST_START.length);
          if (/^[0-9A-F]{0,16}$/u.test(tail) ||
            (/^[0-9A-F]{16}/u.test(tail) && URL_ALIAS_SUFFIX.toUpperCase().startsWith(tail.slice(16)) && !tail.endsWith("/"))) {
            const beforeHost = upper.slice(Math.max(0, hostAt - 8), hostAt);
            const scheme = beforeHost.endsWith("HTTPS://") ? 8 : beforeHost.endsWith("HTTP://") ? 7 : 0;
            holdFrom = Math.min(holdFrom, hostAt - scheme);
          }
        }
        if (holdFrom < combined.length) pending.set(key, combined.slice(holdFrom));
        return restoreText(combined.slice(0, holdFrom), values);
      },
      flush() {
        const out = new Map();
        for (const [key, text] of pending) out.set(key, restoreText(text, values));
        pending.clear();
        return out;
      },
    };
  }

  async function close() {
    stopped = true;
    await serial(async () => {
      await stopProcess(processState);
      processState = undefined;
    });
  }

  return { enabled: true, maskBody, close };

  function rememberPlaceholder(values, kind, value) {
    const hash = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16).toUpperCase();
    const placeholder = `{{MAGPIE_${kind}_${hash}}}`;
    values.set(placeholder, value);
    if (kind === "PRIVATE_URL") values.set(`{{MAGPIE_URL_${hash}}}`, value);
    return placeholder;
  }

  function rememberUrl(values, value) {
    const marker = rememberPlaceholder(values, "PRIVATE_URL", value);
    if (preserveUrls) return value;
    return `${URL_ALIAS_START}${marker.slice(-18, -2).toLowerCase()}${URL_ALIAS_SUFFIX}`;
  }

  async function startProcess() {
    const assets = resolveAssets(config, fsExists);
    if (assets.executables.length === 0 || assets.model === undefined) {
      throw new PrivacyFilterError(
        "PRIVACY_FILTER_NOT_INSTALLED",
        `Magpie privacy-filter assets were not found; expected ${assets.directory}`,
      );
    }
    if (typeof spawn !== "function") {
      throw new PrivacyFilterError("PRIVACY_FILTER_SPAWN_UNAVAILABLE", "Node process spawning is unavailable in this Harness host");
    }
    const candidates = forceCpu
      ? assets.executables.filter((candidate) => candidate.cpu)
      : assets.executables;
    const choices = candidates.length > 0 ? candidates : assets.executables;
    let lastError;
    for (const candidate of choices) {
      try {
        return await spawnProcess(spawn, candidate, assets.model, threshold, startupTimeoutMs);
      } catch (error) {
        lastError = error;
      }
    }
    throw asPrivacyError("PRIVACY_FILTER_START_FAILED", "Magpie privacy-filter did not start", lastError);
  }
}

function disabledFilter() {
  return {
    enabled: false,
    async maskBody(body) { return { body }; },
    async close() {},
  };
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function asPrivacyError(code, message, cause) {
  if (cause instanceof PrivacyFilterError && cause.code === code) return cause;
  return new PrivacyFilterError(code, cause instanceof Error ? `${message}: ${cause.message}` : message, cause);
}

function resolveAssets(config, fsExists) {
  const explicitModel = stringValue(config.modelPath);
  const explicitExecutable = stringValue(config.executablePath);
  const explicitDirectory = stringValue(config.cacheDir);
  const cacheDirectories = unique([
    explicitDirectory,
    explicitModel === undefined ? undefined : dirname(explicitModel),
    explicitExecutable === undefined ? undefined : dirname(explicitExecutable),
    process.env.MAGPIE_PRIVACY_FILTER_DIR,
    process.env.XDG_CACHE_HOME === undefined ? undefined : join(process.env.XDG_CACHE_HOME, "magpie", "privacy-filter"),
    join(homedir(), ".cache", "magpie", "privacy-filter"),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, "magpie", "privacy-filter"),
    join(homedir(), "AppData", "Local", "magpie", "privacy-filter"),
  ]);
  const target = process.platform === "win32"
    ? "windows-amd64"
    : process.platform === "darwin"
      ? `darwin-${process.arch === "arm64" ? "arm64" : "amd64"}`
      : `${process.platform}-${process.arch === "arm64" ? "arm64" : "amd64"}`;
  const directories = unique([
    ...cacheDirectories,
    ...cacheDirectories.flatMap((dir) => [
      join(dir, `pf-v4-${target}`),
      join(dir, `pf-v3-${target}`),
      join(dir, `pf-v2-${target}`),
      join(dir, `pf-v1-${target}`),
    ]),
  ]);
  const directory = cacheDirectories[0] ?? join(homedir(), ".cache", "magpie", "privacy-filter");
  const model = explicitModel ?? cacheDirectories.map((dir) => join(dir, MODEL_FILE)).find((path) => fsExists(path));
  const executableNames = process.platform === "win32"
    ? ["pf-serve-vulkan.exe", "pf-serve.exe"]
    : ["pf-serve-vulkan", "pf-serve"];
  const executables = explicitExecutable !== undefined
    ? [{ path: explicitExecutable, cpu: basenameOf(explicitExecutable) === "pf-serve.exe" }]
    : directories.flatMap((dir) => executableNames.map((name) => ({ path: join(dir, name), cpu: name === "pf-serve.exe" || name === "pf-serve" })))
      .filter((candidate) => fsExists(candidate.path));
  return { directory, model: model !== undefined && fsExists(model) ? model : undefined, executables };
}

function collectSlots(node, slots, image = false, argument = false) {
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") {
      if (!(image && key === "url") && (argument || shouldMask(key, value))) {
        slots.push({ owner: node, key, pieces: splitProtectedText(value) });
      }
    } else {
      if (key === "imageUrls" || key === "image_urls") continue;
      collectSlots(value, slots, !argument && node.type === "image_url" && key === "image_url", argument);
    }
  }
}

function splitProtectedText(text) {
  const pieces = [];
  let cursor = 0;
  for (const match of text.matchAll(PROTECTED_RE)) {
    const start = match.index;
    const kind = match[0].startsWith("{{") || URL_ALIAS_HINT_RE.test(match[0]) ? "placeholder" : "url";
    let value = match[0];
    if (kind === "url") {
      value = value.replace(/[，。；：！？、]+$/u, "");
      if (value.endsWith(")") && !value.includes("(") && text[start - 1] === "(") value = value.slice(0, -1);
    }
    if (start > cursor) pieces.push({ value: text.slice(cursor, start), kind: "text" });
    pieces.push({ value, kind });
    cursor = start + value.length;
  }
  if (cursor < text.length) pieces.push({ value: text.slice(cursor), kind: "text" });
  return pieces;
}

function shouldMask(key, value) {
  if (value.length < 3 || hasOnlyPlaceholder(value)) return false;
  if (key === "image_urls" || key === "imageUrls") return false;
  if (key === "id" || key.endsWith("_id") || key.endsWith("Id") || key === "role" || key === "type") return false;
  if (key === "model" || key === "key" || key === "source" || key === "version" || key === "stage" || key === "product") return false;
  if (key === "session_type" || key === "agent_id" || key === "task_id" || key === "name") return false;
  return true;
}

function replaceSpans(text, spans, put) {
  if (!Array.isArray(spans) || spans.length === 0) return text;
  const bytes = Buffer.from(text, "utf8");
  const ordered = spans
    .filter((span) => Number.isInteger(span?.start) && Number.isInteger(span?.end) && span.start >= 0 && span.end > span.start && span.end <= bytes.length)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .slice(0, MAX_SPANS_PER_TEXT);
  let cursor = 0;
  const parts = [];
  for (const span of ordered) {
    if (span.start < cursor) continue;
    const value = bytes.subarray(span.start, span.end).toString("utf8");
    if (value.length === 0 || hasPrivacyPlaceholder(value)) continue;
    parts.push(bytes.subarray(cursor, span.start).toString("utf8"));
    parts.push(put(span.label, value));
    cursor = span.end;
  }
  if (cursor === 0) return text;
  parts.push(bytes.subarray(cursor).toString("utf8"));
  return parts.join("");
}

function hasOnlyPlaceholder(text) {
  return text.match(PLACEHOLDER_RE)?.[0] === text;
}

function normalizeLabel(label) {
  const normalized = String(label ?? "PRIVATE").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return (normalized || "PRIVATE").slice(0, MAX_LABEL_LENGTH);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function basenameOf(path) {
  return String(path).replaceAll("\\", "/").split("/").at(-1) ?? "";
}

async function spawnProcess(spawn, candidate, model, threshold, startupTimeoutMs) {
  const child = await spawn(candidate.path, [model, String(threshold)], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: candidate.cpu ? { ...process.env, PF_DEVICE: "cpu" } : { ...process.env },
  });
  if (child === null || child.stdout === undefined || child.stdin === undefined) {
    throw new PrivacyFilterError("PRIVACY_FILTER_SPAWN_FAILED", "pf-serve did not expose stdin/stdout");
  }
  try {
    const reader = new StreamReader(child.stdout);
    const hello = await withTimeout(reader.line(), startupTimeoutMs, async () => stopProcess({ child }));
    let parsed;
    try {
      parsed = JSON.parse(hello);
    } catch (error) {
      throw new PrivacyFilterError("PRIVACY_FILTER_BAD_HELLO", "pf-serve returned an invalid startup message", error);
    }
    if (typeof parsed?.error === "string" || typeof parsed?.device !== "string") {
      throw new PrivacyFilterError("PRIVACY_FILTER_BAD_HELLO", parsed?.error ?? "pf-serve did not report a device");
    }
    return { child, reader };
  } catch (error) {
    await stopProcess({ child });
    throw error;
  }
}

async function classifyProcess(state, texts, requestTimeoutMs) {
  const request = encodeRequest(texts);
  await write(state.child.stdin, request);
  const timeout = requestTimeoutMs + Math.ceil(request.length / 4096) * 1000;
  return withTimeout(readReply(state.reader, texts), timeout, async () => stopProcess(state));
}

function encodeRequest(texts) {
  const parts = [u32(texts.length)];
  for (const text of texts) {
    const bytes = Buffer.from(text, "utf8");
    parts.push(u32(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

async function readReply(reader, texts) {
  const status = await reader.u32();
  if (status === 1) {
    const length = await reader.u32();
    const message = (await reader.bytes(length)).toString("utf8");
    throw new PrivacyFilterError("PRIVACY_FILTER_CLASSIFY_FAILED", message || "pf-serve returned an error");
  }
  if (status !== 0) throw new PrivacyFilterError("PRIVACY_FILTER_BAD_REPLY", `pf-serve returned status ${status}`);
  const result = [];
  for (const text of texts) {
    const count = await reader.u32();
    if (count > MAX_SPANS_PER_TEXT) throw new PrivacyFilterError("PRIVACY_FILTER_BAD_REPLY", "pf-serve returned too many spans");
    const bytes = Buffer.byteLength(text, "utf8");
    const spans = [];
    for (let index = 0; index < count; index += 1) {
      const start = await reader.u32();
      const end = await reader.u32();
      await reader.u32();
      const labelLength = await reader.u8();
      const label = (await reader.bytes(labelLength)).toString("utf8");
      if (end > start && end <= bytes) spans.push({ start, end, label });
    }
    result.push(spans);
  }
  return result;
}

function u32(value) {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

async function write(stream, bytes) {
  await new Promise((resolve, reject) => {
    stream.write(bytes, (error) => error == null ? resolve() : reject(error));
  });
}

async function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          Promise.resolve(onTimeout()).catch(() => {});
          reject(new PrivacyFilterError("PRIVACY_FILTER_TIMEOUT", `pf-serve did not answer within ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopProcess(state) {
  if (state === undefined || state === null) return;
  try { state.child.stdin?.end(); } catch {}
  if (state.child.exitCode === null && state.child.signalCode === null) {
    try { state.child.kill(); } catch {}
  }
  await new Promise((resolve) => {
    let timer = setTimeout(resolve, 1000);
    timer.unref?.();
    state.child.once?.("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

class StreamReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async fill(size) {
    while (this.buffer.length < size) {
      const next = await this.iterator.next();
      if (next.done) throw new PrivacyFilterError("PRIVACY_FILTER_EOF", "pf-serve ended before replying");
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }

  async bytes(size) {
    await this.fill(size);
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  async u8() { return (await this.bytes(1)).readUInt8(0); }

  async u32() { return (await this.bytes(4)).readUInt32LE(0); }

  async line() {
    for (;;) {
      const index = this.buffer.indexOf(0x0a);
      if (index >= 0) {
        const line = this.buffer.subarray(0, index).toString("utf8").replace(/\r$/u, "");
        this.buffer = this.buffer.subarray(index + 1);
        return line;
      }
      const next = await this.iterator.next();
      if (next.done) throw new PrivacyFilterError("PRIVACY_FILTER_EOF", "pf-serve ended before startup");
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }
}

export async function defaultPrivacyFilterSpawn(...args) {
  const { spawn } = await import("node:child_process");
  return spawn(...args);
}
