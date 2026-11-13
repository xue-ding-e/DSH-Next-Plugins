/**
 * dsh-qoder-connect 的宿主层：把 Qoder CN 的模型注册成 DSH 的一个 provider 渠道。
 *
 * 协议实现在 ./protocol.js；这里只做 DSH 0.2.x 的接线：
 * Config（schemastery）、pi-ai 适配器、provider 注册、目录巡检与运行态落盘。
 */

import z from "@deepseek-ai/schemastery";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveImageAttachmentAccess, resolveRetryPolicy, RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { updateQoderCli } from "./qoder-cli.js";
import {
  QODER_DISPLAY_NAME,
  QODER_PROVIDER,
  createCatalog,
  createPatStore,
  createQoderAccountClient,
  createQoderClient,
  createQoderShim,
  createTokenManager,
  probeCatalogAudit,
  buildThinkingLevelMap,
} from "./protocol.js";

/** Cordis 插件名。必须与 cordis.patch.yml 里的 `id` 一致。 */
export const name = "llm-qoder";
/** 注册 provider 之前必须先拿到模型注册表。 */
export const inject = ["llm"];

//#region 配置

const PAT_FILE_FIELD = z.string().description("Qoder 默认 PAT 文件（默认 $DSH_HOME/qoder/pat；界面新增账号会另存到 qoder/accounts）");
const GATEWAY_FIELD = z.string().description("Qoder 推理网关（默认 https://gateway.qoder.com.cn）");
const OPENAPI_FIELD = z.string().description("Qoder OpenAPI 网关（额度/签到；默认 https://openapi.qoder.com.cn）");
const CHAT_PATH_FIELD = z.string().description("对话路径与查询串（默认 /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1）");
const SESSION_TYPE_FIELD = z.string().description("session_type 取值（CN 客户端是 qoderclicn；国际版 qodercli）");
const COSY_VERSION_FIELD = z.string().description("Cosy-Version 取值（默认跟本机 Qoder CN 客户端版本；服务端裁剪模型列表时就调这个）");
const POLL_FIELD = z.number().description("凭据/目录巡检间隔（毫秒）");
/**
 * 按模型覆盖「上下文窗口」。
 *
 * 为什么需要这个开关：DSH 的压缩阈值是按 `contextWindow × 0.8` 算的，而
 * `contextWindow` 最终来自**适配器**（`preparedCall.context.contextWindow` 写进
 * 会话的 `request/context`）。DSH 设置页里那个「上下文窗口」滑块改的是**另一个
 * 层**（配置化 provider 的目录项），对程序化注册的 `qoder1` 不生效 —— 实测把
 * dfmodel 拖到 1M 后，新会话的 `request/context` 仍是 `180000`。
 *
 * 所以想真的放大窗口，必须在适配器这层改：这里按模型 id 覆盖目录值。
 * 注意这是**信任调用方**的开关 —— 声明值超过 Qoder 官方 `max_input_tokens` 时，
 * 一旦真的发超过该上限，上游可能直接报超长。
 *
 * 例：`{ dfmodel: 1000000 }`
 */
const CONTEXT_WINDOW_OVERRIDES_FIELD = z.dict(z.number())
  .description("按模型覆盖上下文窗口（如 { dfmodel: 1000000 }）；仅在你明确知道上游能吃更多时使用");

const PRIVACY_FILTER_FIELD = z.object({
  enabled: z.boolean(),
  preserveUrls: z.boolean().description("将 HTTP(S) 链接原样发送给 Qoder，包括查询参数。默认脱敏并在本地恢复。"),
  cacheDir: z.string(),
  modelPath: z.string(),
  executablePath: z.string(),
  threshold: z.number(),
  startupTimeoutMs: z.number(),
  requestTimeoutMs: z.number(),
  chunkBytes: z.number(),
}).description("通过 Magpie 本地 privacy-filter/ pf-serve 在 Qoder 请求发出前脱敏；启用后资产缺失或分类失败会阻止请求");

export const Config = z.object({
  patFile: PAT_FILE_FIELD,
  gateway: GATEWAY_FIELD,
  openapiBase: OPENAPI_FIELD,
  chatPath: CHAT_PATH_FIELD,
  sessionType: SESSION_TYPE_FIELD,
  cosyVersion: COSY_VERSION_FIELD,
  pollIntervalMs: POLL_FIELD,
  contextWindowOverrides: CONTEXT_WINDOW_OVERRIDES_FIELD,
  privacyFilter: PRIVACY_FILTER_FIELD,
  retryPolicy: RetryPolicySchema,
});



