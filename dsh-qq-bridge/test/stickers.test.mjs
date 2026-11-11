/**
 * 表情包标记（v0.8.0）的纯逻辑测试：
 * 库怎么读、名字怎么归一、标记怎么抠、抠出来的图段什么形状。
 * 跑法：node --test test/stickers.test.mjs（必须点名文件，传目录会 MODULE_NOT_FOUND）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STICKER_MARK_RE,
  loadStickers,
  missingStickerText,
  normalizeStickerName,
  parseStickerMarkers,
  stickerSegments
} from '../lib/stickers.js'
import { PHOTO_MARK_RE } from '../lib/photos.js'

/** 临时表情库：给一份 manifest（原始行），返回库目录。 */
function makeLib(lines = []) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-stickers-'))
  const dir = join(root, 'stickers')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.jsonl'), lines.join('\n'), 'utf8')
  return { root, dir }
}

const row = (name, file, extra = {}) => JSON.stringify({ at: 1793600000000, name, file, from: 'qq', via: 'share', note: '', ...extra })

/* ---------- 读库 ---------- */

test('loadStickers：目录不存在 → 空表，不抛', () => {
  const r = loadStickers(join(tmpdir(), 'bridge-stickers-不存在-' + process.pid))
  assert.equal(r.byName.size, 0)
  assert.deepEqual(r.list, [])
})

test('loadStickers：dir 为 null → 空表，不抛', () => {
  const r = loadStickers(null)
  assert.equal(r.byName.size, 0)
  assert.deepEqual(r.list, [])
})

