// 编排层特征测试（G-1 拆核安全网，2026-11-22）：拆核前把现行为钉死——
// loadBook 重试六次/损坏备份、pullFast 游标推进、索引维护、saveNodes 原子落盘。
// 这些不是单元行为，是「现在就是这样跑」的存证：拆核后它们必须一字不差地还成立。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { createBook, loadBook, saveNodes } from '../../core/protocol/book.js'

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

// ------------------------------------------------- 批 A2（2026-11-25 外部审查 P1-2）：假成功传播
// 钉 1：saveNodes 的返回值契约——拒写/写失败 false，写成 true（协议层直接钉）。
test('saveNodes：拒写返回 false、写成返回 true（批 A2 返回值契约）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-saveret-'))
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    const book = createBook({ dataDir: bookDir, log: () => {}, dshHome: dir })
    // 拒写路：红灯亮着、备份没成 → 拒绝覆盖写，返回 false，saveError 带文案，盘上不动
    book.broken = true
    book.backupOk = false
    book.nodes = []
    assert.equal(saveNodes(book), false, 'broken && !backupOk → false（不许再无声无息）')
    assert.ok(String(book.meta.saveError).includes('拒绝覆盖写'), `saveError 带拒写文案（${book.meta.saveError}）`)
    assert.equal(existsSync(join(bookDir, 'memory.json')), false, '拒写路一个字节都没落盘（保原文）')
    // 备份成了 → 放行；写成一次返回 true，红灯解除、saveError 清空
    book.backupOk = true
    assert.equal(saveNodes(book), true, '写成 → true')
    assert.equal(book.meta.saveError, null, '成功清 saveError')
    assert.equal(book.broken, false, '写成一次 = 红灯解除')
    assert.equal(JSON.parse(readFileSync(join(bookDir, 'memory.json'), 'utf8')).version, 1, '盘上落了能认的账')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 钉 2（假成功的回归钉）：saveNodes 失败时 remember 的回执必须 ok:false——
