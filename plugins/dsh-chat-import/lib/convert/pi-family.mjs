// lib/convert/pi-family.mjs — pi 家族会话 JSONL → DSH 会话（纯函数）
//
// pi（Pi Coding Agent）与 omp（oh-my-pi）同源：首行是 session 头，其余条目经 id/parentId
// 组成树；条目分类、message.role 的 camelCase 命名、toolCall 块与 toolResult 角色、压缩与
// 分支摘要注入上下文的方式都一致。差异（根目录与标题载体、model_change 字段、摘要模板措辞、
// reset_boundary 等新条目）由 profile 描述，**转换实现只有这一份**——两个来源各写一份
// 必然漂移（docs/architecture.md D21）。
//
// 与 Claude/Codex 的线性格式不同：
//   - 树形分支：只重建活动分支（末条目沿 parentId 走到根），旁支条目丢弃；
//   - toolCall 块用 `arguments`（对象，非 input），thinking 块为 {type:"thinking"}；
//   - toolResult 是独立条目（role:"toolResult"，toolCallId 配对）→ 挂回声明调用的 step；
//   - bashExecution / pythonExecution / fileMention / custom / branchSummary /
//     compactionSummary 在源侧是注入进上下文的 user/developer 消息（convertToLlm），这里用
//     源自身的文本格式降级为文本块挂到相邻步骤（DSH 无独立注入角色可挂，保证 wire 合法）；
//   - compaction 默认尊重（只导最后一次摘要 + 保留范围 + 尾部），fullHistory:true 导全量；
//     omp 的 reset_boundary（/clear，无摘要）按同一口径切掉清空点之前的内容并上报；
//   - branch_summary/compaction 摘要 → reasoning 块（检查点未承载时）。

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseJsonlLines,
  parseTime,
} from './core.mjs'
import { imageBlockFromSource } from './image.mjs'
import { skipResult } from './util.mjs'
import { createTurns, shadowTurns } from './ir.mjs'

/**
 * 按 profile 转换一份 pi 家族会话 JSONL。
 *
 * profile 字段（两个来源的差异全部集中在这里，转换逻辑不分支）：
 *   provider             事件里写入的 provider 名
 *   skipReason           没有会话头时的跳过原因文本
 *   idArg                args 里源 id 的兜底键（导入口按文件名派生）
 *   toolCallIdPrefix     缺失 id 的 toolCall 兜底 id 前缀（'pi' / 'omp'）
 *   initialTitle(header, recs)  进入活动路径之前的标题候选（omp 的定宽标题槽 / header.title）
 *   titleOf(item)        活动路径上覆盖标题的条目（取最后一个非空值）
 *   modelOf(item)        模型切换条目取的字段名不同（pi: modelId；omp: model）
 *   compactOf(item)      压缩边界条目 → { summary, firstKeptEntryId?, retainedTail? } | null
 *   honorsResetBoundary  是否把 reset_boundary（纯标记）当上下文截断
 *   renderSummary        摘要注入文本模板：{ compaction(s), branch(s), handoff?(s) }
 */
