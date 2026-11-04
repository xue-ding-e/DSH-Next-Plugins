/**
 * Qoder 桌面客户端的**官方模型目录缓存**读取器（只读、离线、零 token）。
 *
 * 为什么要有这个文件
 * ------------------
 * 「模型变少了」有两种完全不同的原因，处理方式相反：
 *
 *   1. **官方下线** —— 服务端真的没这个模型了，我们应该跟着删。
 *   2. **我们版本落后** —— 服务端按 `Cosy-Version` 静默裁剪，模型还在，只是不返给我们。
 *
 * 光看我们自己的目录分不清这两者。而 Qoder 桌面客户端会把**它自己那份**完整目录
 * 落盘缓存到 `~/.qoder-cn/.models/<uid>/catalog-v<N>`，那份就是我们最好的参照物：
 * 同一个账号、同一台机器、官方客户端看到的东西。读它不需要网络、不需要 token、
 * 也不产生任何推理计费。
 *
 * 缓存格式（逆向所得，见 docs/upstream-risk-register.md 的 R1 证据表）
 * ---------------------------------------------------------------
 * 文件本身是 **base64 文本**，解出来是：
 *
 *     offset 0   "QMC" + 0x01       4 字节 魔数 + 版本号
 *     offset 4   nonce             12 字节 AES-GCM IV
 *     offset 16  ciphertext        N  字节
 *     tail       tag              16 字节 GCM 认证标签
 *
 * 明文是 UTF-8 的 JSON，顶层按 **scene** 分组（`chat` / `developer` / `inline` /
 * `quest` / `qwork` / `experts` / `qwake` / `app` / `byok_*`），每组是模型条目数组。
 * 我们只关心 `chat`（agent 聊天用的就是它）。
 *
 * 密钥不走系统钥匙串，而是**由 uid 现场派生**——这就是为什么早先按
 * DPAPI / safeStorage 去猜一个字节都对不上：
 *
 *     key = HKDF-SHA256(ikm = uid, salt = "qoder-model-cache-enc",
 *                       info = "model-cache-v1", length = 32)
 *
 * 没有 AAD。算法实现在官方客户端的 `qoder_auth_wasm`（Rust → WASM）里，
 * 源码路径字符串为 `src/model_cache_crypto.rs`，依赖 `hkdf-0.12.4` +
 * `aes-gcm-0.10.3` + `sha2-0.10.9`。
 *
 * 也就是说：**只要知道 uid，谁都能解开这份缓存**，它防的是「随手翻文件」而不是
 * 密码学意义上的机密。这也意味着这个模块不引入任何额外信任面——它读的是本机
 * 用户自己的缓存，明文里只有模型目录（没有任何凭据）。
 *
 * 只依赖 `node:*`，可以被 selfcheck 那类零依赖脚本直接 import。
 */

import { createDecipheriv, hkdfSync } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 缓存魔数：`QMC` + 版本 1。 */
export const OFFICIAL_CACHE_MAGIC = Buffer.from([0x51, 0x4d, 0x43, 0x01]);

/** 密钥派生参数（与官方客户端 `src/model_cache_crypto.rs` 一致）。 */
export const OFFICIAL_CACHE_KDF = Object.freeze({
  algorithm: "hkdf-sha256",
  salt: "qoder-model-cache-enc",
  info: "model-cache-v1",
  length: 32,
});

/** Qoder 桌面客户端的用户数据目录名。 */
const QODER_HOME_DIR = ".qoder-cn";

/** 缓存版本号前缀；文件名形如 `catalog-v7`。 */
const CATALOG_FILE_PATTERN = /^catalog-v(\d+)$/;

/**
 * 由 uid 派生 AES-256-GCM 密钥。
 *
 * 注意 ikm 就是 uid 的 UTF-8 字节本身（不是它的哈希），salt/info 是固定字面量。
 */
export function deriveOfficialCacheKey(uid) {
  const id = String(uid ?? "").trim();
  if (id.length === 0) throw new Error("official-cache: uid 为空，无法派生缓存密钥");
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(id, "utf8"),
    Buffer.from(OFFICIAL_CACHE_KDF.salt, "utf8"),
    Buffer.from(OFFICIAL_CACHE_KDF.info, "utf8"),
    OFFICIAL_CACHE_KDF.length,
  ));
}

/**
 * 解一份缓存字节（已 base64 解码过的**二进制**）成对象。
 *
 * @param {Buffer|Uint8Array} payload
 * @param {string} uid
 * @returns {Record<string, unknown>} 顶层按 scene 分组的 JSON
 */
