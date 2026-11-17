/**
 * dsh-reach 单测：只测 lib/reach.js 里的纯逻辑。
 *
 * 磁盘、宿主服务、定时器都不在这里 —— 那些用 tools/smoke.mjs 打假 ctx 跑一遍。
 * 跑法（Windows 上 `node --test test/` 会 MODULE_NOT_FOUND，必须写明文件）：
 *   node --test test/reach.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STATUS,
  applyConfigPatch,
  describeWhen,
  inScope,
  inWindow,
  isDue,
  makeEntry,
  nextCheckInAt,
  parseHHMM,
  parseWhen,
  renderCheckInText,
  renderDeliveryText,
  sanitize,
  toHHMM,
} from '../lib/reach.js'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

// ---------------------------------------------------------------- HH:MM

test('parseHHMM：宽松但不出格', () => {
  assert.equal(parseHHMM('21:30'), 21 * 60 + 30)
  assert.equal(parseHHMM('7:5'), 7 * 60 + 5) // 宽松：不补零也认
  assert.equal(parseHHMM('07：05'), 7 * 60 + 5) // 全角冒号
  assert.equal(parseHHMM(' 09:00 '), 540)
  assert.equal(parseHHMM('00:00'), 0)
  assert.equal(parseHHMM('23:59'), 1439)
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(parseHHMM('21:60'), null)
  assert.equal(parseHHMM('abc'), null)
  assert.equal(parseHHMM(''), null)
  assert.equal(parseHHMM(null), null)
})

test('toHHMM：写回去是两位', () => {
  assert.equal(toHHMM(1290), '21:30')
  assert.equal(toHHMM(0), '00:00')
  assert.equal(toHHMM(425), '07:05')
  assert.equal(toHHMM(99999), '23:59') // 越界夹住，不抛
})

// ---------------------------------------------------------------- 时段

test('inWindow：普通时段与跨夜时段', () => {
  const t = (h, mi = 0) => new Date(2026, 9, 31, h, mi)
  assert.equal(inWindow(540, 1380, t(10)), true) // 09:00–23:00
  assert.equal(inWindow(540, 1380, t(8, 59)), false)
  assert.equal(inWindow(540, 1380, t(23)), false)
  assert.equal(inWindow(540, 1380, t(22, 59)), true)
  // 跨夜 23:00–08:00
  assert.equal(inWindow(1380, 480, t(1)), true)
  assert.equal(inWindow(1380, 480, t(7, 59)), true)
  assert.equal(inWindow(1380, 480, t(8)), false)
  assert.equal(inWindow(1380, 480, t(12)), false)
  assert.equal(inWindow(1380, 480, t(23, 30)), true)
  // 起点等于终点 = 全天
  assert.equal(inWindow(600, 600, t(3)), true)
})

// ---------------------------------------------------------------- 什么时候说

test('parseWhen：三选一，不给或多给都报错', () => {
  const now = at(2026, 10, 31, 20, 0)
  assert.equal(parseWhen({}, now).ok, false)
  assert.equal(parseWhen({ at: '21:30', when: 'now' }, now).ok, false)
  assert.equal(parseWhen({ at: '21:30', inMinutes: 10 }, now).ok, false)
  assert.equal(parseWhen({ when: 'later' }, now).ok, false)
})

test('parseWhen：now / idle', () => {
  const now = at(2026, 10, 31, 20, 0)
  const nowRes = parseWhen({ when: 'now' }, now)
  assert.deepEqual(nowRes, { ok: true, mode: 'now', dueAt: now })
  const idleRes = parseWhen({ when: 'idle' }, now)
  assert.deepEqual(idleRes, { ok: true, mode: 'idle', dueAt: null })
})

test('parseWhen：inMinutes', () => {
  const now = at(2026, 10, 31, 20, 0)
  const r = parseWhen({ inMinutes: 30 }, now)
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'at')
  assert.equal(r.dueAt, now + 30 * MINUTE)

  assert.equal(parseWhen({ inMinutes: 0 }, now).ok, false)
  assert.equal(parseWhen({ inMinutes: -5 }, now).ok, false)
  assert.equal(parseWhen({ inMinutes: 'abc' }, now).ok, false)
  // 30 天以外不给
  assert.equal(parseWhen({ inMinutes: 31 * 1440 }, now, { maxAheadDays: 30 }).ok, false)
})

test('parseWhen：at 是 HH:MM 时，过了就算明天', () => {
  const now = at(2026, 10, 31, 20, 0)
  const same = parseWhen({ at: '21:30' }, now)
  assert.equal(same.ok, true)
  assert.equal(same.dueAt, at(2026, 10, 31, 21, 30))

  const past = parseWhen({ at: '19:00' }, now)
  assert.equal(past.ok, true)
  assert.equal(past.dueAt, at(2026, 11, 1, 19, 0)) // 明天
  assert.equal(past.dueAt - now <= DAY, true)

  // 正好现在：算明天（不能定一个已经到点的时刻还叫"以后"）
  const exactly = parseWhen({ at: '20:00' }, now)
  assert.equal(exactly.dueAt, at(2026, 11, 1, 20, 0))
})

test('parseWhen：at 是完整时间时用 Date.parse', () => {
  const now = at(2026, 10, 31, 20, 0)
  const r = parseWhen({ at: '2026-11-01 09:00' }, now)
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'at')
  assert.ok(r.dueAt > now)

  assert.equal(parseWhen({ at: '看不懂' }, now).ok, false)
  assert.equal(parseWhen({ at: '2020-01-01 09:00' }, now).ok, false) // 已经过去了
})

// ---------------------------------------------------------------- 到点没有

test('isDue：到点 / 没到 / 已经送过', () => {
  const now = at(2026, 10, 31, 21, 30)
  const base = { status: STATUS.pending, mode: 'at', dueAt: now - 1000, createdAt: now - HOUR }
  assert.equal(isDue(base, now), true)
  assert.equal(isDue({ ...base, dueAt: now + HOUR }, now), false)
  assert.equal(isDue({ ...base, status: STATUS.sent }, now), false)
  assert.equal(isDue({ ...base, dueAt: null }, now), false)
})

test('isDue：idle 要等他安静够久', () => {
  const now = at(2026, 10, 31, 21, 30)
  const entry = { status: STATUS.pending, mode: 'idle', dueAt: null, createdAt: now - 2 * HOUR }
  assert.equal(isDue(entry, now, { lastActivity: now - 60 * MINUTE, idleMinutes: 30 }), true)
  assert.equal(isDue(entry, now, { lastActivity: now - 5 * MINUTE, idleMinutes: 30 }), false)
  // 没有 lastActivity 时退回 createdAt
  assert.equal(isDue(entry, now, { idleMinutes: 30 }), true)
})

// ---------------------------------------------------------------- 空手回合

const cfgBase = {
  checkInEnabled: true,
  checkInEveryMinutes: 240,
  checkInWindowStart: '09:00',
  checkInWindowEnd: '23:00',
  checkInMaxPerDay: 2,
}

test('nextCheckInAt：关了就永远不叫', () => {
  assert.equal(nextCheckInAt(Date.now(), { ...cfgBase, checkInEnabled: false }, {}), null)
})

test('nextCheckInAt：配额用完了今天就不叫', () => {
  const now = at(2026, 10, 31, 20, 0)
  assert.equal(nextCheckInAt(now, cfgBase, { todayCount: 2 }), null)
  assert.equal(nextCheckInAt(now, { ...cfgBase, checkInMaxPerDay: 0 }, { todayCount: 0 }), null)
  assert.equal(nextCheckInAt(now, cfgBase, { todayCount: 1 }), now)
})

test('nextCheckInAt：间隔不到就往后推', () => {
  const now = at(2026, 10, 31, 20, 0)
  const last = now - 180 * MINUTE // 17:00 + 240 分钟 = 21:00，还在窗口里
  const n = nextCheckInAt(now, cfgBase, { lastCheckInAt: last, todayCount: 0 })
  assert.equal(n, last + 240 * MINUTE)
  assert.ok(n > now)

  // 推出来的时刻越过窗口末（23:00 是窗口外）就顺延到明天
  const late = nextCheckInAt(now, cfgBase, { lastCheckInAt: now - 60 * MINUTE, todayCount: 0 })
  assert.equal(late, at(2026, 11, 1, 9, 0))
})

test('nextCheckInAt：算出来的时刻在窗口外就挪到下次窗口开', () => {
  const now = at(2026, 10, 31, 22, 30)
  const last = now - 60 * MINUTE // +240min = 次日 01:30，在窗口外
  const n = nextCheckInAt(now, cfgBase, { lastCheckInAt: last, todayCount: 0 })
  assert.equal(n, at(2026, 11, 1, 9, 0))
})

test('nextCheckInAt：窗口写坏了就不叫', () => {
  const now = at(2026, 10, 31, 20, 0)
  assert.equal(nextCheckInAt(now, { ...cfgBase, checkInWindowStart: '坏的' }, {}), null)
})

// ---------------------------------------------------------------- 范围

test('inScope：没设范围就是哪儿都行，取不到目录就不认', () => {
  assert.equal(inScope('E:\\shihai-fixtures\\Plugin', {}), true)
  assert.equal(inScope('', {}), false)
  assert.equal(inScope(null, {}), false)
  assert.equal(inScope('   ', {}), false)
})

test('inScope：targetRoot 是「只能在这一棵树下」', () => {
  const cfg = { targetRoot: 'E:\\shihai-fixtures\\Plugin' }
  assert.equal(inScope('E:\\shihai-fixtures\\Plugin', cfg), true)
  assert.equal(inScope('E:\\shihai-fixtures\\Plugin\\dsh-reach', cfg), true) // 子目录算
  assert.equal(inScope('E:/shihai-fixtures/plugin', cfg), true) // 斜杠和大小写不敏感
  assert.equal(inScope('E:\\shihai-fixtures\\dsh-fish\\home', cfg), false) // 她那儿不算
  assert.equal(inScope('E:\\shihai-fixtures\\PluginBak', cfg), false) // 只是前缀相同不算
})

test('inScope：allowRoots 是白名单，命中一个就行', () => {
  const cfg = { allowRoots: ['E:\\a', 'E:\\b'] }
  assert.equal(inScope('E:\\a\\x', cfg), true)
  assert.equal(inScope('E:\\b', cfg), true)
  assert.equal(inScope('E:\\c', cfg), false)
})

test('inScope：denyRoots 最优先，压过 targetRoot 和 allowRoots', () => {
  const cfg = {
    targetRoot: 'E:\\shihai-fixtures',
    allowRoots: ['E:\\shihai-fixtures'],
    denyRoots: ['E:\\shihai-fixtures\\dsh-fish\\home'],
  }
  assert.equal(inScope('E:\\shihai-fixtures\\Plugin', cfg), true) // 没有被按住
  assert.equal(inScope('E:\\shihai-fixtures\\dsh-fish\\home', cfg), false) // 按住优先
  assert.equal(inScope('E:\\shihai-fixtures\\dsh-fish\\home\\sub', cfg), false)
  // 空字符串项不扩大也不缩小范围
  assert.equal(inScope('E:\\shihai-fixtures\\Plugin', { denyRoots: [''] }), true)
})

// ---------------------------------------------------------------- 说人话

test('describeWhen：三种模式都说得清', () => {
  const now = at(2026, 10, 31, 20, 0)
  const idle = { mode: 'idle', dueAt: null, createdAt: now }
  assert.equal(describeWhen(idle, now, { idleMinutes: 30 }), '等他安静 30 分钟之后')

  const nowEntry = { mode: 'now', dueAt: now, createdAt: now }
  assert.equal(describeWhen(nowEntry, now), '现在')

  const later = { mode: 'at', dueAt: now + 90 * MINUTE, createdAt: now }
  const s = describeWhen(later, now)
  assert.ok(s.includes('22:30') || s.includes('21:30') || s.includes('小时'), s)
  assert.ok(/（.*后）/.test(s), s)

  const past = { mode: 'at', dueAt: now - 1000, createdAt: now - HOUR }
  assert.ok(describeWhen(past, now).includes('已经到点了'))
})

// ---------------------------------------------------------------- 交给自己的那段话

test('renderDeliveryText：是"我自己留的"，不是他说的', () => {
  const now = at(2026, 10, 31, 20, 0)
  const entry = makeEntry({ text: '等你有空，把那句评论替他发了吧。', note: '他今晚会忙到很晚', timing: { mode: 'at', dueAt: now + HOUR }, now })
  const text = renderDeliveryText(entry)
  assert.ok(text.includes('【自己留给自己的话 · 到点了】'))
  assert.ok(text.includes('等你有空，把那句评论替他发了吧。'))
  assert.ok(text.includes('他今晚会忙到很晚'))
  assert.ok(text.includes('这句我不说了')) // 允许反悔
  assert.ok(!text.includes('{{'))
})

test('renderCheckInText：没有想说的就什么都不做', () => {
  const text = renderCheckInText()
  assert.ok(text.includes('问一句'))
  assert.ok(text.includes('没有就什么都不做'))
  assert.ok(text.includes('不要为了回应而回应'))
})

test('sanitize：双大括号换成全角（别被提示词插值吃掉）', () => {
  assert.equal(sanitize('{{name}}'), '｛｛name｝｝')
  assert.equal(sanitize('普通文字'), '普通文字')
  assert.equal(sanitize(null), '')
})

// ---------------------------------------------------------------- 记录

test('makeEntry：形状对、text 去空格、id 唯一前缀', () => {
  const now = at(2026, 10, 31, 20, 0)
  const a = makeEntry({ text: '  说一句  ', note: ' 为什么 ', sessionId: 's1', cwd: 'E:\\x', timing: { mode: 'at', dueAt: now + HOUR }, now })
  assert.ok(a.id.startsWith('r_'))
  assert.equal(a.text, '说一句')
  assert.equal(a.note, '为什么')
  assert.equal(a.status, STATUS.pending)
  assert.equal(a.mode, 'at')
  assert.equal(a.dueAt, now + HOUR)
  assert.equal(a.createdAt, now)
  assert.equal(a.attempts, 0)
  const b = makeEntry({ text: 'x', timing: { mode: 'idle', dueAt: null }, now })
  assert.equal(b.mode, 'idle')
  assert.equal(b.dueAt, null)
  assert.notEqual(a.id, b.id)
})

// ---------------------------------------------------------------- 配置补丁

test('applyConfigPatch：不认识的字段和坏值都拒，并说理由', () => {
  const r = applyConfigPatch({ overrides: {}, effective: {}, patch: { 不存在: 1, enabled: 'yes' } })
  assert.equal(r.ok, false)
  assert.equal(r.rejected.length, 2)
  assert.ok(r.rejected.every((x) => typeof x.why === 'string' && x.why.length > 0))
})

test('applyConfigPatch：时间和范围会归一化 / 夹死在白名单里', () => {
  const r = applyConfigPatch({
    overrides: {},
    effective: {},
    patch: { checkInWindowStart: '7:5', checkInEveryMinutes: 5, checkInMaxPerDay: 3 },
  })
  assert.equal(r.overrides.checkInWindowStart, '07:05')
  assert.equal(r.rejected.some((x) => x.key === 'checkInEveryMinutes'), true) // 5 分钟太小
  assert.equal(r.overrides.checkInMaxPerDay, 3)
})

test('applyConfigPatch：目录列表能吃三种写法，且去重', () => {
  const r = applyConfigPatch({
    overrides: {},
    effective: {},
    patch: { allowRoots: 'E:\\a；E:\\b\nE:\\a' },
  })
  assert.deepEqual(r.overrides.allowRoots, ['E:\\a', 'E:\\b'])
  const r2 = applyConfigPatch({ overrides: {}, effective: {}, patch: { allowRoots: ['E:\\x', ''] } })
  assert.deepEqual(r2.overrides.allowRoots, ['E:\\x'])
})

test('applyConfigPatch：denyRoots 也能从设置页改', () => {
  const r = applyConfigPatch({ overrides: {}, effective: {}, patch: { denyRoots: 'E:\\shihai-fixtures\\dsh-fish\\home' } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.overrides.denyRoots, ['E:\\shihai-fixtures\\dsh-fish\\home'])
  // targetRoot 还是只有一个（不是列表）
  const bad = applyConfigPatch({ overrides: {}, effective: {}, patch: { targetRoot: 'E:\\a\nE:\\b' } })
  assert.equal(bad.rejected.length, 1)
})

test('applyConfigPatch：叠加在旧覆盖层上，不改入参', () => {
  const overrides = { checkInMaxPerDay: 1 }
  const r = applyConfigPatch({ overrides, effective: {}, patch: { debug: true } })
  assert.equal(r.overrides.checkInMaxPerDay, 1)
  assert.equal(r.overrides.debug, true)
  assert.deepEqual(overrides, { checkInMaxPerDay: 1 }) // 入参没被改
})

test('applyConfigPatch：空补丁不算成功', () => {
  const r = applyConfigPatch({ overrides: {}, effective: {}, patch: {} })
  assert.equal(r.ok, false)
  assert.equal(r.accepted.length, 0)
})
