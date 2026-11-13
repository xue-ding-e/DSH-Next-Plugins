/**
 * dsh-qoder-connect 的协议层：COSY 签名、`Encode=1` 请求体编码、PAT→jobToken、
 * 模型目录、上游 SSE 解析、回环 shim。**只依赖 node: 内置模块**，不碰任何
 * @deepseek-ai/* 或 pi-ai 的东西 —— 这样宿主插件（./index.js）和离线签名器
 * （tools/cosy-signer.mjs）可以共用同一份协议实现，不会各存一份而漂移。
 */


import { createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { compareVersion, diffAgainstOfficial, readOfficialCatalog, requiredCliVersion } from "./official-cache.js";
import { createPrivacyFilter, hasPrivacyPlaceholder } from "./privacy-filter.js";

/**
 * 协议层自己解析 DSH home。
 *
 * 宿主进程里 `DSH_HOME` 由桌面启动器注入；签名器（tools/cosy-signer.mjs）跑在普通
 * Node 里没有这个变量，按 `~/.dsh` 兜底。Config 里显式给了 `patFile` 时不会走到这里。
 */
function protocolDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homedir(), ".dsh");
}

//#region 常量


/** DSH 里对用户展示的 provider id，也是模型选择器上那一组的名字（= 渠道名）。 */
export const QODER_PROVIDER = "qoder1";
export const QODER_DISPLAY_NAME = "Qoder CN";

/** 推理平面（COSY 签名 + `Encode=1`）。 */
export const DEFAULT_GATEWAY = "https://gateway.qoder.com.cn";
/** OpenAPI 平面（普通 Bearer）：userinfo / 额度 / 签到活动。 */
export const DEFAULT_OPENAPI = "https://openapi.qoder.com.cn";

/** PAT → jobToken。**不需要签名**，也不带 Encode。 */
const PATH_EXCHANGE = "/api/v1/jobToken/exchange";
const PATH_USERINFO = "/api/v1/userinfo";
/**
 * 模型目录。**必须带 `/algo` 前缀**：网关上的目录接口在 `/algo/api/v2/model/list`，
 * 少了 `/algo` 是 404（签名只覆盖去掉 `/algo` 的 pathname，所以签名本身没问题）。
 * `Encode=1` 只约束请求体，GET 的响应是明文 JSON。
 */
const PATH_MODELS = "/algo/api/v2/model/list?Encode=1";
/** 对话。CN 渠道的 agent 入口（pathname 部分；签名只覆盖它，不含 query）。 */
const PATH_CHAT = "/algo/api/v2/service/pro/sse/agent_chat_generation";
/**
 * 对话的完整路径 + 查询串。
 *
 * `Encode=1` 必须有（插件的请求体是编码过的）；`FetchKeys` / `AgentId` 是从
 * 社区 MIT 实现 `pi-provider-qoder` 抄来的，SDK 里的常量只有裸 pathname
 * （查询串由它的 wasm `prepareRequest` 补）。保险起见整串可配置：万一哪天服务端
 * 不认这两个参数，改配置即可，不用改代码。多带的查询参数一般会被忽略，
 * 而漏掉 `Encode=1` 是致命的，所以默认按「全带上」。
 */