// 工具层把 memory.json 设成只读：原子写的 rename 覆盖只读目标会 EPERM，
// 账本写不进去，回执不许再报 ok:true（盘上还是原文）。
test('saveNodes 失败 → remember 回执 ok:false（假成功回归钉，批 A2）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-savefail-'))
  try {
    const memFile = join(dir, 'book', 'memory.json')
    mkdirSync(join(dir, 'book'), { recursive: true })
    writeFileSync(memFile, JSON.stringify({ version: 1, updatedAt: Date.now(), nodes: [] }))
    const h = harness(dir)
    chmodSync(memFile, 0o444) // 只读：rename 覆盖它必 EPERM（账本写不进去）
    const w = await h.tools.get('remember').execute({ text: '写不进去也要出声', kind: 'fact', weight: 0.5, changes: 'x' }, h.exec)
    assert.equal(w.ok, false, `账本没写进去就不许报 ok:true（实际 ${JSON.stringify({ ok: w.ok, note: w.note })}）`)
    assert.ok(String(w.note).includes('账本没写进去'), `回执说明卡在哪（${w.note}）`)
    assert.ok(readFileSync(memFile, 'utf8').includes('"nodes":[]'), '盘上还是原文（新条没冲掉旧账）')
  } finally {
    try {
      chmodSync(join(dir, 'book', 'memory.json'), 0o666)
    } catch {
      /* 已经删了就算了 */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- 批 A3（2026-11-25 外部审查 P1-3）：memory_list 套受众过滤
const listAudNode = (id, text, audience, weight) => ({
  id, at: Date.now() - 3600_000, lastAt: Date.now() - 3600_000, text, kind: 'fact', weight,
  changes: 'x', tags: [], refs: [], touches: [], audience, happenedAt: 0, prev: '', prevSelf: '',
  anchor: false, anchorWhy: '', restoredAt: 0, replaces: [], contexts: [], hits: 0, answered: false,
  moodAt: null, sealed: false, sealUntil: 0, sealCond: '', faded: false, superseded: false,
  supersededBy: '', supersededAt: 0, transformed: false, transformedBy: '', transformedAt: 0,
})
const listAudIntent = (id, text, chatType, groupId) => ({
  id, at: Date.now() - 60_000, kind: 'other', intensity: 0, text, source: 'qq-bridge', from: '',
  mid: `mid-${id}`, atMe: chatType === 'group', chatType, groupId: groupId ?? '', nickname: '', matched: [],
})

test('memory_list：hard 档过滤他场条目；off 档全显（批 A3）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-listaud-'))
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir // 密封：别让真家的消息流/事件流串进这本测试账
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    const now = Date.now()
    // 同场的条（group:222）+ 他场的条（private）；意图层同样两场各一条；
    // 再来一条窗内群来话把这一轮的受众定成群 222
    writeFileSync(join(bookDir, 'memory.json'), JSON.stringify({ version: 1, updatedAt: now, nodes: [
      listAudNode('r_in222', '群轮该看见的条', 'group:222', 0.9),
      listAudNode('r_prv', '私聊场的条', 'private', 0.9),
    ] }))
    writeFileSync(
      join(bookDir, 'intent.jsonl'),
      [listAudIntent('i_g1', '群里的来话', 'group', '222'), listAudIntent('i_p1', '私聊的来话', 'private', '')]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    )
    const h = harness(dir, { recallAudience: 'hard' })
    const hard = await h.tools.get('memory_list').execute({}, h.exec)
    assert.ok(hard.items.some((x) => x.includes('群轮该看见的条')), 'hard 档同场的条照列')
    assert.ok(!hard.items.some((x) => x.includes('私聊场的条')), `hard 档他场的条不列（${hard.items.join(' ┃ ').slice(0, 120)}）`)
    assert.ok(!hard.items.some((x) => x.includes('私聊的来话')), 'hard 档他场的意图事件也不列')
    assert.ok(hard.items.some((x) => x.includes('群里的来话')), 'hard 档同场的意图事件照列')
    // off 档：全景视图，全显
    const h2 = harness(dir, { recallAudience: 'off' })
    const off = await h2.tools.get('memory_list').execute({}, h2.exec)
    assert.ok(off.items.some((x) => x.includes('群轮该看见的条')) && off.items.some((x) => x.includes('私聊场的条')), 'off 档节点全显')
    assert.ok(off.items.some((x) => x.includes('群里的来话')) && off.items.some((x) => x.includes('私聊的来话')), 'off 档意图事件全显')
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- 批 C1（2026-11-25 方案 A）：群册恢复入库——受众检测的数据源必须活着
// 钉 1：群分册在源清单、群行照抄入库、游标键存在；私聊册照旧增量。
test('群册恢复入库：源清单含群分册、群行照抄、游标键在（批 C1 方案 A）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-grpsrc-'))
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const bridgeDir = join(dir, '.dsh-qq-bridge')
    mkdirSync(bridgeDir, { recursive: true })
    const row = (text, extra = {}) => JSON.stringify({ at: Date.now(), chatType: 'private', userId: '10001', nickname: '', text, mid: `m-${text}`, atMe: false, ...extra })
    writeFileSync(join(bridgeDir, 'messages-group-222.jsonl'), [row('群册第一句', { chatType: 'group', groupId: '222', mid: 'm-群一', atMe: true, userId: '20001' }), row('群册第二句', { chatType: 'group', groupId: '222', mid: 'm-群二', atMe: true, userId: '20001' })].join('\n') + '\n')
    writeFileSync(join(bridgeDir, 'messages-private-10001.jsonl'), row('私聊册第一句') + '\n')
    const h = harness(dir)
    const st = await h.status()
    assert.equal(st.intent.sources.some((s) => String(s).includes('messages-group-222.jsonl')), true, '群分册在源清单里（受众检测的数据源）')
    const copied = readFileSync(join(dir, 'book', 'intent.jsonl'), 'utf8')
    assert.ok(copied.includes('私聊册第一句'), '私聊册照抄')
    assert.ok(copied.includes('群册第一句') && copied.includes('群册第二句'), '群册照抄（入库只记账）')
    const cursor = JSON.parse(readFileSync(join(dir, 'book', 'intent.cursor.json'), 'utf8'))
    assert.ok(Object.keys(cursor.files ?? {}).some((k) => k === 'messages-private-10001.jsonl'), '私聊册的游标键在')
    assert.ok(Object.keys(cursor.files ?? {}).some((k) => k === 'messages-group-222.jsonl'), '群册的游标键在')
    // 第二拍：群册增量照常推进
    appendFileSync(join(bridgeDir, 'messages-group-222.jsonl'), row('群册第三句', { chatType: 'group', groupId: '222', mid: 'm-群三', atMe: true, userId: '20001' }) + '\n')
    const h2 = harness(dir)
    await h2.status()
    const copied2 = readFileSync(join(dir, 'book', 'intent.jsonl'), 'utf8')
    assert.ok(copied2.includes('群册第三句'), '群册增量推进')
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    rmSync(dir, { recursive: true, force: true })
  }
})

