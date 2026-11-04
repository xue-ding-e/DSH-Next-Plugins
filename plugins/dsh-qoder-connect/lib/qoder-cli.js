/**
 * Qoder CN CLI 的受限安装/更新入口。
 *
 * 浏览器只能请求这个模块暴露的固定动作；命令、参数和安装地址都由这里写死，
 * 不把 shell 字符串交给设置页。这样既能复用 Qoder 自己的更新流程，也不会把
 * 一个通用命令执行器暴露给同源页面。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTALL_SCRIPT_URL = "https://static.qoder.com.cn/qoder-cli-cn/install.ps1";
const COMMAND_TIMEOUT_MS = 120000;
const MAX_OUTPUT_LENGTH = 600;

function fileExists(path, exists = existsSync) {
  try {
    return exists(path);
  } catch {
    return false;
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((path) => {
    if (typeof path !== "string" || path.length === 0) return false;
    const key = path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 只在固定的用户目录和 PATH 中找 Qoder 自己的入口。 */
export function findQoderCliCommand({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const home = env.USERPROFILE || env.HOME || homedir();
  const names = platform === "win32"
    ? ["qodercn.cmd", "qoder-cn.cmd", "qodercn.exe", "qoderclicn.exe"]
    : ["qodercn", "qoder-cn", "qoderclicn"];
  const bundled = platform === "win32"
    ? [
        join(home, ".qoder-cn", "entry", "qodercn.cmd"),
        join(home, ".qoder-cn", "entry", "qoder-cn.cmd"),
        join(home, ".qoder-cn", "bin", "qoderclicn", "qoderclicn.exe"),
      ]
    : [];
  const pathEntries = typeof env.PATH === "string"
    ? env.PATH.split(delimiter).flatMap((dir) => names.map((name) => join(dir, name)))
    : [];
  return uniquePaths([
    ...bundled,
    ...(typeof env.QODERCN_CLI_BIN === "string" ? [env.QODERCN_CLI_BIN] : []),
    ...pathEntries,
  ]).find((path) => fileExists(path, exists));
}

function sanitizeOutput(value) {
  return String(value ?? "")
    .replace(/pt-[^\s"'`]+/gi, "pt-***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_OUTPUT_LENGTH);
}

async function invoke(execFileImpl, command, args, env, options = {}) {
  try {
    const result = await execFileImpl(command, args, {
      env,
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout: result?.stdout ?? "", stderr: result?.stderr ?? "" };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : -1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function invokeQoder(command, args, { platform, env, execFileImpl }) {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    // Node's Windows argument quoting escapes the quotes inside a `/c` string
    // when cmd.exe is called as a child process. That makes cmd.exe search for
    // a literal filename containing backslashes (the error shown in the UI).
    // Let Node invoke the .cmd file through its native shell path instead.
    return invoke(execFileImpl, command, args, env, {
      shell: env.ComSpec || env.COMSPEC || true,
    });
  }
  return invoke(execFileImpl, command, args, env);
}

function isMissingCli(result) {
  const text = `${result.stderr} ${result.stdout} ${result.error}`.toLowerCase();
  return result.code === 127 || text.includes("cli is not installed") || text.includes("qodercn cli is not installed");
}

function failureResult(action, result) {
  const detail = sanitizeOutput(result.stderr || result.stdout || result.error);
  return {
    status: "failed",
    message: detail.length > 0 ? `Qoder CLI${action}失败：${detail}` : `Qoder CLI${action}失败（退出码 ${String(result.code)}）`,
  };
}

async function installQoderCli({ platform, env, execFileImpl }) {
  if (platform !== "win32") {
    return { status: "failed", message: "Qoder CLI 一键安装/更新目前只支持 Windows。" };
  }
  const command = env.SystemRoot
    ? join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const script = `Invoke-RestMethod -Uri '${INSTALL_SCRIPT_URL}' | Invoke-Expression`;
  const result = await invoke(execFileImpl, command, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], env);
  if (result.code === 0) return { status: "installed", message: "Qoder CLI 已安装/更新。" };
  return failureResult("安装/更新", result);
}

/**
 * 执行一次固定的 Qoder CLI 更新动作。
 *
 * 更新命令失败且明确表示 CLI 尚未安装时，才进入官方安装脚本；普通网络或
 * 权限错误直接返回失败，避免把真实错误掩盖成重复安装。
 */
export async function runQoderCliUpdate({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  execFileImpl = execFileAsync,
} = {}) {
  const command = findQoderCliCommand({ platform, env, exists });
  if (command !== undefined) {
    const updated = await invokeQoder(command, ["update"], { platform, env, execFileImpl });
    if (updated.code === 0) return { status: "updated", message: "Qoder CLI 已更新。" };
    if (!isMissingCli(updated)) return failureResult("更新", updated);
  }
  return installQoderCli({ platform, env, execFileImpl });
}

let updateInFlight;

/** 同一时间只允许一个更新器运行，连续点击不会启动多个安装进程。 */
export function updateQoderCli(options) {
  if (updateInFlight !== undefined) return updateInFlight;
  const task = runQoderCliUpdate(options).finally(() => {
    if (updateInFlight === task) updateInFlight = undefined;
  });
  updateInFlight = task;
  return task;
}