export const DEFAULT_CHAT_PATH = `${PATH_CHAT}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
/** CN 客户端身份。SDK 里 `Ji ? "qoderclicn" : "qodercli"`，CN 走前者。 */
const DEFAULT_SESSION_TYPE = "qoderclicn";

//#endregion
//#region COSY 客户端身份常量

/**
 * COSY 内置 RSA 公钥（用来加密临时的 aesKey）。
 * 与 Qoder CLI 同一份；换 key 只会在服务端轮换时发生。
 */
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * 客户端身份版本号。
 *
 * ⚠️ 这是**硬编码契约**：`Cosy-Version` 落后于 Qoder CLI 当前版本时，服务端会
 * 返回被裁剪过的模型列表（本地实测：CLI 1.1.61 对应 1.1.38 可用）。
 * 随 CLI 升级要复核这里。
 */
export const COSY_VERSION = "1.1.75-hotfix.1";
/** OpenAPI 平面用的是另一条版本线。 */
export const COSY_OPENAPI_VERSION = "1.0.1";
/** App 的 clientType（SDK 里的 `Mh.clientType`）。 */
export const COSY_CLIENT_TYPE = "5";
const COSY_DATA_POLICY = "disagree";

/**
 * `reasoning_effort` 上游认的拼写（取自目录里每条模型的 `thinking_config.efforts`，
 * 并逐个实测确认：`dmodel`+`max`、`qmodel_38max`+`xhigh` 都正常返回正文）。
 */
const WIRE_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** DSH 思考档位的强弱序（`off` 另算，不进这个序）。 */
const EFFORT_RANK = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

/**
 * 逐模型的 pi-ai `thinkingLevelMap`：DSH 七个档位 → 该模型该发的 `reasoning_effort`。
 *
 * 规则只有两条，但都有依据：
 *   1. 官方声明过的档位**原样发**（`max`→`max`、`xhigh`→`xhigh`）。这是重点：
 *      早先把 `xhigh`/`max` 一律折成 `high`，等于把模型真支持的档位吃掉了 ——
 *      用户点「最大」拿到的其实是 high。
 *   2. 官方没声明的档位，取**距离最近**的官方档位；距离相同取**更强**的那个。
 *      理由：宁可多想，也不要把用户要的能力扣掉。实测上游对档位很宽容：
 *      `dmodel`+`max`、`qmodel_38max`+`xhigh` 都正常出正文，连没有 `thinking_config`
 *      的 `auto` 发 `max` 也只是被忽略，不报错。
 *
 * `off` 故意**不写进** map：pi-ai 的 qwen 分支据此发 `enable_thinking: false`，
 * 写进去反而让「关闭思考」失效。
 *
 * @param {{ thinkingEfforts?: string[] }} info 归一化后的目录条目
 * @returns {Record<string, string>} 只含 minimal/low/medium/high/xhigh/max 六个键
 */
export function buildThinkingLevelMap(info) {
  const declared = Array.isArray(info?.thinkingEfforts)
    ? info.thinkingEfforts.filter((effort) => Object.prototype.hasOwnProperty.call(EFFORT_RANK, effort))
    : [];
  if (declared.length === 0) {
    // 目录没给 `thinking_config`（auto / fast / mmodel）：沿用历史映射。
    // 这组值是长期跑通的，没有新依据就不动。
    return { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
  }
  const nearest = (level) => {
    if (declared.includes(level)) return level;
    const want = EFFORT_RANK[level];
    let best = declared[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of declared) {
      const delta = Math.abs(EFFORT_RANK[candidate] - want);
      if (delta < bestDelta || (delta === bestDelta && EFFORT_RANK[candidate] > EFFORT_RANK[best])) {
        best = candidate;
        bestDelta = delta;
      }
    }
    return best;
  };
  const map = {};
  for (const level of Object.keys(EFFORT_RANK)) map[level] = nearest(level);
  return map;
}

//#endregion
//#region Encode=1（Qoder 自定义 base64）

/** 自定义字母表：第 i 个字符替代标准 base64 的第 i 个字符。 */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const ENC_TABLE = new Uint8Array(256);
const DEC_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) {
  ENC_TABLE[i] = i;
  DEC_TABLE[i] = i;
}
for (let i = 0; i < 64; i += 1) {
  ENC_TABLE[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  DEC_TABLE[CUSTOM_ALPHABET.charCodeAt(i)] = STD_ALPHABET.charCodeAt(i);
}
// Qoder 用 `$` 代替标准 base64 的 `=`。
ENC_TABLE["=".charCodeAt(0)] = "$".charCodeAt(0);
DEC_TABLE["$".charCodeAt(0)] = "=".charCodeAt(0);

/**
 * 请求体编码：标准 base64 → 字母表重映射 → 三段块旋转。
 *
 *   标准串 std[0,n)，a = floor(n/3)
 *   密文 = map(std[n-a, n)) + map(std[a, n-a)) + map(std[0, a))
 *
 * 返回 Buffer 直接当请求体用。
 */
export function qoderEncodeBody(plain) {
  const std = Buffer.isBuffer(plain) ? plain.toString("base64") : Buffer.from(plain, "utf8").toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let dst = 0;
  for (let i = n - a; i < n; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  for (let i = a; i < n - a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  for (let i = 0; i < a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  return out;
}

/** {@link qoderEncodeBody} 的逆。线上响应不需要解，只给自检用。 */
export function qoderDecodeBody(encoded) {
  const e = Buffer.isBuffer(encoded) ? encoded.toString("latin1") : String(encoded);
  const n = e.length;
  const a = Math.floor(n / 3);
  const m = n - 2 * a;
  const std = Buffer.allocUnsafe(n);
  const put = (chars, at) => {
    for (let i = 0; i < chars.length; i += 1) std[at + i] = DEC_TABLE[chars.charCodeAt(i)];
  };
  put(e.slice(0, a), n - a);
  put(e.slice(a, a + m), a);
  put(e.slice(a + m, n), 0);
  return Buffer.from(std.toString("latin1"), "base64");
}

//#endregion
//#region COSY 鉴权头

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

/**
 * 签名只覆盖 pathname 去掉前导 `/algo`，**不含 query**。
 *
 * 例：`/algo/api/v2/model/list?Encode=1` → `/api/v2/model/list`。
 * 这一点错了会拿到 401 而不是 404，很容易误判成 token 失效。
 */
export function sigPathOf(url) {
  const p = new URL(url).pathname;
  return p.startsWith("/algo") ? p.slice("/algo".length) : p;
}

/** 机器码：优先用 Qoder 已落盘的那份，保证跨次稳定（否则服务端会当成新设备）。 */
export function resolveMachineId() {
  const candidates = [
    process.env.QODERCN_MACHINE_ID,
    join(homedir(), ".qoder-cn", ".auth", "machine_id"),
    join(homedir(), ".qoder", ".auth", "machine_id"),
  ].filter((p) => typeof p === "string" && p.length > 0);
  for (const path of candidates) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return value;
    } catch { /* 继续找下一个 */ }
  }
  const fallback = join(protocolDshHome(), "qoder", "machine-id");
  try {
    const value = readFileSync(fallback, "utf8").trim();
    if (value.length > 0) return value;
  } catch { /* 下面生成 */ }
  const generated = randomUUID();
  try {
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, `${generated}\n`, { mode: 0o600 });
  } catch { /* 只读环境就算了，本次进程内仍然一致 */ }
  return generated;
}

/** 平台串。SDK 会按 arch/os 拼，这里照抄。 */
function machineOs() {
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
  return process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}

/**
 * 生成 `Authorization: Bearer COSY.<payloadB64>.<sig>` 及其配套 `Cosy-*` 头。
 *
 * `body` 必须是**最终要发出去的字节**（即已经过 {@link qoderEncodeBody} 的那份），
 * 因为签名和 `Cosy-Bodyhash` / `Cosy-Bodylength` 都覆盖它。
 */
export function buildCosyHeaders(body, requestUrl, creds) {
  if (typeof creds?.userID !== "string" || creds.userID.length === 0) throw new Error("cosy: userID 为空");
  if (typeof creds?.authToken !== "string" || creds.authToken.length === 0) throw new Error("cosy: authToken 为空");

  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name ?? "",
    aid: "",
    email: creds.email ?? "",
  };
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = cipher.update(JSON.stringify(userInfo), "utf8", "base64") + cipher.final("base64");
  const cosyKey = publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: 1 /* RSA_PKCS1_PADDING */ },
    Buffer.from(aesKey),
  ).toString("base64");

  const ts = String(Math.floor(Date.now() / 1000));
  const cosyVersion = typeof creds?.cosyVersion === "string" && creds.cosyVersion.length > 0
    ? creds.cosyVersion
    : COSY_VERSION;
  const payloadB64 = Buffer.from(JSON.stringify({
    version: "v1",
    requestId: randomUUID(),
    info: infoB64,
    cosyVersion,
    ideVersion: "",
  })).toString("base64");

  const bodyBytes = body === undefined || body === null
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  const sig = createHash("md5")
    .update(payloadB64).update("\n")
    .update(cosyKey).update("\n")
    .update(ts).update("\n")
    .update(bodyBytes).update("\n")
    .update(sigPathOf(requestUrl))
    .digest("hex");

  const machineId = creds.machineID ?? resolveMachineId();
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": ts,
    "Cosy-Version": cosyVersion,
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": "5",
    "Cosy-Machineos": machineOs(),
    "Cosy-Clienttype": COSY_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": md5(bodyBytes),
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": sigPathOf(requestUrl),
    "Cosy-Data-Policy": COSY_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": "v2",
    "X-Request-Id": randomUUID(),
  };
}

//#endregion
/** PAT 默认路径 —— 必须在 DSH_HOME 可用之后求值。 */
export function defaultPatPath() {
  return join(protocolDshHome(), "qoder", "pat");
}

const PAT_ENV_KEYS = ["QODERCN_PAT", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_API_KEY"];
const LEGACY_ACCOUNT_ID = "legacy";
const ACCOUNT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MAX_ACCOUNT_LABEL_LENGTH = 80;
const MAX_PAT_LENGTH = 4096;

function qoderPatDirectory() {
  return join(protocolDshHome(), "qoder");
}

function accountMetadataPath() {
  return join(qoderPatDirectory(), "accounts.json");
}

function accountPatDirectory() {
  return join(qoderPatDirectory(), "accounts");
}

function accountPatPath(id) {
  if (!ACCOUNT_ID_PATTERN.test(id)) throw new Error("Qoder 账号 ID 无效");
  return join(accountPatDirectory(), `${id}.pat`);
}

function normalizeAccountLabel(value, fallback) {
  const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (label.length > 0 ? label : fallback).slice(0, MAX_ACCOUNT_LABEL_LENGTH);
}

function readAccountMetadata() {
  try {
    const raw = JSON.parse(readFileSync(accountMetadataPath(), "utf8"));
    const accounts = Array.isArray(raw?.accounts)
      ? raw.accounts
        .filter((item) => ACCOUNT_ID_PATTERN.test(String(item?.id ?? "")))
        .map((item) => ({
          id: String(item.id),
          label: normalizeAccountLabel(item.label, "Qoder 账号"),
        }))
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
      : [];
    return {
      activeId: typeof raw?.activeId === "string" ? raw.activeId : LEGACY_ACCOUNT_ID,
      legacyLabel: normalizeAccountLabel(raw?.legacyLabel, "默认 PAT 文件"),
      accounts,
    };
  } catch {
    return { activeId: LEGACY_ACCOUNT_ID, legacyLabel: "默认 PAT 文件", accounts: [] };
  }
}

function writeAccountMetadata(metadata) {
  mkdirSync(qoderPatDirectory(), { recursive: true });
  const payload = {
    version: 1,
    activeId: metadata.activeId,
    legacyLabel: normalizeAccountLabel(metadata.legacyLabel, "默认 PAT 文件"),
    accounts: metadata.accounts.map((item) => ({ id: item.id, label: item.label })),
  };
  writeFileSync(accountMetadataPath(), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function writePatFile(path, pat) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pat}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * 生效的 Cosy-Version：配置优先，否则用内置默认。
 *
 * 内置默认值刻意跟本机 Qoder CN 客户端版本对齐；服务端按这个版本号决定返回多少
 * 模型，落后就会被裁剪，所以它必须可配、可随客户端升级改配置。
 */
export function resolveCosyVersion(config) {
  const value = config?.()?.cosyVersion;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  // 没显式配置时，读本机 Qoder CN 客户端自己的版本号 —— 这样换一台机器装插件
  // 也能自动对上，不用手改常量（服务端按这个版本决定返回多少模型）。
  return detectLocalQoderVersion() ?? COSY_VERSION;
}

/** 本机 Qoder CN 客户端版本（读最近的 run manifest），只探测一次。 */
let detectedVersion;
let detectedAt = 0;
export function detectLocalQoderVersion() {
  if (detectedVersion !== undefined) return detectedVersion;
  if (Date.now() - detectedAt < 300000) return detectedVersion; // 5 分钟内失败过就不再 IO
  detectedAt = Date.now();
  try {
    const runs = join(homedir(), ".qoder-cn", "logs", "runs");
    const entries = readdirSync(runs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, dir: join(runs, entry.name) }))
      .map((entry) => ({ ...entry, mtime: statSync(entry.dir).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);
    for (const entry of entries) {
      const manifest = JSON.parse(readFileSync(join(entry.dir, "manifest.json"), "utf8"));
      const version = manifest?.cli_version;
      if (typeof version === "string" && /^\d+\.\d+/.test(version)) {
        detectedVersion = version;
        return version;
      }
    }
  } catch { /* 没装客户端就回退到内置默认值 */ }
  return undefined;
}

//#region 凭据（PAT）

/**
 * PAT 读取器。
 *
 * 每次 `resolve()` 都重新读盘 + 重新读环境变量，所以宿主侧换 PAT 之后**不用重启
 * DSH** 就能生效（与 WorkBuddy / Trae 两条路一致）。
 */
export function createPatStore(options) {
  const { config } = options;
  const explicitPath = () => {
    const value = config()?.patFile;
    return typeof value === "string" && value.length > 0 ? value : defaultPatPath();
  };

  const fromEnv = () => {
    for (const key of PAT_ENV_KEYS) {
      const value = process.env[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return {
          pat: value.trim(),
          source: key,
          accountId: `env:${key}`,
          label: `环境变量（${key}）`,
        };
      }
    }
    return undefined;
  };

  const accountEntries = (metadata = readAccountMetadata()) => [
    {
      id: LEGACY_ACCOUNT_ID,
      label: metadata.legacyLabel,
      path: explicitPath(),
      source: "legacy-file",
      readonly: true,
    },
    ...metadata.accounts.map((item) => ({
      id: item.id,
      label: item.label,
      path: accountPatPath(item.id),
      source: "file",
      readonly: false,
    })),
  ];

  const entryFor = (id, metadata = readAccountMetadata()) => accountEntries(metadata).find((entry) => entry.id === id);

  const fromFile = (entry) => {
    const path = entry.path;
    if (!existsSync(path)) return undefined;
    try {
      const value = readFileSync(path, "utf8").trim();
      return value.length > 0
        ? { pat: value, source: path, accountId: entry.id, label: entry.label }
        : undefined;
    } catch {
      return undefined;
    }
  };

  const validatePat = (found) => {
    if (found === undefined) return undefined;
    if (found.pat.length > MAX_PAT_LENGTH) {
      throw new Error(`${found.source} 里的令牌长度异常，请重新生成 Qoder PAT。`);
    }
    if (!found.pat.startsWith("pt-")) {
      throw new Error(`${found.source} 里的令牌不是 pt- 前缀，Qoder 的 PAT 形如 pt-xxxxxxxx。`);
    }
    return found;
  };

  const accountState = () => {
    const metadata = readAccountMetadata();
    const env = fromEnv();
    const selected = entryFor(metadata.activeId, metadata) ?? entryFor(LEGACY_ACCOUNT_ID, metadata);
    const effectiveId = env?.accountId ?? selected.id;
    const accounts = accountEntries(metadata).map((entry) => ({
      id: entry.id,
      label: entry.label,
      active: effectiveId === entry.id,
      configured: fromFile(entry) !== undefined,
      source: entry.source,
      readonly: entry.readonly,
    }));
    if (env !== undefined) {
      accounts.unshift({
        id: env.accountId,
        label: env.label,
        active: true,
        configured: true,
        source: "environment",
        readonly: true,
      });
    }
    return {
      activeAccountId: effectiveId,
      environmentOverride: env?.source,
      accounts,
      selectedPath: selected.path,
    };
  };

  const requireFileEntry = (id, metadata = readAccountMetadata()) => {
    const entry = entryFor(id, metadata);
    if (entry === undefined || entry.source === "environment") throw new Error("Qoder 账号不存在");
    return entry;
  };

  const publicAccount = (entry, state = accountState()) => state.accounts.find((item) => item.id === entry.id)
    ?? { id: entry.id, label: entry.label, active: false, configured: false, source: entry.source, readonly: entry.readonly };

  return {
    path: explicitPath,
    activePath: () => accountState().selectedPath,
    listAccounts: () => accountState().accounts,
    state: accountState,
    async addAccount(label, pat, activate = true) {
      if (typeof activate !== "boolean") throw new Error("activate 必须是布尔值");
      const metadata = readAccountMetadata();
      const id = randomUUID();
      const entry = {
        id,
        label: normalizeAccountLabel(label, `Qoder 账号 ${metadata.accounts.length + 1}`),
        path: accountPatPath(id),
        source: "file",
        readonly: false,
      };
      const clean = validatePat({ pat: typeof pat === "string" ? pat.trim() : "", source: "新 Qoder PAT" });
      writePatFile(entry.path, clean.pat);
      metadata.accounts.push({ id: entry.id, label: entry.label });
      if (activate) metadata.activeId = entry.id;
      writeAccountMetadata(metadata);
      return publicAccount(entry);
    },
    async replaceAccount(id, label, pat) {
      const metadata = readAccountMetadata();
      const entry = requireFileEntry(id, metadata);
      const clean = validatePat({ pat: typeof pat === "string" ? pat.trim() : "", source: "新的 Qoder PAT" });
      writePatFile(entry.path, clean.pat);
      if (entry.id !== LEGACY_ACCOUNT_ID) {
        const record = metadata.accounts.find((item) => item.id === entry.id);
        if (record !== undefined) record.label = normalizeAccountLabel(label, record.label);
      }
      metadata.activeId = entry.id;
      writeAccountMetadata(metadata);
      return publicAccount(entry);
    },
    async renameAccount(id, label) {
      const metadata = readAccountMetadata();
      const entry = requireFileEntry(id, metadata);
      const nextLabel = normalizeAccountLabel(label, entry.label);
      if (entry.id === LEGACY_ACCOUNT_ID) {
        metadata.legacyLabel = nextLabel;
      } else {
        const record = metadata.accounts.find((item) => item.id === entry.id);
        if (record === undefined) throw new Error("Qoder 账号不存在");
        record.label = nextLabel;
      }
      writeAccountMetadata(metadata);
      return publicAccount(entryFor(entry.id, metadata), accountState());
    },
    async selectAccount(id) {
      if (fromEnv() !== undefined) throw new Error("检测到 QODERCN_PAT 等环境变量，它会优先于界面账号；请先清除环境变量后再切换。");
      const metadata = readAccountMetadata();
      const entry = requireFileEntry(id, metadata);
      metadata.activeId = entry.id;
      writeAccountMetadata(metadata);
      return publicAccount(entry);
    },
    async removeAccount(id) {
      if (id === LEGACY_ACCOUNT_ID) throw new Error("默认 PAT 文件由你手动维护，不能从这里删除；可以直接替换它。");
      const metadata = readAccountMetadata();
      const entry = requireFileEntry(id, metadata);
      try {
        unlinkSync(entry.path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      metadata.accounts = metadata.accounts.filter((item) => item.id !== entry.id);
      if (metadata.activeId === entry.id) metadata.activeId = LEGACY_ACCOUNT_ID;
      writeAccountMetadata(metadata);
      return accountState();
    },
    /**
     * 取 PAT。读不到就抛，由调用方降级成「未登录」。
     *
     * 环境变量优先于文件：便于临时用另一个账号跑一次而不动落盘的凭据。
     */
    async resolve() {
      const env = fromEnv();
      const metadata = readAccountMetadata();
      const selected = entryFor(metadata.activeId, metadata) ?? entryFor(LEGACY_ACCOUNT_ID, metadata);
      const found = env ?? fromFile(selected);
      if (found === undefined) {
        throw new Error(`未配置 Qoder PAT：既没有 QODERCN_PAT/QODERCN_PERSONAL_ACCESS_TOKEN/QODERCN_API_KEY，也读不到 ${selected.path}。请到 https://qoder.com.cn/account/integrations 建一个 pt- 开头的 PAT。`);
      }
      return validatePat(found);
    },
    async current() {
      try {
        return await this.resolve();
      } catch {
        return undefined;
      }
    },
  };
}

