// lib/sources/doubao.mjs — 豆包桌面版（Doubao Desktop）会话库定位、读取与导入编排（host 面）
//
// 库不是单一文件，而是 Chromium IndexedDB 的一个 LevelDB **目录**：
//   %LOCALAPPDATA%\Doubao\User Data\<profile>\IndexedDB\chrome_doubao-chat_0.indexeddb
//     .leveldb\          （Windows；macOS / Linux 见 doubaoUserDataDirs）
//
// 目录名的 `<origin>_0.indexeddb.leveldb` 由 Chromium 的 origin 标识派生：豆包主聊天窗口
// 是 `chrome_doubao-chat`，另有 `chrome_doubao-background` / `-launcher` / `-text-picker`
// 等辅助窗口。会话正文只在 **chat** 那个库里（实测：background 库只有权限/配置缓存），
// 因此定位时认 chat 库，但名字不写死——见 `doubaoIndexedDbDirs`。
//
// `%APPDATA%\Doubao` 只放 public_config.json 一类的启动配置，没有会话数据。
//
// 读取（lib/sources/chromium-indexeddb.mjs）做了三层解码；本模块负责：
//   • 定位数据根 / profile / IndexedDB 目录；
//   • 拼接会话摘要（发现层用，便宜路径只解协议存储）；
//   • 逐会话导入（沿用 importMultiSource 的状态机：库指纹短路径、增量续写、另存副本）
//     与 dry-run 预览。
//
// 失败要大声（docs/architecture.md D4）：解不开的记录逐条计数并由结果携带；一个会话都没有
// 时抛带原因的错，不返回空成功。
import { join } from 'node:path'
import { readIndexedDb, levelDbFingerprint, levelDbFiles } from './chromium-indexeddb.mjs'
import { extractDoubaoSessions, convertDoubaoSession } from '../convert/doubao.mjs'
import { importMultiSource, convertSessionItems, previewSessionSet, selectionSet } from '../import-core.mjs'
import { sessionSelection } from '../import-state.mjs'
import { normalizeTitle } from '../convert/util.mjs'

/** Chromium IndexedDB 目录名后缀。 */
export const DOUBAO_IDB_SUFFIX = '.indexeddb.leveldb'

/** 主聊天窗口的 IndexedDB 前缀（会话正文所在）。 */
export const DOUBAO_CHAT_ORIGIN = 'chrome_doubao-chat'

/**
 * 豆包的用户数据根候选（每个根下还有 profile 目录）。
 * Windows：`%LOCALAPPDATA%\Doubao\User Data`；macOS / Linux 按 Electron 的默认 appData 位置。
 */
export function doubaoUserDataDirs(home, env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : null)
    if (!local) return []
    return [join(local, 'Doubao', 'User Data')]
  }
  if (platform === 'darwin') {
    return home ? [join(home, 'Library', 'Application Support', 'Doubao')] : []
  }
  return home ? [join(home, '.config', 'Doubao')] : []
}

/**
 * 在用户数据根下枚举候选 IndexedDB 目录（按 chat 优先）。
 * 结构：`<root>/<profile>/IndexedDB/<origin>_0.indexeddb.leveldb/`。
 * profile 名不定（`Default`、`aha/users/<id>/profile_explorer` …），所以按目录名匹配，
 * 不写死 profile。`originPrefix` 为空时匹配全部 IndexedDB 目录。
 */
export function doubaoIndexedDbDirs(entries, originPrefix = DOUBAO_CHAT_ORIGIN) {
  const dirs = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = entry && (entry.path || entry.name)
    if (!path) continue
    const base = String(entry.name ?? String(path).split(/[\\/]/).pop())
    if (!base.endsWith(DOUBAO_IDB_SUFFIX)) continue
    if (originPrefix && !base.startsWith(originPrefix)) continue
    dirs.push({ path, name: base })
  }
  // chat 库排最前：它才是会话正文所在，别的窗口库只在 chat 缺席时兜底。
  // 按**目录名**排，不看路径（路径只有末段是库名，其余部分与窗口无关）。
  dirs.sort((a, b) => Number(!a.name.startsWith(DOUBAO_CHAT_ORIGIN)) - Number(!b.name.startsWith(DOUBAO_CHAT_ORIGIN)))
  return dirs.map((d) => d.path)
}

/**
 * 从一个目标路径（用户数据根 / profile / IndexedDB 目录 / 具体库目录）解析出库目录。
 * host = { stat, readDir }（与发现层同形）。
 */
export async function findDoubaoDatabases(host, target) {
  const st = await host.stat(target)
  if (!st) return []
  if (st.type === 'file') return []
  const base = String(target).split(/[\\/]/).filter(Boolean).pop() || ''
  // 直接给了某个库目录
  if (base.endsWith(DOUBAO_IDB_SUFFIX)) {
    const files = levelDbFiles(target)
    return files.length > 0 ? [target] : []
  }
  // 给了 IndexedDB 目录：枚举其中的库
  if (base === 'IndexedDB') {
    const entries = await host.readDir(target)
    const dirs = doubaoIndexedDbDirs(entries)
    return filterExisting(host, dirs)
  }
  const found = []
  const seen = new Set()
  const pushDirs = async (dirs) => {
    for (const dir of await filterExisting(host, dirs)) {
      if (!seen.has(dir)) {
        seen.add(dir)
        found.push(dir)
      }
    }
  }
  // 给了 profile 或用户数据根：向下最多两层找 IndexedDB
  const idbChildren = await idbDirsUnder(host, target, 0)
  await pushDirs(idbChildren)
  return found
}

