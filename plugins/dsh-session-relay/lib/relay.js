/** Independent-chat delivery through the Host's Session controller and inbox. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/** Operational errors preserve whether inbox acceptance already happened. */
export class RelayError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RelayError'
    this.code = code
    this.details = details
  }
}

const MODES = new Set(['context', 'queue', 'steer'])

/** Validate deployment policy once, including direct apply() callers. */
export function resolveConfig(config = {}) {
  const value = {
    scope: 'same-directory', defaultDelivery: 'context',
    maxMessageBytes: 32768, maxReadChars: 12000, maxListItems: 50,
    ...config,
  }
  for (const key of Object.keys(value)) {
    if (!['scope', 'defaultDelivery', 'maxMessageBytes', 'maxReadChars', 'maxListItems'].includes(key)) {
      throw new RelayError('INVALID_CONFIG', `Unknown session-relay setting: ${key}`)
    }
  }
  if (!['same-directory', 'all'].includes(value.scope) || !MODES.has(value.defaultDelivery)) {
    throw new RelayError('INVALID_CONFIG', 'scope must be same-directory or all; defaultDelivery must be context, queue or steer')
  }
  for (const key of ['maxMessageBytes', 'maxReadChars', 'maxListItems']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      throw new RelayError('INVALID_CONFIG', `${key} must be a positive safe integer`)
    }
  }
  return Object.freeze(value)
}

/** SHA-256 over unambiguous JSON tuples, never over shell command text. */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Model-facing plain text deliberately excludes tools, images and reasoning. */
export function visibleMessages(messages) {
  return messages.filter(message => message.role === 'assistant'
    || (message.role === 'user' && ['user', 'agent-message'].includes(message.source.kind)))
    .flatMap(message => {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      return text === '' ? [] : [{ id: message.id, role: message.role, source: message.source.kind, text }]
    })
}

/** Owns serialization, liveness checks and delivery receipts for one plugin fiber. */
export class SessionRelay {
  constructor(ctx, config, readMessages) {
    this.ctx = ctx
    this.config = resolveConfig(config)
    this.readMessages = readMessages
    this.chains = new Map()
    this.closed = false
  }

  caller(agent, signal) {
    signal?.throwIfAborted()
    if (this.closed) throw new RelayError('DISPOSED', 'Session relay was unloaded')
    if (agent === undefined || this.ctx.agents.get(agent.id) !== agent) {
      throw new RelayError('STALE_CALLER', 'A live calling chat is required')
    }
    if (agent.session.header.origin === 'subagent') {
      throw new RelayError('SUBAGENT_CALLER', 'Use send_message and list_agents inside a subagent tree')
    }
    return agent
  }

  inScope(agent, header) {
    if (header.origin === 'subagent') return false
    if (!this.ctx.remoteAccess.allows({ kind: 'session', id: header.id ?? header.sessionId })) return false
    if (this.config.scope === 'all') return true
    const left = agent.session.header.cwd
    const right = header.cwd
    if (typeof left !== 'string' || typeof right !== 'string') return false
    const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    return normalize(left) === normalize(right)
  }

  async list(agent, { cursor = 0, limit = this.config.maxListItems, query = '' } = {}, signal) {
    this.caller(agent, signal)
    integer(cursor, 0, Number.MAX_SAFE_INTEGER, 'cursor')
    integer(limit, 1, this.config.maxListItems, 'limit')
    const { items } = await this.ctx.sessionController.list({}, signal ?? new AbortController().signal)
    this.caller(agent, signal)
    const rows = items.filter(row => this.inScope(agent, row))
      .map(row => ({
        session_id: row.sessionId, current: row.sessionId === agent.id,
        cwd: row.cwd ?? null, running: row.running, loaded: row.agentAvailable,
        updated_at: row.updatedAt, title: row.projections?.values.title ?? null,
        archived: this.ctx.workspaceRegistry.archivedSessionIds.includes(row.sessionId),
      }))
      .filter(row => JSON.stringify(row).toLowerCase().includes(query.toLowerCase()))
    const result = { sessions: [], next_cursor: null, total: rows.length }
    for (let index = cursor; index < Math.min(cursor + limit, rows.length); index++) {
      result.sessions.push(rows[index])
      result.next_cursor = index + 1 < rows.length ? index + 1 : null
      if (JSON.stringify(result).length > this.config.maxReadChars) {
        result.sessions.pop()
        result.next_cursor = index
        if (result.sessions.length === 0) throw new RelayError('OUTPUT_LIMIT', 'A chat listing row exceeds maxReadChars')
        break
      }
    }
    return result
  }

