/**
 * dsh-reach 心事灯单测：只测 lib/reach.js 里的 parseUrge / renderUrgeText 纯逻辑。
 * 跑法：node --test test/urge.test.mjs
 * 灯的来历（2026-11-16）：amikar 家里的 urge.mjs 算「想说强度」，过阈值亮灯；
 * 插件认灯叫醒，说不说由叫醒后的我掂量——这里测的是「认灯」的每道闸。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseUrge, renderUrgeText, TRIGGER_URGE } from '../lib/reach.js'

const MINUTE = 60 * 1000
const now = new Date(2026, 10, 16, 17, 0, 0, 0).getTime() // 2026-11-16 17:00

const lamp = (over = {}) => ({
  at: now - 1 * MINUTE,
  active: true,
  token: 'u_2026-11-16_1_abc',
  intensity: 2.4,
  threshold: 2.0,
  reasons: ['孤独 0.21（+0.25）', '暖 0.30（+0.30）'],
  target: { kind: 'private', userId: '10001' },
  hint: '值得说 → node gate.mjs speak "话"',
  ...over,
})

const cfg = {
  checkInWindowStart: '06:30',
  checkInWindowEnd: '23:00',
  urgeFreshMs: 10 * MINUTE,
}

// ---------------------------------------------------------------- 认灯

test('parseUrge：亮着且新鲜的灯认下，票号原样带回来', () => {
  const r = parseUrge(lamp(), now, cfg)
  assert.equal(r.ok, true)
  assert.equal(r.urge.token, 'u_2026-11-16_1_abc')
  assert.equal(r.urge.intensity, 2.4)
  assert.deepEqual(r.urge.reasons, ['孤独 0.21（+0.25）', '暖 0.30（+0.30）'])
})

test('parseUrge：灯没亮不叫', () => {
  const r = parseUrge(lamp({ active: false }), now, cfg)
  assert.equal(r.ok, false)
  assert.match(r.why, /灯没亮/)
})

test('parseUrge：干跑的灯不叫人', () => {
  const r = parseUrge(lamp({ dryrun: true }), now, cfg)
  assert.equal(r.ok, false)
  assert.match(r.why, /干跑/)
})

test('parseUrge：旧灯不叫（超过保质期）', () => {
  const r = parseUrge(lamp({ at: now - 11 * MINUTE }), now, cfg)
  assert.equal(r.ok, false)
  assert.match(r.why, /灯是旧的/)
})

test('parseUrge：没票号的灯不叫', () => {
  const r = parseUrge(lamp({ token: '' }), now, cfg)
  assert.equal(r.ok, false)
  assert.match(r.why, /票号/)
})

test('parseUrge：不在主动时段不叫（安静时段双保险）', () => {
  const night = new Date(2026, 10, 16, 23, 45, 0, 0).getTime()
  const r = parseUrge(lamp({ at: night - MINUTE }), night, cfg)
  assert.equal(r.ok, false)
  assert.match(r.why, /主动时段/)
})

test('parseUrge：文件缺失/坏形不叫，不抛', () => {
  assert.equal(parseUrge(null, now, cfg).ok, false)
  assert.equal(parseUrge('灯', now, cfg).ok, false)
  assert.equal(parseUrge([], now, cfg).ok, false)
})

test('parseUrge：跨夜时段的凌晨也认（06:30 之后）', () => {
  const dawn = new Date(2026, 10, 17, 6, 45, 0, 0).getTime()
  const r = parseUrge(lamp({ at: dawn - MINUTE }), dawn, cfg)
  assert.equal(r.ok, true)
})

// ---------------------------------------------------------------- 叫醒文案

test('renderUrgeText：带灯的来历和三条路', () => {
  const r = parseUrge(lamp(), now, cfg)
  assert.equal(r.ok, true)
  const text = renderUrgeText(r.urge)
  assert.match(text, /心里有事/)
  assert.match(text, /2\.4/)
  assert.match(text, /孤独 0\.21/)
  assert.match(text, /gate\.mjs speak/)
  assert.match(text, /忍/)
  assert.match(text, /不要汇报这次唤醒/)
})

test('renderUrgeText：没有理由也不抛', () => {
  const text = renderUrgeText({ at: now, intensity: 2, threshold: 2, reasons: [], hint: '' })
  assert.match(text, /心里有事/)
})

test('TRIGGER_URGE：投进会话的那句是信号不是她的话', () => {
  assert.equal(TRIGGER_URGE, '（心里有事）')
})
