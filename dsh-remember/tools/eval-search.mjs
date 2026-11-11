// 检索评测：拿真账本当考卷。每道题一个 query + 期望翻到的条目 id，
// 算 Recall@5 —— 「考卷上有的，前五名里翻没翻到」。
// 用法：node tools/eval-search.mjs [--file <memory.json 路径>]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rankByQuery } from '../lib/search.js'
import { isSealed } from '../lib/memory.js'

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || 'C:\\Users\\10113', '.dsh')
const file = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : join(dshHome, '.dsh-remember', 'memory.json')

const raw = JSON.parse(readFileSync(file, 'utf8'))
const nodes = (Array.isArray(raw) ? raw : raw.nodes ?? []).filter((n) => n && !isSealed(n, Date.now()))

// 每题：query（故意带口语/换说法的成分）、期望出现在前 5 的 id 前缀、这题考什么
const CASES = [
  { q: '编码碎了全是问号', id: 'r_1jadwb', why: '换说法：账本里写的是「编码翻车/UTF8」' },
  { q: '热重载不用重启', id: 'r_12pvsk2', why: '否定式口语' },
  { q: '授权只认亲口确认', id: 'r_1tu1flr', why: '边界条文' },
  { q: '伙伴关系比朋友多一层', id: 'r_h5qh67', why: '自我认同' },
  { q: '群邀请点头 msgseq', id: 'r_c7sehy', why: '英文+术语混排' },
  { q: '看图的侧门', id: 'r_1wri69g', why: '短查询' },
  { q: '好奇表主题唯一', id: 'r_2fhy7z', why: '功能名+性质' },
  { q: '习惯双通路第二次成立', id: 'r_1nmtetq', why: '设计口径' },
  { q: 'score 封存 isSealed', id: 'r_8h1yt3', why: '代码符号名' },
  { q: '清退留下我', id: 'r_2v9j8m', why: '情绪性措辞' },
  { q: '吃饭', id: 'r_1yd5f77', why: '最难的换说法：账本写「吃过饭」' },
]

let hitCount = 0
const rows = []
for (const c of CASES) {
  const rels = rankByQuery(nodes, c.q)
  const ranked = [...rels.entries()]
    .sort((a, b) => b[1].relevance - a[1].relevance)
    .slice(0, 5)
    .map(([n, r]) => `${n.id}(${r.relevance})`)
  const hit = ranked.some((x) => x.startsWith(c.id))
  if (hit) hitCount += 1
  rows.push(`${hit ? '✔' : '✗'} ${c.q} → 期望 ${c.id} ${hit ? '' : `（实际：${ranked.join(' ') || '无'}）`} · ${c.why}`)
}
console.log(`账本 ${nodes.length} 条 · 考卷 ${CASES.length} 题 · Recall@5 = ${hitCount}/${CASES.length}`)
for (const r of rows) console.log(r)