  async observe(agent, sessionId, signal) {
    this.caller(agent, signal)
    nonempty(sessionId, 'session_id')
    if (!this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId })) {
      throw new RelayError('OUT_OF_SCOPE', 'The current caller cannot access the destination chat')
    }
    const observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal })
    try {
      this.caller(agent, signal)
      if (!this.inScope(agent, observation.header)) {
        throw new RelayError('OUT_OF_SCOPE', 'Target must be an ordinary chat allowed by the configured scope')
      }
      return observation
    } catch (error) {
      observation[Symbol.dispose]()
      throw error
    }
  }

  async read(agent, { session_id, cursor, max_chars = this.config.maxReadChars }, signal) {
    integer(max_chars, 1, this.config.maxReadChars, 'max_chars')
    const observation = await this.observe(agent, session_id, signal)
    try {
      const messages = visibleMessages(this.readMessages(observation))
      return readPage(session_id, observation.cursor, messages, cursor, max_chars)
    } finally {
      observation[Symbol.dispose]()
    }
  }

  async status(agent, { session_id, request_id }, signal) {
    nonempty(request_id, 'request_id')
    const observation = await this.observe(agent, session_id, signal)
    try {
      const found = findDelivery(observation.events, `relay-${digest([agent.id, session_id, request_id])}-`)
      return {
        session_id, request_id, message_id: found?.messageId ?? null,
        delivery_status: found?.status ?? 'not-found', captured_through_seq: observation.cursor,
      }
    } finally {
      observation[Symbol.dispose]()
    }
  }

  async send(agent, request, signal) {
    this.caller(agent, signal)
    const { session_id, message, request_id, delivery = this.config.defaultDelivery } = request
    nonempty(session_id, 'session_id')
    nonempty(message, 'message')
    nonempty(request_id, 'request_id')
    if (request_id.length > 200) throw new RelayError('INVALID_ARGUMENT', 'request_id must be at most 200 characters')
    if (!MODES.has(delivery)) throw new RelayError('INVALID_ARGUMENT', 'delivery must be context, queue or steer')
    if (session_id === agent.id) throw new RelayError('SELF_SEND', 'Choose another chat')
    const prefix = `relay-${digest([agent.id, session_id, request_id])}-`
    const messageId = `${prefix}${digest([message, delivery])}`
    const content = [
      { type: 'text', text: `Agent in session ${JSON.stringify(agent.id)} sent a message:\n` },
      { type: 'text', text: message },
    ]
    const input = {
      id: messageId, role: 'user', content,
      source: { kind: 'agent-message', form: 'relay', senderSessionId: agent.id },
    }
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > this.config.maxMessageBytes) {
      throw new RelayError('MESSAGE_TOO_LARGE', 'Message including attribution exceeds maxMessageBytes')
    }
    return this.serialize(session_id, async () => {
      const observation = await this.observe(agent, session_id, signal)
      let duplicate
      let deliveryStatus = 'accepted'
      try {
        const previous = findDelivery(observation.events, prefix)
        duplicate = previous !== undefined
        if (previous !== undefined) {
          if (previous.messageId !== messageId) throw new RelayError('REQUEST_CONFLICT', 'request_id already names different content or delivery')
          deliveryStatus = previous.status
          if (previous.status === 'cancelled') {
            throw new RelayError('DELIVERY_CANCELLED', 'Native inbox input was cancelled; use a new request_id only when resending is intended', {
              message_id: messageId, request_id, accepted: true, delivery_status: previous.status,
            })
          }
        }
      } finally {
        observation[Symbol.dispose]()
      }
      let target = this.ctx.agents.get(session_id)
      if (!duplicate) {
        this.assertWritable(session_id)
        const found = await this.ctx.sessionController.resolveAgent(session_id)
        if ('error' in found) throw found.error
        target = found.agent
        this.caller(agent, signal)
        this.assertWritable(session_id)
        if (this.ctx.agents.get(session_id) !== target || !this.inScope(agent, target.session.header)) {
          throw new RelayError('TARGET_CHANGED', 'Target changed during activation; retry the same request_id')
        }
        // Native input owns wake, cancellation and step/turn ordering after acceptance.
        try {
          target.send(input, delivery === 'queue' ? 'next-turn' : 'next-step', delivery !== 'context')
        } catch (error) {
          throw new RelayError('DELIVERY_UNCONFIRMED', String(error), { message_id: messageId, request_id })
        }
      }
      const session = target?.session ?? this.ctx.sessions.get(session_id)
      if (session !== undefined) {
        try {
          // A caller cancellation after acceptance must not cancel the durability check.
          await this.ctx.sessions.flush(session)
        } catch (error) {
          throw new RelayError('PERSISTENCE_UNCONFIRMED', String(error), { message_id: messageId, request_id, accepted: true })
        }
      }
      return {
        session_id, sender_session_id: agent.id, request_id, message_id: messageId,
        delivery, duplicate, durable: true, delivery_status: deliveryStatus, wakeup_requested: delivery !== 'context',
      }
    })
  }

  serialize(sessionId, operation) {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.chains.set(sessionId, settled)
    return result.finally(() => {
      if (this.chains.get(sessionId) === settled) this.chains.delete(sessionId)
    })
  }

  assertWritable(sessionId) {
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      throw new RelayError('ARCHIVED_TARGET', 'Restore the destination chat before sending a new message')
    }
  }

  async dispose() {
    this.closed = true
    await Promise.allSettled([...this.chains.values()])
  }
}

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RelayError('INVALID_ARGUMENT', `${name} must be an integer from ${min} through ${max}`)
  }
}