export function convertPiFamilyJsonl(raw, args = {}, profile) {
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  // 首行 session 头：源会话 id / 创建时间 / cwd。无头行 = 非本族会话文件 → 跳过。
  const header = recs.find((r) => r && typeof r === 'object' && r.type === 'session') || null
  if (!header) {
    return skipResult(profile.skipReason, { skipped: 1, records: recs.length })
  }

  // 树条目：v2/v3 用 id/parentId；v1 线性无 id → 顺序链（parentId 缺省取前一条）。
  // 跳过物理记录：session 头，以及 omp 的定宽标题槽（存储层产物，不是树条目——进了树会在
  // 线性 v1 文件里被顺序链接上，污染活动分支）。
  const entries = []
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object' || rec.type === 'session' || rec.type === 'title') continue
    const id = typeof rec.id === 'string' && rec.id ? rec.id : 'e' + entries.length
    const parentId = typeof rec.parentId === 'string' ? rec.parentId
      : (entries.length > 0 ? entries[entries.length - 1].id : null)
    entries.push({ ...rec, _id: id, _parentId: parentId })
  }

  // 活动分支：末条目即当前叶，沿 parentId 走到根（visited 防环），再反转为时间序。
  const byId = new Map(entries.map((e) => [e._id, e]))
  const path = []
  {
    let cur = entries.length > 0 ? entries[entries.length - 1] : null
    const seen = new Set()
    while (cur) {
      if (seen.has(cur._id)) break
      seen.add(cur._id)
      path.push(cur)
      if (cur._parentId === null || cur._parentId === undefined) break
      cur = byId.get(cur._parentId) || null
    }
  }
  path.reverse()

  // 上下文清空（omp 的 /clear，reset_boundary 纯标记、没有摘要正文）：源侧模型视角从最后一次
  // 清空点之后开始。DSH 的压缩检查点必须有摘要正文（宿主不变式要求 shadowedSeqs 非空且有
  // 摘要），这里无从还原 → 与 Kimi「只有边界没有摘要」同口径：宁可日志里丢前段，也不给模型
  // 一条空摘要，并显式上报 resetBoundaries（不静默）。fullHistory:true 时不切。
  let startIndex = 0
  let resetBoundaries = 0
  if (profile.honorsResetBoundary && args.fullHistory !== true) {
    for (let i = 0; i < path.length; i++) {
      const item = path[i]
      if (item && item.type === 'reset_boundary') {
        startIndex = i + 1
        resetBoundaries += 1
      }
    }
  }

  // 上下文压缩导入为 **DSH 原生压缩检查点**（见 events.mjs）：活动路径上每个 compaction
  // 条目都是一次压缩边界。可见段从「保留窗口的起点」开始——retainedTail 是该条目前的最后 N
  // 条物化消息（现代格式），legacy 用 firstKeptEntryId 指定；边界之前的条目照常进日志，但被
  // 检查点遮蔽（模型只看得到摘要 + 保留窗口 + 其后的条目）。fullHistory:true 时不发检查点。
  const boundaries = new Map() // 路径下标 → 摘要正文（该下标处发射检查点）
  const consumedCompactions = new Set() // 摘要已进检查点的 compaction 条目（不再作 reasoning 块）
  if (args.fullHistory !== true) {
    for (let i = startIndex; i < path.length; i++) {
      const cut = profile.compactOf(path[i])
      if (!cut) continue
      const summary = typeof cut.summary === 'string' ? cut.summary.trim() : ''
      if (!summary) continue
      let from = -1
      if (typeof cut.firstKeptEntryId === 'string') from = path.findIndex((e) => e._id === cut.firstKeptEntryId)
      if (from < 0 && Array.isArray(cut.retainedTail) && cut.retainedTail.length > 0) from = i - cut.retainedTail.length
      if (from < 0) from = i
      boundaries.set(Math.max(startIndex, from), summary)
      consumedCompactions.add(path[i]._id)
    }
  }
  const turnQueue = createTurns()
  const turns = turnQueue.turns
  // 已标 log-only 的轮数（多次压缩只走新增的轮）
  let shadowedTurns = 0
  let cur = null
  let model = null
  let lastModelChange = null
  let title = profile.initialTitle ? profile.initialTitle(header, recs) : undefined
  // callId → 它所属的 step：toolResult 条目晚于其声明调用到达，按 callId 挂回
  // 声明 step（挂最近一步会让投影出的消息里带 tool_calls 的 assistant 后面紧跟
  // 另一条 assistant，违反 wire 规则）
  const callSteps = new Map()
  let droppedToolResults = 0
  let droppedInjected = 0
  // 摘要/注入类内容（compaction / branch_summary / custom_message / 注入角色）：前置到下一个
  // assistant 步骤（摘要作 reasoning、注入作 text）
  const pendingBlocks = []
  // 拿不到字节、以 [image: <mime>] 文本占位导入的图片张数（能落成宿主附件的不计这里）
  let imagesDegraded = 0

  const processMessage = (m) => {
    if (!m || typeof m !== 'object') return
    if (m.role === 'user') {
      const prompt = familyUserText(m.content)
      if (prompt) {
        // 边界后开启的第一个轮由 open() 挂上待落检查点（压缩点在轮之间时就是这个轮）
        cur = turnQueue.open(prompt)
        // 用户贴图提问：图片进 promptBlocks（合成时优先于纯文本 prompt）
        const userImages = familyUserImageBlocks(m.content)
        if (userImages.length > 0) cur.promptBlocks = [{ type: 'text', text: prompt }, ...userImages]
      }
    } else if (m.role === 'assistant') {
      // retainedTail 可能以 assistant 开头（无 user）：开空 prompt 轮次兜底
      if (!cur) {
        cur = turnQueue.open('')
      }
      const step = { content: [], toolCalls: [], toolResults: [] }
      const pending = pendingBlocks.splice(0)
      if (pending.length > 0) step.content.unshift(...pending)
      if (typeof m.model === 'string' && m.model) step.model = m.model
      if (!model && typeof m.model === 'string' && m.model) model = m.model
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') {
          step.content.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          step.content.push({ type: 'reasoning', text: block.thinking })
        } else if (block.type === 'image') {
          // 有内联字节（data + mimeType）→ IR image 块（宿主层落成附件），否则占位 + 计数
          const img = imageBlockFromSource(block)
          if (img) step.content.push(img)
          else { imagesDegraded++; step.content.push({ type: 'text', text: '[image: ' + (typeof block.mimeType === 'string' ? block.mimeType : 'image') + ']' }) }
        } else if (block.type === 'toolCall') {
          const mapped = familyToolCall(block, profile.toolCallIdPrefix, turns.length, cur.steps.length + 1)
          step.content.push({ type: 'tool-call', ...mapped })
          step.toolCalls.push(mapped)
        }
        // redactedThinking / anthropicServerTool / fallback 等：provider 重放产物，
        // 没有可读文本，DSH 侧无对应物 → 跳过（不是失败，不计数）
      }
      cur.steps.push(step)
      for (const tc of step.toolCalls) callSteps.set(tc.id, step)
    } else if (m.role === 'toolResult') {
      const step = callSteps.get(String(m.toolCallId))
      if (!step) { droppedToolResults++; return }
      const inner = familyToolResultContent(m)
        .map((b) => familyContentBlock(b, () => { imagesDegraded++ }))
        .filter(Boolean)
      step.toolResults.push({
        toolCallId: m.toolCallId,
        content: inner,
        isError: m.isError === true,
      })
    } else if (m.role === 'bashExecution') {
      if (m.excludeFromContext === true) return
      // 用户 bash REPL 活动在源侧是注入的 user 消息 → 用源自身文本格式降级
      // 为当前轮最后一步的文本块（无独立消息角色可挂，保证 wire 合法）
      if (!cur) { droppedInjected++; return }
      const step = cur.steps.length > 0 ? cur.steps[cur.steps.length - 1] : null
      if (step) step.content.push({ type: 'text', text: familyBashText(m) })
      else droppedInjected++
    } else if (m.role === 'pythonExecution') {
      if (m.excludeFromContext === true) return
      if (!cur) { droppedInjected++; return }
      const step = cur.steps.length > 0 ? cur.steps[cur.steps.length - 1] : null
      if (step) step.content.push({ type: 'text', text: familyPythonText(m) })
      else droppedInjected++
    } else if (m.role === 'fileMention') {
      // @file 内联内容：源侧拆成 developer（文本）与 user（图片）两条消息 → 文本进前置块、
      // 图片单独取（有字节落成附件）
      for (const b of familyFileMentionBlocks(m, () => { imagesDegraded++ })) pendingBlocks.push(b)
    } else if (m.role === 'branchSummary' || m.role === 'compactionSummary') {
      // 源侧这两个角色是注入 user 消息（带固定模板前缀）→ reasoning 块（内容一致）
      if (typeof m.summary === 'string' && m.summary.trim()) {
        pendingBlocks.push({
          type: 'reasoning',
          text: (m.role === 'branchSummary'
            ? profile.renderSummary.branch(m.summary.trim())
            : (m.method === 'handoff' && profile.renderSummary.handoff
              ? profile.renderSummary.handoff(m.summary.trim())
              : profile.renderSummary.compaction(m.summary.trim()))),
        })
      }
    } else if (m.role === 'custom' || m.role === 'hookMessage' || m.role === 'developer') {
      // 扩展注入消息 / developer 指令（源侧是 developer 消息）→ 前置文本块
      for (const b of familyCustomBlocks(m.content)) pendingBlocks.push(b)
    }
    // 未知 role 跳过
  }

  for (let i = startIndex; i < path.length; i++) {
    const item = path[i]
    // 压缩边界：此刻之前的轮全部 log-only（正文留在日志里），检查点落到下一个开启的轮
    if (boundaries.has(i)) {
      shadowedTurns = shadowTurns(turns, shadowedTurns)
      cur = null
      turnQueue.setCompaction({ summary: boundaries.get(i), provider: profile.provider, model: model || undefined })
    }
    if (!item || typeof item !== 'object') continue
    const cut = profile.compactOf(item)
    if (cut) {
      // 摘要已由检查点承载（consumedCompactions）→ 不再作 reasoning 块
      if (!consumedCompactions.has(item._id) && typeof cut.summary === 'string' && cut.summary.trim()) {
        const wrapped = (item.method === 'handoff' && profile.renderSummary.handoff)
          ? profile.renderSummary.handoff(cut.summary.trim())
          : profile.renderSummary.compaction(cut.summary.trim())
        pendingBlocks.push({ type: 'reasoning', text: wrapped })
      }
    } else if (item.type === 'branch_summary') {
      if (typeof item.summary === 'string' && item.summary.trim()) {
        pendingBlocks.push({ type: 'reasoning', text: profile.renderSummary.branch(item.summary.trim()) })
      }
    } else {
      const t = profile.titleOf ? profile.titleOf(item) : undefined
      if (t) title = t
      const mid = profile.modelOf ? profile.modelOf(item) : null
      if (mid) lastModelChange = mid
      if (item.type === 'message') processMessage(item.message)
      else if (item.type === 'custom_message') {
        // 扩展注入条目（参与上下文）：降级为前置文本块
        for (const b of familyCustomBlocks(item.content)) pendingBlocks.push(b)
      }
      // label / custom / thinking_level_change / model_usage / service_tier_change /
      // session_init / mode_change / credential_pin / ttsr_injection / title_change /
      // reset_boundary 不进入对话内容 → 跳过
    }
  }

  // 待落检查点没等到新轮（会话正好停在压缩点）：空 prompt 轮兜住，否则边界无处发射
  turnQueue.flush()

  // 无任何可挂接步骤的残留摘要/注入（文件尾）→ 丢弃，不产生空事件
  if (pendingBlocks.length > 0 && turns.length > 0) {
    const steps = turns.flatMap((t) => t.steps)
    const last = steps.length > 0 ? steps[steps.length - 1] : null
    if (last) last.content.unshift(...pendingBlocks.splice(0))
  }

  if (turns.length === 0) {
    return skipResult(null, { skipped: 1, records: recs.length })
  }

  const sourceId = typeof header.id === 'string' && header.id ? header.id : args[profile.idArg]
  const finalId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: finalId, createdAt: parseTime(header.timestamp) }
  if (sourceId) meta.sourceId = sourceId
  if (typeof header.cwd === 'string' && header.cwd) meta.cwd = header.cwd

  return finishSession(turns, args.budget, {
    meta,
    title,
    provider: profile.provider,
    model: lastModelChange || model,
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
  }, {
    droppedToolResults,
    ...(droppedInjected > 0 ? { droppedInjected } : {}),
    // 图片降级数（>0 才占键）：拿不到字节、以 [image: <mime>] 文本占位导入的图片张数
    ...(imagesDegraded > 0 ? { imagesDegraded } : {}),
    // 源侧 /clear 次数（>0 才占键）：清空点之前的内容未进日志，fullHistory:true 可保留
    ...(resetBoundaries > 0 ? { resetBoundaries } : {}),
  })
}

