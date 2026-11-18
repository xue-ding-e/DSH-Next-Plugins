/**
 * Carries rejected Qoder arguments through the normal DSH tool-result path.
 * The reserved argument envelope contains only a failure code. The tool
 * policy rejects it before dispatch, and AgentLoop records its feedback.
 */

const ERROR_FIELD = "__dsh_qoder_argument_error__";
const failures = new Map([
  ["PRIVACY_FILTER_UNKNOWN_PLACEHOLDER", "Qoder 返回了当前请求中不存在或已改写的脱敏标记。工具未执行。请从用户消息或已有工具结果复制完整链接或原值，或重新搜索；不要编造脱敏标记。"],
  ["PRIVACY_FILTER_TOOL_JSON", "Qoder 返回的工具参数不是有效的 JSON 对象。工具未执行。请修正参数并重新调用该工具。"],
]);

/**
 * Register recoverable argument failures on the owning plugin's lifetime.
 *
 * @param {object} ctx Cordis context owning the tool policy.
 * @returns {(error: Error) => string} Failure encoder for the Qoder transport.
 */
export function installToolErrorRecovery(ctx) {
  ctx.tools.guard((execution) => {
    const args = execution.arguments;
    if (args === null || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).length !== 1 || !Object.hasOwn(args, ERROR_FIELD)) return undefined;
    const code = args[ERROR_FIELD];
    const reason = failures.get(code);
    if (reason === undefined) return undefined;
    return { reason, info: { name: "QoderToolArgumentsError", code } };
  });
  return (error) => {
    const code = failures.has(error.code) ? error.code : "PRIVACY_FILTER_TOOL_JSON";
    return JSON.stringify({ [ERROR_FIELD]: code });
  };
}
