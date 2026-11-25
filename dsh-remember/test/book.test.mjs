// 协议层单测（批 B2，2026-11-25）：执受阻尼双刀的 feelTracker——
// 连击 3 次强制静默 2 小时、跨 60 分钟重置、静默期全跳。直接钉 core/protocol/book.js 的 sproutToBody。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBook, sproutToBody } from '../../core/protocol/book.js'
import { makeNode } from '../../core/memory.js'

const MIN = 60_000
const T0 = Date.parse('2026-11-25T02:00:00.000Z')

const dyed = (id, dominant) =>
  makeNode({ id, text: `种子 ${id}`, kind: 'fact', weight: 0.5, changes: 'x', moodAt: { dominant, level: 0.9 } }, T0)

function rig(dirName) {
  const dir = mkdtempSync(join(tmpdir(), dirName))
  const bookDir = join(dir, 'book')
  mkdirSync(bookDir, { recursive: true })
  mkdirSync(join(dir, '.dsh-body'), { recursive: true })
  const book = createBook({ dataDir: bookDir, log: () => {}, dshHome: dir })
  const cfg = {
    sproutBodyEnabled: true,
    sproutBodyCooldownMinutes: 1,
    sproutBodyFeelCooldownMinutes: 30,
    sproutBodyMinLevel: 0.5,
    sproutBodyDailyCap: 20,
    sproutBodyDailyTotalCap: 50,
  }
  const moodFile = join(dir, '.dsh-body', 'mood-events.jsonl')
  const rows = () =>
    existsSync(moodFile)
      ? readFileSync(moodFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.kind === 'sprout')
      : []
  return { dir, book, cfg, rows, moodFile }
}

const CALM = { dominant: 'calm', level: 0 }

test('feelTracker：连击 3 次（60 分钟内）→ 第 3 声不落地、强制静默 2 小时（批 B2 刀 a）', () => {
  const { dir, book, cfg, rows } = rig('book-streak-')
  try {
    sproutToBody(book, [dyed('r_w1', 'warm')], CALM, T0, cfg)
    assert.equal(rows().length, 1, '第 1 声（warm）落地')
    assert.equal(book.feelTracker.streak, 1, 'streak 记到 1')
    sproutToBody(book, [dyed('r_t1', 'tense')], CALM, T0 + 10 * MIN, cfg)
    assert.equal(rows().length, 2, '第 2 声（tense）落地')
    assert.equal(book.feelTracker.streak, 2, 'streak 记到 2')
    sproutToBody(book, [dyed('r_d1', 'down')], CALM, T0 + 20 * MIN, cfg)
    assert.equal(rows().length, 2, '第 3 次连击 → 不写（强制静默）')
    assert.equal(book.feelTracker.streak, 0, '触发后 streak 清零')
    assert.equal(book.feelTracker.silentUntil, T0 + 20 * MIN + 2 * 60 * MIN, 'silentUntil = 现在 + 2 小时')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('feelTracker：静默期全跳——换感觉换种子都闭嘴，过了 silentUntil 才重新开口（批 B2 刀 a）', () => {
  const { dir, book, cfg, rows } = rig('book-silent-')
  try {
    sproutToBody(book, [dyed('r_w1', 'warm')], CALM, T0, cfg)
    sproutToBody(book, [dyed('r_t1', 'tense')], CALM, T0 + 10 * MIN, cfg)
    sproutToBody(book, [dyed('r_d1', 'down')], CALM, T0 + 20 * MIN, cfg) // 触发静默
    assert.equal(rows().length, 2)
    sproutToBody(book, [dyed('r_l1', 'lonely')], CALM, T0 + 30 * MIN, cfg)
    sproutToBody(book, [dyed('r_r1', 'restless')], CALM, T0 + 40 * MIN, cfg)
    assert.equal(rows().length, 2, '静默期内换什么感觉都不写')
    sproutToBody(book, [dyed('r_p1', 'pleased')], CALM, T0 + 20 * MIN + 2 * 60 * MIN, cfg)
    assert.equal(rows().length, 3, '静默期过了 → 重新开口')
    assert.equal(book.feelTracker.streak, 1, '静默期后连击从头数（跨 60 分重置）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('feelTracker：跨 60 分钟重置——上一声在 60 分之外，连击从头数（批 B2 刀 a）', () => {
  const { dir, book, cfg, rows } = rig('book-reset-')
  try {
    sproutToBody(book, [dyed('r_w1', 'warm')], CALM, T0, cfg)
    sproutToBody(book, [dyed('r_t1', 'tense')], CALM, T0 + 10 * MIN, cfg)
    assert.equal(book.feelTracker.streak, 2)
    // 第 3 次候选落在第 2 声的 60 分钟之外 → withinStreak false → streak 从 1 重数，不触发静默
    sproutToBody(book, [dyed('r_d1', 'down')], CALM, T0 + 10 * MIN + 61 * MIN, cfg)
    assert.equal(rows().length, 3, '跨 60 分 → 第 3 声照常落地')
    assert.equal(book.feelTracker.streak, 1, '连击重置为 1')
    assert.equal(book.feelTracker.silentUntil, 0, '没触发静默')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('全局日帽（C-amend ②）：合计到帽全门静默——帽在连击之前拦（批 B2 后帽的端到端钉）', () => {
  const { dir, book, cfg, rows } = rig('book-cap-')
  try {
    const cap3 = { ...cfg, sproutBodyDailyTotalCap: 3 } // 日帽下限被 clamp 在 3（既有口径）
    // 每声都跨 60 分钟 → 连击永不触发，帽才是拦人的那道
    sproutToBody(book, [dyed('r_w1', 'warm')], CALM, T0, cap3)
    sproutToBody(book, [dyed('r_t1', 'tense')], CALM, T0 + 61 * MIN, cap3)
    sproutToBody(book, [dyed('r_d1', 'down')], CALM, T0 + 122 * MIN, cap3)
    assert.equal(rows().length, 3, '3 声落地（每次跨 60 分，连击不触发）')
    sproutToBody(book, [dyed('r_l1', 'lonely')], CALM, T0 + 183 * MIN, cap3)
    sproutToBody(book, [dyed('r_r1', 'restless')], CALM, T0 + 244 * MIN, cap3)
    assert.equal(rows().length, 3, '全局日帽：到 3 声后全门静默')
    assert.equal(book.feelTracker.silentUntil, 0, '拦它的是日帽不是静默（无 silentUntil）')
    assert.equal(book.feelTracker.streak, 1, '最后一声的连击停在 1（没凑满 3）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
