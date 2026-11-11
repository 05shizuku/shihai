import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVATION_AXES,
  ECHO_WINDOW_MS,
  RECENCY_TAU_BASE_MIN,
  RECENCY_TAU_SPAN_MIN,
  REPEAT_FULL,
  activationOf,
  recencyAxis,
  recencyTauMinutes,
  repeatAxis,
  repeatCounts,
  themeKey,
  weightAxis,
} from '../lib/activation.js'
import { rankNodes, renderSection, searchNodes, summaryOf } from '../lib/memory.js'
import { fitAxis } from '../lib/activation.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.parse('2026-11-01T02:00:00.000Z')

test('四路权重和为 1，新近的钟是分钟级的', () => {
  const sum = ACTIVATION_AXES.weight + ACTIVATION_AXES.recency + ACTIVATION_AXES.fit + ACTIVATION_AXES.repeat
  assert.ok(Math.abs(sum - 1) < 1e-9, `凸组合权重和应为 1，实际 ${sum}`)
  // 分量占大头 —— 分量是我写下的判断
  assert.ok(ACTIVATION_AXES.weight > ACTIVATION_AXES.recency, '分量这一路得比新近重')
  assert.equal(RECENCY_TAU_BASE_MIN, 30)
  assert.equal(RECENCY_TAU_SPAN_MIN, 90)
  assert.equal(REPEAT_FULL, 4)
})

test('两把钟：新近按分钟到小时，自我按月，分量淡按天', () => {
  assert.equal(recencyTauMinutes(0), 30) // 轻：半小时就凉了一半
  assert.equal(recencyTauMinutes(1), 120) // 重：两个小时才凉一半
  // 自我不吃分钟这一套：weight 0.5 → (30 + 135) 天，换算成分钟
  const month = (30 + 270 * 0.5) * 24 * 60
  assert.equal(recencyTauMinutes(0.5, 'self'), month)
  // 「SELF」大小写无所谓
  assert.equal(recencyTauMinutes(0.5, 'Self'), month)
})

test('新近：刚写下的≈1，两小时前的轻条已经凉了大半，自我隔天还很热', () => {
  const fresh = { weight: 0.5, at: NOW, lastAt: NOW, kind: 'fact' }
  assert.ok(recencyAxis(fresh, NOW) > 0.999)
  const twoHours = { weight: 0.5, at: NOW - 2 * HOUR, lastAt: NOW - 2 * HOUR, kind: 'fact' }
  const r = recencyAxis(twoHours, NOW)
  assert.ok(r > 0 && r < 0.3, `两小时的轻条新近应很小，实际 ${r}`)
  const self = { weight: 0.5, at: NOW - 1 * DAY, lastAt: NOW - 1 * DAY, kind: 'self' }
  assert.ok(recencyAxis(self, NOW) > 0.99, '自我隔一天的新近应还接近 1（按月淡）')
  // 没时间的、坏时间的 → 0
  assert.equal(recencyAxis({}, NOW), 0)
  assert.equal(recencyAxis(null, NOW), 0)
})

test('分量淡：就是我写下的分量按天淡（跟老 score 那一层同口径）', () => {
  const fresh = { weight: 0.8, at: NOW, lastAt: NOW, kind: 'fact' }
  assert.ok(Math.abs(weightAxis(fresh, NOW) - 0.8) < 1e-9)
  const twoMonths = { weight: 0.8, at: NOW - 60 * DAY, lastAt: NOW - 60 * DAY, kind: 'fact' }
  const w = weightAxis(twoMonths, NOW)
  assert.ok(w > 0.3 && w < 0.55, `两个月后的分量轴应明显缩水，实际 ${w}`)
})

test('主题键：同一组标签算同一主题，标签的顺序和大小写不算身份', () => {
  assert.equal(themeKey({ tags: ['快层', '身体'] }), '快层|身体')
  assert.equal(themeKey({ tags: ['身体', '快层'] }), '快层|身体')
  assert.equal(themeKey({ tags: ['  身体 ', '快层'] }), '快层|身体')
  assert.equal(themeKey({ tags: [] }), '')
  assert.equal(themeKey({}), '')
})

test('复现计数：只数活着的同主题条，按住的、被顶掉的不算', () => {
  const nodes = [
    { id: 'a', tags: ['x'], sealed: false },
    { id: 'b', tags: ['X'], sealed: false },
    { id: 'c', tags: ['x'], sealed: true },
    { id: 'd', tags: ['x'], superseded: true },
    { id: 'e', tags: [] },
  ]
  const counts = repeatCounts(nodes)
  assert.equal(counts.get('x'), 2)
  assert.equal(counts.has(''), false)
})

