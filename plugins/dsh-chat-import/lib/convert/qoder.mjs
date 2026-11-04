// lib/convert/qoder.mjs — Qoder CLI 会话 JSONL → DSH 会话（纯函数）
//
// Qoder CLI 把每会话 transcript 落盘为 ~/.qoder/projects/<encoded-project>/
// <sessionId>.jsonl（子代理 transcript 在 <sessionId>/subagents/*.jsonl）。Qoder CN
// （国内发行版）落在 ~/.qoder-cn/projects 下，格式逐字相同，两版共用本转换器。逐行 JSON，
// 结构与 Claude Code 高度一致：
//   {"type":"user","uuid":"…","sessionId":"…","timestamp":"…","cwd":"…",
//    "message":{"role":"user","content": "…" | [content blocks]}}
//   {"type":"assistant","message":{"role":"assistant","content":[blocks]}}
//   {"type":"ai-title","aiTitle":"…"}     —— 标题（重命名后到者胜）
//   {"type":"last-prompt","lastPrompt":"…"} —— 标题兜底（ai-title 缺省时）
// content block：text / thinking（→reasoning）/ tool_use（{name,input}）/ tool_result
// （{content,tool_use_id?}）。user 记录：字符串 content 或不含 tool_result 的块数组 =
// 直连提问（开新轮，text 块拼接为 prompt）；含 tool_result 的块数组 = 工具结果。tool_result 按 tool_use_id 挂回 call 所属 step（对齐
// claude.mjs 的并行工具后置结果语义）；缺 tool_use_id 时按未决调用顺序回退配对。
// 标题选取：ai-title > last-prompt > 首问兜底。cwd 取记录内 cwd（Qoder 每轮都记录）。
// 与 claude 同款「主 transcript」判定：fileStem != sessionId 的辅助/subagent 文件跳过。
//
// 上下文压缩：Qoder CLI 自动/手动压缩时落**两条**记录（与 Claude Code 同款）——
//   {"type":"system","subtype":"compact_boundary","isCompactSummary":true,
//    "compactMetadata":{"preTokens":…,"postTokens":…,"messagesSummarized":…}}
//   {"type":"user","isCompactSummary":true,"message":{"content":"This session is being
//    continued from a previous conversation that ran out of context. …"}}
// 即「边界标记 + 摘要正文」。此前本转换器两条都不认，摘要当普通 user 提问导入，
// 边界之前的全部历史原样留在 surface 上：Qoder 当初压掉的上下文全回来了，导入会话
// 直接堆到几百万 token，DSH 的自动压缩请求自己也超窗 → 每轮 400（CONTEXT_WINDOW_EXCEEDED），
// 会话永久不可用。本机实测两份真实转录：12 次压缩 / 47 次压缩，导入后各生效 0 次，
// 分别堆到 381 万与 850 万 token；修好后同一份源降到 57 万与 29 万。
// 处理方式对齐 claude.mjs：摘要进 DSH 原生压缩检查点（compaction 事务 + 带
// surfaceOp:replace 的检查点消息），边界之前的轮全部标 log-only（正文仍在日志里，
// 只是不进模型投影）。fullHistory: true 时退回旧行为，摘要按普通 user 记录导入。

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mapContentBlock,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  parseTimeMs,
} from './core.mjs'
import { createTurns, shadowTurns } from './ir.mjs'
import { contentText, normalizeTitle, skipResult } from './util.mjs'

// tool_result 块 → 配对 callId：优先显式 tool_use_id（Claude 同款），缺省返回 null
//（调用方按未决调用顺序回退配对）。
function toolResultCallId(block) {
  if (block && typeof block === 'object') {
    if (typeof block.tool_use_id === 'string' && block.tool_use_id) return block.tool_use_id
    if (typeof block.toolUseId === 'string' && block.toolUseId) return block.toolUseId
  }
  return null
}