//#endregion

//#region 适配器

/** pi-ai 的 auth 平面在本插件里必须惰性：认证只走 shim 的共享密钥。 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error("dsh-qoder-connect: the qoder route has no pi-ai credential lifecycle"); },
    async delete() {},
  },
  authContext: {
    async env() {},
  },
};

/** pi-ai 模型描述里要显式写 0，否则计费面板会按未知价格处理。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};
const QODER_STREAM_IDLE_TIMEOUT_MS = 300000;


/** 组装 pi-ai 的 provider + DSH 的 adapter。 */
export function createQoderAdapter(options) {
  const { shim, catalog, ctx } = options;
  /**
   * 插件配置读取器。宿主传的是 `() => config`（配置热更后取到新值），
   * 也允许直接传对象（自检脚本用），两种都认。
   */
  const readConfig = () => (typeof options.config === "function" ? options.config() : options.config) ?? {};
  const providerId = options.providerId ?? QODER_PROVIDER;
  const displayName = options.displayName ?? QODER_DISPLAY_NAME;

  /**
   * 该模型最终报给 DSH 的上下文窗口：配置覆盖 > 官方目录值 > 兜底 200000。
   *
   * 覆盖存在的原因见 `CONTEXT_WINDOW_OVERRIDES_FIELD`：DSH 设置页那个滑块改的是
   * 配置化 provider 的目录项，够不到程序化注册的 `qoder1`，所以只能在这里改。
   */
  const contextWindowOf = (info) => {
    const override = Number(readConfig()?.contextWindowOverrides?.[info.id]);
    if (Number.isFinite(override) && override > 0) return Math.trunc(override);
    return info.contextWindow ?? 200000;
  };

  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    return catalog.current().map((info) => ({
      id: info.id,
      name: info.name,
      api: "openai-completions",
      provider: providerId,
      baseUrl,
      /**
       * 按目录声明多模态能力：`is_vl=true` 的模型就是能看图，不能因为我们没接线
       * 就把能力砍掉。
       *
       * pi-ai 处理图片要两项配置（见 `createQoderAdapter` 里的
       * `resolveAttachments` / `resolveImageAccess`），接上之后它会把附件读成
       * data URL 塞进 `image_url`，Qoder 侧实测认这个形状。
       */
      input: info.supportsImages === true ? ["text", "image"] : ["text"],
      /**
       * **所有模型都声明 reasoning**，不看目录里的 `is_reasoning`。
       *
       * 原因：DSH 的「模型设置」面板会给每个模型记住「思考开关 + 思考强度」，
       * 并在调用前用 `resolveReasoningLevel()` 校验。若我们按 `is_reasoning=false`
       * 声明，该模型的支持档位只有 `off` —— 用户只要把那个开关拨到「高」，
       * 调用就会在**发请求前**报 `UNSUPPORTED_REASONING_EFFORT` 直接失败。
       *
       * 而且实测 Qoder 侧带 `is_reasoning=false` 的 DeepSeek-Flash 照样吐
       * `reasoning_content`，这个标志更像「不能关思考」而不是「不会思考」。
       * 所以统一声明为可思考，由 Qoder 自己决定思考多少；用户关掉时我们发
       * `enable_thinking=false`，Qoder 认这个字段。
       */
      reasoning: true,
      cost: NO_COST,
      contextWindow: contextWindowOf(info),
      maxTokens: info.maxTokens ?? 32000,
      compat: {
        maxTokensField: "max_tokens",
        // Qwen 系（Qoder 的后端就是 Qwen 家族）的思考开关格式。
        thinkingFormat: "qwen",
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
      },
      /**
       * 思考档位：**逐模型**按官方 `thinking_config.efforts` 映射，不再一刀切。
       *
       * Qoder 的档位集合是 `off/low/medium/high/xhigh/max`，但不同模型支持的不一样
       * （DeepSeek-V4-Pro 只有 high/max，Qwen3.8 系是 xhigh/low/medium）。这里把
       * DSH 的七个档位逐个映射到该模型声明过的拼写，见 `buildThinkingLevelMap`。
       */
      thinkingLevelMap: buildThinkingLevelMap(info),
    }));
  };

  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: "Qoder 回环凭据（由插件自己维护，无需填写）",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: "Qoder" };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  /**
   * 每个模型的最大输出 token 交给 DSH 当默认值：模型菜单里「最大输出」才有数可改。
   * 每次 invalidate 重建，目录一刷新就跟着变。
   */
  const buildMaxTokens = () => new Map(
    catalog.current().map((info) => [info.id, info.maxTokens ?? 32000]),
  );

  const buildProfile = () => ({
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(readConfig().retryPolicy, "dsh-qoder-connect retryPolicy"),
    configuredMaxTokens: buildMaxTokens(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  });
  let profiles = new Map([[providerId, buildProfile()]]);
  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      /**
       * 图片输入的两项接线（与官方 `llm-pi-ai` 的 apply 完全一致）：
       *
       * pi-ai 拿到消息里的 `image` 块后，先向 `resolveAttachments()` 要附件服务，
       * 再用 `resolveImageAccess(store, ref)` 把附件读成可投递的字节。缺任何一项，
       * 任何带图的上下文都会抛 `UNSUPPORTED_CONTENT`，把整轮对话打死。
       *
       * 这里用 `ctx.get(...)` 惰性取，而不是在构造时抓死：附件/文件系统服务可能
       * 比本插件晚挂载，惰性读取保证那时的请求仍然正确。
       */
      resolveAttachments: () => ctx.get("attachments"),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath),
        ref,
      ),
    }),
    invalidate: () => { profiles = new Map([[providerId, buildProfile()]]); },
    /**
     * 诊断用：**走 provider 真正会用的那条 `buildModels()`**，把每个模型最终报给
     * DSH 的 `contextWindow` 拿出来。
     *
     * 为什么不让状态接口自己再算一遍：那样等于把公式复制一份，配置覆盖一旦没接进
     * 适配器，状态看着对、实际还是旧值 —— 这个坑必须用同一条代码路径堵住。
     */
    effectiveContextWindows: () => new Map(buildModels().map((model) => [model.id, model.contextWindow])),
  };
}

