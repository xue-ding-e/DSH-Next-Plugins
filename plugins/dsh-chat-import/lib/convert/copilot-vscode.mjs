// Copilot VS Code chatSessions/<id>.json, ISerializableChatData3 → DSH turns.
// Contract: microsoft/vscode chat/common/model/chatModel.ts and
// chat/common/chatService/chatService.ts (version 3, checked 2026-10-23).
// requests contain parsed message text, Markdown values without kind, thinking,
// and serialized tool invocations. Serialized invocations do not retain the
// original parameters; only persisted input/result sidecars can restore them.
import { fileURLToPath } from 'node:url'
import { SESSION_FORMAT_VERSION, finishSession, mintSessionId, parseTimeMs } from './core.mjs'
import { contentText, isAbsoluteLike, normalizeTitle, skipResult } from './util.mjs'
import { createTurns, dropDuplicateCalls } from './ir.mjs'

export function readCopilotVscodeSession(raw) {
  let session
  try { session = JSON.parse(raw) } catch { return null }
  return session && session.version === 3 && typeof session.sessionId === 'string'
    && session.sessionId.trim() && Array.isArray(session.requests) ? session : null
}

// Keep Windows drive/UNC paths when importing on another OS; remote URIs are
// not local working directories. No URI is fetched or dereferenced here.
export function copilotVscodeCwd(value) {
  if (typeof value !== 'string' || !value) return null
  if (isAbsoluteLike(value)) return value
  try {
    const uri = new URL(value)
    if (uri.protocol !== 'file:') return null
    const windows = /^\/[a-z]:/i.test(decodeURIComponent(uri.pathname))
      || !!(uri.hostname && uri.hostname !== 'localhost')
    return fileURLToPath(uri, { windows })
  } catch { return null }
}

function promptText(message) {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return ''
  return typeof message.text === 'string' ? message.text
    : contentText(message.parts, { types: null, sep: '', skipEmpty: true })
}

export function copilotVscodeMetadata(session) {
  const times = []
  for (const request of session.requests) {
    if (!request || typeof request !== 'object') continue
    times.push(request.timestamp, request.responseTimestamp)
    for (const part of Array.isArray(request.response) ? request.response : []) {
      if (part && typeof part === 'object') times.push(part.startedAt, part.completedAt)
    }
  }
  const valid = [session.creationDate, session.lastMessageDate, ...times]
    .map((v) => parseTimeMs(v)).filter((v) => v !== null)
  return {
    id: session.sessionId,
    title: normalizeTitle(typeof session.customTitle === 'string' && session.customTitle.trim()
      ? session.customTitle : promptText(session.requests.find((r) => r?.message)?.message)),
    cwd: copilotVscodeCwd(session.workingDirectory),
    createdAt: parseTimeMs(session.creationDate) ?? valid[0],
    lastActiveAt: valid.length ? valid.reduce((latest, time) => Math.max(latest, time)) : undefined,
  }
}

const UI_PARTS = new Set([
  'inlineReference', 'codeblockUri', 'undoStop', 'textEditGroup', 'notebookEditGroup',
  'mcpServersStarting', 'mcpServersStartingSerialized', 'progressMessage', 'progressTask',
  'progressTaskSerialized', 'reference', 'treeData', 'confirmation', 'codeCitation',
  'autoModeResolution', 'hook', 'warning', 'info', 'toolResources',
])

const savedText = (value) => typeof value === 'string' ? value
  : value && typeof value.value === 'string' ? value.value : ''
const callIdOf = (part) => typeof part.toolCallId === 'string' ? part.toolCallId
  : typeof part.id === 'string' ? part.id : ''

function toolInput(part, prepared) {
  const data = part.toolSpecificData || prepared?.toolSpecificData
  if (data && data.kind === 'input' && data.rawInput !== undefined) return JSON.stringify(data.rawInput)
  if (typeof part.resultDetails?.input === 'string') {
    try { return JSON.stringify(JSON.parse(part.resultDetails.input)) } catch {
      // Non-JSON input (for example a shell command) is retained as a JSON
      // string, without inventing parameter names from the invocation label.
      return JSON.stringify(part.resultDetails.input)
    }
  }
  return null
}

function toolOutput(part, counts) {
  const details = part.resultDetails
  if (typeof details?.output === 'string') {
    return details.output ? [{ type: 'text', text: details.output }] : []
  }
  if (Array.isArray(details?.output)) {
    const content = []
    for (const item of details.output) {
      if (item?.type === 'embed' && item.isText === true && typeof item.value === 'string') {
        if (item.value) content.push({ type: 'text', text: item.value })
      } else {
        // Binary and URI references are not read from the source machine.
        counts.droppedToolResultBlocks++
      }
    }
    return content
  }
  const terminal = part.toolSpecificData?.terminalCommandOutput
  if (terminal && typeof terminal.text === 'string') {
    return terminal.text ? [{ type: 'text', text: terminal.text }] : []
  }
  return null
}