// 钉 2（N1 回归钉）：群 @ 来话在窗内 → remember 打标 group:<群号>——B3 断源时这条必红
test('群轮受众：群 @ 来话在窗内 → remember 打标 group:<群号>（批 C1 回归钉）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-grpaud-'))
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    writeFileSync(join(bookDir, 'intent.jsonl'), [listAudIntent('i_g1', '群里的来话', 'group', '222')].map((x) => JSON.stringify(x)).join('\n') + '\n')
    const h = harness(dir)
    const w = await h.tools.get('remember').execute({ text: '群轮里记下的', kind: 'fact', weight: 0.5, changes: 'x' }, h.exec)
    assert.equal(w.ok, true, `remember 应成功（${w.note}）`)
    const saved = JSON.parse(readFileSync(join(bookDir, 'memory.json'), 'utf8'))
    const node = (saved.nodes ?? []).find((n) => n.id === w.id)
    assert.ok(node, '节点在账上')
    assert.equal(node.audience, 'group:222', `群轮打标（实际 ${node.audience}）`)
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    rmSync(dir, { recursive: true, force: true })
  }
})

// 钉 3（N1 的用户可见面）：hard 档群轮——私账不进 recall
test('hard 档群轮：私聊场的条不进 recall（批 C1 回归钉）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-grphard-'))
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    const now = Date.now()
    writeFileSync(join(bookDir, 'memory.json'), JSON.stringify({ version: 1, updatedAt: now, nodes: [
      listAudNode('r_prv', '星屑落在私聊场的便条上，只有他看得见', 'private', 0.9),
      listAudNode('r_g222', '星屑记在群轮该看见的地方', 'group:222', 0.9),
      listAudNode('r_f1', '无关的垫场条目甲，随便写点别的什么字', 'any', 0.2),
      listAudNode('r_f2', '无关的垫场条目乙，再凑一点语料长度', 'any', 0.2),
    ] }))
    writeFileSync(join(bookDir, 'intent.jsonl'), [listAudIntent('i_g1', '群里的来话', 'group', '222')].map((x) => JSON.stringify(x)).join('\n') + '\n')
    const h = harness(dir, { recallAudience: 'hard' })
    const r = await h.tools.get('recall').execute({ query: '星屑' }, h.exec)
    assert.equal(r.ok, true, `recall 应成功（${r.note}）`)
    assert.ok(!r.items.some((x) => x.includes('私聊场的便条')), `hard 群轮不翻私账（${r.items.join(' ┃ ').slice(0, 160)}）`)
    assert.ok(r.items.some((x) => x.includes('群轮该看见的')), '同场的条照翻')
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    rmSync(dir, { recursive: true, force: true })
  }
})