function nonempty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RelayError('INVALID_ARGUMENT', `${name} must be a nonempty string`)
  }
}

/** Native splice removals distinguish cancellation from admission; history confirms consumption. */
function findDelivery(events, prefix) {
  const queues = { 'next-step': [], 'next-turn': [] }
  let found
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount = 0, inserted, outcome } = event.data
      const removed = queues[target].splice(start, removedCount, ...inserted.map(message => message.id))
      if (found !== undefined && removed.includes(found.messageId)) {
        found.status = outcome === 'canceled' ? 'cancelled' : 'claimed'
      }
      for (const message of inserted) {
        if (message.id.startsWith(prefix)) found = { messageId: message.id, status: 'pending' }
      }
    } else if (event.type === 'user/message' && found?.messageId === event.data.id) {
      found.status = 'consumed'
    }
  }
  return found
}

/** Opaque cursors bind fragments to one exact Session cut, including title/context edits. */
function readPage(sessionId, capturedSeq, messages, cursor, maxChars) {
  const revision = digest([sessionId, capturedSeq, messages.map(message => message.id)])
  let index = Math.max(0, messages.length - 20)
  let offset = 0
  const omitted = index
  if (cursor !== undefined) {
    let saved
    try {
      if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error('invalid cursor')
      saved = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (saved.v !== 1 || saved.session !== sessionId || saved.revision !== revision) throw new Error('source changed')
      integer(saved.index, 0, messages.length, 'cursor.index')
      integer(saved.offset, 0, messages[saved.index]?.text.length ?? 0, 'cursor.offset')
      index = saved.index
      offset = saved.offset
      if (offset > 0 && /[\uDC00-\uDFFF]/u.test(messages[index].text[offset])) throw new Error('split surrogate')
    } catch {
      throw new RelayError('INVALID_CURSOR', 'Cursor is invalid or the chat changed; read again without cursor')
    }
  }
  const token = (nextIndex, nextOffset) => nextIndex >= messages.length ? null
    : Buffer.from(JSON.stringify({ v: 1, session: sessionId, revision, index: nextIndex, offset: nextOffset })).toString('base64url')
  const page = { session_id: sessionId, captured_through_seq: capturedSeq, omitted_before: omitted, messages: [], next_cursor: null }
  const fits = () => JSON.stringify(page).length <= maxChars
  if (!fits()) throw new RelayError('OUTPUT_LIMIT', 'max_chars cannot fit the read response metadata')
  while (index < messages.length) {
    const message = messages[index]
    const fragment = { ...message, text: message.text.slice(offset), char_offset: offset, complete: true }
    page.messages.push(fragment)
    page.next_cursor = token(index + 1, 0)
    if (fits()) { index++; offset = 0; continue }
    fragment.complete = false
    let low = 0
    let high = message.text.length - offset
    while (low < high) {
      const length = Math.ceil((low + high) / 2)
      fragment.text = message.text.slice(offset, offset + length)
      page.next_cursor = token(index, offset + length)
      if (fits()) low = length
      else high = length - 1
    }
    if (low > 0 && /[\uD800-\uDBFF]/u.test(message.text[offset + low - 1])) low--
    if (low === 0) {
      page.messages.pop()
      page.next_cursor = token(index, offset)
      if (page.messages.length === 0) throw new RelayError('OUTPUT_LIMIT', 'max_chars cannot fit a message fragment and cursor')
    } else {
      fragment.text = message.text.slice(offset, offset + low)
      page.next_cursor = token(index, offset + low)
    }
    break
  }
  return page
}
