/**
 * report.js 的单测：设置页那两种输入（读数、配置补丁）不许把插件带崩
 *   node --test test/
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyConfigPatch, tailLines } from '../lib/report.js'

const MEALS = [
  { id: 'breakfast', label: '早饭', at: '08:30', windowMinutes: 90 },
  { id: 'lunch', label: '中饭', at: '12:30', windowMinutes: 90 },
  { id: 'dinner', label: '晚饭', at: '18:30', windowMinutes: 120 },
]

test('睡眠窗：合法时间收下，写坏的拒绝', () => {
  const ok = applyConfigPatch({
    overrides: {},
    effective: { meals: MEALS },
    patch: { sleep: { start: '22:15', end: '7:5' } },
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.overrides.sleep, { start: '22:15', end: '07:05' })
  assert.deepEqual(ok.rejected, [])

  const bad = applyConfigPatch({ overrides: {}, effective: { meals: MEALS }, patch: { sleep: { start: '25:00' } } })
  assert.equal(bad.ok, false)
  assert.equal(bad.rejected[0].key, 'sleep.start')
})

test('三餐：按 id 改时间，不认识的 id 拒绝；没改到就不写回', () => {
  const r = applyConfigPatch({
    overrides: {},
    effective: { meals: MEALS },
    patch: { meals: [{ id: 'lunch', at: '12:45' }, { id: 'supper', at: '20:00' }] },
  })
  assert.equal(r.overrides.meals.length, 3)
  assert.equal(r.overrides.meals.find((m) => m.id === 'lunch').at, '12:45')
  assert.ok(r.rejected.some((x) => x.key === 'meals.supper'))
  // 原来那三条不能被就地改掉
  assert.equal(MEALS[1].at, '12:30')
})

test('三餐：窗口分钟数与标签也校验', () => {
  const r = applyConfigPatch({
    overrides: {},
    effective: { meals: MEALS },
    patch: { meals: [{ id: 'dinner', windowMinutes: 999 }, { id: 'lunch', windowMinutes: 45 }] },
  })
  assert.ok(r.rejected.some((x) => x.key === 'meals.dinner.windowMinutes'))
  assert.equal(r.overrides.meals.find((m) => m.id === 'lunch').windowMinutes, 45)
})

test('标量：超范围拒绝，布尔只收 true/false', () => {
  const r = applyConfigPatch({
    overrides: {},
    effective: { meals: MEALS },
    patch: { maxCatchUpHours: 100, debug: 'yes', applyToAll: true, sectionOrder: 9000 },
  })
  assert.equal(r.overrides.applyToAll, true)
  assert.equal(r.overrides.sectionOrder, 9000)
  assert.ok(r.rejected.some((x) => x.key === 'maxCatchUpHours'))
  assert.ok(r.rejected.some((x) => x.key === 'debug'))
})

test('目标会话：数组里夹空串会被清掉', () => {
  const r = applyConfigPatch({
    overrides: {},
    effective: { meals: MEALS },
    patch: { targetSessionIds: [' session-a ', '', 'session-b'] },
  })
  assert.deepEqual(r.overrides.targetSessionIds, ['session-a', 'session-b'])
})

test('隔离工作区：allowRoots/denyRoots 数组清洗；非数组拒绝', () => {
  const ok = applyConfigPatch({
    overrides: {},
    effective: { meals: MEALS },
    patch: { allowRoots: [' E:\\a ', ''], denyRoots: ['E:\\b'] },
  })
  assert.deepEqual(ok.overrides.allowRoots, ['E:\\a'])
  assert.deepEqual(ok.overrides.denyRoots, ['E:\\b'])
  assert.ok(ok.accepted.includes('allowRoots') && ok.accepted.includes('denyRoots'))

  const bad = applyConfigPatch({ overrides: {}, effective: { meals: MEALS }, patch: { denyRoots: 'E:\\b' } })
  assert.ok(bad.rejected.some((x) => x.key === 'denyRoots'))
})

test('段名：非法字符拒绝；什么都没改返回 ok=false', () => {
  const bad = applyConfigPatch({ overrides: {}, effective: { meals: MEALS }, patch: { sectionName: 'has space' } })
  assert.equal(bad.ok, false)
  assert.ok(bad.rejected.length > 0)

  const empty = applyConfigPatch({ overrides: {}, effective: { meals: MEALS }, patch: {} })
  assert.equal(empty.ok, false)
  assert.deepEqual(empty.overrides, {})
})

test('覆盖层是叠加的，不是替换的', () => {
  const r = applyConfigPatch({
    overrides: { debug: true, sleep: { start: '23:30', end: '08:30' } },
    effective: { meals: MEALS },
    patch: { sleep: { end: '09:00' } },
  })
  assert.deepEqual(r.overrides.sleep, { start: '23:30', end: '09:00' })
  assert.equal(r.overrides.debug, true)
})

test('tailLines：取最后几行；文件不在就是空数组', () => {
  const dir = join(tmpdir(), 'dsh-body-report-test')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'a.log')
  writeFileSync(file, ['1', '2', '3', '4', '5'].join('\n'), 'utf8')
  assert.deepEqual(tailLines(file, 2), ['4', '5'])
  assert.deepEqual(tailLines(join(dir, 'nope.log'), 3), [])
  rmSync(dir, { recursive: true, force: true })
})