//#endregion
//#region jobToken 管理

/** 换来的 jobToken 还剩不到这个时长就提前重换一次。 */
const JOB_TOKEN_SKEW_MS = 120000;

/**
 * `expires_at` 在 Qoder 的返回里可能是 ISO 串、秒级数字或毫秒级数字；
 * `expires_in` 可能是秒也可能是毫秒。全部宽容处理，读不出来就返回 undefined
 * （调用方按「保守 30 分钟」处理）。
 */
export function resolveExpiry(doc) {
  const at = doc?.expires_at;
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof at === "number" && Number.isFinite(at)) return at < 1e12 ? at * 1000 : at;
  const inSecondsOrMs = doc?.expires_in;
  if (typeof inSecondsOrMs === "number" && Number.isFinite(inSecondsOrMs) && inSecondsOrMs > 0) {
    return Date.now() + (inSecondsOrMs < 1e6 ? inSecondsOrMs * 1000 : inSecondsOrMs);
  }
  return undefined;
}

/** 保守兜底：拿不到有效期时按 30 分钟算。 */
const ASSUMED_JOB_TOKEN_TTL_MS = 1800000;

/**
 * PAT → jobToken 的管理器。
 *
 * 一次成功的交换缓存起来；并发调用只会打一次上游（single-flight）。
 * jobToken 过期就重新用 PAT 换 —— PAT 本身不会过期（除非用户在网页上吊销）。
 */
