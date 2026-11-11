// 意图层单测：分类必须确定、可复现、认不出就是 other。
// 原则：宁可漏，不可编 —— 认不出来不许硬套一个类型。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INTENT_KINDS,
  INTENT_LABEL,
  classifyIntent,
  intentEventFromMessage,
  intentEventId,
  intentIdFromMessage,
  intentRelTime,
  makeIntentEvent,
  normIntentEvent,
  normalizeForIntent,
  pushIntentIndex,
  renderIntentLine,
  searchIntentEvents,
  summarizeIntents,
} from '../lib/intent.js'

test('意图类型是固定枚举，每一类都有中文标签', () => {
  assert.equal(INTENT_KINDS.length, 11)
  assert.equal(INTENT_KINDS[0], 'farewell')
  assert.equal(INTENT_KINDS[INTENT_KINDS.length - 1], 'other')
  for (const k of INTENT_KINDS) assert.equal(typeof INTENT_LABEL[k], 'string')
})

test('空文本和空白文本：认不出来，强度 0', () => {
  for (const t of ['', '   ', null, undefined]) {
    const r = classifyIntent(t)
    assert.equal(r.kind, 'other')
    assert.equal(r.intensity, 0)
  }
})

test('招呼、告别、赞美、冲突、批评，各归各的类', () => {
  assert.equal(classifyIntent('在吗').kind, 'greet')
  assert.equal(classifyIntent('晚安').kind, 'farewell')
  assert.equal(classifyIntent('你太厉害了！').kind, 'praise')
  assert.equal(classifyIntent('别废话，气死了').kind, 'conflict')
  assert.equal(classifyIntent('你错了').kind, 'criticize')
})

test('提问、赞同、分享、邀请、教我，也能分开', () => {
  assert.equal(classifyIntent('你是怎么想的？').kind, 'ask')
  assert.equal(classifyIntent('收到').kind, 'agree')
  assert.equal(classifyIntent('我吃了晚饭').kind, 'share')
  assert.equal(classifyIntent('一起来玩').kind, 'invite')
  assert.equal(classifyIntent('你得记住').kind, 'teach')
})

test('认不出来就说认不出来，不硬套类型', () => {
  const r = classifyIntent('哈哈哈')
  assert.equal(r.kind, 'other')
  assert.equal(r.intensity, 1)
})

test('强度：告别和重话底子重，问句轻', () => {
  assert.equal(classifyIntent('晚安').intensity, 3)
  assert.equal(classifyIntent('你错了').intensity, 3)
  assert.equal(classifyIntent('你是怎么想的？').intensity, 2)
})

test('加强词和感叹号会抬高强度，但封顶 5', () => {
  assert.equal(classifyIntent('你太厉害了！').intensity, 5)
  assert.equal(classifyIntent('你太厉害了！！！！！').intensity, 5)
})

test('又夸又骂：矛盾本身算强度', () => {
  const r = classifyIntent('厉害，但是不对')
  assert.equal(r.kind, 'praise')
  assert.equal(r.intensity, 4)
})

test('同一句话永远同一个结果（可重放）', () => {
  const a = classifyIntent('你太厉害了！')
  const b = classifyIntent('你太厉害了！')
  assert.deepEqual(a, b)
})

test('命中的词记下来，能指着规则查', () => {
  const r = classifyIntent('晚安')
  assert.ok(r.matched.includes('晚安'))
  assert.ok(r.score > 0)
})

test('normalizeForIntent 去掉零宽字符和多余空白', () => {
  assert.equal(normalizeForIntent('  a\u200b b  '), 'a b')
  assert.equal(normalizeForIntent('x'.repeat(300)).length, 200)
})

