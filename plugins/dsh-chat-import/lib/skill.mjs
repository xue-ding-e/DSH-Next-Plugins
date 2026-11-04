// lib/skill.mjs — docs/ 下的指南注册为宿主运行时 skill（可选服务，缺席跳过）
//
// 两个 skill，各自的内容单一事实源都在 docs/（npm 包 files 含 docs/*.md），注册时读入：
//   dsh-chat-import-convert  docs/INTERCHANGE-GUIDE.md  文件识别失败后的转换出路
//   dsh-chat-import-usage    docs/IMPORT-GUIDE.md       import_chat 的长文说明
//
// usage 这条是为常驻成本服务的：工具 schema 只留「调用必需」（format 枚举、必填 path、
// 一行参数说明），29 个来源的 path 形状表与参数长文搬进指南——schema 是每轮都要付的钱，
// skill 正文只在真要看的时候付一次（常驻成本护栏见 test/tools-injection.test.mjs，
// 指南与代码的对账见 test/import-guide.test.mjs）。
//
// skills 是可选 host 服务（旧宿主 / headless profile 可能没有），入口经
// ctx.inject(['skills'], …) 延迟注册——与 webServer 同一姿势：服务永不就绪时回调不执行，
// 导入功能不受影响（schema 里仍有一行参数说明与完整枚举，模型照常能调用 import_chat）。
//
// 内容读不到时记警告并跳过注册（失败要大声，不静默）。resourceBase 指到 docs/ 目录：
// 指南里的相对链接由消费方按目录解析。

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 转换指南 skill 名（kebab-case；任务模板与文档里点名它，改名三处同步）。 */
export const CONVERT_SKILL_NAME = 'dsh-chat-import-convert'

/** import_chat 长文说明 skill 名（import_chat 的 schema 里点名它，改名两处同步）。 */
export const USAGE_SKILL_NAME = 'dsh-chat-import-usage'

const CONVERT_GUIDE_FILE = new URL('../docs/INTERCHANGE-GUIDE.md', import.meta.url)
const USAGE_GUIDE_FILE = new URL('../docs/IMPORT-GUIDE.md', import.meta.url)

// 组装 skill 定义（纯函数，便于测试）：content 空时返回 null（调用方跳过注册）。
function buildGuideSkill(name, description, whenToUse, guideFile, content) {
  if (typeof content !== 'string' || !content.trim()) return null
  return {
    name,
    description,
    whenToUse,
    source: 'runtime',
    content,
    resourceBase: { kind: 'directory', path: dirname(fileURLToPath(guideFile)) },
  }
}

export function buildConvertSkill(content) {
  return buildGuideSkill(
    CONVERT_SKILL_NAME,
    'Convert any external chat transcript into an importable dsh-chat-import interchange v1 JSON document（把任意对话记录转成可导入的 interchange v1 文档）。',
    '文件导入提示「所有对话格式解析器全部解析失败」时使用；user pastes a failure summary asking to convert a transcript.',
    CONVERT_GUIDE_FILE,
    content,
  )
}

export function buildUsageSkill(content) {
  return buildGuideSkill(
    USAGE_SKILL_NAME,
    'Format table (path shape of all sources), parameter semantics and re-import rules for the import_chat tool（import_chat 的来源格式表、参数语义与重导规则）。',
    '准备调用 import_chat、或不确定某来源的数据放在哪 / 某参数怎么用 / 重导会怎样时使用；about to import a transcript, or unsure where a source keeps its data.',
    USAGE_GUIDE_FILE,
    content,
  )
}

// 读指南 → 组装 → 注册；读不到或内容为空只警告（面板 / 命令 / 工具不依赖 skill）。
function registerGuide(build, guideFile, label, skills, readFile) {
  const read = readFile || ((p) => readFileSync(p, 'utf8'))
  let content
  try {
    content = read(fileURLToPath(guideFile))
  } catch (err) {
    console.warn('[dsh-chat-import] ' + label + '读取失败，跳过 skill 注册：' + String((err && err.message) || err))
    return undefined
  }
  const skill = build(content)
  if (!skill) {
    console.warn('[dsh-chat-import] ' + label + '内容为空，跳过 skill 注册')
    return undefined
  }
  return skills.register(skill)
}

// 注册进 ctx 所在层（全局层）：技能目录对宿主内所有 agent 可见。
export function registerConvertSkill(ctx, skills, { readFile } = {}) {
  return registerGuide(buildConvertSkill, CONVERT_GUIDE_FILE, '转换指南', skills, readFile)
}

export function registerUsageSkill(ctx, skills, { readFile } = {}) {
  return registerGuide(buildUsageSkill, USAGE_GUIDE_FILE, '导入指南', skills, readFile)
}
