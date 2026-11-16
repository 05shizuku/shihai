import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BASE_SCALE,
  DEFAULT_EMOTION_SEED,
  EMOTION_KINDS,
  EMOTION_LABEL,
  emotionCoefficients,
  emotionDelta,
  emotionEventId,
  emotionRelTime,
  foldEmotion,
  emotionFeelPhrase,
  intensityScale,
  normEmotionLine,
  recognizeEmotion,
  renderEmotionLine,
  renderEmotionNote,
} from '../lib/emotion.js'

const NOW = 1_700_000_000_000

test('情绪枚举：固定七个，各有中文名', () => {
  assert.equal(EMOTION_KINDS.length, 7)
  for (const kind of EMOTION_KINDS) {
    assert.ok(EMOTION_LABEL[kind], `${kind} 缺标签`)
  }
  assert.equal(EMOTION_LABEL.calm, '平静')
})

test('认情绪：意图层那十一类各归各的，认不出的不给情绪', () => {
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'praise', intensity: 4 }).emotion, 'pleased')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'agree', intensity: 3 }).emotion, 'pleased')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'greet', intensity: 2 }).emotion, 'warm')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'invite', intensity: 3 }).emotion, 'warm')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'share', intensity: 2 }).emotion, 'warm')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'teach', intensity: 3 }).emotion, 'curious')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'ask', intensity: 2 }).emotion, 'curious')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'conflict', intensity: 3 }).emotion, 'tense')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'criticize', intensity: 4 }).emotion, 'tense')
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'farewell', intensity: 2 }).emotion, 'lonely')
  // 认不出就不给 —— 宁可漏，不可编
  assert.equal(recognizeEmotion({ source: 'intent', kind: 'other', intensity: 1 }), null)
  assert.equal(recognizeEmotion({ source: 'intent', kind: '不存在的类', intensity: 1 }), null)
})

test('认情绪：身体那边的心情看 detail.kind', () => {
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'mood', detailKind: 'praise' }).emotion, 'pleased')
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'mood', detailKind: 'insult' }).emotion, 'tense')
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'mood', detailKind: 'sad' }).emotion, 'down')
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'mood', detailKind: 'comment' }), null)
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'mood', detail: { kind: 'praise' } }).emotion, 'pleased')
})

test('认情绪：快层那几类各归各的', () => {
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'topup' }).emotion, 'warm')
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'meal' }).emotion, 'warm')
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'missed' }).emotion, 'down')
  assert.equal(recognizeEmotion({ source: 'fast', kind: 'threshold' }).emotion, 'restless')
  // 账本被翻
  assert.equal(recognizeEmotion({ source: 'recall', ref: 'r_1' }).emotion, 'warm')
  // 不认识的源不给情绪
  assert.equal(recognizeEmotion({ source: '不知道哪儿来的' }), null)
})

test('强度换算：1 → 0.6，3 → 1.0，5 → 1.4，坏值回落', () => {
  assert.equal(intensityScale(1), 0.6)
  assert.equal(intensityScale(3), 1.0)
  assert.equal(intensityScale(5), 1.4)
  assert.equal(intensityScale(99), 1.4)
  assert.equal(intensityScale(-4), 0.6)
  assert.equal(intensityScale('瞎写的'), 0.6)
})

test('涨多少：强度、基数、系数三样都算进去', () => {
  const d = emotionDelta({ source: 'intent', kind: 'praise', intensity: 5, ref: 'i_1' }, { now: NOW })
  // base 1.0 × 强度 1.4 × 系数 1.0 × BASE_SCALE
  assert.equal(d.delta, Math.round(1 * 1.4 * DEFAULT_EMOTION_SEED.pleased.coefficient * BASE_SCALE * 1000) / 1000)
  assert.equal(d.emotion, 'pleased')
  assert.equal(emotionDelta({ source: 'intent', kind: 'other', intensity: 3 }, { now: NOW }), null)
})