export function createTokenManager(options) {
  const { pats, logger, config } = options;
  const openapiBase = () => String(config()?.openapiBase ?? DEFAULT_OPENAPI).replace(/\/+$/, "");

  /** @type {{ jobToken: string, expiresAt: number, userID: string, name: string, email: string, machineID: string, source: string, accountId?: string, label?: string }|undefined} */
  let cached;
  /** @type {Promise<unknown>|undefined} */
  let inflight;

  /** PAT 交换。不需要签名，也不带 Encode —— 这是唯一一条「裸」请求。 */
  async function exchange(pat) {
    const url = `${openapiBase()}${PATH_EXCHANGE}`;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "dsh-qoder-connect",
          "Cosy-Version": COSY_OPENAPI_VERSION,
          "Cosy-ClientType": COSY_CLIENT_TYPE,
        },
        body: JSON.stringify({ personal_token: pat }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new Error(`连不上 Qoder OpenAPI（${openapiBase()}）：${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const brief = text.replace(/\s+/g, " ").slice(0, 200);
      if (response.status === 401 || response.status === 403) {
        throw new Error(`PAT 被拒绝（HTTP ${response.status}）：可能已吊销或填错。${brief}`);
      }
      throw new Error(`PAT 交换失败（HTTP ${response.status}）：${brief}`);
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error(`PAT 交换返回的不是 JSON：${text.slice(0, 200)}`);
    }
    const jobToken = typeof doc?.token === "string" ? doc.token.trim() : "";
    if (jobToken.length === 0) throw new Error(`PAT 交换没有返回 token：${text.slice(0, 200)}`);
    return {
      jobToken,
      refreshToken: typeof doc?.refresh_token === "string" ? doc.refresh_token : "",
      expiresAt: resolveExpiry(doc) ?? (Date.now() + ASSUMED_JOB_TOKEN_TTL_MS),
    };
  }

  /**
   * userinfo：补上 COSY 签名需要的 uid/name/email。
   *
   * **这一条走 OpenAPI 平面的普通 `Bearer <jobToken>`，不是 COSY 签名** —— 签名本身
   * 需要 uid，而 uid 又要由它换出来（先有鸡还是先有蛋），所以引导这一跳只能用 bearer。
   * 服务端在 openapi 平面只校验 jobToken 本身。
   */
  async function fetchUserInfo(creds) {
    const url = `${openapiBase()}${PATH_USERINFO}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.authToken}`,
        Accept: "application/json",
        "Cosy-Version": COSY_OPENAPI_VERSION,
        "Cosy-ClientType": COSY_CLIENT_TYPE,
        "User-Agent": "dsh-qoder-connect",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw new Error(`userinfo 返回 HTTP ${response.status}：${(await response.text().catch(() => "")).slice(0, 200)}`);
    }
    const doc = await response.json().catch(() => undefined);
    // 形状没打中时把顶层键留在错误里 —— 否则只看到「没有 id」完全没法定位。
    if (typeof doc?.id !== "string" || doc.id.length === 0) {
      const keys = doc !== null && typeof doc === "object" ? Object.keys(doc).slice(0, 12).join(",") : typeof doc;
      throw new Error(`userinfo 返回 200 但没有 id 字段（顶层键：${keys}）`);
    }
    return {
      userID: doc.id,
      email: typeof doc?.email === "string" ? doc.email : "",
      name: typeof doc?.name === "string" ? doc.name : (typeof doc?.username === "string" ? doc.username : ""),
    };
  }

  async function refresh() {
    const { pat, source, accountId, label } = await pats.resolve();
    const exchanged = await exchange(pat);
    const machineID = resolveMachineId();

    // userinfo 要 uid 才能签，而 uid 又要拿 jobToken 去问 —— 先要一次再补全。
    let identityError;
    const identity = await fetchUserInfo({ userID: "", authToken: exchanged.jobToken, machineID }).catch((error) => {
      identityError = error instanceof Error ? error.message : String(error);
      logger?.warn(`dsh-qoder-connect: userinfo 读取失败（额度与签到会缺账号名，推理不受影响）：${identityError}`);
      return { userID: "", email: "", name: "" };
    });
    if (identity.userID === "") {
      // uid 拿不到就签不出 COSY，等于不能用。
      throw new Error(`Qoder userinfo 没有返回用户 id，无法生成 COSY 签名：${identityError ?? "响应里没有 id 字段"}`);
    }

    cached = {
      // 推理平面签名要的字段名是 authToken（= jobToken），两者必须同时留一份：
      // jobToken 给 OpenAI 兼容层/诊断看，authToken 给 buildCosyHeaders 用。
      jobToken: exchanged.jobToken,
      authToken: exchanged.jobToken,
      expiresAt: exchanged.expiresAt,
      userID: identity.userID,
      name: identity.name,
      email: identity.email,
      machineID,
      cosyVersion: resolveCosyVersion(config),
      pat,
      source,
      accountId,
      label,
    };
    logger?.debug?.(`dsh-qoder-connect: jobToken 已刷新（uid=${cached.userID}，有效期至 ${new Date(cached.expiresAt).toISOString()}）`);
    return cached;
  }

  return {
    /**
     * 拿一份当前可用的凭据；过期、缺失、或 **PAT 被换过** 就重换。
     *
     * 每次调用都重新读一次 PAT 源（环境变量或文件，一次 readFile，成本可忽略）：
     * 否则换了 PAT 得等 jobToken 自然过期（24h）才生效，和 README 的承诺对不上。
     */
    async get() {
      const found = await pats.resolve().catch(() => undefined);
      if (cached !== undefined) {
        if (found === undefined || found.pat !== cached.pat) cached = undefined;
      }
      if (cached !== undefined && cached.expiresAt - JOB_TOKEN_SKEW_MS > Date.now()) return cached;
      if (inflight === undefined) {
        inflight = refresh().finally(() => { inflight = undefined; });
      }
      return inflight;
    },
    /** 只读快照，不触发刷新；状态路由用它避免每次打开面板都打上游。 */
    peek() {
      return cached;
    },
    /** 强制重换（PAT 在网页上被吊销后，用户改了 pat 文件等场景）。 */
    invalidate() {
      cached = undefined;
    },
  };
}

//#endregion
//#region 模型目录

/**
 * 拿不到目录时的兜底名单。
 *
 * 为什么现在能写全 11 个：这些不再是猜的。我们解开了 Qoder 桌面客户端的官方目录
 * 缓存（`~/.qoder-cn/.models/<uid>/catalog-v<N>`，见 `lib/official-cache.js`），
 * 里面的 `chat` 场景就是官方客户端看到的权威清单 —— key、`display_name`、
 * `price_factor`、`max_input_tokens`、`is_vl`、`is_reasoning`、`is_free` 全部来自它，
 * 并与服务端 `/algo/api/v2/model/list` 的返回逐字段核对过。
 *
 * 目录一旦拉到真数据就以真数据为准；这份只在「一次都没拉成」时生效，
 * 免得模型组为空被 DSH 整个隐藏掉。
 *
 * `contextWindow` 取官方 `max_input_tokens`（模型真实能吃多少），
 * 不是 `context_config` 的档位最大值 —— 理由见 `contextWindowOf`。
 */
export const FALLBACK_QODER_MODELS = [
  { id: "auto", name: "Auto", contextWindow: 200000, maxTokens: 32000, supportsImages: true, isReasoning: true, isFree: false, rate: 0.5 },
  { id: "fast", name: "Fast", contextWindow: 200000, maxTokens: 32000, supportsImages: true, isReasoning: true, isFree: false, rate: 0.8 },
  { id: "qmodel_38max", name: "Qwen3.8-Max", contextWindow: 180000, maxTokens: 32000, supportsImages: true, isReasoning: true, isFree: false, rate: 0.2 },
  { id: "qfmodel", name: "Qwen3.8-Flash", contextWindow: 180000, maxTokens: 32000, supportsImages: true, isReasoning: true, isFree: true, rate: 0.1 },
  { id: "dmodel", name: "DeepSeek-V4-Pro", contextWindow: 96000, maxTokens: 32000, supportsImages: true, isReasoning: true, isFree: false, rate: 0.5 },
  { id: "dfmodel", name: "DeepSeek-Flash", contextWindow: 180000, maxTokens: 32000, supportsImages: true, isReasoning: false, isFree: false, rate: 0.1 },
  { id: "gmodel", name: "GLM-5.3", contextWindow: 180000, maxTokens: 32000, supportsImages: true, isReasoning: true, isFree: false, rate: 0.8 },
  { id: "gfmodel", name: "GLM-5.3-Flash", contextWindow: 1000000, maxTokens: 32000, supportsImages: true, isReasoning: true, isFree: false, rate: 0.1 },
  { id: "kmodel_latest", name: "Kimi-K3.1-Pro", contextWindow: 180000, maxTokens: 32000, supportsImages: true, isReasoning: false, isFree: false, rate: 1 },
  { id: "kmodel", name: "Kimi-K2.8-Preview", contextWindow: 180000, maxTokens: 32000, supportsImages: true, isReasoning: true, isFree: false, rate: 0.8 },
  { id: "mmodel", name: "MiniMax-M3.1-Flash", contextWindow: 180000, maxTokens: 32000, supportsImages: true, isReasoning: false, isFree: false, rate: 0.1 },
];

/** 宽松取数：数字或数字串都认（SDK 的 `oci()` 就是这么写的）。 */
function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 宽松取布尔（SDK 的 `aci()`）。 */
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return undefined;
}

/**
 * 模型实际能吃的输入长度 = `max_input_tokens`（官方客户端同样把它当硬上限）。
 *
 * **不是** `context_config` 里最大的那个档位。这不是推测 —— 是反编译客户端
 * `qoder-worker-runtime.obf.mjs` 里的窗口解析得到的（三个函数，语义完整闭环）：
 *
 * ```js
 * // ① 能选哪些档位：完全不看 context_config，从 max_input_tokens 生成候选
 * function aAe(model) {
 *   const t = model.max_input_tokens;           // 上限
 *   const add = (n) => { if (n > 0 && n <= t && !out.includes(n)) out.push(n); };
 *   add(128000); add(200000); add(t);           // 128K / 200K / 上限，超出上限的丢掉
 *   return out;
 * }
 * // ② 某个档位合不合法：一律拿 max_input_tokens 卡
 * function sAe(model, n) { return cap === undefined || n <= cap; }
 * // ③ 没传 context_length 时用哪个：default_context_window（目录里没有）→ 否则就是上限
 * function Krt(model, requested, fallback) { ... return fallback; }
 * ```
 *
 * 所以 `context_config` 里的 `1M/400K/200K` 是**全局通用档位表**，会被 `n <= cap`
 * 过滤掉：DeepSeek-Flash（cap=180000）只剩 `[128K, 180K]`，1M 根本不出现；
 * DeepSeek-V4-Pro（cap=96000）只剩 `[96K]`。真正 1M 的只有 GLM-5.3-Flash（cap=1000000）。
 *
 * 为什么必须照这个来：DSH 拿 `contextWindow` 决定**什么时候压缩上下文**。
 * 把 180K 的模型声明成 1M，等于让它一直不压缩，长对话必然上游报超长。
 */
function contextWindowOf(entry) {
  const maxInput = toNumber(entry?.max_input_tokens ?? entry?.maxInputTokens);
  if (maxInput !== undefined && maxInput > 0) return maxInput;
  const config = entry?.context_config;
  if (config !== null && typeof config === "object" && !Array.isArray(config)) {
    let best;
    for (const window of Object.values(config)) {
      const count = toNumber(window?.token_count);
      if (count !== undefined && (best === undefined || count > best)) best = count;
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

/**
 * 该模型**可选**的上下文档位，逐字复刻官方客户端 `aAe()` 的算法：
 * 候选 `128K / 200K / 上限`，凡超过上限的一律丢掉。
 *
 * 放在状态接口里是为了让「为什么是 180K」这件事**在面板上自证**：
 * DeepSeek-Flash 会显示成 `180K（可选 128K / 180K）`，一眼能看出 1M 不在其中。
 */
export function availableContextWindows(entry) {
  const explicit = Array.isArray(entry?.available_context_windows) ? entry.available_context_windows : undefined;
  if (explicit !== undefined) {
    const windows = [...new Set(explicit.map((value) => toNumber(value)).filter((value) => value !== undefined && value > 0))];
    if (windows.length > 0) return windows;
  }
  const cap = contextWindowOf(entry);
  if (cap === undefined) return [];
  const windows = [];
  const add = (value) => {
    if (value > 0 && value <= cap && !windows.includes(value)) windows.push(value);
  };
  add(128000);
  add(200000);
  add(cap);
  return windows;
}

/**
 * 把网关的 `chat[]` 条目归一化成本插件内部形状。
 *
 * 字段名以 `@qoder-ai/qoder-cn-agent-sdk` 的 `sci()` 为准（那里是 camelCase 与
 * snake_case 都认）——**倍率就是 `price_factor`**，界面上按 `<n>×` 显示。
 */
export function normalizeCatalogEntry(raw) {
  const key = String(raw?.key ?? raw?.model_key ?? "").trim();
  if (key.length === 0) return undefined;
  const enabled = raw?.enable === undefined ? true : (toBoolean(raw.enable) ?? true);
  const rate = toNumber(raw?.price_factor ?? raw?.priceFactor);
  const free = toBoolean(raw?.is_free ?? raw?.isFree) ?? (rate === 0);
  return {
    id: key,
    name: String(raw?.display_name ?? raw?.name ?? key) || key,
    contextWindow: contextWindowOf(raw),
    maxTokens: toNumber(raw?.max_output_tokens) ?? 32000,
    supportsImages: toBoolean(raw?.is_vl) === true,
    isReasoning: toBoolean(raw?.is_reasoning) === true,
    isFree: free,
    rate,
    originalRate: toNumber(raw?.original_price_factor ?? raw?.originPriceFactor),
    promotion: raw?.promotion !== null && typeof raw.promotion === "object" ? raw.promotion : undefined,
    source: typeof raw?.source === "string" ? raw.source : "system",
    outerProvider: typeof raw?.outer_provider === "string" ? raw.outer_provider : undefined,
    enabled,
    /**
     * 以下四项原先被丢掉了，现在留着——它们是**「版本落后 / 官方下线」判据的全部依据**：
     *
     * - `minimalVersion.cli`：这个模型要求的最低客户端版本。我们的 `Cosy-Version`
     *   低于它，服务端就把这个模型静默裁掉。这是「落后」的铁证。
     * - `contextTiers`：官方给的上下文档位（200K/400K/1M），带 `isDefault`。
     * - `thinkingEfforts`：官方认的思考档位（如 `high`/`max`、`xhigh`/`low`/`medium`）。
     * - `isNew` / `tags`：面板上「新模型」角标用。
     */
    minimalVersion: raw?.minimal_version !== null && typeof raw?.minimal_version === "object"
      ? Object.fromEntries(Object.entries(raw.minimal_version).filter(([, value]) => typeof value === "string" && value.length > 0))
      : undefined,
    contextTiers: contextTiersOf(raw),
    /** 该模型**真正可选**的上下文档位（官方 aAe 算法，超上限的已被过滤）。 */
    contextWindows: availableContextWindows(raw),
    thinkingEfforts: thinkingEffortsOf(raw),
    isNew: toBoolean(raw?.is_new) === true,
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((tag) => typeof tag === "string") : undefined,
  };
}

/** 官方上下文档位，按 token_count 从大到小。 */
function contextTiersOf(entry) {
  const config = entry?.context_config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const tiers = [];
  for (const [label, value] of Object.entries(config)) {
    const tokens = toNumber(value?.token_count);
    if (tokens === undefined || tokens <= 0) continue;
    tiers.push({ label, tokens, isDefault: value?.is_default === true });
  }
  if (tiers.length === 0) return undefined;
  tiers.sort((a, b) => b.tokens - a.tokens);
  return tiers;
}

/** 官方认的思考档位；`off` 表示「可以关」。 */
function thinkingEffortsOf(entry) {
  const thinking = entry?.thinking_config;
  if (thinking === null || typeof thinking !== "object" || Array.isArray(thinking)) return undefined;
  const efforts = [];
  const listed = thinking?.enabled?.efforts;
  if (listed !== null && typeof listed === "object" && !Array.isArray(listed)) efforts.push(...Object.keys(listed));
  if (thinking?.disabled !== null && typeof thinking?.disabled === "object") efforts.push("off");
  return efforts.length > 0 ? efforts : undefined;
}

/**
 * 模型目录。
 *
 * 与 WorkBuddy / Trae 两条路不同，Qoder 的目录是**懒加载 + 快照兜底**：
 * 只有拿到可用 jobToken 才会去拉一次，拉到就缓存；失败保留上一次的结果（或者
 * 兜底名单），绝不让「目录暂时不可用」升级成「渠道消失」。
 */
export function createCatalog(options) {
  const { tokens, logger, config } = options;
  const gateway = () => String(config()?.gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, "");

  let models = [...FALLBACK_QODER_MODELS];
  let source = "fallback";
  let fetchedAt = 0;
  let lastError;

  /** 打一次 `GET /api/v2/model/list?Encode=1`（COSY 签名，响应是明文 JSON）。 */
  async function fetchFromRemote(credential) {
    const url = `${gateway()}${PATH_MODELS}`;
    const response = await fetch(url, {
      headers: { ...buildCosyHeaders(null, url, credential), Accept: "application/json", "User-Agent": "dsh-qoder-connect" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`model/list 返回 HTTP ${response.status}：${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
    const doc = await response.json().catch(() => undefined);
    const chat = Array.isArray(doc?.chat) ? doc.chat : [];
    const usable = chat.map((entry) => normalizeCatalogEntry(entry)).filter((entry) => entry !== undefined && entry.enabled);
    if (usable.length === 0) throw new Error(`model/list 没有返回任何可用模型（chat 长度 ${chat.length}）`);
    return usable;
  }

  /** 刷新目录。并发调用共享同一次上游请求。 */
  let inflight;
  async function reload() {
    if (inflight === undefined) {
      inflight = (async () => {
        const credential = await tokens.get();
        const list = await fetchFromRemote(credential);
        models = list;
        source = "remote";
        fetchedAt = Date.now();
        lastError = undefined;
        logger?.info?.(`dsh-qoder-connect: 目录已刷新，${list.length} 个模型可用`);
        return list;
      })().catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
        logger?.warn?.(`dsh-qoder-connect: 目录刷新失败，沿用${source === "remote" ? "上次快照" : "兜底名单"}：${lastError}`);
        throw error;
      }).finally(() => { inflight = undefined; });
    }
    return inflight;
  }

  return {
    reload,
    source: () => source,
    fetchedAt: () => fetchedAt,
    lastError: () => lastError,
    current: () => models,
    find: (id) => models.find((model) => model.id === id),
  };
}