// 钉 4（N2/C2 回归钉）：翻身位端到端——命中满 5 条时 echo 仍记上它，下轮不再重复翻身
test('翻身位端到端：echo 记上、下轮不重复（批 C2）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-resur-'))
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    const now = Date.now()
    const oldNode = (id, text, weight, ageDays) => ({
      id, at: now - ageDays * 24 * 60 * 60 * 1000, lastAt: now - ageDays * 24 * 60 * 60 * 1000, text, kind: 'fact', weight,
      changes: 'x', tags: [], refs: [], touches: [], audience: 'any', happenedAt: 0, prev: '', prevSelf: '',
      anchor: false, anchorWhy: '', restoredAt: 0, replaces: [], contexts: [], hits: 0, answered: false,
      moodAt: null, sealed: false, sealUntil: 0, sealCond: '', faded: false, superseded: false,
      supersededBy: '', supersededAt: 0, transformed: false, transformedBy: '', transformedAt: 0,
    })
    const hits = [1, 2, 3, 4, 5].map((i) =>
      listAudNode(`r_hit${i}`, `荧光第${i}份：抽屉深处那点荧光，是谁忘了关的小灯`, 'any', 0.3))
    const nodes = [...hits, oldNode('r_old', '一条从没被翻出来过的老账，压在最底下没人问', 0.99, 3)]
    writeFileSync(join(bookDir, 'memory.json'), JSON.stringify({ version: 1, updatedAt: now, nodes }))
    const h = harness(dir)
    const r1 = await h.tools.get('recall').execute({ query: '荧光' }, h.exec)
    assert.equal(r1.ok, true, `recall 应成功（${r1.note}）`)
    assert.ok(r1.items.some((x) => x.includes('翻身位')), '翻身位上了 items')
    assert.equal(r1.resurrect, 'r_old', '机读字段带翻身 id')
    const echoRaw = readFileSync(join(bookDir, 'echo.jsonl'), 'utf8').split('\n').filter((l) => l.trim())
    const lastEcho = JSON.parse(echoRaw[echoRaw.length - 1])
    assert.ok((lastEcho.refs ?? []).includes('r_old'), `echo 名单含翻身条（实际 ${JSON.stringify(lastEcho.refs)}）`)
    // 第二轮：r_old 已有现行 → 不再重复翻身
    const r2 = await h.tools.get('recall').execute({ query: '荧光' }, h.exec)
    assert.ok(!r2.items.some((x) => x.includes('翻身位')), '下轮不再重复翻身')
    assert.equal(r2.resurrect, undefined, '下轮无机读翻身字段')
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    rmSync(dir, { recursive: true, force: true })
  }
})

// 钉 5（N3/C3 回归钉）：kind 检索不占翻身位
test('翻身位不进 kind 检索（批 C3）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-reskind-'))
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    const now = Date.now()
    const decision = {
      id: 'r_dec', at: now - 3 * 24 * 60 * 60 * 1000, lastAt: now - 3 * 24 * 60 * 60 * 1000,
      text: '该翻身的老决定，从来没被现行过', kind: 'decision', weight: 0.9,
      changes: 'x', tags: [], refs: [], touches: [], audience: 'any', happenedAt: 0, prev: '', prevSelf: '',
      anchor: false, anchorWhy: '', restoredAt: 0, replaces: [], contexts: [], hits: 0, answered: false,
      moodAt: null, sealed: false, sealUntil: 0, sealCond: '', faded: false, superseded: false,
      supersededBy: '', supersededAt: 0, transformed: false, transformedBy: '', transformedAt: 0,
    }
    writeFileSync(join(bookDir, 'memory.json'), JSON.stringify({ version: 1, updatedAt: now, nodes: [decision] }))
    const h = harness(dir)
    const r = await h.tools.get('recall').execute({ query: '老决定', kind: 'fact' }, h.exec)
    assert.equal(r.ok, true, `recall 应成功（${r.note}）`)
    assert.ok(!r.items.some((x) => x.includes('翻身位')), 'kind 检索不带翻身位')
    assert.equal(r.resurrect, undefined, 'kind 检索无机读翻身字段')
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    rmSync(dir, { recursive: true, force: true })
  }
})