export function convertQoderJsonl(raw, args = {}) {
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let sourceId = null
  let title = null
  let lastPrompt = null
  let cwd = null
  let createdAt = null
  let model = null

  let cur = null
  // 轮队列与待落压缩检查点由 ir.mjs 统一维护（本转换器原先是手写 turns/cur，
  // 补压缩时一并收口到共用骨架，避免与 claude.mjs 再漂移）。
  // 压缩次数由合成层（events.mjs）按实际发射的检查点上报，这里不单独计数。
  let shadowedTurns = 0
  const turnQueue = createTurns()
  const turns = turnQueue.turns
  // callId → 它所属的 step：tool_result 按 id 挂回 call 所在 step（并行工具结果
  // 可能乱序/后置）；查不到显式 id 时按未决调用顺序回退配对。
  const callSteps = new Map()
  const unresolved = []
  let droppedToolResults = 0

  // 记下待落压缩检查点：边界之前的轮标 log-only，摘要由 createTurns 挂到下一个开出的轮上。
  const setCompaction = (summary, time) => {
    shadowedTurns = shadowTurns(turns, shadowedTurns)
    cur = null
    turnQueue.setCompaction({
      summary,
      provider: 'qoder',
      ...(model ? { model } : {}),
      ...(time !== undefined && time !== null ? { time } : {}),
    })
  }

  for (const rec of recs) {
    if (rec && typeof rec.sessionId === 'string' && !sourceId) sourceId = rec.sessionId
    if (rec && typeof rec.cwd === 'string' && !cwd) cwd = rec.cwd
    if (rec && rec.timestamp !== undefined && createdAt === null) createdAt = parseTime(rec.timestamp)
    const recTime = parseTimeMs(rec && rec.timestamp)
    if (rec && rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && !title) title = rec.aiTitle
    if (rec && rec.type === 'last-prompt' && typeof rec.lastPrompt === 'string' && !lastPrompt) lastPrompt = rec.lastPrompt
    const recModel = rec ? (rec.message?.model ?? rec.model) : undefined
    if (typeof recModel === 'string' && !model) model = recModel

    // 压缩边界标记：摘要正文在紧随其后的 isCompactSummary user 记录里；边界记录
    // 本身不带对话正文，直接跳过（不能当提问开轮）。
    if (rec && rec.type === 'system' && rec.subtype === 'compact_boundary') {
      const ownText = contentText(rec.message?.content, { trim: true })
      if (ownText) setCompaction(ownText, recTime)
      continue
    }

    // 压缩摘要正文（不是人类提问）：进检查点，此前的轮全部标 log-only。
    // fullHistory 时退回旧行为——按普通 user 记录导入，摘要正文不丢。
    if (rec && rec.type === 'user' && rec.isCompactSummary === true && args.fullHistory !== true) {
      const text = contentText(rec.message?.content, { trim: true })
      if (text) setCompaction(text, recTime)
      continue
    }

    const userBlocks = rec && rec.type === 'user' && Array.isArray(rec.message?.content) ? rec.message.content : null
    const isToolResultRec = userBlocks !== null && userBlocks.some((b) => b && b.type === 'tool_result')
    if (rec && rec.type === 'user' && rec.message && (typeof rec.message.content === 'string' || (userBlocks !== null && !isToolResultRec))) {
      // 直连人类提问 → 新轮。新版 Qoder 与新版 Claude Code 同款，直接提问也写数组
      // content（[{type:'text',...}]）；此前只认字符串，数组提问落进下方 tool_result
      // 分支被静默丢弃、整段对话 0 轮导入。纯文本块数组按 text 拼接作为 prompt；
      // 含 tool_result 块的数组只走下方配对分支，绝不在此开新轮（对齐 claude.mjs）。
      const prompt = contentText(rec.message.content)
      cur = turnQueue.open(prompt, recTime)
    } else if (rec && rec.type === 'assistant' && (cur || turnQueue.hasCompaction())) {
      // 自动压缩发生在轮中间：Qoder 写完摘要后直接续跑原任务，之后可能再也没有人类提问。
      // 续跑的 assistant 记录归入一个空 prompt 的压缩边界轮（检查点就是它的 user 侧消息）。
      if (!cur) {
        // 用检查点自己的 time（边界轮的 user 侧就是压缩摘要）
        cur = turnQueue.flush()
      }
      // 一条 assistant 消息 = 一步
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (recTime !== null) step.time = recTime
      if (Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content) {
          const mapped = mapContentBlock(block)
          if (!mapped) continue
          if (mapped.type === 'tool-call') {
            step.content.push(mapped)   // 助手内容里的 tool-call block
            step.toolCalls.push(mapped) // 同时作为 tool/call 事件
            callSteps.set(mapped.id, step)
            unresolved.push(mapped.id)
          } else {
            step.content.push(mapped)   // text / reasoning block
          }
        }
      } else if (typeof rec.message?.content === 'string') {
        step.content.push({ type: 'text', text: rec.message.content })
      }
      cur.steps.push(step)
    } else if (isToolResultRec) {
      // 工具结果：优先按 tool_use_id 挂到 call 所属 step，否则按未决调用顺序回退。
      for (const block of rec.message.content) {
        if (!(block && block.type === 'tool_result')) continue
        let callId = toolResultCallId(block)
        let step = callId ? callSteps.get(callId) : undefined
        if (!step && unresolved.length > 0) {
          // 顺序回退：取最早未决调用（Qoder 个别版本 tool_result 不带 tool_use_id）
          callId = unresolved.shift()
          step = callSteps.get(callId)
        }
        if (!step) { droppedToolResults++; continue }
        if (callId && unresolved.includes(callId)) unresolved.splice(unresolved.indexOf(callId), 1)
        const inner = (Array.isArray(block.content) ? block.content : [])
          .map(mapContentBlock)
          .filter(Boolean)
        step.toolResults.push({
          toolCallId: callId,
          ...(recTime !== null ? { time: recTime } : {}),
          content: inner,
          isError: block.is_error === true,
        })
      }
    }
    // 其余记录类型（mode / summary / subagent 元数据等）不产生对话内容，跳过
  }

  // 待落检查点若没等到新轮（会话正好停在压缩点）：用空 prompt 轮兜住，
  // 否则这次压缩的摘要无处发射、边界之前的轮仍留在 surface 上。
  turnQueue.flush()

  // 只有主 transcript（文件名 = <sessionId>.jsonl）是独立会话。Qoder 的子代理
  // transcript 在 <sessionId>/subagents/*.jsonl，记录携带父 sessionId，若按它建会话
  // 会与主 transcript 撞 id：先扫描到的文件占会话、主内容被幂等跳过而丢失。
  // 文件名与记录 sessionId 不一致的一律跳过并给原因（对齐 claude 语义）。
  const fileStem = typeof args.fileStem === 'string' ? args.fileStem : null
  if (fileStem && sourceId && fileStem !== sourceId) {
    return skipResult('auxiliary/subagent transcript (file "' + fileStem + '" does not match sessionId "' + sourceId + '"); only the main <sessionId>.jsonl becomes a session', { records: recs.length })
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  // 标题选取：ai-title > last-prompt > 首问兜底。显式标题（归一后非空）钉
  // session/title 事件；纯首问兜底只回填 out.title（DSH 自动回退首条 user 文本）。
  const explicitTitle = (title && title.trim()) || (lastPrompt && lastPrompt.trim()) || null
  const finalTitle = normalizeTitle(explicitTitle || (turns.length > 0 ? turns[0].prompt : ''))
  return finishSession(turns, args.budget, {
    meta,
    title: explicitTitle ? finalTitle : undefined,
    provider: 'qoder',
    model,
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
  }, { title: finalTitle, droppedToolResults })
}