//#endregion
//#region 插件入口

const CREDENTIAL_POLL_MS = 30000;
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 86400000;

/** 浏览器侧状态接口。与 client.js 里的路径必须逐字一致。 */
export const QODER_STATUS_ROUTE = "/plugins/dsh-qoder-connect/status";
export const QODER_ACCOUNTS_ROUTE = "/plugins/dsh-qoder-connect/accounts";
export const QODER_ACCOUNT_ADD_ROUTE = "/plugins/dsh-qoder-connect/accounts/add";
export const QODER_ACCOUNT_REPLACE_ROUTE = "/plugins/dsh-qoder-connect/accounts/replace";
export const QODER_ACCOUNT_RENAME_ROUTE = "/plugins/dsh-qoder-connect/accounts/rename";
export const QODER_ACCOUNT_SELECT_ROUTE = "/plugins/dsh-qoder-connect/accounts/select";
export const QODER_ACCOUNT_REMOVE_ROUTE = "/plugins/dsh-qoder-connect/accounts/remove";
export const QODER_CLI_UPDATE_ROUTE = "/plugins/dsh-qoder-connect/cli/update";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Host 头是不是回环地址（IPv6 带方括号、可带端口）。 */
function isLoopbackHost(host) {
  const text = String(host ?? "").trim().toLowerCase();
  if (text.length === 0) return false;
  const hostname = text.startsWith("[")
    ? text.slice(0, text.indexOf("]") + 1)
    : text.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(hostname);
}

const MAX_MANAGEMENT_BODY_BYTES = 16384;