// 工具结果内容：源侧被裁剪过（prunedAt）时正文已换成占位，取可见文本（与源侧
// getPrunedToolResultContent 同口径）。
function familyToolResultContent(m) {
  const content = Array.isArray(m.content) ? m.content : []
  if (m.prunedAt === undefined) return content
  const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') || '[Output truncated]'
  const firstText = content.findIndex((b) => b && b.type === 'text')
  if (firstText < 0) return [{ type: 'text', text }, ...content]
  const out = []
  for (let i = 0; i < content.length; i++) {
    const b = content[i]
    if (!b || b.type !== 'text') out.push(b)
    else if (i === firstText) out.push({ type: 'text', text })
  }
  return out
}

// 用户消息内容 → 提问文本：string 原样；块数组取 text（image 降级为占位符）。
// 图片本身由 familyUserImageBlocks 单独取（提问里的图进 promptBlocks，不再只留文本占位）。
function familyUserText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) texts.push(block.text.trim())
    else if (block.type === 'image') texts.push('[image: ' + (typeof block.mimeType === 'string' ? block.mimeType : 'image') + ']')
  }
  return texts.join('\n')
}

// 用户消息里的图片块 → IR image 块（有字节才收；拿不到的留给 familyUserText 的文本占位）。
function familyUserImageBlocks(content) {
  const out = []
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'image') continue
    const img = imageBlockFromSource(block)
    if (img) out.push(img)
  }
  return out
}