//#endregion
//#region 上游对话客户端

/** 逐字节喂入的 SSE 读取器：`event:<name>\n` + `data:<payload>\n\n`。 */
export function createSseReader() {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  const dataLines = [];
  const pending = [];

  const flush = () => {
    if (eventName === "" && dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    pending.push({ event: eventName === "" ? "message" : eventName, raw });
    eventName = "";
    dataLines.length = 0;
  };

  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") { flush(); continue; }
        if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
        if (line.startsWith("data:")) { dataLines.push(line.slice(5).replace(/^ /, "")); continue; }
      }
      const out = pending.slice();
      pending.length = 0;
      return out;
    },
    pending() {
      const out = pending.slice();
      pending.length = 0;
      return out;
    },
  };
}

/** Qoder 的 SSE 控制哨兵（见 SDK 的 `giA()`）。 */
function isControlSentinel(raw) {
  return raw === "[DONE]"
    || raw === "[NOT_EXCEED_QUOTA]"
    || raw.startsWith("[EXCEED_QUOTA]")
    || raw.startsWith("[NOTIFICATIONS]");
}

/**
 * 解开一层 Qoder 信封。
 *
 * Qoder 的 `data:` 有两层：
 *   data: {"statusCodeValue":200,"statusCode":200,"body":"{\"choices\":[...]}"}
 * 其中 `body` 是**字符串**，里面才是 OpenAI 形状的 chunk；也可能是 `"[DONE]"`。
 *
 * 返回：
 *   `{kind:"chunk", chunk}`   内层是普通 chunk
 *   `{kind:"done"}`           流结束
 *   `{kind:"error", message}` 上游业务错误
 *   `{kind:"ignore"}`         控制哨兵 / 空事件
 */
export function unwrapQoderEvent(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { kind: "ignore" };
  if (text === "[DONE]") return { kind: "done" };
  if (text === "[NOT_EXCEED_QUOTA]") return { kind: "ignore" };
  if (text.startsWith("[EXCEED_QUOTA]")) return { kind: "error", message: "Qoder 额度已用尽（EXCEED_QUOTA）" };
  if (text.startsWith("[NOTIFICATIONS]")) return { kind: "ignore" };

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { kind: "ignore" };
  }

  // 带信封的形状。
  if (envelope !== null && typeof envelope === "object" && envelope.statusCodeValue !== undefined && envelope.body !== undefined) {
    const code = toNumber(envelope.statusCodeValue);
    if (code !== undefined && code !== 200) {
      const detail = typeof envelope.body === "string" ? envelope.body : JSON.stringify(envelope.body);
      return { kind: "error", message: `Qoder 上游 ${code}：${detail.slice(0, 400)}` };
    }
    const body = envelope.body;
    if (typeof body !== "string") {
      // 有的实现直接把对象塞在 body 里。
      return body !== null && typeof body === "object" ? { kind: "chunk", chunk: body, envelope } : { kind: "ignore" };
    }
    const inner = body.trim();
    if (inner === "") return { kind: "ignore" };
    if (inner === "[DONE]") return { kind: "done" };
    if (isControlSentinel(inner)) return { kind: "ignore" };
    try {
      return { kind: "chunk", chunk: JSON.parse(inner), envelope };
    } catch {
      return { kind: "ignore" };
    }
  }

  // 裸 OpenAI chunk（防御性：万一服务端换了形状）。
  if (envelope !== null && typeof envelope === "object" && Array.isArray(envelope.choices)) {
    return { kind: "chunk", chunk: envelope };
  }
  return { kind: "ignore" };
}

/** 把 Qoder 的 delta 翻成 OpenAI 的 delta。 */
function deltaOf(chunk) {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
  const delta = choice?.delta;
  const message = choice?.message;
  if ((delta === null || typeof delta !== "object") && (message === null || typeof message !== "object")) return undefined;
  const out = {};
  if (typeof delta?.content === "string" && delta.content.length > 0) out.content = delta.content;
  // Qoder 的思考链字段就叫 reasoning_content（与 DeepSeek 一致）。
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) out.reasoning_content = delta.reasoning_content;
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    out.tool_calls = delta.tool_calls;
  } else if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    // 完整消息中的工具调用使用同一条参数恢复路径。
    out.tool_calls = message.tool_calls;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 取出「当前轮」的消息：从**最后一条 `role: "user"`** 开始到结尾。
 *
 * 为什么以 user 为界而不是别的：DSH 每个 turn 都以一条 user/message 开头，
 * 之后是 assistant/tool 交替，直到下一个 user/message 开始新的一轮。取最后一条
 * user 之后的部分，正好是「用户这一次问的东西 + 它引发的工具往返」。
 *
 * 只给顶层旁路字段（`image_urls` / `chat_context.imageUrls`）用 —— 真正生效的
 * `messages[].content` 一律原样透传，绝不在这里裁剪（那会改写模型记忆）。
 *
 * @param {readonly unknown[]} messages
 * @returns {readonly any[]} 当前轮消息；没有任何 user 时退化为整个列表
 */
function currentTurnMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === "user") return list.slice(i);
  }
  return list;
}

/** 组装对话请求体（OpenAI 形状 + Qoder 专有字段）。 */
export function buildChatBody(options) {
  const { modelKey, messages, isReasoning, reasoningEffort, maxTokens, tools, toolChoice, temperature, sessionId, sessionType } = options;
  const requestId = randomUUID();
  const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === "user");
  const promptText = typeof lastUser?.content === "string"
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
      : "";

  /**
   * 上下文预算：**本层只透传，不做任何裁剪或覆盖**。
   *
   * 用多少上下文是上层（DSH）的事 —— 它按 `resolveModel()` 报的 `contextWindow`
   * 决定何时压缩历史，再把最终消息序列交给我们。这里绝不截断 messages、也绝不
   * 自己加 context 参数：上层说用多少，下层就发多少。Qoder 的请求体里也没有
   * 「上下文长度」这种字段（实测只有 enable_thinking / reasoning_effort /
   * max_tokens），硬塞会被 400。
   */
  /** @type {Record<string, unknown>} */
  const parameters = { enable_thinking: isReasoning === true };
  if (Number.isFinite(maxTokens) && maxTokens > 0) parameters.max_tokens = Math.trunc(maxTokens);
  if (Number.isFinite(temperature)) parameters.temperature = temperature;
  if (isReasoning === true) {
    // 档位拼写以 Qoder 自己 `thinking_config.efforts` 里出现过的为准：
    // low / medium / high / xhigh / max。实测这五个值上游都收（dmodel+max、
    // qmodel_38max+xhigh 都正常出正文；连没有 thinking_config 的 auto 发 max 也只是
    // 被上游忽略，不报错）。
    //
    // 早先这里把 xhigh/max 折叠成 high，等于**把模型真支持的档位吃掉了**；
    // 现在只做两件事：DSH 独有的 minimal 归一成 low，认不出来的值兜底 high。
    const raw = typeof reasoningEffort === "string" && reasoningEffort.length > 0 ? reasoningEffort : "high";
    parameters.reasoning_effort = raw === "minimal"
      ? "low"
      : (WIRE_REASONING_EFFORTS.has(raw) ? raw : "high");
  }

  /**
   * 把**当前轮**的图片收成一份（data URL），给顶层 `image_urls` 用。
   * 没有图片时保持 `null`，与 App 客户端的形状一致。
   *
   * ⚠️ 只收当前轮，不再收整段历史 —— 这不是洁癖，是硬约束：
   *
   *   `messages[].content` 里那份才是**真正生效**的图片（见 Bug 7 的对照表：
   *   只有它能正确识图）。顶层这两个字段是「与 App 客户端一致」的旁路。
   *   而请求体会被 `qoderEncodeBody` 整体再做一次 base64（×4/3），于是
   *   **每多一份旁路就多 4/3 倍的图片字节**。早先这里收全量历史，等于把
   *   整段历史图片复制三遍：16 张图 ≈ 8.37 MB base64 → JSON 膨胀成 29 MB
   *   → 编码后 39 MB，直接顶穿 Qoder 网关 50 MB 的请求体上限，session
   *   0403132f 就是这样永久卡死的（每轮 413，连 /compact 都发不出去）。
   *
   *   收窄到当前轮后：旁路至多与「这一轮用户真正在问的那几张图」同量级，
   *   历史图片仍完整保留在 messages 里（模型该看见的一张不少），而
   *   请求体不再随对话长度线性膨胀。
   *
   *   App 客户端本来就只带当前轮的图 —— 这才是「与 App 一致」。
   */
  const imageUrls = [];
  for (const message of currentTurnMessages(messages)) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const url = part?.type === "image_url" ? part.image_url?.url : undefined;
      if (typeof url === "string" && url.length > 0) imageUrls.push(url);
    }
  }
  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: typeof sessionType === "string" && sessionType.length > 0 ? sessionType : DEFAULT_SESSION_TYPE,
    code_language: "",
    chat_prompt: "",
    /**
     * 图片：Qoder 真正认的是 **messages 里 content 的 `image_url` 片段**（实测能
     * 正确描述截图内容）。这个顶层字段与 `chat_context.imageUrls` 是 App 客户端
     * 一起带的旁路信息，仅带顶层会被回「无法查看这张图片」，所以两份都填上。
     */
    image_urls: imageUrls.length > 0 ? imageUrls : null,
    aliyun_user_type: "",
    // 顶层 system 服务端会忽略，系统提示走 messages 里的 {role:"system"}。
    system: "",
    messages: Array.isArray(messages) ? messages : [],
    tools: Array.isArray(tools) ? tools : [],
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    parameters,
    chat_context: {
      chatPrompt: "",
      imageUrls: imageUrls.length > 0 ? imageUrls : null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning === true },
        originalContent: promptText,
      },
      features: [],
      text: promptText,
    },
    model_config: { key: modelKey, source: "system" },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: requestId,
      name: promptText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
}

/**
 * 上游对话客户端。
 *
 * `chatStream` 发一次 `POST /algo/api/v2/service/pro/sse/agent_chat_generation`，
 * 返回一个**已经把 Qoder 双层 SSE 翻成 OpenAI SSE** 的 ReadableStream，
 * 这样 shim 只要 pipe 出去就行。
 */
