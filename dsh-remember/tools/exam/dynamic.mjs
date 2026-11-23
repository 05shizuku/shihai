// 保鲜度考卷（dynamic exam v1，2026-11-23）：
//   node tools/exam/dynamic.mjs [--hours 72] [--json]
// 灵感：回声的动态自检（尔水青禾/回声 2026-11-22 群讨论）——「按当前会话出题，换会话后答，
//   差值 = 账本价值」。识海版适配：识海侧没有上下文压缩环节（那是万卷的事），本卷测的是
//   「最近写入的账，纯检索能补回多少」——短期保鲜度，与冻结卷（长期存量）互补。
// 纪律：题随账长，每次跑题都不同——**不可冻结、不可用于调参**（跑分可比性靠分池结构）。
// 出题（纯规则，不上模型）：对最近 N 小时写入的节点（at ≥ now-Nh，排除 sealed），
//   取 text 中段特征片段（去日期/括号前缀后，在 30%–70% 位置滑窗选「标点最少」的
//   8–16 字窗）作查询——题面是账文原样片段，测「片段回查」：记得半句话，能不能翻回那条。
//   节点 <12 字或全标点跳过。
// 负题：复用 frozen.jsonl 的负题（账本里没有的事，天然保鲜卷负题；NEG_FLOOR/MIN_RELEVANCE 同款）。
// 分池：正题按写入距今分 0–24h / 24–48h / 48–72h 三池，各算 R@5 / MRR@5——
//   三池落差 = 新账衰减曲线的第一段（激活度「分量淡」路的实测形状）。
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rankByQuery, MIN_RELEVANCE } from '../../../core/search.js'
import { isSealed } from '../../../core/memory.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const dshHome = process.env.SHIHAI_HOME || process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
const file = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : join(dshHome, '.dsh-remember', 'memory.json')
const hoursArg = process.argv.includes('--hours') ? Number(process.argv[process.argv.indexOf('--hours') + 1]) : 72
const hours = Number.isFinite(hoursArg) && hoursArg > 1 ? hoursArg : 72
const asJson = process.argv.includes('--json')

const raw = JSON.parse(readFileSync(file, 'utf8'))
const nodes = (Array.isArray(raw) ? raw : raw.nodes ?? []).filter((n) => n && !isSealed(n, Date.now()))

const now = Date.now()
const windowStart = now - hours * 3600e3
const fresh = nodes.filter((n) => Number(n.at) >= windowStart)

/** 从账文里挑一段「标点最少的 8–16 字中段窗」作查询片段；挑不出返回 null。 */
function pickSnippet(text) {
  const clean = String(text ?? '')
    .replace(/^[【\[（(][^】\]）)]*[】\]）)]/, '')
    .replace(/^\d{4}-\d{2}-\d{2}[^：:]*[：:]/, '')
    .trim()
  if (clean.length < 12) return null
  const start = Math.floor(clean.length * 0.3)
  const end = Math.min(Math.floor(clean.length * 0.7), clean.length - 12)
  let best = null
  let bestScore = -1
  for (let s = start; s <= end; s++) {
    const win = clean.slice(s, s + 14)
    const punct = (win.match(/[，。、；：！？「」（）()【】\[\]\s—…·]/g) || []).length
    const score = win.length - punct * 3
    if (score > bestScore) { bestScore = score; best = win }
  }
  return bestScore >= 10 ? best.trim() : null
}

const POOLS = [
  { name: '0-24h', min: 0, max: 24 * 3600e3 },
  { name: '24-48h', min: 24 * 3600e3, max: 48 * 3600e3 },
  { name: '48-72h', min: 48 * 3600e3, max: 72 * 3600e3 },
]
const H = hours * 3600e3
const pools = POOLS.filter((p) => p.max <= H)
if (pools.length && pools[pools.length - 1].max < H) pools[pools.length - 1] = { ...pools[pools.length - 1], max: H }

const poolOf = (n) => {
  const age = now - Number(n.at)
  return pools.find((p) => age >= p.min && age < p.max) ?? null
}

const stats = new Map(pools.map((p) => [p.name, { total: 0, hit: 0, mrrSum: 0 }]))
const rows = []
let skipped = 0
for (const n of fresh) {
  const pool = poolOf(n)
  if (!pool) { skipped += 1; continue }
  const q = pickSnippet(n.text)
  if (!q) { skipped += 1; continue }
  const ranked = [...rankByQuery(nodes, q).entries()].sort((a, b) => b[1].relevance - a[1].relevance)
  const hitIdx = ranked.slice(0, 5).findIndex(([m]) => m.id === n.id)
  const hit = hitIdx >= 0
  const s = stats.get(pool.name)
  s.total += 1
  if (hit) { s.hit += 1; s.mrrSum += 1 / (hitIdx + 1) }
  rows.push(`${hit ? '✔' : '✗'} [${pool.name}] 「${q}」→ 期望 ${n.id} ${hit ? `（第 ${hitIdx + 1} 位）` : `（未进前五）`}`)
}

// 负题：复用冻结集（账本里没有的事）
const NEG_FLOOR = 0.5
const frozen = readFileSync(join(HERE, 'frozen.jsonl'), 'utf8')
  .split(/\r?\n/).filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((c) => c && c.neg)
let negHits = 0
for (const c of frozen) {
  const ranked = [...rankByQuery(nodes, c.q).entries()]
    .filter(([, r]) => r.relevance >= MIN_RELEVANCE)
    .sort((a, b) => b[1].relevance - a[1].relevance)
  const over = ranked.filter(([, r]) => r.relevance >= NEG_FLOOR)
  const pass = over.length === 0
  if (!pass) negHits += 1
  rows.push(`${pass ? '✔' : '✗'} [负题·借冻结卷] ${c.q} → ${pass ? '正确沉默' : `不该命中：${ranked.slice(0, 3).map(([n, r]) => `${n.id}(${r.relevance.toFixed(3)})`).join(' ')}`}`)
}

const poolOut = pools.map((p) => {
  const s = stats.get(p.name)
  return { pool: p.name, total: s.total, recallAt5: s.total ? Number((s.hit / s.total).toFixed(3)) : null, mrrAt5: s.total ? Number((s.mrrSum / s.total).toFixed(3)) : null }
})
const allPos = poolOut.reduce((a, p) => a + p.total, 0)
const allHit = poolOut.reduce((a, p) => a + (p.recallAt5 ?? 0) * p.total, 0)
const summary = {
  suite: 'dynamic-freshness',
  windowHours: hours,
  ledger: nodes.length,
  freshNodes: fresh.length,
  questions: allPos,
  skipped,
  pools: poolOut,
  overallRecallAt5: allPos ? Number((allHit / allPos).toFixed(3)) : null,
  negativeHits: negHits,
  negativeTotal: frozen.length,
  discipline: '题随账长不可冻结，不可用于调参',
}

if (asJson) {
  console.log(JSON.stringify({ ...summary, rows }, null, 2))
} else {
  console.log(`保鲜度考卷 · 窗口 ${hours}h · 账本 ${nodes.length} 条（窗口内 ${fresh.length}，出题 ${allPos}，跳过 ${skipped}）`)
  for (const p of poolOut) console.log(`  ${p.pool}: R@5 ${p.total ? `${p.recallAt5}（${Math.round((p.recallAt5 ?? 0) * p.total)}/${p.total}）` : '无题'} · MRR ${p.mrrAt5 ?? '—'}`)
  console.log(`  总体 R@5 = ${summary.overallRecallAt5 ?? '—'} · 负题命中 = ${negHits}/${frozen.length}（必须 0）`)
  for (const r of rows) console.log(r)
}