export function convertCopilotVscodeJson(raw, args = {}) {
  const session = readCopilotVscodeSession(raw)
  if (!session) return skipResult('not a Copilot VS Code v3 session', { skipped: 1 })
  const info = copilotVscodeMetadata(session)
  const queue = createTurns()
  const counts = {
    metaMessages: 0, droppedMalformedOutputs: 0, droppedToolResultBlocks: 0,
    missingToolInputs: 0, missingToolOutputs: 0,
  }
  let skipped = 0
  let model = null
  for (const request of session.requests) {
    if (!request || typeof request !== 'object' || request.message === null || request.message === undefined) { skipped++; continue }
    const turn = queue.open(promptText(request.message), parseTimeMs(request.timestamp))
    let step = null
    const parts = Array.isArray(request.response) ? request.response : []
    if (request.response !== null && request.response !== undefined && !Array.isArray(request.response)) counts.droppedMalformedOutputs++
    const prepared = new Map()
    const lastCall = new Map()
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      if (part.kind === 'prepareToolInvocation') prepared.set(callIdOf(part), part)
      if (part.kind === 'toolInvocationSerialized') lastCall.set(callIdOf(part), part)
    }
    const newStep = (time) => {
      step = { content: [], toolCalls: [], toolResults: [] }
      const stamp = parseTimeMs(time ?? request.responseTimestamp)
      if (stamp !== null) step.time = stamp
      if (typeof request.modelId === 'string' && request.modelId) step.model = model = request.modelId
      turn.steps.push(step)
      return step
    }
    const text = (type, value, time) => {
      if (!value) return
      if (!step || step.toolCalls.length) newStep(time)
      const previous = step.content.at(-1)
      if (previous?.type === type) previous.text += value
      else step.content.push({ type, text: value })
    }
    for (const part of parts) {
      if (typeof part === 'string') { text('text', part); continue }
      if (!part || typeof part !== 'object') { counts.droppedMalformedOutputs++; continue }
      if (!part.kind || part.kind === 'markdownContent' || part.kind === 'markdownVuln') {
        const payload = part.kind ? part.content : part
        const value = savedText(payload)
        if (value) text('text', value)
        else if (!(typeof payload === 'string' || typeof payload?.value === 'string')) counts.droppedMalformedOutputs++
      } else if (part.kind === 'thinking') {
        const value = typeof part.value === 'string' ? part.value
          : Array.isArray(part.value) ? part.value.filter((v) => typeof v === 'string').join('\n') : ''
        text('reasoning', value, part.reasoningStartedAt)
      } else if (part.kind === 'toolInvocationSerialized') {
        const id = callIdOf(part)
        if (!id || typeof part.toolId !== 'string' || !part.toolId) { counts.droppedMalformedOutputs++; continue }
        if (lastCall.get(id) !== part) { counts.metaMessages++; continue }
        const input = toolInput(part, prepared.get(id))
        if (input === null) {
          counts.missingToolInputs++
          // Retain the stored command/label as prose when raw parameters were
          // not saved. It is evidence, not a reconstructed function argument.
          const command = part.toolSpecificData?.commandLine
          text('text', command ? JSON.stringify(command) : savedText(part.invocationMessage), part.startedAt)
        }
        if (!step) newStep(part.startedAt)
        const call = { id, name: part.toolId, arguments: input ?? '{}' }
        step.content.push({ type: 'tool-call', ...call })
        step.toolCalls.push(call)
        const output = toolOutput(part, counts)
        if (output === null) counts.missingToolOutputs++
        step.toolResults.push({
          toolCallId: id, content: output ?? [],
          isError: !!(part.resultError || part.resultDetails?.isError),
          ...(parseTimeMs(part.completedAt) !== null ? { time: parseTimeMs(part.completedAt) } : {}),
        })
      } else if (part.kind === 'prepareToolInvocation' || UI_PARTS.has(part.kind)) {
        counts.metaMessages++
      } else {
        counts.droppedMalformedOutputs++
      }
    }
    // Attach request-level token counts once, to the final stored step.
    if (step && request.promptTokens !== undefined && request.completionTokens !== undefined) {
      step.usage = { inputTokens: request.promptTokens, outputTokens: request.completionTokens }
    }
    if (!turn.prompt.trim() && !turn.steps.length) queue.turns.pop()
  }
  if (!queue.turns.length) return skipResult('Copilot session has no conversation', { records: session.requests.length, skipped: skipped || 1 })
  counts.metaMessages += dropDuplicateCalls(queue.turns)
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: args.sessionId || mintSessionId(info.id),
    sourceId: info.id,
    createdAt: args.createdAt ?? info.createdAt ?? Date.now(),
  }
  if (info.cwd || args.cwd) meta.cwd = info.cwd || args.cwd
  const explicitTitle = typeof session.customTitle === 'string' && session.customTitle.trim()
  return finishSession(queue.turns, args.budget, {
    meta, title: explicitTitle ? info.title : undefined, provider: 'copilot-vscode', model,
    skipped, records: session.requests.length,
  }, { title: info.title, ...counts })
}
