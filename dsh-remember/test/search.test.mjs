// 检索内核单测：分词、df 恒正、字段权重、单字兜底（换了说法也翻得到）、
// 口语词对扩展、trigram 覆盖率、零命中排除、确定性。
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeNode } from '../lib/memory.js'
import { searchNodes } from '../lib/memory.js'
import { splitTerms, trigrams, expandQuery, rankByQuery, QUERY_PAIRS } from '../lib/search.js'

const NOW = Date.parse('2026-11-05T03:00:00.000Z')
const node = (over) => makeNode({ text: '一句话', kind: 'fact', weight: 0.6, changes: 'x', ...over }, NOW)

test('分词：中文 bigram+单字兜底、英文按词、带数字的串更贵、虚字单字丢掉', () => {
  const ts = splitTerms('吃饭了 v0.9.0 dsh')
  const bigrams = ts.filter((x) => x.t.length === 2 && !/[a-z0-9]/.test(x.t))
  assert.ok(bigrams.some((x) => x.t === '吃饭'), JSON.stringify(ts))
  assert.ok(ts.some((x) => x.t === '饭' && x.w === 0.4), '单字兜底 0.4')
  assert.ok(!ts.some((x) => x.t === '了' ), '虚字「了」不入索引')
  assert.ok(ts.some((x) => x.t === 'v0.9.0' && x.w === 1.25), '版本号 1.25')
  assert.ok(ts.some((x) => x.t === 'dsh' && x.w === 1.0), '英文词 1.0')
})

test('trigram：分母是查询不是正文', () => {
  const q = trigrams('记忆架构说明')
  assert.equal(q.size, 4, '六字查询 = 4 个 trigram')
  const longDoc = trigrams('这是一篇很长的正文，开头提了一句记忆架构说明，后面全是别的事'.repeat(3))
  let hit = 0
  for (const g of q) if (longDoc.has(g)) hit += 1
  assert.equal(hit, 4, '长文里的命中数不受文长影响')
})

test('口语词对：命中一侧撒另一侧，最多 2 个概念，权重 0.6', () => {
  const out = expandQuery([{ t: '吃饭', w: 1.0 }, { t: '饭', w: 0.4 }])
  assert.ok(out.some((x) => x.t === '添饭' && x.w === 0.6), JSON.stringify(out))
  assert.ok(out.some((x) => x.t === '吃过' && x.w === 0.6))
  const none = expandQuery([{ t: '完全', w: 1.0 }, { t: '对不上', w: 1.0 }])
  assert.equal(none.length, 2, '没命中词对就不加')
})

test('换了说法也翻得到：吃饭 → 吃过中饭了（单字兜底接住）', () => {
  const nodes = [node({ text: '吃过中饭了，胃里踏实一点' }), node({ text: '完全无关的事情' })]
  const rels = rankByQuery(nodes, '吃饭')
  assert.equal(rels.size, 1, '只有吃过那条翻得到')
  const rel = rels.get(nodes[0])
  assert.ok(rel && rel.relevance > 0 && rel.relevance < 1, '弱匹配：分数低但不是零')
})

test('精确 bigram 压过单字兜底', () => {
  const exact = node({ text: '吃饭要按时' })
  const fuzzy = node({ text: '吃过中饭了，胃里踏实一点' })
  const hits = searchNodes([exact, fuzzy], '吃饭', { now: NOW })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].node, exact, '整词命中的排前面')
})

test('df 恒正：每个文档都有的词，idf 缩小但不出负数、不归零', () => {
  const nodes = [node({ text: '账本要能翻' }), node({ text: '账本要能查' }), node({ text: '账本要能背' })]
  const rels = rankByQuery(nodes, '账本')
  assert.equal(rels.size, 3)
  for (const r of rels.values()) assert.ok(r.bm25 > 0, 'idf 恒正，分数为正')
})

test('字段权重：标签里的命中比正文里的命中贵', () => {
  const tagged = node({ text: '随口一提的事', tags: '插件' })
  const inBody = node({ text: '插件的事写在这里，重复重复重复重复重复重复重复重复重复重复' })
  const hits = searchNodes([tagged, inBody], '插件', { now: NOW })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].node, tagged, '标签命中排前面（1.4 > 1.0，正文堆再长也不稀释）')
})

test('零命中不在结果里，空词走分量排名', () => {
  const nodes = [node({ text: '一条事' }), node({ text: '另一条事' })]
  assert.equal(searchNodes(nodes, '完全对不上', { now: NOW }).length, 0)
  assert.equal(searchNodes(nodes, '', { now: NOW }).length, 2)
})

test('技能在哪学的也翻得到（skillWhere 字段）', () => {
  const n = node({ text: '拆会话帧这门手艺', kind: 'skill', contexts: [{ where: 'E:\\示例\\Plugin' }] })
  assert.equal(searchNodes([n, node({ text: '别的事' })], '示例', { now: NOW }).length, 1)
})

test('同一天重放同一个结果（确定性）', () => {
  const nodes = [node({ text: '吃过中饭了' }), node({ text: '吃饭要按时' }), node({ text: '别的事' })]
  const a = searchNodes(nodes, '吃饭', { now: NOW }).map((h) => h.node.id)
  const b = searchNodes(nodes, '吃饭', { now: NOW }).map((h) => h.node.id)
  assert.deepEqual(a, b)
})

test('数字串查询：群号、版本号精确命中', () => {
  const n = node({ text: '他邀我进的群 222222222，我点头进去了' })
  assert.equal(searchNodes([n, node({ text: '别的事' })], '222222222', { now: NOW }).length, 1)
})

