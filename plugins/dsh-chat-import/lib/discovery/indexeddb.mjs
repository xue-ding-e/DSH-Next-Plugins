// lib/discovery/indexeddb.mjs — Chromium IndexedDB 族的发现：豆包桌面版
//
// 账号级来源里唯一不落在单个文件上的一个：库是 `<User Data>/<profile>/IndexedDB/
// chrome_doubao-chat_0.indexeddb.leveldb/` 这个 **LevelDB 目录**（一堆 .ldb/.log 文件）。
// 因此扫描单位是「目录」，指纹取目录内全部文件的 size+mtime 复合签名（LevelDB 会轮换
// 文件名，只 stat 目录看不出内容变化），命中的会话摘要经 host.readSessions 取（读取器在
// lib/sources/doubao.mjs，摘要与导入口径一致：只列本地确实有正文的会话）。

import { join } from 'node:path'
import { doubaoUserDataDirs, doubaoIndexedDbDirs, DOUBAO_IDB_SUFFIX } from '../sources/doubao.mjs'
import { normalizeTitle } from '../convert/util.mjs'
import { makeEntry, emitEach } from './common.mjs'
import { probeSource } from './scan-cache.mjs'

// 库目录指纹：目录内每个 LevelDB 文件的 name:size:mtime，用 | 连接（与 compositeFingerprint
// 同思路，但文件名清单本身就是签名的一部分）。读不到目录返回空串——空签名与「库被删」等价，
// 书签失效后重扫。
async function indexedDbFingerprint(host, dir) {
  const entries = await host.readDir(dir)
  if (!entries) return ''
  const parts = []
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const name = entry.name
    if (!name.endsWith('.ldb') && !name.endsWith('.log')) continue
    const path = entry.path || join(dir, name)
    const st = await host.stat(path)
    parts.push(name + ':' + (st ? String(st.size ?? '') + ':' + String(st.mtimeMs ?? '') : '?'))
  }
  return parts.sort().join('|')
}

// 目标（用户数据根 / profile / IndexedDB 目录 / 具体库目录）→ 库目录列表。
// 走 lib/sources/doubao.mjs 的定位逻辑，补上扫描器需要的 readDir(name/path/type) 形状。
async function doubaoDbDirs(host, target) {
  const st = await host.stat(target)
  if (!st) return []
  if (st.type === 'file') return []
  const base = String(target).split(/[\\/]/).filter(Boolean).pop() || ''
  if (base.endsWith(DOUBAO_IDB_SUFFIX)) return [target]
  if (base === 'IndexedDB') return doubaoIndexedDbDirs(await listChildren(host, target))
  // 用户数据根 / profile：向下最多两层找 IndexedDB
  const out = []
  const walk = async (dir, depth) => {
    if (depth > 2) return
    const entries = await listChildren(host, dir)
    for (const entry of entries) {
      if (entry.type !== 'directory') continue
      const path = entry.path || join(dir, entry.name)
      if (entry.name === 'IndexedDB') {
        out.push(...doubaoIndexedDbDirs(await listChildren(host, path)))
        continue
      }
      await walk(path, depth + 1)
    }
  }
  await walk(target, 0)
  return out
}

async function listChildren(host, dir) {
  const entries = await host.readDir(dir)
  if (!entries) return []
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.type,
    path: entry.path || join(dir, entry.name),
  }))
}

async function scanDoubao(host, target, { bm, emit }) {
  const dirs = await doubaoDbDirs(host, target)
  const out = []
  for (const dir of dirs) {
    const dirStat = await host.stat(dir)
    if (!dirStat) continue
    const fp = { mtimeMs: await indexedDbFingerprint(host, dir), sizeBytes: 0 }
    const entries = await probeSource(bm, 'doubao', dir, fp, async () => {
      const sessions = await host.readSessions('doubao', dir)
      if (!sessions) return []
      return sessions.map((s) => makeEntry({
        format: 'doubao',
        sessionId: s.id,
        title: normalizeTitle(s.title),
        project: null,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        sourcePath: dir,
        cwd: null,
      }))
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// ── 来源描述符（注册与顺序见 ./registry.mjs；字段契约见该文件头）──────────────

export const doubaoSource = {
  format: 'doubao',
  // 摘要读取器在 host 侧（lib/discovery-host.mjs 的 DB_SUMMARY_FORMATS）
  sessionsFromHost: true,
  // 默认根：Windows %LOCALAPPDATA%\Doubao\User Data；macOS/Linux 按 Electron 默认 appData
  roots: (home, env) => doubaoUserDataDirs(home, env),
  scan: scanDoubao,
  // 单文件形态不存在（库是目录），所以不给 matchFile / fileFallback：显式传某库目录或
  // IndexedDB 目录即可发现。
}