export function createQoderClient(options) {
  const { tokens, logger, config } = options;
  const injectedPrivacy = options.privacy;
  const privacyInstances = new Set();
  let currentPrivacy;
  let currentPrivacyConfig = "";
  const gateway = () => String(config()?.gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, "");
  const chatPath = () => {
    const value = config()?.chatPath;
    return typeof value === "string" && value.length > 0 ? value : DEFAULT_CHAT_PATH;
  };
  const chatUrl = () => `${gateway()}${chatPath()}`;

  function privacyOf() {
    if (injectedPrivacy !== undefined) return injectedPrivacy;
    const privacyConfig = config()?.privacyFilter ?? {};
    const serialized = JSON.stringify(privacyConfig);
    if (currentPrivacy !== undefined && serialized === currentPrivacyConfig) return currentPrivacy;
    const next = createPrivacyFilter(privacyConfig, { spawn: options.spawnPrivacyFilter });
    const previous = currentPrivacy;
    currentPrivacy = next;
    currentPrivacyConfig = serialized;
    privacyInstances.add(next);
    if (previous !== undefined) void previous.close();
    return next;
  }

  /**
   * 发一次流式请求。
   *
   * 返回 `{ok:true, response}` 或 `{ok:false, status, kind, message}`。
   * 因为上游**总是**回 HTTP 200 + SSE（业务错误藏在信封的 `statusCodeValue` 里），
   * 所以这里先读**首个有效事件**再决定成败，避免已经写出 200 才发现是错误。
   *
   * 免费/低价模型（`qfmodel` 等）偶发「立刻空结束」：回一帧 `delta:{}` +
   * `finish_reason:"stop"` 就收工。DSH 会把这种响应当成 `EMPTY_RESPONSE` 直接失败，
   * 所以此时在**写响应头之前**重试一次——已经流式发出的内容不会重试。
   */
  async function chatStream(request, signal) {
    let last;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      last = await chatStreamOnce(request, signal);
      if (last.ok === true) return last;
      if (last.kind !== "empty") return last;
      if (signal?.aborted === true) return last;
      logger?.warn?.(`dsh-qoder-connect: 上游空响应（${request.model}），第 ${attempt} 次重试`);
    }
    return last;
  }

  async function chatStreamOnce(request, signal) {
    const credential = await tokens.get();
    const url = chatUrl();
    const privacy = privacyOf();
    let prepared;
    try {
      prepared = await privacy.maskBody(buildChatBody({
        modelKey: request.model,
        messages: request.messages,
        isReasoning: request.isReasoning,
        reasoningEffort: request.reasoningEffort,
        maxTokens: request.maxTokens,
        tools: request.tools,
        toolChoice: request.toolChoice,
        temperature: request.temperature,
        sessionId: request.sessionId,
        sessionType: config()?.sessionType,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn?.(`dsh-qoder-connect: Magpie 脱敏失败，已阻止 Qoder 请求 — ${message}`);
      return { ok: false, status: 503, kind: "privacy", message };
    }

    // 只有要发出去的字节才参与签名 —— 顺序不能反。
    const encoded = qoderEncodeBody(Buffer.from(JSON.stringify(prepared.body), "utf8"));
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          ...buildCosyHeaders(encoded, url, credential),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
          "X-Model-Key": request.model,
          "X-Model-Source": "system",
        },
        body: encoded,
        signal,
      });
    } catch (error) {
      if (signal?.aborted === true) return { ok: false, status: 0, kind: "aborted", message: "客户端已取消" };
      return { ok: false, status: 0, kind: "network", message: `连不上 Qoder 网关：${error instanceof Error ? error.message : String(error)}` };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const auth = response.status === 401 || response.status === 403;
      if (auth) tokens.invalidate();
      return {
        ok: false,
        status: response.status,
        kind: auth ? "auth" : "upstream",
        message: auth
          ? `Qoder 拒绝了凭据（HTTP ${response.status}）：jobToken 可能已失效或 PAT 被吊销。${text.slice(0, 200)}`
          : text.replace(/\s+/g, " ").slice(0, 400),
      };
    }
    if (response.body === null) return { ok: false, status: response.status, kind: "upstream", message: "Qoder 返回了空响应体" };

    const reader = response.body.getReader();
    const parser = createSseReader();
    let first;
    const leftoverEvents = [];
    /** 见过「空 delta 但带 finish_reason」= 模型什么都没生成就收尾。 */
    let emptyFinish = false;
    while (first === undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(value)) {
        // push() 已移出整批事件，首个有效事件之后的帧必须交给 translate。
        if (first !== undefined) { leftoverEvents.push(event); continue; }
        const parsed = unwrapQoderEvent(event.raw);
        if (parsed.kind === "ignore") continue;
        if (parsed.kind !== "chunk") { first = parsed; continue; }
        // 空内容的首帧不能当「有效事件」：放过去会让 DSH 拿到一个空响应。
        if (chunkHasPayload(parsed.chunk)) { first = parsed; continue; }
        if (chunkHasFinish(parsed.chunk)) emptyFinish = true;
      }
    }
    if (first === undefined) {
      return emptyFinish
        ? { ok: false, status: 502, kind: "empty", message: "Qoder 立刻空结束（模型没有生成任何正文）" }
        : { ok: false, status: 502, kind: "upstream", message: "Qoder 流提前结束，没有读到任何事件" };
    }
    if (first.kind === "error") return { ok: false, status: 502, kind: "upstream", message: first.message };
    if (first.kind === "done") return { ok: false, status: 502, kind: "empty", message: "Qoder 只回了一个结束标记，没有正文" };
    return { ok: true, response: translate(reader, parser, leftoverEvents, first, request, signal, prepared) };
  }

  /** 这一帧 delta 里到底有没有「内容」（正文 / 思考链 / 工具调用）。 */
function chunkHasPayload(chunk) {
  for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
    const delta = choice?.delta;
    if (typeof delta?.content === "string" && delta.content.length > 0) return true;
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return true;
    if (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0) return true;
  }
  return false;
}

/** 这一帧是不是带了收尾标记。 */
function chunkHasFinish(chunk) {
  for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
    if (typeof choice?.finish_reason === "string" && choice.finish_reason.length > 0) return true;
  }
  return false;
}

/** 把 Qoder 事件流翻译成 OpenAI SSE，沿用首帧预读的解析状态和剩余事件。 */
  function translate(reader, parser, leftoverEvents, firstChunk, request, signal, prepared) {
    const model = request.model;
    const id = `chatcmpl-qoder-${randomBytes(8).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    // 延用预读的解析器，保留半帧文本和跨网络块的 UTF-8 解码状态。
    let usage;
    let finished = false;
    const responseRestorer = prepared.createResponseRestorer?.();
    const calls = new Map();

    function restoreDelta(delta) {
      if (delta === undefined || responseRestorer === undefined) return delta;
      const { tool_calls, ...out } = delta;
      for (const key of ["content", "reasoning_content"]) {
        if (typeof out[key] === "string") out[key] = responseRestorer.restore(key, out[key]);
      }
      // Wait for complete JSON so escaping and unresolved markers are checked
      // before DSH receives any of the calls.
      for (const [position, call] of (tool_calls ?? []).entries()) {
        const index = call.index ?? position;
        const prior = calls.get(index);
        calls.set(index, {
          ...prior,
          ...call,
          index,
          function: {
            ...prior?.function,
            ...call.function,
            arguments: (prior?.function.arguments ?? "") + (call.function?.arguments ?? ""),
          },
        });
      }
      return out;
    }

    function restoredCalls() {
      return [...calls.values()].map((call) => {
        const original = call.function.arguments || "{}";
        let changed = false;
        const args = JSON.parse(original, (_key, value) => {
          if (typeof value !== "string") return value;
          const restored = prepared.restoreArgument(value);
          if (hasPrivacyPlaceholder(restored)) throw new Error("Unresolved Magpie placeholder");
          changed ||= value !== restored;
          return restored;
        });
        if (args === null || typeof args !== "object" || Array.isArray(args) || hasPrivacyPlaceholder(JSON.stringify(args))) {
          throw new Error("Invalid tool arguments after Magpie restoration");
        }
        return { ...call, function: { ...call.function, arguments: changed ? JSON.stringify(args) : original } };
      });
    }

    const chunk = (delta, finishReason) => {
      const payload = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
      };
      if (finishReason !== undefined && finishReason !== null) {
        // openai-completions 的解析器只在最后一帧读 usage，所以并到收尾帧里。
        // billable / credits / *_details 一并透出：这是 Qoder 的真实计费口径，
        // 丢掉它们就等于把「这次花了多少钱」藏起来了。
        payload.usage = usage === undefined || usage === null
          ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          : usage;
      }
      return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
    };

    return new ReadableStream({
      start(controller) {
        // `finished` = 逻辑上收尾了；`closed` = 流真的关了。两者必须分开，
        // 否则 done 事件里 close() 之后 pump() 结尾再 close() 会抛 ERR_INVALID_STATE。
        let closed = false;
        const closeStream = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* 下游已取消 */ }
        };
        const enqueue = (bytes) => {
          if (closed) return;
          try { controller.enqueue(bytes); } catch { closed = true; }
        };
        const finish = (reason) => {
          for (const [key, text] of responseRestorer?.flush() ?? []) {
            if (text.length > 0) enqueue(chunk({ [key]: text }));
          }
          let toolCalls;
          if (calls.size > 0 && ["stop", "tool_calls", "function_call"].includes(reason)) {
            try {
              toolCalls = restoredCalls();
            } catch (error) {
              logger?.warn?.("dsh-qoder-connect: Qoder 工具参数无效或含未还原的 Magpie 占位符，已阻止工具执行");
              enqueue(encoder.encode(`data: ${JSON.stringify({ error: {
                message: "Qoder 工具参数无效或含未还原的 Magpie 占位符。请使用原始值重试。",
                code: "MAGPIE_TOOL_ARGUMENTS",
              } })}\n\n`));
              reason = "network_error";
            }
          }
          finished = true;
          if (toolCalls?.length > 0) enqueue(chunk({ tool_calls: toolCalls }));
          enqueue(chunk({}, toolCalls?.length > 0 && reason === "stop" ? "tool_calls" : reason));
          enqueue(encoder.encode("data: [DONE]\n\n"));
          closeStream();
        };
        const emit = (parsed) => {
          if (finished || closed) return;
          if (parsed.kind === "ignore") return;
          if (parsed.kind === "error") {
            enqueue(chunk({ content: `\n\n[Qoder 错误] ${parsed.message}` }));
            return;
          }
          if (parsed.kind === "done") {
            finish("stop");
            return;
          }
          const inner = parsed.chunk;
          if (inner?.usage !== undefined && inner.usage !== null) usage = inner.usage;
          const choice = Array.isArray(inner?.choices) ? inner.choices[0] : undefined;
          const delta = restoreDelta(deltaOf(inner));
          if (delta !== undefined && Object.keys(delta).length > 0) enqueue(chunk(delta));
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
            finish(choice.finish_reason);
          }
        };

        const pump = async () => {
          try {
            // 首个 chunk 已经在 chatStream 里读出来了，这里补发。
            if (firstChunk !== undefined) emit(firstChunk);
            for (const raw of leftoverEvents) emit(unwrapQoderEvent(raw.raw));
            while (!finished && !closed) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const event of parser.push(value)) emit(unwrapQoderEvent(event.raw));
            }
            if (!finished) {
              finish(calls.size > 0 ? "network_error" : "stop");
            }
            closeStream();
          } catch (error) {
            logger?.warn?.(`dsh-qoder-connect: 上游流中断：${error instanceof Error ? error.message : String(error)}`);
            if (!finished) {
              finish(calls.size > 0 ? "network_error" : "stop");
            }
            closeStream();
          }
        };

        if (signal?.aborted === true) { finished = true; closeStream(); return; }
        pump();
      },
      cancel() {
        finished = true;
        reader.cancel().catch(() => {});
      },
    });
  }

  return {
    chatStream,
    async close() {
      await Promise.allSettled([...privacyInstances].map((privacy) => privacy.close()));
      privacyInstances.clear();
      currentPrivacy = undefined;
    },
  };
}

//#endregion
/**
 * 把 Qoder 的双层 SSE 聚合成一个标准 `chat.completion` 对象。
 *
 * 用于非流式请求（`stream` 不是 true）。正文拼 `delta.content`，思考链拼
 * `delta.reasoning_content`（放在 `reasoning_content` 字段里，OpenAI 兼容客户端
 * 会忽略它，需要的人能读到）。
 */
export function aggregateSseToCompletion(bytes, fallbackModel) {
  const reader = createSseReader();
  const events = reader.push(bytes);
  const parts = [];
  const reasoning = [];
  let finishReason = "stop";
  let usage;
  let id = `chatcmpl-qoder-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  /** 上游会把请求里的 model 名改写成它实际路由到的模型（如 auto），记下来。 */
  let routedModel;

  for (const event of events) {
    if (event.raw === "" || event.raw.startsWith("[")) continue;
    const parsed = unwrapQoderEvent(event.raw);
    if (parsed.kind !== "chunk") continue;
    const chunk = parsed.chunk;
    if (typeof chunk?.id === "string" && chunk.id.length > 0) id = chunk.id;
    if (typeof chunk?.created === "number") created = chunk.created;
    if (typeof chunk?.model === "string" && chunk.model.length > 0) model = chunk.model;
    // 计费在**最后一条 chunk 的 usage 里**（含 billable / credits），只认带数字的那条：
    // 中间的空 delta chunk 也可能带 usage 字段但内容为空，不能拿来覆盖。
    if (chunk?.usage !== undefined && chunk?.usage !== null && Number.isFinite(chunk.usage.total_tokens)) {
      usage = chunk.usage;
    }
    for (const choice of chunk?.choices ?? []) {
      if (typeof choice?.delta?.content === "string") parts.push(choice.delta.content);
      if (typeof choice?.delta?.reasoning_content === "string") reasoning.push(choice.delta.reasoning_content);
      if (typeof choice?.finish_reason === "string" && choice.finish_reason.length > 0) finishReason = choice.finish_reason;
    }
  }
  if (model !== fallbackModel) routedModel = model;

  const message = { role: "assistant", content: parts.join("") };
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("");

  // usage 是 Qoder 自己那套（比 OpenAI 多 billable / credits / *_details），
  // 原样透出，在 Apifox 里就能直接看到这一次调用花了多少额度。
  const normalizedUsage = usage === undefined || usage === null
    ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    : usage;

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: normalizedUsage,
    // 上游没给 usage 时显式标出来，免得误以为「花了 0 额度」。
    ...(usage === undefined || usage === null ? { qoder_usage_unavailable: true } : {}),
    // 请求的模型与实际路由到的模型不一致时（例如 auto），两个都告诉调用方。
    ...(routedModel === undefined || routedModel === fallbackModel ? {} : { qoder_routed_model: routedModel }),
  };
}

