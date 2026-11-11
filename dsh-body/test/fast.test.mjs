/**
 * fast.test.mjs —— 快层那些纯逻辑：事件怎么造、多久之前怎么说、那一段怎么排
 *   node --test test/fast.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  FAST_KINDS,
  appendEvent,
  countEvents,
  hasDigits,
  makeEvent,
  readEvents,
  relWords,
  renderFastSection,
} from '../lib/fast.js'

const NOW = Date.parse('2026-11-03T02:00:00.000Z')
const MIN = 60 * 1000

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-body-fast-'))
}

test('makeEvent：空文字、坏时间都收不下 —— 宁可不记，不记空话', () => {
  assert.equal(makeEvent('meal', '', NOW), null)
  assert.equal(makeEvent('meal', '   ', NOW), null)
  assert.equal(makeEvent('meal', '吃了饭', NaN), null)
  assert.equal(makeEvent('meal', '吃了饭', 0), null)
  assert.equal(makeEvent('meal', '吃了饭', 'now'), null)
})

test('makeEvent：认得的事件照原样收，未知 kind 记 other，来源写死 dsh-body', () => {
  for (const kind of FAST_KINDS) {
    const ev = makeEvent(kind, '有点事', NOW)
    assert.equal(ev.kind, kind)
  }
  const odd = makeEvent('地震', '晃了一下', NOW, { where: '脚下' })
  assert.equal(odd.kind, 'other')
  assert.equal(odd.source, 'dsh-body')
  assert.equal(odd.at, NOW)
  assert.deepEqual(odd.detail, { where: '脚下' })
  assert.equal(makeEvent('meal', '吃了饭', NOW).detail, undefined)
})

test('relWords：只说人话，一个阿拉伯数字都没有', () => {
  const cases = [0, 30 * 1000, 5 * MIN, 30 * MIN, 3 * 60 * MIN, 20 * 60 * MIN, 3 * 24 * 60 * MIN, 30 * 24 * 60 * MIN]
  for (const age of cases) {
    const w = relWords(NOW - age, NOW)
    assert.ok(w.length > 0)
    assert.equal(hasDigits(w), false, `「${w}」里出现了数字`)
  }
  assert.equal(relWords(NOW - 10 * 1000, NOW), '刚刚')
  assert.equal(relWords(NOW - 5 * MIN, NOW), '不久前')
  assert.equal(relWords(NOW - 30 * MIN, NOW), '一会儿前')
  assert.equal(relWords(NOW - 3 * 60 * MIN, NOW), '今天早些时候')
  assert.equal(relWords(NOW - 20 * 60 * MIN, NOW), '昨天')
  assert.equal(relWords(NOW - 3 * 24 * 60 * MIN, NOW), '前几天')
  assert.equal(relWords(NOW - 30 * 24 * 60 * MIN, NOW), '早一些日子')
})

test('appendEvent：一行一件，只往后加，旧行永远不动', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'body-events.jsonl')
    assert.equal(appendEvent(file, makeEvent('meal', '吃过早饭了', NOW - MIN)), true)
    const first = readFileSync(file, 'utf8')
    assert.equal(appendEvent(file, makeEvent('mood', '心里动了一下', NOW)), true)
    const second = readFileSync(file, 'utf8')
    assert.ok(second.startsWith(first))
    assert.equal(second.split('\n').filter(Boolean).length, 2)
    assert.equal(appendEvent('', makeEvent('meal', 'x', NOW)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readEvents：坏行跳过，不存在的文件是空的，数得清条数', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'body-events.jsonl')
    assert.deepEqual(readEvents(file), [])
    assert.equal(countEvents(file), 0)
    writeFileSync(
      file,
      [
        JSON.stringify(makeEvent('meal', '吃过中饭了', NOW - MIN)),
        '这不是 JSON',
        JSON.stringify({ at: 0, text: '时间不真' }),
        JSON.stringify({ at: NOW, text: '' }),
        JSON.stringify(makeEvent('missed', '错过了一顿', NOW)),
      ].join('\n') + '\n',
      'utf8',
    )
    const rows = readEvents(file)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].text, '吃过中饭了')
    assert.equal(rows[1].text, '错过了一顿')
    assert.equal(countEvents(file), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderFastSection：一条都没有 → 空字符串（宿主不显示空段）', () => {
  assert.equal(renderFastSection([], { now: NOW }), '')
  assert.equal(renderFastSection(null, { now: NOW }), '')
  assert.equal(renderFastSection([{ at: 0, text: '坏' }], { now: NOW }), '')
})

test('renderFastSection：最新的在前，带【刚刚】和口语化的时间', () => {
  const events = [
    makeEvent('meal', '吃过早饭了', NOW - 30 * MIN),
    makeEvent('mood', '心里动了一下', NOW - 2 * MIN),
    makeEvent('threshold', '困得撑不住了', NOW - 10 * MIN),
  ]
  const text = renderFastSection(events, { now: NOW, ttlMinutes: 120 })
  assert.ok(text.startsWith('【刚刚】\n'))
  const lines = text.split('\n')
  assert.equal(lines.length, 4)
  assert.ok(lines[1].includes('心里动了一下') && lines[1].includes('不久前'))
  assert.ok(lines[2].includes('困得撑不住了'))
  assert.ok(lines[3].includes('吃过早饭了'))
  assert.equal(/[0-9]/.test(text), false, `渲染里出现了数字：\n${text}`)
})

test('renderFastSection：超过 TTL 的不再挂在嘴上；未来的时间不显示', () => {
  const events = [
    makeEvent('meal', '很久以前吃的', NOW - 5 * 60 * MIN),
    makeEvent('meal', '刚刚吃的', NOW - MIN),
    makeEvent('meal', '还没发生', NOW + MIN),
  ]
  const text = renderFastSection(events, { now: NOW, ttlMinutes: 120 })
  assert.ok(text.includes('刚刚吃的'))
  assert.equal(text.includes('很久以前吃的'), false)
  assert.equal(text.includes('还没发生'), false)
  // ttlMinutes=0 表示不限新鲜度
  const all = renderFastSection(events, { now: NOW, ttlMinutes: 0 })
  assert.ok(all.includes('很久以前吃的'))
})

test('renderFastSection：最多几行就几行（新的留下，旧的沉下去）', () => {
  const events = Array.from({ length: 8 }, (_, i) => makeEvent('meal', `第${i}件`, NOW - i * MIN))
  const text = renderFastSection(events, { now: NOW, maxLines: 3 })
  assert.equal(text.split('\n').length, 4)
  assert.ok(text.includes('第0件') && text.includes('第1件') && text.includes('第2件'))
})

test('renderFastSection：整段超字数时按行回退，不留半截行', () => {
  const long = '这是一件很长很长的感受句'.repeat(8)
  const events = [
    makeEvent('meal', long, NOW - MIN),
    makeEvent('mood', long, NOW - 2 * MIN),
    makeEvent('meal', long, NOW - 3 * MIN),
  ]
  const text = renderFastSection(events, { now: NOW, maxChars: 120 })
  assert.ok(text.length <= 120, `超了：${text.length}`)
  assert.ok(text.endsWith('…'))
  for (const line of text.split('\n')) {
    assert.ok(line.startsWith('· ') || line === '【刚刚】')
  }
})