// 向下找 IndexedDB 目录（最多两层：<root>/<profile>/IndexedDB）
async function idbDirsUnder(host, dir, depth) {
  if (depth > 2) return []
  const entries = await host.readDir(dir)
  if (!entries) return []
  const out = []
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const path = entry.path || join(dir, entry.name)
    if (entry.name === 'IndexedDB') {
      out.push(...doubaoIndexedDbDirs(await host.readDir(path) ?? []))
      continue
    }
    out.push(...await idbDirsUnder(host, path, depth + 1))
  }
  return out
}

async function filterExisting(host, dirs) {
  const out = []
  for (const dir of dirs) {
    const st = await host.stat(dir)
    if (st && st.type === 'directory' && levelDbFiles(dir).length > 0) out.push(dir)
  }
  return out
}

/** 把 ctx.fs 适配成 findDoubaoDatabases 需要的 host 形状。 */
export function doubaoHostOf(ctx) {
  return {
    async stat(candidate) {
      try {
        const result = await ctx.fs.stat(await ctx.fs.resolve(candidate))
        return result ? { type: result.type } : null
      } catch {
        return null
      }
    },
    async readDir(candidate) {
      try {
        const entries = await ctx.fs.listDir(await ctx.fs.resolve(candidate))
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.type,
          path: entry.target && (entry.target.displayPath || entry.target.targetKey),
        }))
      } catch {
        return null
      }
    },
  }
}

/** 读一个豆包库目录 → 中间会话数组（读不到 / 不是这个库 → null，由调用方决定怎么报）。 */
export function readDoubaoDb(dir) {
  let db
  try {
    db = readIndexedDb(dir)
  } catch {
    return null
  }
  if (!db || db.rawCount === 0) return null
  const { sessions, stats } = extractDoubaoSessions(db)
  return { sessions, stats, undecodable: db.undecodable, rawCount: db.rawCount }
}

const NOT_DOUBAO_DB = '不是豆包会话库（没有可解码的 IndexedDB 记录）: '

function readDoubaoDbOrThrow(dir) {
  const read = readDoubaoDb(dir)
  if (!read) throw new Error(NOT_DOUBAO_DB + dir)
  return read
}

/** 会话摘要（发现层用）：只有本地确实有正文的会话才列出，与导入口径一致。 */
export function readDoubaoSessionSummaries(dir) {
  const read = readDoubaoDb(dir)
  if (!read) return null
  return read.sessions.map((session) => ({
    id: session.id,
    title: normalizeTitle(session.title),
    directory: null,
    createdAt: session.createdAt ?? undefined,
    lastActiveAt: session.updatedAt ?? session.createdAt ?? undefined,
  }))
}

const doubaoConvertOne = (args, path) => (session) => convertDoubaoSession(session, { ...args, sourcePath: path })

// 一个会话都没有时点名原因：解不开的记录数 + 库路径，别让用户对着一句「成功了但 0 条」猜。
function assertHasSessions(read, dir) {
  if (read.sessions.length > 0) return
  const details = read.undecodable > 0 ? `，${read.undecodable} 条记录解不开` : ''
  throw new Error(
    `豆包库里没有可导入的会话正文（本地只缓存最近打开过的对话）: ${dir}${details}`,
  )
}

/** 导入一个豆包库目录：每个会话独立落盘（一库多会话，恒批量形态）。 */
export async function importDoubaoDirectory(ctx, dirTarget, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const selection = sessionSelection(args)
  return importMultiSource(ctx, dirTarget, args, {
    registryDir,
    persisted,
    fingerprintKeys,
    selection,
    importFormat: 'doubao',
    load: (path) => {
      const read = readDoubaoDbOrThrow(path)
      assertHasSessions(read, path)
      return convertSessionItems(ctx, read.sessions, {
        path,
        args,
        wanted: selectionSet(selection),
        sourceLabel: 'Doubao',
        convertOne: doubaoConvertOne(args, path),
      })
    },
  })
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

export async function previewDoubaoDirectory(ctx, dirTarget, args) {
  const path = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const read = readDoubaoDbOrThrow(path)
  assertHasSessions(read, path)
  const results = previewSessionSet(read.sessions, {
    path,
    args,
    wanted: selectionSet(sessionSelection(args)),
    sourceLabel: 'Doubao',
    convertOne: doubaoConvertOne(args, path),
  })
  return { total: read.sessions.length, results }
}

/**
 * 库指纹（导入层用）：LevelDB 会轮换文件名，只 stat 目录看不出内容变化 →
 * 逐文件 size + mtime。写进 registry 的 `walSig` 位（与 SQLite 源的 WAL 同位）。
 */
export function doubaoFingerprint(dir) {
  return levelDbFingerprint(dir)
}