async function readJsonBody(req) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_MANAGEMENT_BODY_BYTES) {
    throw new Error("请求体过大");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_MANAGEMENT_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
    return value;
  } catch (error) {
    throw new Error(`请求体不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertJsonKeys(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new Error(`请求体字段不受支持：${key}`);
  }
}

function pollInterval(config) {
  const override = config?.pollIntervalMs;
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
  return Math.min(override, MAX_POLL_MS);
}

/**
 * 运行态落盘：`$DSH_HOME/.qoder-connect-state.json`。
 *
 * 与另外两条渠道同思路 —— DSH 的插件日志默认不进 web 日志文件，
 * 只看日志无法判断一个渠道到底有没有注册成功、当前是「未登录」还是「已就绪」。
 * 这份文件把结论固化下来，排查时直接看它。
 */
function writeState(patch) {
  try {
    const path = join(resolveDshHome(), ".qoder-connect-state.json");
    writeFileSync(path, `${JSON.stringify({ ...patch, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch { /* 落盘失败不影响渠道本身 */ }
}

/**
 * 启动：起回环 shim → 注册 `qoder1` provider → 按凭据巡检刷新目录。
 *
 * 无论有没有 PAT 都先注册 provider —— DSH 用「模型组为空」来隐藏一个模型组，
 * 所以登录（放进 PAT）发生在 DSH 已经跑起来之后也能生效，不需要重新注册。
 */
export function apply(ctx, config) {
  let stopped = false;
  const current = () => config ?? {};

  const pats = createPatStore({ config: current });
  const tokens = createTokenManager({ pats, config: current, logger: ctx.logger });
  const catalog = createCatalog({ tokens, config: current, logger: ctx.logger });
  const client = createQoderClient({ tokens, config: current, logger: ctx.logger });

  const shim = createQoderShim({ client, catalog, logger: ctx.logger });
  const account = createQoderAccountClient({ tokens, config: current });

  /**
   * 浏览器侧读的状态文档（设置页「Qoder CN」用它渲染用量面板）。
   *
   * 额度/套餐是「尽力而为」：任何一项失败只写进 `*Error` 字段，不让整份文档 500。
   * 结果缓存 15 秒 —— 面板轮询与多标签页都不会把上游打爆。
   */
  let statusCache = { at: 0, doc: undefined };
  const STATUS_TTL_MS = 15000;
  /**
   * 适配器真正报给 DSH 的 contextWindow（含配置覆盖）。适配器在 `shim.ready` 之后
   * 才创建，所以先用空表占位，建好后替换。
   */
  let readEffectiveContextWindows = () => new Map();
  let reloadCatalogForCredentialChange = async () => {};

  async function buildStatus(force = false) {
    if (!force && statusCache.doc !== undefined && Date.now() - statusCache.at < STATUS_TTL_MS) {
      return statusCache.doc;
    }
    const accountState = pats.state();
    const base = {
      provider: QODER_PROVIDER,
      channel: QODER_DISPLAY_NAME,
      shim: shim.baseUrl(),
      accounts: accountState.accounts,
      activeAccountId: accountState.activeAccountId,
      environmentOverride: accountState.environmentOverride,
    };
    const pat = await pats.current();
    if (pat === undefined) {
      const doc = { ...base, status: "signed-out", patPath: pats.activePath() };
      statusCache = { at: Date.now(), doc };
      return doc;
    }
    let credential;
    try {
      credential = await tokens.get();
    } catch (error) {
      const doc = {
        ...base,
        status: "signed-out",
        patPath: pats.activePath(),
        patSource: pat.source,
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
      statusCache = { at: Date.now(), doc };
      return doc;
    }

    const overrides = current()?.contextWindowOverrides ?? {};
    // 直接问适配器：它报多少，DSH 的压缩阈值就按多少算。
    const effective = readEffectiveContextWindows();
    const models = catalog.current().map((model) => {
      const reported = effective.get(model.id);
      const override = Number(overrides?.[model.id]);
      const overridden = Number.isFinite(override) && override > 0;
      return {
        id: model.id,
        name: model.name,
        rate: model.rate,
        free: model.isFree === true,
        reasoning: model.isReasoning === true,
        vision: model.supportsImages === true,
        /** 真正报给 DSH 的值（含配置覆盖）。压缩阈值就是拿它乘 0.8。 */
        contextWindow: reported ?? (overridden ? Math.trunc(override) : model.contextWindow),
        /** 官方目录声明的值，用来对比「有没有被覆盖」。 */
        declaredContextWindow: model.contextWindow,
        /** 是否被插件配置覆盖过（DSH 设置页的滑块够不到本渠道，只能走这里）。 */
        contextWindowOverridden: overridden,
        /** 官方 aAe 算法下**真正可选**的档位（128K / 200K / 上限，超上限已过滤）。 */
        contextWindows: model.contextWindows,
        /** 官方给的上下文档位（原始 context_config，选择器语义，不是能力上限）。 */
        contextTiers: model.contextTiers,
        /** 官方认的思考档位；`off` 表示可关。 */
        thinkingEfforts: model.thinkingEfforts,
        /** 该模型要求的最低客户端版本（`minimal_version.cli`），有就是版本门槛。 */
        requiresCosyVersion: model.minimalVersion?.cli,
        isNew: model.isNew === true,
      };
    });
    const doc = {
      ...base,
      status: "signed-in",
      userId: credential.userID,
      account: credential.name === "" ? credential.email : credential.name,
      email: credential.email,
      accountId: credential.accountId,
      accountLabel: credential.label,
      patSource: credential.source,
      jobTokenExpiresAt: new Date(credential.expiresAt).toISOString(),
      catalogSource: catalog.source(),
      modelCount: models.length,
      models,
    };
    try {
      doc.user = await account.fetchUserInfo();
    } catch (error) {
      doc.userError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
    try {
      doc.usage = await account.fetchUsage();
    } catch (error) {
      doc.usageError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
    try {
      doc.plan = await account.fetchPlan();
    } catch (error) {
      doc.planError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
    // 目录审计：区分「官方下线」和「我们版本落后」。
    //
    // 两个相互独立的参照物（都是零 token）：高版本目录探测（网络）＋ 官方客户端
    // 目录缓存（离线，密钥由 uid 派生，见 lib/official-cache.js）。结果变化很慢，
    // 跟着状态缓存走；失败只降级成 warnings，不影响面板主数据。
    try {
      const gateway = String(current()?.gateway ?? "").length > 0 ? current().gateway : undefined;
      doc.catalogAudit = await probeCatalogAudit({
        credential,
        gateway,
        cosyVersion: credential.cosyVersion,
      });
      const audit = doc.catalogAudit;
      // 面板老形状，保持向后兼容（client.js 的 VersionProbeRow 读它）。
      doc.versionProbe = {
        behind: audit.behind,
        current: audit.cosyVersion,
        currentCount: audit.currentCount,
        suggestedVersion: audit.suggestedVersion,
        suggestedCount: audit.universeCount,
        gated: audit.gated,
        unexplained: audit.unexplained,
        probes: audit.probes,
      };
      const warnings = [...(doc.warnings ?? [])];
      if (audit.behind === true && Array.isArray(audit.gated) && audit.gated.length > 0) {
        const detail = audit.gated
          .map((item) => `${item.name ?? item.id}（要求 Cosy-Version ≥ ${item.requires}）`)
          .join("、");
        warnings.push(`当前 Cosy-Version ${audit.cosyVersion} 被服务端裁掉了 ${audit.gated.length} 个模型：${detail}。这是**我们版本落后**，不是官方下线——调高 cosyVersion 或升级 Qoder 客户端即可。`);
      }
      if (Array.isArray(audit.unexplained) && audit.unexplained.length > 0) {
        const detail = audit.unexplained.map((item) => `${item.name ?? item.id}`).join("、");
        warnings.push(`有 ${audit.unexplained.length} 个模型在「高版本目录」里存在、版本门槛也够，但我们没拿到：${detail}。这不是版本裁剪，请检查目录解析。`);
      }
      const official = audit.official;
      if (official?.available === true) {
        // 已被 minimal_version.cli 解释过的缺口不再重复报——同一件事只给一条告警。
        const explained = new Set((audit.gated ?? []).map((item) => item.id));
        const extraHere = (official.missingHere ?? []).filter((item) => !explained.has(item.id));
        if (extraHere.length > 0) {
          warnings.push(`官方客户端缓存（${official.updatedAt}）里有 ${extraHere.length} 个我们没显示、且无法用版本门槛解释的模型：${extraHere.map((item) => item.name ?? item.id).join("、")}。`);
        }
        if (Array.isArray(official.missingThere) && official.missingThere.length > 0) {
          warnings.push(`我们显示、但官方客户端缓存里没有的模型：${official.missingThere.join("、")}。大概率官方已下线，可对照高版本目录确认。`);
        }
      }
      if (warnings.length > 0) doc.warnings = warnings;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      doc.versionProbe = { behind: false, error: reason };
      doc.catalogAudit = { available: false, error: reason };
    }
    statusCache = { at: Date.now(), doc };
    return doc;
  }

  const credentialsChanged = async () => {
    tokens.invalidate();
    statusCache = { at: 0, doc: undefined };
    await reloadCatalogForCredentialChange();
  };

  // 面板走 DSH 自己的 webServer（同源、回环保护）；回环 shim 只服务推理，两者别混。
  ctx.inject(["webServer"], (webCtx) => {
    if (stopped) return;
    try {
      const dispose = webCtx.webServer.register({
        kind: "exact",
        path: QODER_STATUS_ROUTE,
        handler: async (req, res) => {
          const send = (code, payload) => {
            const body = JSON.stringify(payload);
            res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(body);
          };
          if (req.method !== "GET") { send(405, { error: "method not allowed" }); return; }
          // 只允许回环来源：Host 头必须是回环地址（挡 DNS rebinding）。
          if (!isLoopbackHost(req.headers.host)) { send(403, { error: "request-not-trusted" }); return; }
          try {
            send(200, await buildStatus(req.url?.includes("refresh=1") === true));
          } catch (error) {
            send(500, { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
          }
        },
      });
      webCtx.effect?.(() => () => dispose(), "dsh-qoder-connect: status route");

      const accountResponse = () => {
        const state = pats.state();
        return {
          accounts: state.accounts,
          activeAccountId: state.activeAccountId,
          environmentOverride: state.environmentOverride,
          patPath: pats.activePath(),
        };
      };

      const registerManagementRoute = (path, method, action) => {
        const managementDispose = webCtx.webServer.register({
          kind: "exact",
          path,
          handler: async (req, res) => {
            const send = (code, payload) => {
              const body = JSON.stringify(payload);
              res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
              res.end(body);
            };
            if (req.method !== method) { send(405, { error: "method not allowed" }); return; }
            // 只允许回环来源：这些接口可以写 PAT，但不能让局域网请求远程操控。
            if (!isLoopbackHost(req.headers.host)) { send(403, { error: "request-not-trusted" }); return; }
            try {
              const body = method === "GET" ? {} : await readJsonBody(req);
              send(200, await action(body));
            } catch (error) {
              send(400, { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
            }
          },
        });
        webCtx.effect?.(() => () => managementDispose(), `dsh-qoder-connect: ${path}`);
      };

      registerManagementRoute(QODER_ACCOUNTS_ROUTE, "GET", async () => accountResponse());
      registerManagementRoute(QODER_ACCOUNT_ADD_ROUTE, "POST", async (body) => {
        assertJsonKeys(body, ["label", "pat", "activate"]);
        const activate = body.activate === undefined ? true : body.activate;
        if (typeof activate !== "boolean") throw new Error("activate 必须是布尔值");
        const account = await pats.addAccount(body.label, body.pat, activate);
        if (account.active) await credentialsChanged();
        else statusCache = { at: 0, doc: undefined };
        return { ok: true, account, ...accountResponse() };
      });
      registerManagementRoute(QODER_ACCOUNT_REPLACE_ROUTE, "POST", async (body) => {
        assertJsonKeys(body, ["id", "label", "pat"]);
        const account = await pats.replaceAccount(body.id, body.label, body.pat);
        await credentialsChanged();
        return { ok: true, account, ...accountResponse() };
      });
      registerManagementRoute(QODER_ACCOUNT_RENAME_ROUTE, "POST", async (body) => {
        assertJsonKeys(body, ["id", "label"]);
        const account = await pats.renameAccount(body.id, body.label);
        tokens.invalidate();
        statusCache = { at: 0, doc: undefined };
        return { ok: true, account, ...accountResponse() };
      });
      registerManagementRoute(QODER_ACCOUNT_SELECT_ROUTE, "POST", async (body) => {
        assertJsonKeys(body, ["id"]);
        const account = await pats.selectAccount(body.id);
        await credentialsChanged();
        return { ok: true, account, ...accountResponse() };
      });
      registerManagementRoute(QODER_ACCOUNT_REMOVE_ROUTE, "POST", async (body) => {
        assertJsonKeys(body, ["id"]);
        const accounts = await pats.removeAccount(body.id);
        await credentialsChanged();
        return { ok: true, ...accounts };
      });
      registerManagementRoute(QODER_CLI_UPDATE_ROUTE, "POST", async (body) => {
        assertJsonKeys(body, []);
        return await updateQoderCli();
      });
    } catch (error) {
      ctx.logger?.warn?.("dsh-qoder-connect: 设置路由注册失败（渠道本身不受影响）", error);
    }
  });

  shim.ready.then(() => {
    if (stopped) return;
    const created = createQoderAdapter({ shim, catalog, ctx, config: current });
    const { adapter, invalidate } = created;
    reloadCatalogForCredentialChange = async () => {
      if (stopped) return;
      try {
        await catalog.reload();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger?.warn?.(`dsh-qoder-connect: 切换账号后刷新模型目录失败 — ${message}`);
      }
      invalidate();
      ctx.emit("llm/adapters-updated");
    };
    // 适配器真正会使用的 contextWindow（含配置覆盖），状态接口直接用它，不另算一遍。
    readEffectiveContextWindows = created.effectiveContextWindows;
    const release = ctx.llm.registerAdapter([QODER_PROVIDER], adapter);
    try {
      ctx.effect(() => () => { release(); shim.close(); });
    } catch {
      release();
      shim.close();
    }

    /**
     * 目录不用跟着 30 秒巡检走：模型集合一天也不变一次，每 30 秒打一次
     * `model/list` 纯属浪费，还可能被上游当异常客户端。
     */
    let lastReloadAt = 0;
    let lastReloadedUser = "";
    const CATALOG_TTL_MS = 300000;

    const refresh = () => {
      if (stopped) return;
      tokens.get().then(
        (credential) => {
          if (stopped) return;
          const stale = Date.now() - lastReloadAt > CATALOG_TTL_MS || lastReloadedUser !== credential.userID;
          if (!stale) {
            writeState({
              ready: true,
              provider: QODER_PROVIDER,
              shim: shim.baseUrl(),
              userId: credential.userID,
              patSource: credential.source,
              jobTokenExpiresAt: new Date(credential.expiresAt).toISOString(),
              catalogSource: catalog.source(),
              modelCount: catalog.current().length,
              models: catalog.current().map((model) => ({ id: model.id, rate: model.rate, free: model.isFree })),
            });
            return;
          }
          return catalog.reload().then(
            () => {
              if (stopped) return;
              lastReloadAt = Date.now();
              lastReloadedUser = credential.userID;
              invalidate();
              ctx.emit("llm/adapters-updated");
              const models = catalog.current();
              writeState({
                ready: true,
                provider: QODER_PROVIDER,
                shim: shim.baseUrl(),
                userId: credential.userID,
                patSource: credential.source,
                jobTokenExpiresAt: new Date(credential.expiresAt).toISOString(),
                catalogSource: catalog.source(),
                modelCount: models.length,
                models: models.map((model) => ({ id: model.id, rate: model.rate, free: model.isFree })),
              });
              ctx.logger.info(`dsh-qoder-connect: Qoder 已就绪（uid=${credential.userID}，${models.length} 个模型）`);
            },
            (error) => {
              if (stopped) return;
              const message = error instanceof Error ? error.message : String(error);
              // 目录挂了但凭据是好的：渠道仍然可用（只是沿用上一次快照或兜底名单）。
              lastReloadAt = Date.now();
              invalidate();
              ctx.emit("llm/adapters-updated");
              writeState({
                ready: true,
                provider: QODER_PROVIDER,
                shim: shim.baseUrl(),
                userId: credential.userID,
                catalogSource: catalog.source(),
                modelCount: catalog.current().length,
                catalogError: message,
              });
              ctx.logger.warn(`dsh-qoder-connect: 目录刷新失败，渠道沿用兜底名单 — ${message}`);
            },
          );
        },
        (error) => {
          if (stopped) return;
          const message = error instanceof Error ? error.message : String(error);
          writeState({ ready: false, provider: QODER_PROVIDER, shim: shim.baseUrl(), patPath: pats.activePath(), error: message });
          ctx.logger.warn(`dsh-qoder-connect: 未就绪 — ${message}`);
        },
      );
    };

    refresh();
    const timer = setInterval(refresh, pollInterval(current()));
    timer.unref?.();
    ctx.effect(() => () => { clearInterval(timer); });
  }).catch((error) => {
    ctx.logger?.error?.("dsh-qoder-connect: 回环 shim 启动失败", error);
  });

  ctx.effect(() => () => { stopped = true; });
}

//#endregion