//#region 回环 shim

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Host 头是不是回环地址（IPv6 带方括号）。 */
function hostnameOfHost(host) {
  const text = String(host ?? "").trim().toLowerCase();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end === -1 ? text : text.slice(0, end + 1);
  }
  return text.replace(/:\d+$/, "");
}
function hostIsLoopback(host) {
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
function originIsLoopback(origin) {
  if (typeof origin !== "string" || origin.trim() === "") return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname === "::1" ? "[::1]" : hostname);
  } catch {
    return false;
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function writeOpenAIError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: code, code } });
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * OpenAI → Qoder 的消息转换。
 *
 * Qoder 的请求是 OpenAI 形状，但 **role 是白名单**：上游反序列化只认
 * `system` / `user` / `assistant` / `tool` / `latest_reminder`，其它一律 400
 * （实测报错：`` messages[0].role: unknown variant `developer` ``）。
 *
 * DSH 会把系统提示以 OpenAI 的 `developer` 角色发下来，所以这里必须降级成
 * `system` —— 不透传，也不丢消息。
 */
const QODER_ROLES = new Set(["system", "user", "assistant", "tool", "latest_reminder"]);

export function toQoderMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== "object") continue;
    const rawRole = typeof message.role === "string" ? message.role : "user";
    // developer（OpenAI 新规范）→ system：语义等价，且 Qoder 只认后者。
    const role = rawRole === "developer" ? "system" : (QODER_ROLES.has(rawRole) ? rawRole : "user");
    /** @type {Record<string, unknown>} */
    const next = { role };
    if (typeof message.content === "string") {
      next.content = message.content;
    } else if (Array.isArray(message.content)) {
      next.content = message.content
        .map((part) => {
          if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
          if (part?.type === "image_url" && part.image_url?.url) return { type: "image_url", image_url: { url: part.image_url.url } };
          return undefined;
        })
        .filter((part) => part !== undefined);
    } else {
      next.content = "";
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) next.tool_calls = message.tool_calls;
    if (typeof message.tool_call_id === "string") next.tool_call_id = message.tool_call_id;
    if (typeof message.name === "string") next.name = message.name;
    out.push(next);
  }
  if (out.length === 0) out.push({ role: "user", content: "" });
  return out;
}

/** 把 OpenAI 的 tools 原样透传（Qoder 的请求就是 OpenAI 形状）。 */
function toQoderTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool?.type === "function" && typeof tool.function?.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.function.name,
        ...(typeof tool.function.description === "string" ? { description: tool.function.description } : {}),
        parameters: tool.function.parameters ?? { type: "object", properties: {} },
        ...(typeof tool.function.strict === "boolean" ? { strict: tool.function.strict } : {}),
      },
    }));
}

/** 解码模型 id 里可选的后缀：`<key>@think` 强制开思考、`@nothink` 强制关。 */
export function decodeModelId(raw, fallback) {
  const id = typeof raw === "string" ? raw : "";
  if (id.endsWith("@think")) return { model: id.slice(0, -"@think".length), thinking: true };
  if (id.endsWith("@nothink")) return { model: id.slice(0, -"@nothink".length), thinking: false };
  return { model: id, thinking: fallback };
}

/**
 * 回环 OpenAI shim。与另外两条渠道同构：随机端口 + 随机 bearer，
 * 只服务三个路由；上游换成 Qoder 客户端。
 */
export function createQoderShim(options) {
  const { client, catalog } = options;
  const logger = options.logger;
  /**
   * 每次启动换一份共享密钥；只在 127.0.0.1 上用。
   *
   * 独立网关（tools/cosy-signer.mjs serve）会显式传 \`secret\` 和 \`port\`，
   * 这样 Apifox 里能填一个稳定的本地地址；DSH 宿主插件不传，保持随机端口 +
   * 随机密钥，外部拿不到。
   */
  const SHARED_SECRET = typeof options.secret === "string" && options.secret.length > 0
    ? options.secret
    : randomBytes(32).toString("base64url");
  const listenPort = Number.isInteger(options.port) ? options.port : 0;

  function bearerOk(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;
    const given = Buffer.from(match[1]);
    const expected = Buffer.from(SHARED_SECRET);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  const server = createServer((req, res) => { handle(req, res); });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(listenPort, "127.0.0.1");
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("dsh-qoder-connect: shim 没有监听地址");
    return `http://127.0.0.1:${address.port}`;
  };

  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) { writeOpenAIError(res, 403, "host_not_allowed", "Host 必须是回环地址"); return; }
      if (!originIsLoopback(req.headers.origin)) { writeOpenAIError(res, 403, "origin_not_allowed", "Origin 必须是回环地址"); return; }
      if (!bearerOk(req)) { writeOpenAIError(res, 401, "unauthorized", "Authorization bearer 缺失或不匹配"); return; }
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) { writeJson(res, 200, { ok: true }); return; }
      if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
        writeJson(res, 200, {
          object: "list",
          data: catalog.current().map((model) => ({ id: model.id, object: "model", created: 0, owned_by: QODER_PROVIDER })),
        });
        return;
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) { await chatCompletions(req, res); return; }
      writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
    } catch (error) {
      if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
      else res.end();
    }
  }

  async function chatCompletions(req, res) {
    if (typeof req.headers["content-type"] !== "string" || !req.headers["content-type"].toLowerCase().includes("application/json")) {
      writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type 必须是 application/json");
      return;
    }
    let request;
    try {
      request = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      writeOpenAIError(res, 400, "invalid_json", "请求体不是合法 JSON");
      return;
    }
    const decoded = decodeModelId(request.model, undefined);
    const entry = catalog.find(decoded.model);
    /**
     * 思考档位：pi-ai 按 `compat.thinkingFormat: "qwen"` 会发
     * `enable_thinking` + `reasoning_effort`，这两个字段 Qoder 自己就认。
     *
     * 关键：显式 false 必须当 false。不能用「模型是 reasoning」回兜底 —— 那样用户
     * 在菜单里选「关闭」也会被我们强行打开。
     */
    const reasoningEffort = typeof request.reasoning_effort === "string" && request.reasoning_effort.length > 0
      ? request.reasoning_effort
      : (typeof request.reasoning?.effort === "string" ? request.reasoning.effort : undefined);
    const explicitThinking = typeof request.enable_thinking === "boolean";
    const isReasoning = explicitThinking || reasoningEffort !== undefined
      ? (request.enable_thinking === true || reasoningEffort !== undefined)
      : (decoded.thinking ?? entry?.isReasoning ?? false);

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    let result;
    try {
      result = await client.chatStream({
        model: decoded.model,
        messages: toQoderMessages(request.messages),
        tools: toQoderTools(request.tools),
        toolChoice: request.tool_choice,
        isReasoning,
        reasoningEffort,
        maxTokens: request.max_tokens ?? request.max_completion_tokens,
        temperature: request.temperature,
      }, controller.signal);
    } catch (error) {
      writeOpenAIError(res, 401, "not_signed_in", error instanceof Error ? error.message : String(error));
      return;
    }

    if (!result.ok) {
      const status = result.kind === "auth" ? 401 : result.kind === "aborted" ? 499 : result.kind === "privacy" ? 503 : 502;
      writeOpenAIError(res, status, result.kind, `qoder upstream (http ${result.status}): ${result.message.slice(0, 500)}`);
      return;
    }
    /**
     * OpenAI 的语义是：`stream:true` 回 SSE，否则回一个完整 JSON。
     * Qoder 上游**永远**回 SSE，所以非流式请求要在这里聚合成一个响应 ——
     * 少了这段，Apifox / 任何普通 HTTP 客户端拿到的都是 `data: {...}` 文本，
     * `JSON.parse` 直接失败。
     */
    if (request.stream !== true) {
      const chunks = [];
      let sawDone = false;
      for await (const chunk of Readable.fromWeb(result.response)) {
        if (Buffer.isBuffer(chunk) && chunk.includes("[DONE]")) sawDone = true;
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      void sawDone;
      const aggregated = aggregateSseToCompletion(Buffer.concat(chunks), decoded.model);
      writeJson(res, 200, aggregated);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let sawDone = false;
    const body = Readable.fromWeb(result.response);
    body.on("data", (chunk) => { if (chunk.includes("[DONE]")) sawDone = true; });
    body.on("error", (error) => {
      logger?.warn?.(`dsh-qoder-connect: 上游流中断：${error instanceof Error ? error.message : String(error)}`);
      if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
    });
    body.pipe(res);
  }

  let closePromise;
  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closePromise = new Promise((resolve, reject) => {
        server.close(() => resolve());
        server.closeAllConnections();
        server.once("error", reject);
      }).then(() => client.close?.());
      return closePromise;
    },
  };
}