// 工具结果 / 普通内容块 → DSH 内容块：text→text、image→image 块（无字节时占位文本
// 并回调 onDegrade，让调用方计数）；其余 null。
function familyContentBlock(block, onDegrade) {
  if (!block || typeof block !== 'object') return null
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
  if (block.type === 'image') {
    const img = imageBlockFromSource(block)
    if (img) return img
    if (typeof onDegrade === 'function') onDegrade()
    return { type: 'text', text: '[image: ' + (typeof block.mimeType === 'string' ? block.mimeType : 'image') + ']' }
  }
  return null
}

// toolCall 块 → tool/call 映射：arguments 是对象（本族格式），序列化为标准 JSON；
// 已是字符串（扩展注入）原样保留。id/name 缺失时给稳定兜底值（前缀由来源给出，
// 同一文件重复转换结果一致）。
function familyToolCall(block, prefix, turnNum, stepNum) {
  const id = typeof block.id === 'string' && block.id ? block.id : prefix + '-' + turnNum + '-' + stepNum
  return {
    id,
    name: typeof block.name === 'string' && block.name ? block.name : 'unknown',
    arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
  }
}

// 扩展注入内容（string 或块数组）→ 前置文本块；image 降级为占位符。
function familyCustomBlocks(content) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content.trim() }] : []
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      blocks.push({ type: 'text', text: block.text.trim() })
    } else if (block.type === 'image') {
      blocks.push({ type: 'text', text: '[image: ' + (typeof block.mimeType === 'string' ? block.mimeType : 'image') + ']' })
    }
  }
  return blocks
}

