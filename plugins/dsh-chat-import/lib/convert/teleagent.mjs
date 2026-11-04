// lib/convert/teleagent.mjs — TeleAgent 历史库会话 → DSH 会话（纯函数）
//
// TeleAgent（星辰超级智能体，中电信 TeleAI 的桌面客户端）的会话库与 opencode 同构：
// SQLite 三表（session/message/part）schema 一致、消息/part 的 data JSON 结构一致
//（part.type ∈ text | reasoning | tool | step-start | step-finish | compaction，
// issue #60 报告者实测 .schema）。仅 provider 标签不同。转换直接复用
// lib/convert/opencode.mjs 的 convertOpencodeJson，只覆盖 provider 为 'teleagent'；
// 独立成文件保持「每源一个 convert 文件」的仓库惯例，opencode 转换器不含任何
// TeleAgent 专属分支。

import { convertOpencodeJson } from './opencode.mjs'

/** TeleAgent 会话（opencode 派生）→ DSH 会话：复用 opencode 转换器，仅换 provider 标签。 */
export function convertTeleagentJson(raw, args = {}) {
  return convertOpencodeJson(raw, { ...args, provider: 'teleagent' })
}