test('复现轴：hits + 被碰 + 同主题同伴，攒满 4 次算 1', () => {
  const counts = new Map([['x', 3]])
  const n = { hits: 1, touches: [{ at: NOW }, { at: NOW }], tags: ['x'] }
  // 1 hit + 2 touches + 2 peers = 5 → 封顶 1
  assert.equal(repeatAxis(n, counts), 1)
  const lonely = { hits: 0, touches: [], tags: [] }
  assert.equal(repeatAxis(lonely, counts), 0)
  const half = { hits: 2, touches: [], tags: ['x'] } // 2 hits + 2 peers = 4 → 1
  assert.equal(repeatAxis(half, counts), 1)
  const quarter = { hits: 1, touches: [], tags: ['x'] } // 1 + 2 = 3 → 0.75
  assert.equal(repeatAxis(quarter, counts), 0.75)
})

test('契合：真的刚发生过的事（事件池）对得上就高；自己那条要从池里摘掉', () => {
  const node = { id: 'r_1', text: '快层事件要用游标增量抄', tags: ['快层'] }
  // 别的条刚说过同一件事 → topic 命中
  const withPeer = fitAxis(node, { events: [{ id: 'r_2', text: '快层事件要用游标增量抄进中层' }] })
  const withoutAny = fitAxis(node, { events: [{ id: 'r_3', text: '今天吃了饭' }] })
  assert.ok(withPeer > withoutAny, `命中事件应比不相关高：${withPeer} vs ${withoutAny}`)
  // 自己那条在池里 → 必须摘掉，不然恒满
  const withSelf = fitAxis(node, { events: [{ id: 'r_1', text: '快层事件要用游标增量抄' }] })
  const withNothing = fitAxis(node, { events: [] })
  assert.equal(withSelf, withNothing, '事件池里自己的那条不该抬自己的契合')
  // 事件池里有内容但都不沾边，比空池还低（空池是中性的 0.5）
  assert.ok(withNothing > withoutAny || withoutAny < 0.5, '不相关事件不该比空池更抬高')
})

test('契合：当前目录对得上（scope）、文件真的在（path）都算数', () => {
  const node = { id: 'r_2', text: '去看 E:\\示例\\Plugin\\dsh-remember\\index.js 的接缝', tags: [] }
  const cwd = 'E:\\示例\\Plugin\\dsh-remember'
  const inScope = fitAxis(node, { cwd, roots: [cwd], events: [] })
  const nowhere = fitAxis(node, { cwd: '', roots: [], events: [] })
  assert.ok(inScope > nowhere, `目录对得上应更高：${inScope} vs ${nowhere}`)
  // 文件真的在 —— exists 注入
  const withFile = fitAxis(node, { cwd, roots: [cwd], events: [], exists: (p) => p.includes('index.js') })
  assert.ok(withFile >= inScope, '文件真的在只会加分或持平')
  // 范围外的文件不查
  const outside = { id: 'r_3', text: 'C:\\Windows\\system32\\config.sys 写着什么', tags: [] }
  const outVal = fitAxis(outside, { cwd, roots: [cwd], events: [], exists: () => true })
  assert.ok(outVal < 1, '范围外的文件不该因为 exists 被查而拿满分')
})

test('激活度：凸组合落在 [0,1]，按住的直接 -1，刚写的重条稳居第一', () => {
  const freshHeavy = { id: 'a', kind: 'decision', weight: 0.9, at: NOW, lastAt: NOW, tags: ['重要'], text: '先做地基', changes: 'x' }
  const oldHeavy = { id: 'b', kind: 'decision', weight: 0.9, at: NOW - 3 * DAY, lastAt: NOW - 3 * DAY, tags: ['重要'], text: '三天前定的方向', changes: 'x' }
  const freshLight = { id: 'c', kind: 'fact', weight: 0.5, at: NOW, lastAt: NOW, tags: [], text: '随手记的', changes: 'x' }
  const sealed = { id: 'd', kind: 'fact', weight: 1, at: NOW, lastAt: NOW, tags: [], text: '被按住的', sealed: true }
  const ctx = { events: [], repeatCounts: repeatCounts([freshHeavy, oldHeavy, freshLight, sealed]) }
  const a = activationOf(freshHeavy, NOW, ctx)
  const b = activationOf(oldHeavy, NOW, ctx)
  const c = activationOf(freshLight, NOW, ctx)
  const d = activationOf(sealed, NOW, ctx)
  assert.ok(a.activation > 0.5 && a.activation <= 1, `刚写的重条应最高：${a.activation}`)
  assert.ok(b.activation > c.activation, `三天前的重要决定（${b.activation}）不该被刚写的小事（${c.activation}）压过`)
  assert.ok(b.activation > 0.3 && b.activation < a.activation)
  assert.equal(d.activation, -1)
  assert.ok(a.axes.weight > 0 && a.axes.recency > 0.9)
  // 各路都拆得开
  for (const k of ['weight', 'recency', 'fit', 'repeat']) {
    assert.ok(typeof a.axes[k] === 'number' && a.axes[k] >= 0 && a.axes[k] <= 1)
  }
})