test('makeIntentEvent：空文本给 null，正常文本字段齐全', () => {
  assert.equal(makeIntentEvent('   '), null)
  const e = makeIntentEvent('晚安', { at: 1000, source: 'qq', chatType: 'private', from: '1000001' })
  assert.equal(e.at, 1000)
  assert.equal(e.kind, 'farewell')
  assert.equal(e.intensity, 3)
  assert.equal(e.text, '晚安')
  assert.equal(e.source, 'qq')
  assert.equal(e.chatType, 'private')
  assert.equal(e.from, '1000001')
  assert.ok(Array.isArray(e.matched))
})

test('summarizeIntents：总数、分类计数、平均强度', () => {
  const s = summarizeIntents([
    { kind: 'ask', intensity: 2 },
    { kind: 'ask', intensity: 4 },
    { kind: 'praise', intensity: 3 },
  ])
  assert.equal(s.total, 3)
  assert.equal(s.byKind.ask, 2)
  assert.equal(s.byKind.praise, 1)
  assert.equal(s.avgIntensity, 3)
  const empty = summarizeIntents([])
  assert.equal(empty.total, 0)
  assert.equal(empty.avgIntensity, 0)
})

// ---------------------------------------------------------------- 身份与接缝

test('身份认的是「那条消息」，不是「我怎么读它」', () => {
  const args = { source: 'qq-bridge', at: 1700000000000, text: '晚安', from: '231', mid: 'm1' }
  const id = intentEventId(args)
  assert.ok(id.startsWith('i_'))
  assert.equal(id, intentEventId({ ...args }))
  // 同一句话、不同时间/来源 → 不同的事
  assert.notEqual(id, intentEventId({ ...args, at: args.at + 1 }))
  assert.notEqual(id, intentEventId({ ...args, source: 'chat' }))
  assert.notEqual(id, intentEventId({ ...args, mid: 'm2' }))
})

test('归一化：坏行给 null，不因为一行坏了丢整批', () => {
  assert.equal(normIntentEvent(null), null)
  assert.equal(normIntentEvent({ text: '有字但没时间' }), null)
  assert.equal(normIntentEvent({ at: 1000, text: '   ' }), null)
  const ev = normIntentEvent({ at: 1000, text: '  你太厉害了！  ', kind: 'praise', intensity: 9 })
  assert.equal(ev.kind, 'praise')
  assert.equal(ev.intensity, 5) // 封顶
  assert.equal(ev.text, '你太厉害了！')
  assert.ok(ev.id.startsWith('i_'))
})

test('归一化：类型不在枚举里就落 other，不编', () => {
  const ev = normIntentEvent({ at: 1000, text: '嗯', kind: 'rage' })
  assert.equal(ev.kind, 'other')
})

test('一条桥消息能认成意图事件：身份、类型、强度都对得上', () => {
  const row = {
    at: 1700000000000,
    chatType: 'private',
    userId: '1000001',
    nickname: '小鱼.',
    text: '晚安',
    mid: '9001',
  }
  const ev = intentEventFromMessage(row)
  assert.ok(ev)
  assert.equal(ev.kind, 'farewell')
  assert.equal(ev.intensity, 3)
  assert.equal(ev.from, '1000001')
  assert.equal(ev.mid, '9001')
  assert.equal(ev.chatType, 'private')
  assert.equal(ev.nickname, '小鱼.')
  assert.equal(ev.id, intentIdFromMessage(row))
  // 空消息、坏时间：一律不认
  assert.equal(intentEventFromMessage({ ...row, text: '  ' }), null)
  assert.equal(intentEventFromMessage({ ...row, at: 0 }), null)
  assert.equal(intentIdFromMessage({ ...row, text: '' }), '')
})

test('索引：同一条只留一份，新的在前，满了挤最老的', () => {
  let idx = []
  idx = pushIntentIndex(idx, { id: 'i_a', at: 100 }, 10)
  idx = pushIntentIndex(idx, { id: 'i_b', at: 200 }, 10)
  idx = pushIntentIndex(idx, { id: 'i_a', at: 300 }, 10)
  assert.equal(idx.length, 2)
  assert.equal(idx[0].id, 'i_a')
  assert.equal(idx[0].at, 300)
  const capped = pushIntentIndex([{ id: 'i_x', at: 1 }, { id: 'i_y', at: 2 }], { id: 'i_z', at: 3 }, 2)
  assert.equal(capped.length, 2)
  assert.equal(capped[0].id, 'i_z')
})

