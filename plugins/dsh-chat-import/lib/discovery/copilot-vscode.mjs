import { copilotVscodeMetadata, readCopilotVscodeSession } from '../convert/copilot-vscode.mjs'
import { isAbsoluteLike, joinForPlatform } from '../convert/util.mjs'
import { copilotVscodeWorkspacePath, readCopilotVscodeWorkspace } from '../sources/copilot-vscode.mjs'
import { fileFingerprint, projectFromRecord, makeEntry, emitEach } from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

export function copilotVscodeRoots(home, env = {}, platform = process.platform) {
  if (isAbsoluteLike(env.COPILOT_VSCODE_STORAGE_DIR || '')) return [env.COPILOT_VSCODE_STORAGE_DIR]
  const path = (...parts) => joinForPlatform(platform, ...parts)
  let base
  if (platform === 'win32') base = env.APPDATA || path(home, 'AppData', 'Roaming')
  else if (platform === 'darwin') base = path(home, 'Library', 'Application Support')
  else base = isAbsoluteLike(env.XDG_CONFIG_HOME || '') ? env.XDG_CONFIG_HOME : path(home, '.config')
  return ['Code', 'Code - Insiders', 'VSCodium'].map((name) => path(base, name, 'User', 'workspaceStorage'))
}

async function scanCopilotVscode(host, target, { bm, emit }) {
  const st = await host.stat(target)
  if (!st) return []
  const files = []
  await walkFiles(host, target, files, (name) => /\.json$/i.test(name))
  const out = []
  for (const file of files) {
    if (st.type !== 'file' && !/[\\/]chatSessions[\\/][^\\/]+\.json$/i.test(file.path)) continue
    const fst = await host.stat(file.path)
    if (!fst) continue
    const workspacePath = copilotVscodeWorkspacePath(file.path)
    // Read the small workspace hint outside the transcript bookmark so a
    // moved workspace is reflected even when the conversation is unchanged.
    const workspace = workspacePath ? readCopilotVscodeWorkspace(await host.readText(workspacePath)) : null
    const entries = await probeSource(bm, 'copilot-vscode', file.path, fileFingerprint(fst), async () => {
      const session = readCopilotVscodeSession(await host.readText(file.path))
      if (!session || !session.requests.length) return []
      const info = copilotVscodeMetadata(session)
      return [makeEntry({
        format: 'copilot-vscode', sessionId: info.id, title: info.title,
        cwd: info.cwd, project: projectFromRecord(info.cwd, () => null),
        createdAt: info.createdAt, lastActiveAt: info.lastActiveAt ?? fst.mtimeMs,
        sourcePath: file.path,
      })]
    })
    const annotated = entries.map((entry) => {
      const cwd = entry.cwd || workspace
      return cwd ? { ...entry, cwd, project: projectFromRecord(cwd, () => null) } : entry
    })
    out.push(...annotated)
    await emitEach(emit, annotated)
  }
  return out
}

export const copilotVscodeSource = {
  format: 'copilot-vscode',
  roots: copilotVscodeRoots,
  scan: scanCopilotVscode,
  matchFile: (lower) => /[\\/]chatsessions[\\/][^\\/]+\.json$/.test(lower) ? 'only' : false,
  fileFallback: ['json'],
}
