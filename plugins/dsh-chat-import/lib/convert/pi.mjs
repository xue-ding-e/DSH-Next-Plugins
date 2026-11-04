// lib/convert/pi.mjs — Pi Coding Agent 会话 JSONL → DSH 会话（纯函数）
//
// 存储：~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl（cwd 的 / \ :
// 替换为 -）。首行是 session 头（type:"session"，version/id/timestamp/cwd），
// 其余条目经 id/parentId 组成树（v1 线性无 id → 顺序链；v2/v3 树形）。
// 条目类型：message（内嵌 AgentMessage）、model_change、thinking_level_change、
// compaction、branch_summary、custom、custom_message、label、session_info。
//
// 转换实现与 omp（oh-my-pi）共用 lib/convert/pi-family.mjs —— 两者同源，差异（标题载体、
// model_change 字段、摘要模板措辞）在下面的 profile 里。pi 侧的特殊面：
//   - 标题：活动路径上最后的 session_info.name（omp 用定宽标题槽 / title_change）；
//   - 压缩边界：firstKeptEntryId，或现代格式的 retainedTail（该条目前的最后 N 条物化消息）；
//   - 摘要注入文本用 pi 自身 convertToLlm 的模板措辞（messages.ts）。

import { convertPiFamilyJsonl } from './pi-family.mjs'

// pi 自身 convertToLlm 里 compaction / branch summary 注入 user 消息的固定前后缀
// （messages.ts），导入时按同样措辞重建，模型看到的内容与 pi 侧一致。
const PI_COMPACTION_SUMMARY_PREFIX = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const PI_BRANCH_SUMMARY_PREFIX = 'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n'
const PI_SUMMARY_SUFFIX = '\n</summary>'

const PI_PROFILE = {
  provider: 'pi-coding-agent',
  skipReason: 'not a Pi Coding Agent session (no session header)',
  idArg: 'piId',
  toolCallIdPrefix: 'pi',
  // 标题：活动路径上最后一个 session_info.name
  titleOf: (item) => (item.type === 'session_info' && typeof item.name === 'string' && item.name.trim()
    ? item.name.trim()
    : undefined),
  // 模型切换条目：pi 写 modelId
  modelOf: (item) => (item.type === 'model_change' && typeof item.modelId === 'string' && item.modelId ? item.modelId : null),
  // 压缩边界：pi 的 compaction 条目（retainedTail 为现代格式的保留窗口）
  compactOf: (item) => {
    if (!item || item.type !== 'compaction') return null
    return {
      summary: item.summary,
      ...(typeof item.firstKeptEntryId === 'string' ? { firstKeptEntryId: item.firstKeptEntryId } : {}),
      ...(Array.isArray(item.retainedTail) ? { retainedTail: item.retainedTail } : {}),
    }
  },
  honorsResetBoundary: false,
  renderSummary: {
    compaction: (s) => PI_COMPACTION_SUMMARY_PREFIX + s + PI_SUMMARY_SUFFIX,
    branch: (s) => PI_BRANCH_SUMMARY_PREFIX + s + PI_SUMMARY_SUFFIX,
  },
}

// Pi Coding Agent 会话 JSONL → DSH 会话。
export function convertPiJsonl(raw, args = {}) {
  return convertPiFamilyJsonl(raw, args, PI_PROFILE)
}
