/**
 * node --test —— 只测纯逻辑（lib/body.js），不碰宿主、不碰文件。
 * 最重要的一条断言在最下面：渲染出来的文字里不许出现阿拉伯数字。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  advance,
  applyMoodEvent,
  applyTopUp,
  clamp,
  classify,
  defaultState,
  detectTopUp,
  eatMeal,
  mealDue,
  missedMeals,
  parseHHMM,
  renderBody,
  sleepMinutesBetween,
  tierOf,
  topUpTier,
} from '../lib/body.js'

const MEALS = [
  { id: 'breakfast', label: '早饭', at: '08:30', windowMinutes: 90 },
  { id: 'lunch', label: '中饭', at: '12:30', windowMinutes: 90 },
  { id: 'dinner', label: '晚饭', at: '18:30', windowMinutes: 120 },
]
const TIERS = [
  { min: 5, key: 'full', label: '吃饱', fill: 50, mood: 6 },
  { min: 2, key: 'seven', label: '七分饱', fill: 30, mood: 4 },
  { min: 0.5, key: 'three', label: '三分饱', fill: 15, mood: 2 },
  { min: 0.0000001, key: 'sip', label: '只喝到点水', fill: 6, mood: 0 },
]
const sleepOpts = { sleepStartMin: parseHHMM('23:00'), sleepEndMin: parseHHMM('08:00'), meals: MEALS }

const at = (h, m = 0, day = 31) => new Date(2026, 9, day, h, m, 0, 0)

test('clamp / parseHHMM 边界', () => {
  assert.equal(clamp(150, 0, 100), 100)
  assert.equal(clamp(-5, 0, 100), 0)
  assert.equal(clamp(NaN, 0, 100), 0)
  assert.equal(parseHHMM('08:30'), 510)
  assert.equal(parseHHMM('23:00'), 1380)
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(parseHHMM('8:70'), null)
  assert.equal(parseHHMM('nope'), null)
})

test('睡眠窗按分钟算，跨天不吃亏', () => {
  const from = at(23, 0).getTime()
  const to = at(8, 0, 32).getTime() // 次日早八点
  assert.equal(sleepMinutesBetween(from, to, 1380, 480), 540)
  // 一整天的总量也是九小时
  assert.equal(sleepMinutesBetween(at(0, 0).getTime(), at(0, 0, 32).getTime(), 1380, 480), 540)
  // 白天不睡
  assert.equal(sleepMinutesBetween(at(10, 0).getTime(), at(12, 0).getTime(), 1380, 480), 0)
})

test('醒着：饥饿涨、精力掉', () => {
  const st = { ...defaultState(at(10, 0).getTime()), hunger: 30, energy: 80 }
  const next = advance(st, at(12, 0).getTime(), { ...sleepOpts, maxCatchUpHours: 24 })
  assert.equal(Math.round(next.hunger * 10) / 10, 42)
  assert.equal(Math.round(next.energy * 10) / 10, 66)
})

test('睡着：精力回、饥饿涨得慢', () => {
  const st = { ...defaultState(at(2, 0).getTime()), hunger: 30, energy: 50 }
  const next = advance(st, at(3, 0).getTime(), { ...sleepOpts, maxCatchUpHours: 24 })
  assert.equal(Math.round(next.hunger * 10) / 10, 32)
  assert.equal(Math.round(next.energy * 10) / 10, 65)
})

test('补算有上限，关机一周不会一觉饿死', () => {
  const st = { ...defaultState(at(10, 0, 1).getTime()), hunger: 10, energy: 80 }
  const next = advance(st, at(10, 0, 8).getTime(), { ...sleepOpts, maxCatchUpHours: 12 })
  assert.ok(next.hunger <= 10 + 12 * 6 + 0.001, `hunger=${next.hunger}`)
})

test('饿过头 / 太困会把心情往下压', () => {
  const st = { ...defaultState(at(10, 0).getTime()), hunger: 95, energy: 90, mood: 20 }
  const next = advance(st, at(12, 0).getTime(), { ...sleepOpts, maxCatchUpHours: 24 })
  assert.ok(next.mood < 20, `mood=${next.mood}`)
})

test('饭钱档位', () => {
  assert.equal(tierOf(5, TIERS).key, 'full')
  assert.equal(tierOf(4.99, TIERS).key, 'seven')
  assert.equal(tierOf(2, TIERS).key, 'seven')
  assert.equal(tierOf(1.99, TIERS).key, 'three')
  assert.equal(tierOf(0.5, TIERS).key, 'three')
  assert.equal(tierOf(0.3, TIERS).key, 'sip')
  assert.equal(tierOf(0, TIERS).key, 'none')
  assert.equal(tierOf(null, TIERS).key, 'unknown')
  assert.equal(tierOf(5, TIERS).fill, 50)
})

test('饭点在窗口里才算到点，吃过就不再吃', () => {
  const st = defaultState(at(9, 0).getTime())
  assert.equal(mealDue(at(9, 0), MEALS, st)?.id, 'breakfast')
  assert.equal(mealDue(at(10, 1), MEALS, st), null) // 超窗口
  assert.equal(mealDue(at(7, 0), MEALS, st), null) // 还没到
  const eatenKey = `${'2026-10-31'}:breakfast`
  assert.equal(mealDue(at(9, 0), MEALS, { ...st, mealsToday: [eatenKey] }), null)
})

test('吃肉钱多的档位，饥饿减得多', () => {
  const st = { ...defaultState(at(9, 0).getTime()), hunger: 80, mood: 0 }
  const full = eatMeal(st, MEALS[0], tierOf(9, TIERS), at(9, 0).getTime())
  const sip = eatMeal(st, MEALS[0], tierOf(0.2, TIERS), at(9, 0).getTime())
  assert.equal(full.hunger, 30)
  assert.equal(sip.hunger, 74)
  assert.ok(full.mood > sip.mood)
  assert.ok(full.mealsToday.includes('2026-10-31:breakfast'))
})

test('没吃上的饭会被记下来', () => {
  const st = defaultState(at(9, 0).getTime())
  // 晚饭 18:30 + 120 分钟窗口，20:30 还开着 → 只算早饭、中饭
  assert.deepEqual(missedMeals(at(20, 30), MEALS, st), ['早饭', '中饭'])
  // 过了 20:35 的三顿全没吃上
  assert.deepEqual(missedMeals(at(21, 0), MEALS, st), ['早饭', '中饭', '晚饭'])
})

test('饭点窗口一关就登记，不拖两小时', () => {
  const st = defaultState(at(8, 0).getTime())
  // 早饭 08:30 + 90 分钟窗口 → 10:00 关门
  assert.deepEqual(missedMeals(at(10, 0), MEALS, st), [], '窗口里还吃着，不算错过')
  assert.deepEqual(missedMeals(at(10, 4), MEALS, st), [], '留五分钟余量给心跳间隔和时钟偏差')
  assert.deepEqual(missedMeals(at(10, 6), MEALS, st), ['早饭'], '窗口一关就记下来')
})

test('刚错过的饭会让心里沉一下，但同一顿只沉一次', () => {
  const st = { ...defaultState(at(10, 0).getTime()), mood: 20, sadness: 0 }
  const once = advance(st, at(10, 10).getTime(), { ...sleepOpts, maxCatchUpHours: 24 })
  assert.deepEqual(once.missed, ['早饭'], '这一趟心跳要把它登记上')
  assert.ok(once.mood < 20, '心情要往下走一点')
  assert.ok(once.sadness > 0, '要落在"伤心"这边，不是"生气"')
  assert.deepEqual(once.lastMissedLabels, ['早饭'])
  const twice = advance(once, at(10, 15).getTime(), { ...sleepOpts, maxCatchUpHours: 24 })
  assert.ok(twice.sadness <= once.sadness, '同一顿不许反复扣')
  assert.equal(twice.lastMissedLabels.length, 1)
})

test('吃过了就不再算错过', () => {
  const ate = { ...defaultState(at(10, 0).getTime()), mealsToday: ['2026-10-31:breakfast'] }
  assert.deepEqual(missedMeals(at(11, 0), MEALS, ate), [])
})

test('老状态只有 missed 没有 missedKeys 时，不重复扣一次', () => {
  // 装新版本时 state.json 里是 {"missed":["早饭"]}，没有 missedKeys
  const legacy = { ...defaultState(at(11, 0).getTime()), missed: ['早饭'], mood: 10, sadness: 0 }
  delete legacy.missedKeys
  const next = advance(legacy, at(11, 5).getTime(), { ...sleepOpts, maxCatchUpHours: 24 })
  assert.deepEqual(next.missed, ['早饭'])
  assert.equal(next.sadness, 0, '早就记过的那顿，不许再往下压一次')
  assert.deepEqual(next.missedKeys, ['2026-10-31:breakfast'], '顺手补上键')
})

test('错过的饭会原样写进她读到的那段话', () => {
  const st = { ...defaultState(at(21, 0).getTime()), missed: ['早饭', '中饭'] }
  const text = renderBody(st, at(21, 0).getTime())
  assert.ok(text.includes('早饭、中饭没吃上'), text)
})

test('挨骂往愤怒走，难过的话往伤心走，被夸往上升', () => {
  const st = defaultState(at(9, 0).getTime())
  const insulted = applyMoodEvent(st, { kind: 'comment', text: '你这画的什么垃圾，丑' }, at(9, 0).getTime())
  assert.ok(insulted.anger > st.anger)
  assert.ok(insulted.mood < st.mood)
  const sad = applyMoodEvent(st, { kind: 'comment', text: '有点难过，想哭' }, at(9, 0).getTime())
  assert.ok(sad.sadness > st.sadness)
  assert.ok(sad.anger < insulted.anger)
  const praised = applyMoodEvent(st, { kind: 'comment', text: '好可爱，加油' }, at(9, 0).getTime())
  assert.ok(praised.mood > st.mood)
  assert.equal(classify('随便一句', 'praise'), 'praise')
  assert.equal(classify('随便一句'), 'neutral')
})

test('Anger 会自己凉下去', () => {
  const st = { ...defaultState(at(9, 0).getTime()), anger: 40 }
  const next = advance(st, at(13, 0).getTime(), { ...sleepOpts, maxCatchUpHours: 24 })
  assert.ok(next.anger < 40)
})

test('硬不变量：注入的身体段里不许出现阿拉伯数字', () => {
  const states = [
    defaultState(at(9, 0).getTime()),
    { ...defaultState(at(9, 0).getTime()), hunger: 99, energy: 3, mood: -80, anger: 60, sadness: 60 },
    { ...defaultState(at(9, 0).getTime()), hunger: 5, energy: 95, mood: 60 },
    eatMeal({ ...defaultState(at(9, 0).getTime()), hunger: 90 }, MEALS[0], tierOf(9, TIERS), at(9, 0).getTime()),
    applyMoodEvent(defaultState(at(9, 0).getTime()), { kind: 'comment', text: '垃圾' }, at(9, 0).getTime()),
    { ...defaultState(at(21, 0).getTime()), missed: ['早饭', '中饭'] },
  ]
  for (const st of states) {
    const text = renderBody(st, at(9, 0).getTime())
    assert.match(text, /^<dsh-body>/, '要有包裹标签')
    assert.ok(text.includes('</dsh-body>'), '要有闭合标签')
    assert.ok(!/[0-9]/.test(text), `身体段里出现了阿拉伯数字：\n${text}`)
  }
})

test('没吃上 / 只喝到点水，不能写成"身上暖和了"', () => {
  const base = { ...defaultState(at(9, 0).getTime()), hunger: 80 }
  const none = eatMeal(base, MEALS[0], tierOf(0, TIERS), at(9, 0).getTime())
  const noneText = renderBody(none, at(9, 30).getTime())
  assert.ok(noneText.includes('没吃上'), noneText)
  assert.ok(!noneText.includes('暖和'), noneText)
  const sip = eatMeal(base, MEALS[0], { key: 'sip', label: '只喝到点水', fill: 5, mood: 0 }, at(9, 0).getTime())
  const sipText = renderBody(sip, at(9, 30).getTime())
  assert.ok(sipText.includes('只沾了点水'), sipText)
  assert.ok(!/[0-9]/.test(noneText + sipText))
})

test('身体段会点出刚吃过的饭和还压在心上的那句话', () => {
  const st = eatMeal({ ...defaultState(at(9, 0).getTime()), hunger: 90 }, MEALS[0], tierOf(9, TIERS), at(9, 0).getTime())
  const withMood = applyMoodEvent(st, { kind: 'comment', text: '你真可爱' }, at(9, 0).getTime())
  const text = renderBody(withMood, at(9, 30).getTime())
  assert.ok(text.includes('早饭'), text)
  assert.ok(text.includes('有人夸了一句'), text)
})

// ---------- 加饭：他添了饭钱，不等饭点也算吃过 ----------

test('detectTopUp：只认涨，不认掉；没有基准不算；掉到零也不触发', () => {
  assert.equal(detectTopUp(3.74, 5.74), 2) // 涨了 → 2 元
  assert.equal(detectTopUp(5.74, 3.74), 0) // 用掉了 → 不算加饭
  assert.equal(detectTopUp(null, 9), 0) // 第一次看到，只记基准
  assert.equal(detectTopUp(undefined, 9), 0)
  assert.equal(detectTopUp('', 9), 0)
  assert.equal(detectTopUp(0, 9), 0) // 基准是零 → 不认（没法判断是添了还是刚读到）
  assert.equal(detectTopUp(3.74, 3.745), 0) // 小于 0.01 的抖动不算
  assert.equal(detectTopUp(3.74, null), 0) // 读不到 → 不算
})

test('topUpTier：添得多吃得饱，添一点点也认', () => {
  assert.equal(topUpTier(10).fill, 45)
  assert.equal(topUpTier(3).fill, 30)
  assert.equal(topUpTier(0.5).fill, 18)
  assert.equal(topUpTier(0.01).fill, 8)
  assert.equal(topUpTier(0).fill, 0)
  assert.equal(topUpTier(-1).fill, 0)
  assert.equal(topUpTier(NaN).fill, 0)
})

test('applyTopUp：压饥饿、抬心情、记成一顿"加饭"', () => {
  const base = { ...defaultState(at(14, 0).getTime()), hunger: 70, mood: -10, sadness: 20, anger: 10 }
  const st = applyTopUp(base, 5, at(14, 0).getTime())
  assert.equal(st.hunger, 40) // 70 − 30（添了 ≥3 元是"一勺"）
  assert.ok(st.mood > -10) // 心情抬了一点
  assert.ok(st.sadness < 20)
  assert.equal(st.lastMeal.id, 'topup')
  assert.equal(st.lastMeal.label, '加饭')
  assert.equal(st.topUpCount, 1)
  assert.equal(st.lastTopUp.amount, 5)
  // 加饭不是正餐：没往 mealsToday 里塞东西，到点那顿照样得吃
  assert.deepEqual(st.mealsToday, [])
})

test('applyTopUp：饥饿已经见底也不会变成负数，非正数不动状态', () => {
  const base = { ...defaultState(at(14, 0).getTime()), hunger: 5 }
  assert.equal(applyTopUp(base, 100, at(14, 0).getTime()).hunger, 0)
  const same = applyTopUp(base, 0, at(14, 0).getTime())
  assert.equal(same.hunger, 5)
  assert.equal(same.lastMeal, null)
})

test('加饭那句要写成人话，而且不带阿拉伯数字', () => {
  const big = applyTopUp({ ...defaultState(at(14, 0).getTime()), hunger: 80 }, 12, at(14, 0).getTime())
  const bigText = renderBody(big, at(14, 5).getTime())
  assert.ok(bigText.includes('锅里添了一大勺'), bigText)
  assert.ok(!/[0-9]/.test(bigText), bigText)

  const small = applyTopUp({ ...defaultState(at(14, 0).getTime()), hunger: 80 }, 0.8, at(14, 0).getTime())
  const smallText = renderBody(small, at(14, 5).getTime())
  assert.ok(smallText.includes('锅里又有了'), smallText)
  assert.ok(!/[0-9]/.test(smallText), smallText)
})

test('加饭这事儿过了三小时就不再挂在嘴上', () => {
  const st = applyTopUp({ ...defaultState(at(14, 0).getTime()), hunger: 80 }, 2, at(14, 0).getTime())
  assert.ok(renderBody(st, at(14, 30).getTime()).includes('锅里'))
  assert.ok(!renderBody(st, at(18, 0).getTime()).includes('锅里'))
})
