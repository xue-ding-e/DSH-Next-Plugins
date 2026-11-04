// lib/convert/omp.mjs — oh-my-pi（omp）会话 JSONL → DSH 会话（纯函数）
//
// 存储：~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl。编码规则：
// home 下的目录 → `-<相对路径>`、临时根 → `-tmp-<相对路径>`、其余 → `--<绝对路径>--`，
// 路径分隔符替换为 `-`（源侧 17.2.5–17.2.8 的哈希方案已回退，本插件只认现行布局）。
//
// 物理文件首行是**定宽 256 字节（含换行）的标题槽**：{type:"title", v:1, title, source?,
// updatedAt, pad}，随后是 session 头与条目（旧文件可能没有标题槽，直接以头开始）。标题槽是
// 存储层产物、不是树条目——转换引擎按物理记录跳过，只在取标题时读它。
//
// 与 pi 同族（共用 lib/convert/pi-family.mjs），omp 侧的差异：
//   - 标题：定宽标题槽 > header.title > 活动路径上最后一个 title_change.title；
//   - model_change 的字段是 `model`（"provider/modelId"），pi 是 `modelId`；
//   - reset_boundary：/clear 的纯标记（无摘要载荷）。源侧模型视角从最后一次清空点之后开始，
//     而 DSH 的压缩检查点必须有摘要正文 → 与 Kimi「只有边界没有摘要」同口径切掉清空点之前的
//     内容并上报 resetBoundaries（fullHistory:true 保留全量）；
//   - 摘要注入文本用 omp 自己的模板（packages/agent/src/compaction/prompts/*.md），与 pi 的
//     措辞不同：compaction / branch / handoff 三套；
//   - 多出的条目与角色（session_init / mode_change / model_usage / service_tier_change /
//     ttsr_injection / credential_pin / pythonExecution / fileMention）由引擎按同族口径处理，
//     不参与上下文的元数据条目跳过。

import { convertPiFamilyJsonl } from './pi-family.mjs'

// omp 的摘要注入模板（compaction-summary-context.md / branch-summary-context.md /
// handoff-summary-context.md 的正文；{{summary}} 即插值点）。模板文件末尾的空行不重建。
const OMP_COMPACTION_PREFIX = 'Prior model work/tool state available.\nMUST build on prior work; NEVER duplicate prior work.\n\n<summary>\n'
const OMP_BRANCH_PREFIX = 'Branch-return summary:\n\n<summary>\n'
const OMP_SUMMARY_SUFFIX = '\n</summary>'
const OMP_HANDOFF_PREFIX = 'Context replaced. The <handoff> below is a handoff document a prior instance of you wrote from the full conversation. It is your own working memory, not user input.\n'
  + '- First person inside it refers to you (the prior instance).\n'
  + '- "Next Steps" is your own resumed plan; re-check it against the latest user message before acting.\n'
  + '- The handoff already exists and is complete: NEVER write another handoff document unless the user explicitly asks.\n'
  + 'MUST build on prior work; NEVER duplicate prior work.\n\n<handoff>\n'
const OMP_HANDOFF_SUFFIX = '\n</handoff>'

// 定宽标题槽（物理首行）：type/v 是槽的签名，title 是当前标题（列表与面板都按它显示，
// 不必读全文）。非槽行 / 旧文件返回 undefined。
function ompTitleSlot(recs) {
  const slot = recs.find((r) => r && typeof r === 'object' && r.type === 'title' && r.v === 1 && typeof r.title === 'string')
  return slot && slot.title.trim() ? slot.title.trim() : undefined
}

const OMP_PROFILE = {
  provider: 'oh-my-pi',
  skipReason: 'not an oh-my-pi session (no session header)',
  idArg: 'ompId',
  toolCallIdPrefix: 'omp',
  // 标题：定宽标题槽（源侧列表用的就是它）> header.title（旧文件无槽）
  initialTitle: (header, recs) => ompTitleSlot(recs)
    || (typeof header.title === 'string' && header.title.trim() ? header.title.trim() : undefined),
  // 活动路径上的改名审计条目：取最后一个（标题槽缺席时的兜底）
  titleOf: (item) => (item.type === 'title_change' && typeof item.title === 'string' && item.title.trim()
    ? item.title.trim()
    : undefined),
  // 模型切换条目：omp 写 model（"provider/modelId"）
  modelOf: (item) => (item.type === 'model_change' && typeof item.model === 'string' && item.model ? item.model : null),
  // 压缩边界：firstKeptEntryId 指定保留窗口起点（omp 没有 pi 的 retainedTail）
  compactOf: (item) => {
    if (!item || item.type !== 'compaction') return null
    return {
      summary: item.summary,
      ...(typeof item.firstKeptEntryId === 'string' ? { firstKeptEntryId: item.firstKeptEntryId } : {}),
    }
  },
  honorsResetBoundary: true,
  renderSummary: {
    compaction: (s) => OMP_COMPACTION_PREFIX + s + OMP_SUMMARY_SUFFIX,
    branch: (s) => OMP_BRANCH_PREFIX + s + OMP_SUMMARY_SUFFIX,
    handoff: (s) => OMP_HANDOFF_PREFIX + s + OMP_HANDOFF_SUFFIX,
  },
}

// oh-my-pi（omp）会话 JSONL → DSH 会话。
export function convertOmpJsonl(raw, args = {}) {
  return convertPiFamilyJsonl(raw, args, OMP_PROFILE)
}