test('loadStickers：manifest 正常 → 名字进表，path 拼对', () => {
  const { root, dir } = makeLib([row('偷笑', '004-touxiao.jpg', { note: '嘿嘿' })])
  try {
    const r = loadStickers(dir)
    assert.equal(r.byName.size, 1)
    const hit = r.byName.get('偷笑')
    assert.equal(hit.name, '偷笑')
    assert.equal(hit.file, '004-touxiao.jpg')
    assert.equal(hit.path, join(dir, '004-touxiao.jpg'))
    assert.equal(hit.note, '嘿嘿')
    assert.equal(r.list.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadStickers：坏行、缺 name、缺 file 的行跳过，好的留下', () => {
  const { root, dir } = makeLib([
    '{ 这不是 json',
    row('心动', '002-xindong.jpg'),
    JSON.stringify({ at: 1, file: 'x.jpg' }), // 缺 name
    JSON.stringify({ at: 2, name: '没图的' }), // 缺 file
    '',
    row('嘿嘿', '003-heihei.jpg')
  ])
  try {
    const r = loadStickers(dir)
    assert.equal(r.byName.size, 2)
    assert.ok(r.byName.has('心动'))
    assert.ok(r.byName.has('嘿嘿'))
    assert.equal(r.list.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadStickers：同名后者不覆盖前者（先到的赢），重名只记一笔不抛', () => {
  const { root, dir } = makeLib([row('偷笑', 'first.jpg'), row('偷笑', 'second.jpg')])
  const logs = []
  try {
    const r = loadStickers(dir, { log: (s) => logs.push(s) })
    assert.equal(r.byName.size, 1)
    assert.equal(r.byName.get('偷笑').file, 'first.jpg')
    assert.equal(logs.length, 1)
    assert.ok(logs[0].includes('偷笑'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ---------- 名字归一 ---------- */

test('normalizeStickerName：去空白、全角括号折半角、外层括号去掉', () => {
  assert.equal(normalizeStickerName('  偷笑 '), '偷笑')
  assert.equal(normalizeStickerName('偷 笑'), '偷笑')
  assert.equal(normalizeStickerName('（偷笑）'), '偷笑')
  assert.equal(normalizeStickerName('【偷笑】'), '偷笑')
  assert.equal(normalizeStickerName('[偷笑]'), '偷笑')
  assert.equal(normalizeStickerName(''), '')
  assert.equal(normalizeStickerName(null), '')
})

test('名字归一后带括号的写法和库里的名字能对上', () => {
  const { root, dir } = makeLib([row('偷笑', '004-touxiao.jpg')])
  try {
    const idx = loadStickers(dir)
    const parsed = parseStickerMarkers('给你[表情:【偷笑】]', idx)
    assert.equal(parsed.stickers.length, 1)
    assert.equal(parsed.stickers[0].name, '偷笑')
    assert.deepEqual(parsed.missing, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ---------- 抠标记 ---------- */

test('parseStickerMarkers：单标记 → 标记抠掉，正文不留痕', () => {
  const { root, dir } = makeLib([row('心动', '002-xindong.jpg')])
  try {
    const idx = loadStickers(dir)
    const parsed = parseStickerMarkers('给你看 [表情:心动] 开心', idx)
    assert.equal(parsed.text, '给你看 开心')
    assert.ok(!parsed.text.includes('[表情:'))
    assert.equal(parsed.stickers.length, 1)
    assert.equal(parsed.stickers[0].path, join(dir, '002-xindong.jpg'))
    assert.deepEqual(parsed.missing, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseStickerMarkers：多个标记 → 都认出来，顺序按出现', () => {
  const { root, dir } = makeLib([row('心动', '002-xindong.jpg'), row('嘿嘿', '003-heihei.jpg')])
  try {
    const idx = loadStickers(dir)
    const parsed = parseStickerMarkers('[表情:心动] [表情:嘿嘿]', idx)
    assert.deepEqual(parsed.stickers.map((s) => s.name), ['心动', '嘿嘿'])
    assert.equal(parsed.text, '')
    assert.deepEqual(parsed.missing, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseStickerMarkers：同一个名字出现两次只取一次', () => {
  const { root, dir } = makeLib([row('偷笑', '004-touxiao.jpg')])
  try {
    const idx = loadStickers(dir)
    const parsed = parseStickerMarkers('[表情:偷笑] 嗯 [表情:偷笑]', idx)
    assert.equal(parsed.stickers.length, 1)
    assert.deepEqual(parsed.missing, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseStickerMarkers：未知名 → 进 missing，标记照样抠掉', () => {
  const { root, dir } = makeLib([row('偷笑', '004-touxiao.jpg')])
  try {
    const idx = loadStickers(dir)
    const parsed = parseStickerMarkers('这个 [表情:库里没有的] 呢', idx)
    assert.deepEqual(parsed.missing, ['库里没有的'])
    assert.equal(parsed.stickers.length, 0)
    assert.ok(!parsed.text.includes('[表情:'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parseStickerMarkers：空库（index 为 null）→ 标记全进 missing', () => {
  const parsed = parseStickerMarkers('[表情:偷笑] [表情:心动]', null)
  assert.deepEqual(parsed.missing, ['偷笑', '心动'])
  assert.equal(parsed.stickers.length, 0)
  assert.equal(parsed.text, '')
})

test('parseStickerMarkers：没有标记 → 原样不动', () => {
  const parsed = parseStickerMarkers('就一句话', { byName: new Map(), list: [] })
  assert.equal(parsed.text, '就一句话')
  assert.deepEqual(parsed.stickers, [])
  assert.deepEqual(parsed.missing, [])
})

/* ---------- 图段 ---------- */

test('stickerSegments：只出图片段（没有文字段），file 指向库里那张', () => {
  const { root, dir } = makeLib([row('偷笑', '004-touxiao.jpg')])
  try {
    const idx = loadStickers(dir)
    const parsed = parseStickerMarkers('[表情:偷笑]', idx)
    const segs = stickerSegments(parsed.stickers)
    assert.equal(segs.length, 1)
    assert.equal(segs[0].type, 'image')
    assert.equal(segs[0].data.file, join(dir, '004-touxiao.jpg'))
    assert.ok(!segs.some((s) => s.type === 'text'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stickerSegments：没有表情 → 空段数组', () => {
  assert.deepEqual(stickerSegments([]), [])
  assert.deepEqual(stickerSegments(null), [])
})

/* ---------- 找不着时要说出去 ---------- */

test('missingStickerText：一个/多个/没有', () => {
  assert.equal(missingStickerText(['偷笑']), '（表情库里没有「偷笑」）')
  assert.equal(missingStickerText(['偷笑', '心动']), '（表情库里没有「偷笑」「心动」）')
  assert.equal(missingStickerText([]), '')
  assert.equal(missingStickerText(null), '')
})

test('STICKER_MARK_RE 只认 [表情:...]，普通方括号不吃', () => {
  assert.ok(STICKER_MARK_RE.test('[表情:偷笑]'))
  STICKER_MARK_RE.lastIndex = 0
  assert.ok(!STICKER_MARK_RE.test('[发图:abc.jpg]'))
  STICKER_MARK_RE.lastIndex = 0
  assert.ok(!STICKER_MARK_RE.test('普通[括号]'))
  STICKER_MARK_RE.lastIndex = 0
})

test('全角冒号/全角方括号也认（2026-11-07 真事回归）', () => {
  // 我把半角冒号打成全角「：」，标记没认出来、原样发给了她
  STICKER_MARK_RE.lastIndex = 0
  assert.ok(STICKER_MARK_RE.test('[表情：咬被被]'))
  STICKER_MARK_RE.lastIndex = 0
  assert.ok(STICKER_MARK_RE.test('［表情：咬被被］'))
  STICKER_MARK_RE.lastIndex = 0
})

test('PHOTO_MARK_RE 全角冒号/全角方括号也认', () => {
  PHOTO_MARK_RE.lastIndex = 0
  assert.equal(PHOTO_MARK_RE.test('[发图：E:\\x\\a.png]'), true)
  PHOTO_MARK_RE.lastIndex = 0
  assert.equal(PHOTO_MARK_RE.test('［发图:E:\\x\\a.png］'), true)
  PHOTO_MARK_RE.lastIndex = 0
  assert.equal(PHOTO_MARK_RE.test('[表情:abc]'), false)
  PHOTO_MARK_RE.lastIndex = 0
})