export function decryptOfficialCache(payload, uid) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  // 容错：调用方可能直接把文件原文（base64 文本）递进来。
  const bytes = buf.length > 0 && buf.subarray(0, 3).toString("latin1") === "QMC"
    ? buf
    : Buffer.from(buf.toString("utf8").trim(), "base64");
  if (bytes.length < 4 + 12 + 16) {
    throw new Error(`official-cache: 数据太短（${bytes.length} 字节），不是合法的目录缓存`);
  }
  if (!bytes.subarray(0, 4).equals(OFFICIAL_CACHE_MAGIC)) {
    throw new Error(`official-cache: 魔数不匹配（实际 ${bytes.subarray(0, 4).toString("hex")}，期望 ${OFFICIAL_CACHE_MAGIC.toString("hex")}）`);
  }
  const nonce = bytes.subarray(4, 16);
  const tag = bytes.subarray(bytes.length - 16);
  const ciphertext = bytes.subarray(16, bytes.length - 16);
  const key = deriveOfficialCacheKey(uid);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`official-cache: 解密失败（uid 与缓存不匹配？uid=${uid}）：${reason}`);
  }
  try {
    return JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`official-cache: 明文不是合法 JSON：${reason}`);
  }
}

/** 读 `default` 指针文件里的 uid（客户端自己就是这么定位的）。 */
function readPointerUid(modelsDir) {
  try {
    const doc = JSON.parse(readFileSync(join(modelsDir, "default"), "utf8"));
    const uid = typeof doc?.uid === "string" ? doc.uid.trim() : "";
    if (uid.length > 0) return { uid, scene: typeof doc?.scene === "string" ? doc.scene : undefined };
  } catch {
    /* 没有指针文件就走下面按目录名兜底 */
  }
  return undefined;
}

/**
 * 找到本机官方客户端的目录缓存文件。
 *
 * 不写死 uid：`default` 指针优先后，仍然会把 `.models/*` 全扫一遍，取版本号最大的
 * 那个 `catalog-v<N>`（客户端升到 v8 也只是文件名变化，这里自动跟上）。
 *
 * @returns {{ path: string, uid: string, scene?: string, mtimeMs: number, version: number } | undefined}
 */