//#endregion

//#region 目录审计（版本裁剪 / 官方下线）
//
// 「模型变少了」有两条完全不同的原因，处理方式相反：
//
//   1. **官方下线** —— 服务端真的没了这个模型，我们应该跟着删。
//   2. **我们版本落后** —— 模型还在，只是服务端按 `Cosy-Version` 静默裁掉。
//
// 光看自己的目录分不清。这里用两个相互独立的参照物：
//
//   A. **高版本探测**（网络、零推理）：用 `Cosy-Version: 9.9.9` 再问一次目录。
//      实测服务端对高版本**不做裁剪**，所以拿到的是「已知全体」。每个条目自带
//      `minimal_version.cli`，于是我们能算出「按我们当前版本应该看到哪些」，
//      缺口里能被 `minimal_version.cli` 解释的就是「落后」，其余才是真异常。
//
//   B. **官方客户端缓存**（离线、零网络）：Qoder 桌面客户端把它自己那份目录缓存在
//      `~/.qoder-cn/.models/<uid>/catalog-v<N>`（加密，但密钥由 uid 派生，见
//      `lib/official-cache.js`）。那是同一账号、同一台机器上**官方客户端看到的东西**，
//      跟我们比一遍：官方有我们没有 → 要查；我们有官方没有 → 大概率已下线。
//
// 两者都只打元数据接口/只读本地文件，**不产生任何推理计费**，可以高频跑。

/** 探测用的「足够高」的版本号：服务端对它不做裁剪。 */
export const CATALOG_PROBE_VERSION = "9.9.9";

/** 打一次目录接口，返回解析后的 JSON（不做归一化）。 */
async function fetchCatalogDocument(options) {
  const { credential, gateway, version, timeoutMs = 20000 } = options;
  const base = String(gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, "");
  const url = `${base}${PATH_MODELS}`;
  const res = await fetch(url, {
    headers: {
      ...buildCosyHeaders(null, url, { ...credential, cosyVersion: version }),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`目录探测 ${version} 返回 HTTP ${res.status}：${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * 完整目录审计：高版本探测 + 官方缓存比对。
 *
 * 返回值里的 `behind` / `missing` / `gated` / `unexplained` 是给面板和 CLI 直接用的：
 *
 * - `behind=true` 且 `unexplained` 为空 → **纯版本落后**，把 `cosyVersion` 调到
 *   `suggestedVersion` 就好，`gated` 里逐条写着「哪个模型要求哪个版本」。
 * - `unexplained` 非空 → 官方没删、版本也够，那我们就是有 bug，得查。
 * - `official.missingThere` 非空 → 我们还在显示官方已经不给的模型。
 *
 * 任何一步失败都只降级对应字段，不让整个面板 500。
 */
export async function probeCatalogAudit(options) {
  const { credential, gateway, cosyVersion, timeoutMs = 20000 } = options;
  const current = typeof cosyVersion === "string" && cosyVersion.length > 0
    ? cosyVersion
    : (credential?.cosyVersion ?? COSY_VERSION);

  // A. 高版本「已知全体」+ 当前版本「实际可见」——两个请求，并发拿。
  const [universeDoc, actualDoc] = await Promise.all([
    fetchCatalogDocument({ credential, gateway, version: CATALOG_PROBE_VERSION, timeoutMs }),
    fetchCatalogDocument({ credential, gateway, version: current, timeoutMs }),
  ]);
  const toList = (doc) => (Array.isArray(doc?.chat) ? doc.chat : [])
    .map((entry) => normalizeCatalogEntry(entry))
    .filter((entry) => entry !== undefined && entry.enabled);
  const universe = toList(universeDoc);
  const actual = toList(actualDoc);
  const actualIds = new Set(actual.map((model) => model.id));

  const missing = [];
  const gated = [];
  const unexplained = [];
  for (const model of universe) {
    if (actualIds.has(model.id)) continue;
    const requires = requiredCliVersion(model);
    const entry = { id: model.id, name: model.name, rate: model.rate, requires };
    missing.push(entry);
    if (requires !== undefined && compareVersion(current, requires) < 0) gated.push(entry);
    else unexplained.push(entry);
  }

  // 当前版本下「按 minimal_version 应该看到」的数量——比 universe 更有解释力。
  const expectedCount = universe.filter((model) => {
    const requires = requiredCliVersion(model);
    return requires === undefined || compareVersion(current, requires) >= 0;
  }).length;

  // B. 官方客户端缓存（离线）。
  let official;
  try {
    const catalog = readOfficialCatalog(options.officialOptions);
    official = {
      available: true,
      ...diffAgainstOfficial({ ourModels: actual, official: catalog, cosyVersion: current }),
      updatedAt: catalog.updatedAt,
      path: catalog.path,
    };
  } catch (error) {
    official = { available: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }

  return {
    cosyVersion: current,
    probeVersion: CATALOG_PROBE_VERSION,
    currentCount: actual.length,
    universeCount: universe.length,
    expectedCount,
    behind: gated.length > 0,
    /** 「落后」时可执行的建议：直接对齐探测用的高版本。 */
    suggestedVersion: gated.length > 0 ? CATALOG_PROBE_VERSION : undefined,
    /** 当前版本实际可见的模型清单（给 selfcheck 做基线对比用）。 */
    visibleIds: actual.map((model) => model.id),
    models: actual,
    missing,
    gated,
    unexplained,
    official,
    probes: [
      { version: current, count: actual.length, current: true },
      { version: CATALOG_PROBE_VERSION, count: universe.length },
    ],
  };
}

/**
 * 探测「我们是不是落后了」——**零 token 消耗**。
 *
 * 保留这个导出是为了向后兼容（面板与 selfcheck 早先读的是它的返回形状），
 * 真正的判据已经升级到 `probeCatalogAudit`：不再靠二分版本号猜门槛，
 * 而是直接读每个模型自带的 `minimal_version.cli`。
 */
export async function probeVersionTrimming(options) {
  const audit = await probeCatalogAudit(options);
  return {
    behind: audit.behind,
    current: audit.cosyVersion,
    currentCount: audit.currentCount,
    suggestedVersion: audit.suggestedVersion,
    suggestedCount: audit.universeCount,
    gated: audit.gated,
    unexplained: audit.unexplained,
    probes: audit.probes,
  };
}

//#endregion
//#region 账号侧（额度 / 套餐）

/**
 * OpenAPI 平面的只读客户端：额度、套餐、登录用户。
 *
 * 这一层**不走 COSY 签名**，就是普通 `Bearer <jobToken>` + `Cosy-ClientType`
 * —— Qoder 桌面 App 自己也是这么打这几个接口的（实测 200）。
 *
 * 全部「尽力而为」：任一项失败只让对应字段缺省，不影响推理链路。
 */
export function createQoderAccountClient(options) {
  const { tokens, config } = options;
  const openapiBase = () => String(config()?.openapiBase ?? DEFAULT_OPENAPI).replace(/\/+$/, "");

  async function getJson(path) {
    const credential = await tokens.get();
    const response = await fetch(`${openapiBase()}${path}`, {
      headers: {
        Authorization: `Bearer ${credential.jobToken}`,
        Accept: "application/json",
        "Cosy-Version": COSY_OPENAPI_VERSION,
        "Cosy-ClientType": COSY_CLIENT_TYPE,
        "User-Agent": "dsh-qoder-connect",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw new Error(`${path} 返回 HTTP ${response.status}：${(await response.text().catch(() => "")).slice(0, 200)}`);
    }
    return response.json();
  }

  return {
    /** 套餐 + 组织信息（`/api/v2/user/plan`）。 */
    async fetchPlan() {
      const doc = await getJson("/api/v2/user/plan");
      return {
        planTierName: doc?.plan_tier_name ?? "",
        userType: doc?.user_type ?? "",
        isPaidPlan: doc?.is_paid_plan === true,
        isHighestTier: doc?.is_highest_tier === true,
        organization: {
          id: doc?.organization?.org_id ?? "",
          name: doc?.organization?.org_name ?? "",
          role: doc?.organization?.role_name ?? "",
        },
      };
    },
    /** 额度用量（`/api/v2/quota/usage`）。 */
    async fetchUsage() {
      const doc = await getJson("/api/v2/quota/usage");
      const quota = doc?.userQuota ?? {};
      return {
        usageType: doc?.usageType ?? "",
        isQuotaExceeded: doc?.isQuotaExceeded === true,
        expiresAt: typeof doc?.expiresAt === "number" ? new Date(doc.expiresAt).toISOString() : undefined,
        upgradeUrl: doc?.upgradeUrl ?? "",
        quota: {
          total: toNumber(quota.total) ?? 0,
          used: toNumber(quota.used) ?? 0,
          remaining: toNumber(quota.remaining) ?? 0,
          percentage: toNumber(quota.percentage) ?? 0,
          unit: quota.unit ?? "credits",
        },
        orgPackage: {
          used: toNumber(doc?.orgResourcePackage?.used) ?? 0,
          cap: toNumber(doc?.orgResourcePackage?.cap) ?? 0,
          available: doc?.orgResourcePackage?.available === true,
        },
      };
    },
    /** 登录用户。 */
    async fetchUserInfo() {
      const doc = await getJson("/api/v1/userinfo");
      return {
        userId: doc?.id ?? "",
        name: doc?.name ?? doc?.username ?? "",
        email: doc?.email ?? "",
        avatar: doc?.avatar ?? "",
      };
    },
  };
}

//#endregion
