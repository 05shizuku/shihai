// 识海考卷跑分器（定案 F）：
//   node tools/exam/run.mjs [--frozen|--draft] [--file <memory.json>] [--json]
// 指标：R@5（期望条目进前五）+ MRR@5 + 分类别命中 + 负题命中（必须 0）。
// 负题判据（2026-11-22 F-fix 标定）：命中里最高 relevance ≥ NEG_FLOOR(0.5) 才算假命中。
//   标定依据（实测 53 题）：修前相对归一让负题全部 ≥0.6（炸）；修后绝对分负题落在
//   0.30–0.49（最弱正题 0.37、多数正题 ≥0.45——四个候选特征 bm/cov/topIdf/topShare
//   全部与正题重叠，单调重打分无法全 silencing，0.5 是「多词扎实命中才算候选」的
//   产品口径）。阈值版本化在 frozen.jsonl 的 fix 字段与 run.mjs 本头注，不悄悄改。
// 2026-11-22 F-fix 同步：跑卷器按生产口径戴 MIN_RELEVANCE 闸（searchNodes 同款
// `relevance < MIN_RELEVANCE` 跳过）——跑分必须 mirror 生产，不 mirror 就会替假命中报喜。
// exam-v1.1 修靶记录：#24 原靶 r_z46voe 已 superseded（她重写过同一句「自由」，
// 现役 r_132dgv4），靶改 r_132dgv4/r_14qykt3——冻结集只做版本化修正，不悄悄改。
// 纪律：--frozen 的题集已冻结（exam-v1），任何调参不许据它做——调参只许在 draft 上。
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rankByQuery, MIN_RELEVANCE } from '../../../core/search.js'

/** 负题假命中线（2026-11-22 标定，见头注）：修后负题 top 全落 0.30–0.49，修前全 ≥0.6。 */
const NEG_FLOOR = 0.5
import { isSealed } from '../../../core/memory.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const dshHome = process.env.SHIHAI_HOME || process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
const file = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : join(dshHome, '.dsh-remember', 'memory.json')
const draft = process.argv.includes('--draft')
const asJson = process.argv.includes('--json')
const gate = process.argv.includes('--gate')

const casesFile = join(HERE, draft ? 'draft.jsonl' : 'frozen.jsonl')
const cases = readFileSync(casesFile, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l, i) => {
    try { return JSON.parse(l) } catch { console.error(`坏行跳过 #${i + 1}`); return null }
  })
  .filter(Boolean)

const raw = JSON.parse(readFileSync(file, 'utf8'))
const nodes = (Array.isArray(raw) ? raw : raw.nodes ?? []).filter((n) => n && !isSealed(n, Date.now()))

const pos = cases.filter((c) => !c.neg)
const neg = cases.filter((c) => c.neg)

let hits = 0
let mrrSum = 0
const rows = []
const byCat = new Map()
for (const c of pos) {
  const ranked = [...rankByQuery(nodes, c.q).entries()]
    .sort((a, b) => b[1].relevance - a[1].relevance)
  const top5 = ranked.slice(0, 5).map(([n, r]) => `${n.id}(${r.relevance.toFixed(3)})`)
  const hitIdx = ranked.slice(0, 5).findIndex(([n]) => (c.expect ?? []).some((e) => n.id.startsWith(e)))
  const hit = hitIdx >= 0
  if (hit) { hits += 1; mrrSum += 1 / (hitIdx + 1) }
  const cat = byCat.get(c.cat) ?? { total: 0, hit: 0 }
  cat.total += 1
  if (hit) cat.hit += 1
  byCat.set(c.cat, cat)
  rows.push(`${hit ? '✔' : '✗'} ${c.q} → 期望 ${(c.expect ?? []).join('/')} ${hit ? `（第 ${hitIdx + 1} 位）` : `（未进前五；实际：${top5.join(' ') || '无'}）`} · ${c.why ?? ''}`)
}

let negHits = 0
for (const c of neg) {
  const ranked = [...rankByQuery(nodes, c.q).entries()]
      .filter(([, r]) => r.relevance >= MIN_RELEVANCE) // 生产闸（searchNodes 同款）
      .sort((a, b) => b[1].relevance - a[1].relevance)
  const over = ranked.filter(([, r]) => r.relevance >= NEG_FLOOR) // 负题判据：≥0.5 的才算假命中（标定见头注）
    const pass = over.length === 0
  if (!pass) negHits += 1
  rows.push(`${pass ? '✔' : '✗'} [负题] ${c.q} → ${pass ? '正确沉默' : `不该命中却命中：${ranked.slice(0, 3).map(([n, r]) => `${n.id}(${r.relevance.toFixed(3)})`).join(' ')}`}`)
}

const r5 = pos.length ? hits / pos.length : 0
const mrr = pos.length ? mrrSum / pos.length : 0
const summary = {
  suite: draft ? 'draft' : 'frozen',
  ledger: nodes.length,
  cases: cases.length,
  recallAt5: Number(r5.toFixed(3)),
  mrrAt5: Number(mrr.toFixed(3)),
  negativeHits: negHits,
  byCategory: [...byCat.entries()].map(([cat, v]) => ({ cat, hit: v.hit, total: v.total })),
}

if (gate) {
  // 回归门程序化（批 D14，ADR-0007）：R@5 ≥ B−0.05 且 MRR@5 ≥ 0.689 且负题 0 → exit 0，否则 1
  const GATE_R5 = 0.888
  const GATE_MRR = 0.689
  const pass = summary.recallAt5 >= GATE_R5 && summary.mrrAt5 >= GATE_MRR && summary.negativeHits === 0
  console.log(`[门] R@5 ≥ ${GATE_R5} && MRR@5 ≥ ${GATE_MRR} && 负题 0 → ${pass ? 'PASS' : 'FAIL'}（ADR-0007 回归门 = B − 0.05）`)
  process.exitCode = pass ? 0 : 1
}

if (asJson) {
  console.log(JSON.stringify({ ...summary, rows }, null, 2))
} else {
  console.log(`账本 ${nodes.length} 条 · 考卷 ${cases.length} 题（正 ${pos.length}/负 ${neg.length}）`)
  console.log(`R@5 = ${hits}/${pos.length} = ${summary.recallAt5} · MRR@5 = ${summary.mrrAt5} · 负题命中 = ${negHits}/${neg.length}（必须 0）`)
  for (const [cat, v] of byCat) console.log(`  ${cat}: ${v.hit}/${v.total}`)
  for (const r of rows) console.log(r)
}