export function findOfficialCatalog(options = {}) {
  const home = options.home ?? process.env.DSH_QODER_HOME ?? homedir();
  const modelsDir = options.modelsDir ?? join(home, QODER_HOME_DIR, ".models");
  let entries;
  try {
    entries = readdirSync(modelsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const pointer = readPointerUid(modelsDir);
  let best;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    const dir = join(modelsDir, uid);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const match = CATALOG_FILE_PATTERN.exec(file);
      if (match === null) continue;
      const version = Number(match[1]);
      if (!Number.isFinite(version)) continue;
      const path = join(dir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      // 排序：指针命中的 uid 优先 → 版本号大的优先 → 更新的优先。
      const score = (pointer?.uid === uid ? 1e15 : 0) + version * 1e9 + mtimeMs;
      if (best === undefined || score > best.score) {
        best = { path, uid, scene: pointer?.uid === uid ? pointer.scene : undefined, mtimeMs, version, score };
      }
    }
  }
  if (best === undefined) return undefined;
  const { score: _score, ...rest } = best;
  return rest;
}

/**
 * 读并解出官方目录缓存。
 *
 * @returns {{
 *   path: string, uid: string, scene?: string, version: number, mtimeMs: number,
 *   updatedAt: string, scenes: Record<string, unknown[]>, models: object[]
 * }}
 */
export function readOfficialCatalog(options = {}) {
  const found = findOfficialCatalog(options);
  if (found === undefined) {
    throw new Error("official-cache: 本机没有找到 Qoder 官方目录缓存（~/.qoder-cn/.models/*/catalog-v*）");
  }
  const text = readFileSync(found.path, "utf8");
  const scenes = decryptOfficialCache(text, found.uid);
  const chat = Array.isArray(scenes?.chat) ? scenes.chat : [];
  return {
    ...found,
    updatedAt: new Date(found.mtimeMs).toISOString(),
    scenes,
    models: chat.map((entry) => normalizeOfficialModel(entry)).filter((entry) => entry !== undefined),
  };
}

/**
 * 把官方目录条目压成我们关心的形状。
 *
 * 字段名直接对应服务端 / 缓存里的 snake_case——**不猜**：
 * `is_vl` 才是多模态能力，`minimal_version.cli` 才是版本门槛。
 */
export function normalizeOfficialModel(entry) {
  const id = typeof entry?.key === "string" ? entry.key.trim() : "";
  if (id.length === 0) return undefined;
  const tiers = [];
  const contextConfig = entry?.context_config;
  if (contextConfig !== null && typeof contextConfig === "object" && !Array.isArray(contextConfig)) {
    for (const [label, value] of Object.entries(contextConfig)) {
      const tokenCount = Number(value?.token_count);
      if (!Number.isFinite(tokenCount) || tokenCount <= 0) continue;
      tiers.push({ label, tokens: tokenCount, isDefault: value?.is_default === true });
    }
    tiers.sort((a, b) => b.tokens - a.tokens);
  }
  const efforts = [];
  const thinking = entry?.thinking_config;
  if (thinking !== null && typeof thinking === "object" && !Array.isArray(thinking)) {
    const enabled = thinking?.enabled;
    const listed = enabled?.efforts;
    if (listed !== null && typeof listed === "object" && !Array.isArray(listed)) {
      efforts.push(...Object.keys(listed));
    }
    if (thinking?.disabled !== null && typeof thinking?.disabled === "object") efforts.push("off");
  }
  const minimal = entry?.minimal_version;
  const minimalVersion = minimal !== null && typeof minimal === "object" && !Array.isArray(minimal)
    ? Object.fromEntries(Object.entries(minimal).filter(([, value]) => typeof value === "string" && value.length > 0))
    : undefined;
  const rate = Number(entry?.price_factor);
  return {
    id,
    name: typeof entry?.display_name === "string" && entry.display_name.length > 0 ? entry.display_name : id,
    isReasoning: entry?.is_reasoning === true,
    supportsImages: entry?.is_vl === true,
    isFree: entry?.is_free === true || rate === 0,
    isNew: entry?.is_new === true,
    rate: Number.isFinite(rate) ? rate : undefined,
    maxInputTokens: Number.isFinite(Number(entry?.max_input_tokens)) ? Number(entry.max_input_tokens) : undefined,
    contextTiers: tiers.length > 0 ? tiers : undefined,
    thinkingEfforts: efforts.length > 0 ? efforts : undefined,
    minimalVersion,
    promotion: entry?.promotion !== null && typeof entry?.promotion === "object" ? entry.promotion : undefined,
    tags: Array.isArray(entry?.tags) ? entry.tags.filter((tag) => typeof tag === "string") : undefined,
    enabled: entry?.enable === undefined ? true : entry.enable !== false,
  };
}

/**
 * 语义化版本比较（只比数值段，预发布标签忽略）。
 *
 * Qoder 的版本号有 `1.1.75-hotfix.1` 这种形状，`minimal_version` 里是 `1.1.70`。
 * 对门槛判断来说，`1.1.75-hotfix.1 >= 1.1.70` 就够用——不需要完整的 semver 语义。
 *
 * @returns {number} 负数表示 a < b，0 相等，正数表示 a > b
 */
export function compareVersion(a, b) {
  const parse = (value) => String(value ?? "")
    .split("-")[0]
    .split(".")
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** `minimal_version.cli` 是否拦得住我们（返回 `undefined` 表示没有门槛）。 */
export function requiredCliVersion(model) {
  const value = model?.minimalVersion?.cli;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 拿官方缓存当参照物，跟我们自己的目录比一遍。
 *
 * 三种结论必须**分开**说，混在一起就失去了这个功能的全部意义：
 *
 * - `missingHere`：官方客户端有、我们没有。可能是被版本门槛裁剪，也可能我们目录太旧。
 * - `missingThere`：我们有、官方客户端没有。通常说明官方已经下线，或它缓存太旧。
 * - `gated`：官方条目自带的 `minimal_version.cli` 高于我们的 `Cosy-Version`，
 *   **这就是「不是官方删了，是我们版本落后」的铁证**。
 *
 * @param {{ ourModels?: object[], official?: object, cosyVersion?: string }} input
 */
export function diffAgainstOfficial(input) {
  const ourModels = Array.isArray(input?.ourModels) ? input.ourModels : [];
  const official = input?.official;
  const cosyVersion = typeof input?.cosyVersion === "string" ? input.cosyVersion : undefined;
  if (official === undefined || official === null || !Array.isArray(official.models)) {
    return { available: false, reason: "没有读到官方目录缓存" };
  }
  const ours = new Set(ourModels.map((model) => String(model?.id ?? model?.key ?? "")));
  const officialModels = official.models.filter((model) => model.enabled !== false);
  const officialIds = new Set(officialModels.map((model) => model.id));
  const missingHere = [];
  const gated = [];
  for (const model of officialModels) {
    if (ours.has(model.id)) continue;
    const required = requiredCliVersion(model);
    const entry = { id: model.id, name: model.name, rate: model.rate, requires: required };
    missingHere.push(entry);
    if (required !== undefined && cosyVersion !== undefined && compareVersion(cosyVersion, required) < 0) {
      gated.push(entry);
    }
  }
  const missingThere = ourModels
    .map((model) => String(model?.id ?? ""))
    .filter((id) => id.length > 0 && !officialIds.has(id));
  return {
    available: true,
    path: official.path,
    uid: official.uid,
    updatedAt: official.updatedAt,
    cosyVersion,
    officialCount: officialModels.length,
    ourCount: ourModels.length,
    missingHere,
    missingThere,
    gated,
    /** 官方缓存更新，且没有无法解释的缺口时，双方一致。 */
    consistent: missingHere.length === 0 && missingThere.length === 0,
  };
}
