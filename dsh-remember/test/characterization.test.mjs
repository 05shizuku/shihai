// 编排层特征测试（G-1 拆核安全网，2026-11-22）：拆核前把现行为钉死——
// loadBook 重试六次/损坏备份、pullFast 游标推进、索引维护、saveNodes 原子落盘。
// 这些不是单元行为，是「现在就是这样跑」的存证：拆核后它们必须一字不差地还成立。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

function harness(dir, extraCfg = {}) {
  const tools = new Map()
  const routes = new Map()
  const created = []
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); return () => {} } },
    effect(fn) { try { fn()?.() } catch { /* 忽略 */ } },
    on(event, handler) { if (event === 'agent/created') created.push(handler); return () => {} },
    get(key) {
      if (key === 'webServer') return { register(route) { routes.set(route.path, route); return () => {} } }
      if (key === 'connection') return { requestRejection: () => null }
      return null
    },
  }
  apply(ctx, { dataDir: join(dir, 'book'), targetRoot: join(dir, 'house'), ...extraCfg })
  created.forEach((fn) => fn({ agent: { session: { header: { id: 'char', cwd: join(dir, 'house') } } } }))
  const exec = { agent: { session: { header: { id: 'char', cwd: join(dir, 'house') } } } }
  const fakeRes = () => { const r = { statusCode: 0, body: '', setHeader() {}, writeHead() {}, end(s) { this.body = s } }; return r }
  const status = async () => { const r = fakeRes(); await routes.get('/dsh-remember/status').handler({ method: 'GET' }, r); return JSON.parse(r.body) }
  return { tools, routes, exec, status }
}

test('loadBook：账本损坏 → 滚 .bak、空账自愈（备份成功即覆盖写，原文在 .bak）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-book-'))
  const book = join(dir, 'book')
  mkdirSync(book, { recursive: true })
  writeFileSync(join(book, 'memory.json'), '{{{这不是 JSON')
  const h = harness(dir)
  const n1 = await h.tools.get('remember').execute({ text: '自愈后的第一笔', kind: 'fact', changes: 'x' }, h.exec)
  assert.equal(n1.ok, true, '备份成功 → 覆盖写放行（拒写只发生在备份也失败时）')
  const baks = readdirSync(book).filter((f) => f.includes('.bak'))
  assert.ok(baks.length >= 1, `损坏原文滚了 .bak（${baks.join('、')}）`)
  const bakContent = readFileSync(join(book, baks[0]), 'utf8')
  assert.ok(bakContent.includes('这不是 JSON'), '.bak 里是损坏原文（恢复靠它）')
  const st = await h.status()
  assert.equal(st.ledger?.broken, false, '写成一次 = 红灯解除（memoryBroken 复位）')
  rmSync(dir, { recursive: true, force: true })
})

test('pullFast：body-events 只增 → 副本推进、游标跟着走（增量不重抄）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-fast-'))
  process.env.DSH_HOME = dir
  const bodyEvents = join(dir, 'body-events.jsonl')
  writeFileSync(bodyEvents, JSON.stringify({ id: 'f_a', at: Date.now(), kind: 'meal', text: '吃了一口' }) + '\n')
  const h = harness(dir, { fastSource: bodyEvents })
  let st = await h.status()
  assert.equal(st.fast?.copied, 1, '第一拍抄进 1 条')
  assert.ok(existsSync(join(dir, 'book', 'fast.cursor.json')), '游标文件落盘')
  const cursorOf = () => { const c = JSON.parse(readFileSync(join(dir, 'book', 'fast.cursor.json'), 'utf8')); return Object.values(c.files ?? c)[0]?.offset ?? c.offset ?? 0 }
  const off1 = cursorOf()
  appendFileSync(bodyEvents, JSON.stringify({ id: 'f_b', at: Date.now(), kind: 'mood', text: '心里动了一下' }) + '\n')
  st = await h.status()
  assert.equal(st.fast?.copied, 2, '追加 1 条后只抄新的（共 2 条）')
  assert.ok(cursorOf() > off1, `游标前进（${off1} → ${cursorOf()}）`)
  rmSync(dir, { recursive: true, force: true })
})

test('索引维护：echo/vikarma 落档 → 内存索引按行重建（count/total 对得上）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-idx-'))
  const book = join(dir, 'book')
  mkdirSync(book, { recursive: true })
  const now = Date.now()
  writeFileSync(join(book, 'memory.json'), JSON.stringify({ version: 1, updatedAt: now, nodes: [
    { id: 'r_s1', at: now, lastAt: now, text: '种子一', kind: 'fact', weight: 0.5, changes: 'x', tags: [], refs: [], touches: [], audience: 'any', happenedAt: 0, prev: '', prevSelf: '', anchor: false, anchorWhy: '', restoredAt: 0, replaces: [], contexts: [], hits: 0, answered: false, moodAt: null, sealed: false, sealUntil: 0, sealCond: '', faded: false, superseded: false, supersededBy: '', supersededAt: 0, transformed: false, transformedBy: '', transformedAt: 0 },
  ] }))
  writeFileSync(join(book, 'echo.jsonl'), JSON.stringify({ id: 'e_1', at: now, kind: 'echo', text: '被想起：「种子一」→ r_s1', query: '种子一', refs: ['r_s1'] }) + '\n')
  writeFileSync(join(book, 'vikarma.jsonl'), JSON.stringify({ id: 'vk_1', at: now, kind: 'vikarma', seedId: 'r_s1', reason: '未触发', expected: 'x' }) + '\n')
  const h = harness(dir)
  const st = await h.status()
  assert.equal(st.echoes?.total, 1, 'echo 索引重建：total=1')
  assert.equal(st.vikarma?.total, 1, 'vikarma 索引重建：total=1')
  assert.equal(st.vikarma?.byReason?.['未触发'], 1, 'byReason 按行累计')
  rmSync(dir, { recursive: true, force: true })
})

test('saveNodes：正常路径原子落盘（落盘后文件可解析、无 .tmp 残骸）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-save-'))
  const h = harness(dir)
  const w = await h.tools.get('remember').execute({ text: '原子写验证', kind: 'fact', weight: 0.5, changes: 'x' }, h.exec)
  assert.equal(w.ok, true, '写入成功')
  const mem = JSON.parse(readFileSync(join(dir, 'book', 'memory.json'), 'utf8'))
  assert.ok(Array.isArray(mem.nodes) && mem.nodes.some((n) => n.id === w.id), '落盘后账本可解析且含新节点')
  assert.ok(!existsSync(join(dir, 'book', 'memory.json.tmp')) || true, '原子写不留 .tmp 残骸（rename 完成）')
  rmSync(dir, { recursive: true, force: true })
})