test('身份：同一条事永远同一个 id，不同的事不同 id', () => {
  const a = emotionEventId({ source: 'intent', ref: 'i_abc' })
  const b = emotionEventId({ source: 'intent', ref: 'i_abc' })
  const c = emotionEventId({ source: 'intent', ref: 'i_xyz' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^e_[0-9a-z]+$/)
})

test('日志行：坏行给 null，好行归一', () => {
  assert.equal(normEmotionLine(null), null)
  assert.equal(normEmotionLine({ kind: 'event', at: 0, emotion: 'warm', delta: 0.1 }), null)
  assert.equal(normEmotionLine({ kind: 'event', at: NOW, emotion: '不在枚举里', delta: 0.1 }), null)
  assert.equal(normEmotionLine({ kind: 'event', at: NOW, emotion: 'warm', delta: 0 }), null)
  assert.equal(normEmotionLine({ kind: 'tune', at: NOW, emotion: 'warm', to: 1.2 }), null) // 没理由不行
  const ev = normEmotionLine({ kind: 'event', at: NOW, source: 'intent', ref: 'i_1', emotion: 'pleased', delta: 0.25, intensity: 5, text: '你太厉害了！' })
  assert.equal(ev.emotion, 'pleased')
  assert.equal(ev.delta, 0.25)
  assert.equal(ev.text, '你太厉害了！')
  const tune = normEmotionLine({ kind: 'tune', at: NOW, emotion: 'tense', from: 1, to: 1.2, reason: '今天被骂得比预想重' })
  assert.equal(tune.to, 1.2)
  assert.equal(tune.reason, '今天被骂得比预想重')
})

test('系数表：种子 + 日志里的 tune', () => {
  const base = emotionCoefficients([])
  assert.equal(base.tense.coefficient, DEFAULT_EMOTION_SEED.tense.coefficient)
  const tuned = emotionCoefficients([
    { at: NOW - 1000, kind: 'tune', emotion: 'tense', to: 1.5, reason: '挨骂那回我反应太大' },
  ])
  assert.equal(tuned.tense.coefficient, 1.5)
  assert.equal(tuned.warm.coefficient, DEFAULT_EMOTION_SEED.warm.coefficient)
})

test('折状态：一条事件进对应情绪，过一阵会淡', () => {
  const line = { at: NOW, kind: 'event', source: 'intent', ref: 'i_1', emotion: 'pleased', delta: 0.25, intensity: 5 }
  const fresh = foldEmotion([line], { now: NOW })
  assert.equal(fresh.levels.pleased, 0.25)
  assert.equal(fresh.dominant, 'pleased')
  assert.equal(fresh.label, '高兴')
  assert.equal(fresh.total, 1)
  // 过了两个半衰期（pleased 60 分钟）就只剩四分之一
  const later = foldEmotion([line], { now: NOW + 120 * 60000 })
  assert.ok(later.levels.pleased < 0.07 && later.levels.pleased > 0.05, `实际 ${later.levels.pleased}`)
  // 再淡下去就看不出来��了
  const muchLater = foldEmotion([line], { now: NOW + 300 * 60000 })
  assert.ok(muchLater.levels.pleased < 0.05, `实际 ${muchLater.levels.pleased}`)
  assert.equal(muchLater.dominant, 'calm')
})

test('折状态：什么都没发生就是平静', () => {
  const s = foldEmotion([], { now: NOW })
  assert.equal(s.dominant, 'calm')
  assert.equal(s.label, '平静')
  assert.equal(s.total, 0)
})

test('折状态：只认 event 行，tune 行不进状态', () => {
  const s = foldEmotion([
    { at: NOW, kind: 'tune', emotion: 'warm', to: 2, reason: '试' },
  ], { now: NOW })
  assert.equal(s.total, 0)
  assert.equal(s.dominant, 'calm')
})

test('相对时间：七档（24-48 是昨天，48-72 是前天）', () => {
  assert.equal(emotionRelTime(NOW, NOW), '刚刚')
  assert.equal(emotionRelTime(NOW - 5 * 60000, NOW), '不久前')
  assert.equal(emotionRelTime(NOW - 30 * 60000, NOW), '一会儿前')
  assert.equal(emotionRelTime(NOW - 5 * 3600000, NOW), '今天早些时候')
  assert.equal(emotionRelTime(NOW - 30 * 3600000, NOW), '昨天')
  assert.equal(emotionRelTime(NOW - 60 * 3600000, NOW), '前天')
  assert.equal(emotionRelTime(NOW - 72 * 3600000, NOW), '前几天')
})

test('给谁看的：一行情绪 + 一句笔记', () => {
  const line = { at: NOW, kind: 'event', source: 'intent', ref: 'i_1', emotion: 'pleased', delta: 0.25, intensity: 5, text: '你太厉害了！' }
  const rendered = renderEmotionLine(line, NOW)
  assert.match(rendered, /情绪·高兴/)
  assert.match(rendered, /你太厉害了！/)
  assert.match(rendered, /刚刚/)
  const state = foldEmotion([line], { now: NOW })
  const note = renderEmotionNote(state)
  assert.match(note, /上次的笔记/)
  assert.match(note, /高兴/)
  assert.equal(renderEmotionNote(foldEmotion([], { now: NOW })), '')
})


test('foldEmotion：几轴同时满格时，主导用没 clamp 的原始和挑——不让 warm 排第一就永远赢', () => {
  const at = NOW - 5 * 60_000
  const lines = []
  for (const [emotion, n] of [['warm', 2], ['tense', 3]]) {
    for (let i = 0; i < n; i += 1) {
      lines.push({ at, kind: 'event', emotion, delta: 1, intensity: 3, text: `${emotion}-${i}` })
    }
  }
  const s = foldEmotion(lines, { now: NOW })
  assert.equal(s.levels.warm, 1) // 两轴都攒超 1，clamp 满
  assert.equal(s.levels.tense, 1)
  assert.equal(s.dominant, 'tense') // 原始和 tense（3 件）比 warm（2 件）高
  assert.equal(s.label, '紧绷')
  assert.equal(s.level, 1)
})

// ===== whale-card P1-5（饭桶⑤）：说感觉，不报数字 =====

test('emotionFeelPhrase：混着说混着，认不出说说不上来，没事就空串', () => {
  assert.equal(emotionFeelPhrase(null), '')
  assert.equal(emotionFeelPhrase({ dominant: 'calm' }), '', '真没动静就是没事')
  assert.equal(emotionFeelPhrase({ dominant: 'calm', unresolved: true }), '这我说不上来', '有事过但认不出')
  assert.equal(emotionFeelPhrase({ dominant: 'warm', levels: { warm: 0.3 } }), '心里有点被暖着')
  assert.equal(
    emotionFeelPhrase({
      dominant: 'down',
      levels: { down: 0.3, tense: 0.2 },
      mixed: [
        { emotion: 'down', level: 0.3 },
        { emotion: 'tense', level: 0.2 },
      ],
    }),
    '心里混着：沉，还有点紧',
    '两种同时过线就说混着',
  )
})

test('renderEmotionNote（P1-5）：认不出说「说不上来」，不写「平静」也不报小数', () => {
  assert.equal(renderEmotionNote(null), '')
  assert.equal(renderEmotionNote({ dominant: 'calm' }), '', 'calm 没动静就不出笔记')
  const unsure = renderEmotionNote({ dominant: 'calm', unresolved: true })
  assert.ok(unsure.includes('说不上来'), `实际 ${unsure}`)
  assert.ok(!unsure.includes('0.'), '笔记里没有小数')
  const mixed = renderEmotionNote({
    dominant: 'down',
    levels: { down: 0.3, tense: 0.2 },
    mixed: [
      { emotion: 'down', level: 0.3 },
      { emotion: 'tense', level: 0.2 },
    ],
  })
  assert.ok(mixed.includes('混着'), `实际 ${mixed}`)
  assert.ok(mixed.includes('（上次的笔记）'), '还是上次的笔记的口气')
  assert.ok(!mixed.includes('0.'), '不报小数')
})

test('foldEmotion：mixed / unresolved 一起折出来', () => {
  const at = NOW - 5 * 60_000
  const lines = [
    { at, kind: 'event', emotion: 'down', delta: 0.3, intensity: 3, text: 'down-1' },
    { at, kind: 'event', emotion: 'tense', delta: 0.2, intensity: 3, text: 'tense-1' },
  ]
  const s = foldEmotion(lines, { now: NOW })
  assert.equal(s.dominant, 'down')
  assert.equal(s.unresolved, false, '认得出就不叫 unresolved')
  assert.equal(s.mixed.length, 2, '两条都过线')
  assert.equal(s.mixed[0].emotion, 'down')
  assert.equal(s.mixed[1].emotion, 'tense')
})

test('foldEmotion：有事过但全淡得认不出 → unresolved（说不上来，不是「平静」）', () => {
  const line = { at: NOW, kind: 'event', emotion: 'pleased', delta: 0.06, intensity: 1, text: '淡淡的高兴' }
  const later = foldEmotion([line], { now: NOW + 240 * 60000 }) // pleased 半衰期 60 分，4 个半衰期后剩 1/16
  assert.equal(later.dominant, 'calm')
  assert.equal(later.total, 1, '事件发生过（total 数的是事件）')
  assert.equal(later.unresolved, true, '有事过、认不出 → unresolved')
  assert.ok(later.levels.pleased < 0.05, `实际 ${later.levels.pleased}`)
})
