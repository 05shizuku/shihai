/**
 * tools/preview.mjs —— 只读预览：拿真实账本，用**现在的算法**把几段渲染出来
 *
 *   node tools/preview.mjs                 # 默认看 <DSH_HOME>/.dsh-remember/memory.json
 *   node tools/preview.mjs <path.json>     # 或指定一本账
 *
 * 它只读、只渲染：不写文件、不动运行中的实例。用途是「重启之前先看一眼
 * 开头会变成什么样」——尤其是新加的【我】【好奇】那两段还没在真机上挂过的时候。
 *
 * 用 namespace import：核心那边要是还没写完某个导出（renderCuriositySection 之类），
 * 这里就少打一段，不炸 —— 预览是给人看的，不该因为半路缺个函数就整个跑不起来。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import * as memory from '../lib/memory.js'
import { resolveDshHome } from '../lib/store.js'

const {
  KIND_LABEL,
  activeSelfNodes,
  fastHabits,
  normNodes,
  renderHabitSection,
  renderSection,
  renderSelfSection,
  slotLabel,
  summaryOf,
} = memory

const renderCuriositySection = typeof memory.renderCuriositySection === 'function' ? memory.renderCuriositySection : null
const curiosityStats = typeof memory.curiosityStats === 'function' ? memory.curiosityStats : null

const file = process.argv[2] || join(resolveDshHome(), '.dsh-remember', 'memory.json')

let raw
try {
  raw = JSON.parse(readFileSync(file, 'utf8'))
} catch (err) {
  console.error(`读不了这本账：${file}\n  ${String(err?.message ?? err)}`)
  process.exit(1)
}

// 配置也读一份（跟账本同目录）：上限、字数照实际配置走，不写死。
// 读不到就用默认值——预览是给人看的，不该因为少个配置就整个跑不起来。
let cfg = {}
try {
  const cfgFile = join(dirname(file), 'config.json')
  const parsed = JSON.parse(readFileSync(cfgFile, 'utf8'))
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed
} catch {
  cfg = {}
}
const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const curiosityLimit = numOr(cfg.curiosityLimit, 3)
const curiosityMaxChars = numOr(cfg.curiosityMaxChars, 320)
const habitLimit = numOr(cfg.habitLimit, 3)
const habitMaxChars = numOr(cfg.habitMaxChars, 320)

const now = Date.now()
const nodes = normNodes(raw.nodes ?? [], now)
const s = summaryOf(nodes, now)

console.log(`账本：${file}`)
console.log(`一共 ${s.total} 条（活着 ${s.alive}，按住 ${s.sealed}，想过三问 ${s.thought}）；最高的分值 ${s.topScore}`)
console.log(
  `分类：${Object.entries(s.kinds)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`)
    .join('、')}`,
)
console.log('')
console.log('———— 按现在的算法，开头会长成这样 ————')
console.log('')
console.log(renderSelfSection(nodes, { now }) || '【我】（还空着：还没有答过三问的自我条）')
console.log('')
console.log(
  renderCuriositySection
    ? renderCuriositySection(nodes, { now, limit: curiosityLimit, maxChars: curiosityMaxChars }) ||
      '【好奇】（还空着：还没有答了三问、还没解答的好奇）'
    : '【好奇】（核心还没写完 renderCuriositySection，这一段暂时看不到）',
)
console.log('')
console.log(renderHabitSection(nodes, { now }) || '【习惯】（还空着：还没有习惯走到快通路）')
console.log('')
console.log(renderSection(nodes, { now }) || '【我记得的】（还空着）')
console.log('')

const self = activeSelfNodes(nodes, now)
if (self.length) {
  console.log('此刻自称的：')
  for (const n of self) console.log(`· ${slotLabel(n.slot)}：${n.text}`)
} else {
  console.log('此刻还没有自我条在自称。')
}

if (curiosityStats) {
  const cs = curiosityStats(nodes, now, { limit: curiosityLimit })
  console.log('')
  console.log(
    `现在好奇的：活跃 ${cs.active} 条（挂上头的 ${cs.list.length} 条，上限 ${cs.limit} 条）· ` +
      `还没答三问 ${cs.thinking} 条 · 已解答 ${cs.answered} 条 · 一共 ${cs.total} 条`,
  )
  if (cs.list.length) {
    for (const x of cs.list) {
      const times = x.hits > 1 ? `（惦记 ${x.hits} 次）` : ''
      const next = x.next ? `→ ${x.next}` : ''
      console.log(`· ${x.topic}：${x.text}${times}${next}`)
    }
  }
  console.log('（上限 ' + cs.limit + ' 条，超出的沉在账本里，翻得到）')
} else {
  console.log('')
  console.log('核心还没写完 curiosityStats，好奇表暂时看不到。')
}

const fast = fastHabits(nodes, now, { limit: habitLimit })
if (fast.length) {
  console.log('')
  console.log('走快通路的习惯：')
  for (const n of fast) console.log(`· ${n.context}：${n.text}（第 ${n.hits} 次）`)
}