test('相对时间不写数字：刚刚／不久前／一会儿前／今天早些时候／前天／前几天', () => {
  const now = 1700000000000
  const at = (mins) => now - mins * 60000
  assert.equal(intentRelTime(at(0), now), '刚刚')
  assert.equal(intentRelTime(at(10), now), '不久前')
  assert.equal(intentRelTime(at(30), now), '一会儿前')
  assert.equal(intentRelTime(at(600), now), '今天早些时候')
  assert.equal(intentRelTime(at(60 * 30), now), '前天')
  assert.equal(intentRelTime(at(60 * 60 * 5), now), '前几天')
  assert.equal(intentRelTime('坏时间', now), '')
})

test('一行意图事件：标签、轻重、正文、相对时间都在', () => {
  const now = 1700000000000
  const line = renderIntentLine({ id: 'i_a', at: now, kind: 'praise', intensity: 5, text: '你太厉害了！' }, now)
  assert.ok(line.includes('意图'))
  assert.ok(line.includes(INTENT_LABEL.praise))
  assert.ok(line.includes('重'))
  assert.ok(line.includes('你太厉害了！'))
  assert.ok(line.includes('刚刚'))
})

test('按词翻意图事件：词打在正文、类型、标签、来源、来源人上都算', () => {
  const events = [
    { id: 'i_a', at: 100, kind: 'praise', intensity: 3, text: '你太厉害了', source: 'qq-bridge', from: '231' },
    { id: 'i_b', at: 200, kind: 'farewell', intensity: 3, text: '晚安', source: 'qq-bridge', from: '999' },
  ]
  assert.equal(searchIntentEvents(events, '厉害')[0].id, 'i_a')
  assert.equal(searchIntentEvents(events, 'praise')[0].id, 'i_a')
  assert.equal(searchIntentEvents(events, INTENT_LABEL.farewell)[0].id, 'i_b')
  assert.equal(searchIntentEvents(events, '999')[0].id, 'i_b')
  assert.equal(searchIntentEvents(events, '晚安 厉害').length, 0) // 全部词都要命中
  assert.equal(searchIntentEvents(events, '').length, 0)
})

test('按场翻意图事件（v0.15.0 分册）：群号点名、private 只翻私聊、词加场一起用', () => {
  const events = [
    { id: 'i_g1', at: 100, kind: 'praise', intensity: 3, text: '群里的夸', source: 'qq-bridge', chatType: 'group', groupId: '222222222', from: '231' },
    { id: 'i_g2', at: 150, kind: 'ask', intensity: 2, text: '另一群的问', source: 'qq-bridge', chatType: 'group', groupId: '10000', from: '777' },
    { id: 'i_p1', at: 200, kind: 'share', intensity: 3, text: '私聊的分享', source: 'qq-bridge', chatType: 'private', groupId: '', from: '231' },
  ]
  // 群号点名：只翻那个群的
  assert.equal(searchIntentEvents(events, '', { group: '222222222' }).length, 1)
  assert.equal(searchIntentEvents(events, '', { group: '222222222' })[0].id, 'i_g1')
  // private 只翻私聊
  assert.equal(searchIntentEvents(events, '', { group: 'private' }).length, 1)
  assert.equal(searchIntentEvents(events, '', { group: 'private' })[0].id, 'i_p1')
  // 词加场一起用：私聊里有「夸」但场上是群 —— 不给
  assert.equal(searchIntentEvents(events, '夸', { group: '10000' }).length, 0)
  // 词加场一起用：群里按词翻得到
  assert.equal(searchIntentEvents(events, '另一群', { group: '10000' })[0].id, 'i_g2')
  // 不传 group 翻全部（老行为不变）
  assert.equal(searchIntentEvents(events, '的').length, 3)
})
