/**
 * 快层（秒级事件）这一侧的单测。
 *
 * 这里测的全是纯函数：怎么归一化、怎么造稳定 id、相对时间怎么说、
 * 索引怎么收、按词怎么翻、摘要怎么算，以及按字节游标增量读 append-only JSONL。
 * 不碰宿主、不碰网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FAST_KINDS,
  fastEventId,
  fastKindLabel,
  fastRelTime,
  fastSummary,
  normFastEvent,
  pushFastIndex,
  renderFastLine,
  searchFastEvents,
} from '../lib/fast.js'
import { readJsonLinesFrom } from '../lib/store.js'

const NOW = Date.parse('2026-11-03T02:00:00.000Z')
const MIN = 60 * 1000

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-remember-fast-'))
}

function rawEvent(over = {}) {
  return { at: NOW - 5 * MIN, kind: 'meal', text: '吃过中饭了，胃里踏实一点', source: 'dsh-body', ...over }
}

test('fastEventId：同一个来源事件永远同一个 id，改一个字就换 id', () => {
  const a = fastEventId({ source: 'dsh-body', at: 1000, kind: 'meal', text: '吃过饭了' })
  const b = fastEventId({ source: 'dsh-body', at: 1000, kind: 'meal', text: '吃过饭了' })
  const c = fastEventId({ source: 'dsh-body', at: 1000, kind: 'meal', text: '吃过中饭了' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^f_[0-9a-z]{7,}$/)
})

test('normFastEvent：坏行返回 null（不因为一行坏了丢整批）', () => {
  assert.equal(normFastEvent(null), null)
  assert.equal(normFastEvent('x'), null)
  assert.equal(normFastEvent(rawEvent({ at: 0 })), null)
  assert.equal(normFastEvent(rawEvent({ at: 'now' })), null)
  assert.equal(normFastEvent(rawEvent({ text: '   ' })), null)
  const ev = normFastEvent(rawEvent({ text: '  吃过   饭了  ' }))
  assert.equal(ev.text, '吃过 饭了')
  assert.equal(ev.source, 'dsh-body')
  assert.ok(ev.id.startsWith('f_'))
  assert.ok(ev.at > 0)
})

test('normFastEvent：未知 kind 记 other，已知 kind 原样收，detail 保留', () => {
  assert.equal(normFastEvent(rawEvent({ kind: 'sing' })).kind, 'other')
  for (const kind of FAST_KINDS) {
    assert.equal(normFastEvent(rawEvent({ kind })).kind, kind)
  }
  const ev = normFastEvent(rawEvent({ kind: 'meal', detail: { meal: '午饭', tier: 'full' } }))
  assert.deepEqual(ev.detail, { meal: '午饭', tier: 'full' })
})

test('fastKindLabel：五类都有中文说法，不认识的也有说法', () => {
  for (const kind of FAST_KINDS) assert.ok(fastKindLabel(kind))
  assert.equal(fastKindLabel('sing'), '有件事')
})

test('fastRelTime：只给词、不给数字', () => {
  const cases = [
    [0.5 * MIN, '刚刚'],
    [5 * MIN, '不久前'],
    [30 * MIN, '一会儿前'],
    [3 * 60 * MIN, '今天早些时候'],
    [40 * 60 * MIN, '前天'],
    [10 * 24 * 60 * MIN, '前几天'],
  ]
  for (const [ago, want] of cases) {
    const got = fastRelTime(NOW - ago, NOW)
    assert.equal(got, want)
    assert.doesNotMatch(got, /[0-9]/)
  }
  assert.equal(fastRelTime(NOW + 5 * MIN, NOW), '刚刚')
})

test('renderFastLine：一行长什么样', () => {
  const ev = normFastEvent(rawEvent({ kind: 'missed', text: '错过了早饭，胃里空落落的' }))
  const line = renderFastLine(ev, NOW)
  assert.match(line, /^· 快层·错过一顿·错过了早饭，胃里空落落的（不久前）$/)
  assert.equal(renderFastLine(null, NOW), '')
})

test('pushFastIndex：按 id 去重、新的在前、超过上限挤最老的', () => {
  const a = normFastEvent(rawEvent({ at: NOW - 10 * MIN, text: 'A' }))
  const b = normFastEvent(rawEvent({ at: NOW - 5 * MIN, text: 'B' }))
  const c = normFastEvent(rawEvent({ at: NOW - 1 * MIN, text: 'C' }))
  let idx = pushFastIndex([], a, 10)
  idx = pushFastIndex(idx, c, 10)
  idx = pushFastIndex(idx, b, 10)
  assert.deepEqual(idx.map((e) => e.text), ['C', 'B', 'A'])
  idx = pushFastIndex(idx, a, 10) // 重抄同一条：不重复
  assert.equal(idx.length, 3)
  assert.deepEqual(idx.map((e) => e.text), ['C', 'B', 'A'])
  const capped = pushFastIndex(idx, b, 2)
  assert.deepEqual(capped.map((e) => e.text), ['C', 'B'])
})

test('searchFastEvents：词打在 text、kind 或 detail 里都算，空词不翻', () => {
  const list = [
    normFastEvent(rawEvent({ at: NOW - 30 * MIN, kind: 'meal', text: '吃过中饭了，胃里踏实一点', detail: { meal: '中饭' } })),
    normFastEvent(rawEvent({ at: NOW - 20 * MIN, kind: 'topup', text: '他往锅里添了饭，肚子一下子暖了' })),
    normFastEvent(rawEvent({ at: NOW - 10 * MIN, kind: 'threshold', text: '困得撑不住了', detail: { what: 'energy' } })),
  ]
  assert.equal(searchFastEvents(list, '').length, 0)
  assert.equal(searchFastEvents(list, '   ').length, 0)
  assert.equal(searchFastEvents(list, '中饭')[0].kind, 'meal')
  assert.equal(searchFastEvents(list, '添了饭')[0].kind, 'topup')
  assert.equal(searchFastEvents(list, '撑不住')[0].kind, 'threshold')
  const limitOne = searchFastEvents(list, '饭', { limit: 1 })
  assert.equal(limitOne.length, 1)
})

test('fastSummary：总数、按类计数、还没掂量的条数', () => {
  const list = [
    normFastEvent(rawEvent({ at: NOW - 30 * MIN, kind: 'meal', text: '吃过中饭了' })),
    normFastEvent(rawEvent({ at: NOW - 20 * MIN, kind: 'mood', text: '心里亮了一下' })),
    normFastEvent(rawEvent({ at: NOW - 10 * MIN, kind: 'meal', text: '吃过晚饭了' })),
  ]
  const none = fastSummary(list)
  assert.equal(none.total, 3)
  assert.equal(none.pending, 3)
  assert.equal(none.byKind['吃了一口'], 2)
  const some = fastSummary(list, { weighed: new Set([list[0].id]) })
  assert.equal(some.pending, 2)
  assert.equal(some.total, 3)
  assert.equal(fastSummary(null).total, 0)
})

test('readJsonLinesFrom：按字节游标只读新增的那一段', () => {
  const dir = tmpDir()
  try {
    const file = join(dir, 'events.jsonl')
    writeFileSync(file, '{"a":1}\n{"a":2}\n')
    const first = readJsonLinesFrom(file, 0)
    assert.equal(first.rows.length, 2)
    assert.equal(first.exists, true)
    assert.equal(first.reset, false)
    assert.equal(first.pending, false)

    appendFileSync(file, '{"a":3}\n')
    const second = readJsonLinesFrom(file, first.next)
    assert.deepEqual(second.rows, [{ a: 3 }])
    assert.equal(second.next, first.next + '{"a":3}\n'.length)

    const again = readJsonLinesFrom(file, second.next)
    assert.deepEqual(again.rows, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readJsonLinesFrom：半行留到下次，坏行跳过', () => {
  const dir = tmpDir()
  try {
    const file = join(dir, 'events.jsonl')
    writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":')
    const first = readJsonLinesFrom(file, 0)
    assert.deepEqual(first.rows, [{ a: 1 }, { a: 2 }])
    assert.equal(first.pending, true)
    // 下次把剩下那半行写完，从上一处 next 接着读，整行才对
    appendFileSync(file, '3}\n')
    const second = readJsonLinesFrom(file, first.next)
    assert.deepEqual(second.rows, [{ a: 3 }])

    writeFileSync(file, '{"bad":\n{"a":9}\n')
    assert.deepEqual(readJsonLinesFrom(file, 0).rows, [{ a: 9 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readJsonLinesFrom：文件没了 → 不存在；被截短 → 从头重读并标 reset', () => {
  const dir = tmpDir()
  try {
    const missing = readJsonLinesFrom(join(dir, 'nope.jsonl'), 0)
    assert.equal(missing.exists, false)
    assert.deepEqual(missing.rows, [])

    const file = join(dir, 'events.jsonl')
    writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3}\n')
    const first = readJsonLinesFrom(file, 0)
    writeFileSync(file, '{"b":1}\n')
    const again = readJsonLinesFrom(file, first.next)
    assert.equal(again.reset, true)
    assert.deepEqual(again.rows, [{ b: 1 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
