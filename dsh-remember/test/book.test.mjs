// 协议层单测（批 B2，2026-11-25）：执受阻尼双刀的 feelTracker——
// 连击 3 次强制静默 2 小时、跨 60 分钟重置、静默期全跳。直接钉 core/protocol/book.js 的 sproutToBody。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBook, loadFeelTracker, sproutToBody } from '../../core/protocol/book.js'
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

test('feelTracker：写失败不涨连击（批 C6-N6）——mood 落不出去那声不算落地', () => {
  const { dir, book, cfg } = rig('book-wfail-')
  // 被堵成目录时 existsSync 仍为真，rig 的 rows() 会撞 EISDIR——用自己的安全行数
  const moodPath = join(dir, '.dsh-body', 'mood-events.jsonl')
  const countRows = () => {
    try {
      if (!existsSync(moodPath)) return 0
      if (!statSync(moodPath).isFile()) return 0 // 堵着 = 写不进去 = 0 行
      return readFileSync(moodPath, 'utf8').split('\n').filter((l) => l.trim()).length
    } catch { return 0 }
  }
  try {
    // 把 mood 目的地堵死：同名目录让 appendJsonLine 必败
    rmSync(moodPath, { force: true })
    mkdirSync(moodPath, { recursive: true })
    sproutToBody(book, [dyed('r_w1', 'warm')], CALM, T0, cfg)
    assert.equal(countRows(), 0, '写失败 → 一行都没有')
    assert.equal(book.feelTracker.streak, 0, '连击不涨（写失败不算落地）')
    assert.equal(book.feelTracker.silentUntil, 0, '不触发静默')
    assert.equal(book.feelTracker.at, 0, '同感冷却表不占')
    // 拆堵后同一拍重试：照常落地、连击从头数
    rmdirSync(moodPath)
    sproutToBody(book, [dyed('r_w1', 'warm')], CALM, T0 + 1000, cfg)
    assert.equal(countRows(), 1, '拆堵后落地')
    assert.equal(book.feelTracker.streak, 1, '连击从头数')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('feelTracker：静默期落盘，重启（新 Book）后依然静默（批 C6-N7）', () => {
  const { dir, book, cfg, rows } = rig('book-feelpersist-')
  try {
    sproutToBody(book, [dyed('r_w1', 'warm')], CALM, T0, cfg)
    sproutToBody(book, [dyed('r_t1', 'tense')], CALM, T0 + 10 * MIN, cfg)
    sproutToBody(book, [dyed('r_d1', 'down')], CALM, T0 + 20 * MIN, cfg) // 触发静默
    assert.equal(book.feelTracker.silentUntil, T0 + 20 * MIN + 2 * 60 * MIN, '静默已触发')
    // 重启：同 dataDir 新 Book，loadFeelTracker 回读
    const book2 = createBook({ dataDir: join(dir, 'book'), log: () => {}, dshHome: dir })
    loadFeelTracker(book2)
    assert.equal(book2.feelTracker.silentUntil, book.feelTracker.silentUntil, '静默期跨重启')
    assert.ok(book2.feelTracker.silentUntil > T0 + 60 * MIN, '仍在静默窗内')
    sproutToBody(book2, [dyed('r_p1', 'pleased')], CALM, T0 + 30 * MIN, cfg)
    assert.equal(rows().length, 2, '重启后静默期内照闭嘴')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('feelTracker+sproutTracker：追踪表落盘，重启后日帽与冷却延续（批 D6）', () => {
  const { dir, book, cfg, rows } = rig('book-trackerpersist-')
  try {
    sproutToBody(book, [dyed('r_w1', 'warm')], CALM, T0, cfg)
    assert.equal(book.sproutTracker.get('r_w1')?.count, 1, '本运行期追踪在')
    // 重启：同 dataDir 新 Book 回读——追踪表与累计口径都在
    const book2 = createBook({ dataDir: join(dir, 'book'), log: () => {}, dshHome: dir })
    loadFeelTracker(book2)
    assert.equal(book2.sproutTracker.get('r_w1')?.count, 1, '每种子冷却/日帽跨重启')
    assert.equal(book2.sproutAgg.total, 1, '累计口径跨重启')
    // 重启后再来一声同感觉：全局同感冷却还在 → 不重发
    sproutToBody(book2, [dyed('r_w2', 'warm')], CALM, T0 + 60 * 1000, cfg)
    assert.equal(rows().length, 1, `同感冷却跨重启压住（实际 ${rows().length} 声）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})