// @file 内联内容 → 文本块（源侧 convertToLlm 的 <file> 包装逐字重建）+ 图片块。
function familyFileMentionBlocks(m, onDegrade) {
  const blocks = []
  for (const file of Array.isArray(m.files) ? m.files : []) {
    if (!file || typeof file !== 'object') continue
    const inner = file.content ? '\n' + file.content + '\n' : '\n'
    const text = '<file path="' + (typeof file.path === 'string' ? file.path : '') + '">' + inner + '</file>'
    blocks.push({ type: 'text', text })
    if (file.image) {
      const img = imageBlockFromSource(file.image)
      if (img) blocks.push(img)
      else if (typeof onDegrade === 'function') { onDegrade(); blocks.push({ type: 'text', text: '[image: ' + (typeof file.image.mimeType === 'string' ? file.image.mimeType : 'image') + ']' }) }
    }
  }
  return blocks
}

// 源自身 convertToLlm 的 bashExecution → 文本格式（bashExecutionToText）。
// meta 的工具输出截断提示（formatOutputNotice）不重建：它不是会话内容。
function familyBashText(m) {
  let text = 'Ran `' + (typeof m.command === 'string' ? m.command : '') + '`\n'
  if (typeof m.output === 'string' && m.output) text += '```\n' + m.output + '\n```'
  else text += '(no output)'
  if (m.cancelled === true) text += '\n\n(command cancelled)'
  else if (m.exitCode !== null && m.exitCode !== undefined && m.exitCode !== 0) text += '\n\nCommand exited with code ' + m.exitCode
  if (m.truncated === true && typeof m.fullOutputPath === 'string') text += '\n\n[Output truncated. Full output: ' + m.fullOutputPath + ']'
  return text
}

// 源自身 convertToLlm 的 pythonExecution → 文本格式（pythonExecutionToText）。
function familyPythonText(m) {
  let text = 'Ran Python:\n```python\n' + (typeof m.code === 'string' ? m.code : '') + '\n```\n'
  if (typeof m.output === 'string' && m.output) text += 'Output:\n```\n' + m.output + '\n```'
  else text += '(no output)'
  if (m.cancelled === true) text += '\n\n(execution cancelled)'
  else if (m.exitCode !== null && m.exitCode !== undefined && m.exitCode !== 0) text += '\n\nExecution failed with code ' + m.exitCode
  return text
}