// ---------------------------------------------------------------------------
// 同义改述对表（QUERY_PAIRS）：组内命中任一，同组其它说法互相命中
// ---------------------------------------------------------------------------

test('同义改述组：组内命中任一，同组其它说法以 0.6 权重补进候选', () => {
  const 记忆 = expandQuery([{ t: '记性', w: 1.0 }])
  assert.ok(记忆.some((x) => x.t === '记忆' && x.w === 0.6), JSON.stringify(记忆))
  const 账 = expandQuery([{ t: '账本', w: 1.0 }])
  assert.ok(账.some((x) => x.t === '记账' && x.w === 0.6), JSON.stringify(账))
  const 群 = expandQuery([{ t: '群聊', w: 1.0 }])
  assert.ok(群.some((x) => x.t === '群里' && x.w === 0.6), JSON.stringify(群))
  const 心情 = expandQuery([{ t: '情绪', w: 1.0 }])
  assert.ok(心情.some((x) => x.t === '心情' && x.w === 0.6), JSON.stringify(心情))
  const 记录 = expandQuery(splitTerms('聊天记录'))
  assert.ok(记录.some((x) => x.t === '会话' && x.w === 0.6), JSON.stringify(记录))
})

test('长说法要求整句在：半句不算命中，也不乱补', () => {
  const half = expandQuery(splitTerms('脑子里'))
  assert.ok(!half.some((x) => x.t === '记忆' || x.t === '记性'), JSON.stringify(half))
  const whole = expandQuery(splitTerms('脑子里存着的'))
  assert.ok(whole.some((x) => x.t === '记性' && x.w === 0.6), JSON.stringify(whole))
})

test('改述一：记性 → 脑子里存着的（没有共同字，全靠对表搭上）', () => {
  const nodes = [node({ text: '我脑子里存着的那些事' }), node({ text: '紫罗兰色的雨伞' })]
  const hits = searchNodes(nodes, '记性', { now: NOW })
  assert.equal(hits.length, 1, '只有那条翻得到')
  assert.equal(hits[0].node.text, '我脑子里存着的那些事')
})

test('改述二：心情 → 情绪', () => {
  const nodes = [node({ text: '情绪有点闷' }), node({ text: '紫罗兰色的雨伞' })]
  const hits = searchNodes(nodes, '心情', { now: NOW })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].node.text, '情绪有点闷')
})

test('改述三：验收 → 查账', () => {
  const nodes = [node({ text: '查账的时候发现两处对不上' }), node({ text: '紫罗兰色的雨伞' })]
  const hits = searchNodes(nodes, '验收', { now: NOW })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].node.text, '查账的时候发现两处对不上')
})

test('改述四：卡住 → 不动了', () => {
  const nodes = [node({ text: '它不动了，进程还挂着' }), node({ text: '紫罗兰色的雨伞' })]
  const hits = searchNodes(nodes, '卡住', { now: NOW })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].node.text, '它不动了，进程还挂着')
})

test('改述五：程序 → 写的东西', () => {
  const nodes = [node({ text: '我把我写的东西都记下来了' }), node({ text: '紫罗兰色的雨伞' })]
  const hits = searchNodes(nodes, '程序', { now: NOW })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].node.text, '我把我写的东西都记下来了')
})

test('改述六：账本 ↔ 记账、群里 ↔ 群聊（互相命中）', () => {
  const 账 = [node({ text: '我给自己记账的那个' }), node({ text: '紫罗兰色的雨伞' })]
  assert.equal(searchNodes(账, '账本', { now: NOW }).length, 1, '账本 → 记账那条')
  const 群 = [node({ text: '大家都在群里说话' }), node({ text: '紫罗兰色的雨伞' })]
  assert.equal(searchNodes(群, '群聊', { now: NOW }).length, 1, '群聊 → 群里那条')
})

test('不误伤：对表只接同义说法，不相干的词照样翻不到', () => {
  const nodes = [node({ text: '今天天气不错' }), node({ text: '紫罗兰色的雨伞' })]
  const hits = searchNodes(nodes, '天气预报', { now: NOW })
  assert.equal(hits.length, 1, '只有真提到天气的那条')
  assert.equal(hits[0].node.text, '今天天气不错')
  assert.equal(searchNodes([node({ text: '紫罗兰色的雨伞' })], '账本', { now: NOW }).length, 0, '扩展不拽不相干的条')
  assert.equal(searchNodes(nodes, '完全对不上', { now: NOW }).length, 0, '没命中词组就一点不给')
})

test('坏表值不崩不误伤：空串、非字符串、不是数组的行都跳过', () => {
  const saved = QUERY_PAIRS.length
  QUERY_PAIRS.push(null, '不是数组', [], [''], [null, 123], ['记忆', null], ['  ', '记忆'])
  try {
    const out = expandQuery([{ t: '记性', w: 1.0 }])
    assert.ok(out.some((x) => x.t === '记忆' && x.w === 0.6), '好行照常生效')
    assert.ok(!out.some((x) => typeof x.t !== 'string' || !x.t), '没有空词条混进来')
    assert.ok(!out.some((x) => x.t === '123' || x.t === 'null' || x.t === '不是数组'), '坏值没被当词条')
    assert.deepEqual(expandQuery(undefined), [], '连输入是坏值也不崩')
    assert.deepEqual(expandQuery([null, { t: 5 }]), [], '词条本身是坏值也不崩')
  } finally {
    QUERY_PAIRS.length = saved
  }
})