test('rankNodes 吃 scoreOf：换成分数函数排名就跟着换，不给就用老 score', () => {
  const nodes = [
    { id: 'old', kind: 'fact', weight: 0.9, at: NOW - 3 * DAY, lastAt: NOW - 3 * DAY, tags: [], text: '老的重的', changes: 'x' },
    { id: 'new', kind: 'fact', weight: 0.5, at: NOW, lastAt: NOW, tags: [], text: '新的轻的', changes: 'x' },
  ]
  const legacy = rankNodes(nodes, NOW, { limit: 2 })
  assert.equal(legacy[0].node.id, 'old') // 老 score：分量主导
  // 倒过来打分 → 排名跟着倒
  const reversed = rankNodes(nodes, NOW, { limit: 2, scoreOf: (n, t) => -rankNodes([n], t)[0].score })
  assert.equal(reversed[0].node.id, 'new')
  // 激活度注入：新近抬刚写的轻条，但压不过老的重条（这正是 0.45/0.15 那笔账）
  const act = rankNodes(nodes, NOW, {
    limit: 2,
    scoreOf: (n, t) => activationOf(n, t, { events: [] }).activation,
  })
  assert.equal(act[0].node.id, 'old')
})

test('renderSection / searchNodes / summaryOf 都吃同一个 scoreOf', () => {
  const nodes = [
    { id: 'r1', kind: 'open', weight: 0.9, at: NOW - 10 * DAY, lastAt: NOW - 10 * DAY, tags: [], text: '很重的没结的事', changes: 'x', conflicts: 'y', willDo: 'z' },
    { id: 'r2', kind: 'fact', weight: 0.6, at: NOW, lastAt: NOW, tags: [], text: '刚写下的带判断的条', changes: 'x', conflicts: 'y', willDo: 'z' },
    { id: 'r3', kind: 'fact', weight: 0.5, at: NOW - DAY, lastAt: NOW - DAY, tags: [], text: '昨天的事', changes: 'x', conflicts: 'y', willDo: 'z' },
  ]
  // 渲染段落：注入「永远选 r2」的分数函数，r2 必须排在正文第一行
  const section = renderSection(nodes, {
    now: NOW,
    limit: 2,
    scoreOf: (n) => (n.id === 'r2' ? 1 : 0),
  })
  const firstLine = section.split('\n')[1] ?? ''
  assert.ok(firstLine.includes('刚写下的带判断的条'), `注入后 r2 应排最前：${section}`)
  // 按词翻：命中数优先，同命中再按注入的分数
  const hits = searchNodes(nodes, '带判断', { now: NOW, limit: 3, scoreOf: (n) => (n.id === 'r3' ? 1 : 0) })
  assert.equal(hits[0].node.id, 'r2') // 只有 r2 命中
  // 空词走 rankNodes：注入谁就翻谁
  const none = searchNodes(nodes, '', { now: NOW, limit: 3, scoreOf: (n) => (n.id === 'r2' ? 1 : 0) })
  assert.equal(none[0].node.id, 'r2')
  // summaryOf 的 top 分数也跟着注入走
  const s = summaryOf(nodes, NOW, { scoreOf: () => 0.42 })
  assert.ok(Math.abs(s.topScore - 0.42) < 1e-9, `topScore 应为注入值：${s.topScore}`)
  // 不注入 → 老 score 照旧
  const s2 = summaryOf(nodes, NOW)
  assert.ok(s2.topScore > 0)
})

test('唤醒回弹：被想起的回声抬复现轴，只数最近 7 天的', () => {
  assert.equal(ECHO_WINDOW_MS, 7 * DAY, '回声窗口 = 7 天')
  const n = { id: 'r1', hits: 0, touches: [], tags: [] }
  // 没回声 = 0
  assert.equal(repeatAxis(n, new Map(), 0), 0)
  // 被想起 2 次 → 2/4 = 0.5
  assert.equal(repeatAxis(n, new Map(), 2), 0.5)
  // 负数、坏值当 0
  assert.equal(repeatAxis(n, new Map(), -3), 0)
  assert.equal(repeatAxis(n, new Map(), NaN), 0)
  // 封顶：回声再多也只算满一路
  assert.equal(repeatAxis(n, new Map(), 99), 1)
  // activationOf 从 ctx.echoes（Map）里拿
  const echoes = new Map([['r1', 3], ['r2', 1]])
  const withEcho = activationOf(n, NOW, { events: [], echoes })
  const noEcho = activationOf(n, NOW, { events: [] })
  assert.ok(withEcho.activation > noEcho.activation, `被想起的该更热：${withEcho.activation} vs ${noEcho.activation}`)
  assert.ok(Math.abs(withEcho.axes.repeat - 0.75) < 1e-9, `回声 3 次 → 复现 0.75，实际 ${withEcho.axes.repeat}`)
  // 别的条的回声不串门
  const other = activationOf({ id: 'r9', hits: 0, touches: [], tags: [] }, NOW, { events: [], echoes })
  assert.equal(other.axes.repeat, 0, '没有回声的条不该被别人的回声抬高')
})