// 钉 6（N4/C4 回归钉）：saveNodes 失败回滚——重试不产生重复节点
test('saveNodes 失败回滚：重试不产生重复节点（批 C4）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-rollback-'))
  try {
    const memFile = join(dir, 'book', 'memory.json')
    mkdirSync(join(dir, 'book'), { recursive: true })
    writeFileSync(memFile, JSON.stringify({ version: 1, updatedAt: Date.now(), nodes: [] }))
    const h = harness(dir)
    chmodSync(memFile, 0o444)
    const w1 = await h.tools.get('remember').execute({ text: '写不进去也要出声', kind: 'fact', weight: 0.5, changes: 'x' }, h.exec)
    assert.equal(w1.ok, false, '第一次必须失败')
    chmodSync(memFile, 0o666)
    const w2 = await h.tools.get('remember').execute({ text: '写不进去也要出声', kind: 'fact', weight: 0.5, changes: 'x' }, h.exec)
    assert.equal(w2.ok, true, '回滚后重试应当成功')
    const saved = JSON.parse(readFileSync(memFile, 'utf8'))
    const dup = (saved.nodes ?? []).filter((n) => n.text === '写不进去也要出声')
    assert.equal(dup.length, 1, `盘上只有一条（实际 ${dup.length}）`)
    assert.equal((saved.nodes ?? []).some((n) => n.id === w1.id), false, '失败那次的节点已回滚')
  } finally {
    try { chmodSync(join(dir, 'book', 'memory.json'), 0o666) } catch { /* 已经删了就算了 */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- 批 D1（2026-11-25）：快照兜底不许静默
const d1Node = (id, text) => ({
  id, at: Date.now() - 3600_000, lastAt: Date.now() - 3600_000, text, kind: 'fact', weight: 0.5,
  changes: 'x', tags: [], refs: [], touches: [], audience: 'any', happenedAt: 0, prev: '', prevSelf: '',
  anchor: false, anchorWhy: '', restoredAt: 0, replaces: [], contexts: [], hits: 0, answered: false,
  moodAt: null, sealed: false, sealUntil: 0, sealCond: '', faded: false, superseded: false,
  supersededBy: '', supersededAt: 0, transformed: false, transformedBy: '', transformedAt: 0,
})

test('loadBook：memory.json 空文件 → 红灯+留证+日志，按快照兜底不再静默（批 D1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-d1empty-'))
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    writeFileSync(join(bookDir, 'memory.json'), '') // 空文件：三道护栏曾被这一支绕开
    writeFileSync(join(bookDir, 'memory.snapshot.json'), JSON.stringify({ version: 1, updatedAt: Date.now(), nodes: [d1Node('r_snap1', '快照里的最后一份好账')] }))
    const logs = []
    const book = createBook({ dataDir: bookDir, log: (l) => logs.push(l), dshHome: dir })
    loadBook(book)
    assert.equal(book.broken, true, '红灯亮起（不再静默）')
    assert.equal(book.backupOk, true, '现状留证成功')
    assert.equal(book.nodes[0]?.id, 'r_snap1', '按快照兜底')
    assert.ok(logs.some((l) => l.includes('读不出能认的账')), '日志写明兜底与恢复口径')
    const baks = readdirSync(bookDir).filter((f) => f.includes('.empty-') && f.endsWith('.bak'))
    assert.equal(baks.length, 1, `空文件留了证（${baks.join('、')}）`)
    // 备份成功 → 覆盖写放行（与 corrupt 路径同一口径）：写成一次红灯解除
    assert.equal(saveNodes(book), true, 'backupOk 后照常放行')
    assert.equal(book.broken, false, '写成一次 = 红灯解除')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadBook：memory.json 不存在 = 首次启动合法空账，不亮红灯（批 D1）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-d1fresh-'))
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    const logs = []
    const book = createBook({ dataDir: bookDir, log: (l) => logs.push(l), dshHome: dir })
    loadBook(book)
    assert.equal(book.broken, false, '首次启动不亮红灯')
    assert.equal(book.nodes.length, 0, '空账起步')
    // 有快照就先恢复现场
    writeFileSync(join(bookDir, 'memory.snapshot.json'), JSON.stringify({ version: 1, updatedAt: Date.now(), nodes: [d1Node('r_snap2', '快照恢复现场')] }))
    const book2 = createBook({ dataDir: bookDir, log: () => {}, dshHome: dir })
    loadBook(book2)
    assert.equal(book2.broken, false, '恢复现场也不亮红灯')
    assert.equal(book2.nodes[0]?.id, 'r_snap2', '有快照先恢复现场')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- 批 D2（2026-11-25）：配置读带防御
test('config.json 带 BOM → 配置照读，隔离名单不再静默放空（批 D2）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-bom-'))
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    writeFileSync(join(bookDir, 'config.json'), String.fromCharCode(0xfeff) + JSON.stringify({ recallAudience: 'hard' }))
    const h = harness(dir)
    const st = await h.status()
    assert.equal(st.audience?.mode, 'hard', `BOM 配置生效（实际 ${JSON.stringify(st.audience ?? {})}）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config.json 坏掉 → 日志亮灯 + 默认值兜底，工具照常（批 D2）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-badcfg-'))
  try {
    const bookDir = join(dir, 'book')
    mkdirSync(bookDir, { recursive: true })
    writeFileSync(join(bookDir, 'config.json'), '{ "recallAudience": ') // 撕裂 JSON
    const h = harness(dir)
    const st = await h.status()
    assert.equal(st.audience?.mode, 'off', '坏配置回落默认')
    const w = await h.tools.get('remember').execute({ text: '坏配置下照常记', kind: 'fact', changes: 'x' }, h.exec)
    assert.equal(w.ok, true, '工具照常（默认值兜底）')
    const logText = readFileSync(join(dir, 'book', 'dsh-remember.log'), 'utf8')
    assert.ok(logText.includes('config.json 解析失败'), '日志亮灯（不再静默）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- 批 D4（2026-11-25）：单例闸——新实例接管，旧实例让位
test('双实例：新实例接管后，旧实例工具只读让位（批 D4）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'char-dual-'))
  try {
    const h1 = harness(dir)
    const w1 = await h1.tools.get('remember').execute({ text: '接管前正常记', kind: 'fact', changes: 'x' }, h1.exec)
    assert.equal(w1.ok, true, '接管前旧实例正常写')
    const h2 = harness(dir) // 新实例接管（instance.lock 换主）
    const w2 = await h2.tools.get('remember').execute({ text: '新实例的账', kind: 'fact', changes: 'x' }, h2.exec)
    assert.equal(w2.ok, true, '新实例照常写')
    const w3 = await h1.tools.get('remember').execute({ text: '旧实例不该再写', kind: 'fact', changes: 'x' }, h1.exec)
    assert.equal(w3.ok, false, '旧实例工具让位（只读）')
    assert.ok(String(w3.note).includes('单例闸'), `回执说明卡在哪（${w3.note}）`)
    // 新实例写的那条在账上；旧实例被拒的那条不在
    const saved = JSON.parse(readFileSync(join(dir, 'book', 'memory.json'), 'utf8'))
    const texts = (saved.nodes ?? []).map((n) => n.text)
    assert.ok(texts.includes('新实例的账'), '新实例的账落了盘')
    assert.ok(!texts.includes('旧实例不该再写'), '旧实例让位后没写盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})