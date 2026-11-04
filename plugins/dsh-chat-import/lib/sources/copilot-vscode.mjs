// Copilot host IO: workspace metadata is beside chatSessions, outside the
// transcript. Conversation parsing stays in the pure converter.
import { collectFiles } from '../import-batch.mjs'
import { copilotVscodeCwd } from '../convert/copilot-vscode.mjs'

export function copilotVscodeWorkspacePath(path) {
  const match = String(path).match(/^(.*)[\\/]chatSessions[\\/][^\\/]+\.json$/i)
  if (!match) return null
  const sep = match[1].includes('\\') ? '\\' : '/'
  return match[1] + sep + 'workspace.json'
}

export function readCopilotVscodeWorkspace(raw) {
  try { return copilotVscodeCwd(JSON.parse(raw)?.folder) } catch { return null }
}

export async function copilotVscodeDeriveArgs(ctx, target) {
  const path = target.displayPath || target.targetKey
  const workspace = copilotVscodeWorkspacePath(path)
  if (!workspace) return {}
  try {
    const cwd = readCopilotVscodeWorkspace(await ctx.fs.readText(await ctx.fs.resolve(workspace)))
    return cwd ? { cwd } : {}
  } catch {
    // A copied session or an untitled/multi-root workspace has no single
    // folder sidecar. The shared importer chooses its usual destination.
    return {}
  }
}

export function collectCopilotVscodeFiles(ctx, target, out, recursive) {
  return collectFiles(ctx, target, out, recursive, (entry) =>
    /[\\/]chatSessions[\\/][^\\/]+\.json$/i.test(entry.target.displayPath || entry.target.targetKey))
}
