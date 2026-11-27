/**
 * commands/emotion.mjs 的特征钉（批 A 第一步，G-2 施工稿）。
 *
 * 命令层是 G-2 唯一能动到行为的地方——这些钉录的是「现行为」：分支回执逐字、
 * D7 游标语义、vikarma 落账字段。迁移与未来重构（批 B/C）都以这些钉为准。
 * 更厚的行为网在 characterization.test.mjs（走工具壳）与冒烟（逐字回执）——
 * 这里钉的是命令层直调的分支面（不走宿主 wrapper）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBook, loadEmotionIndex, loadFeelTracker } from '../../core/protocol/book.js'
import { createEmotionCommands } from '../commands/emotion.mjs'

const T0 = Date.parse('2026-11-27T02:00:00.000Z')

function rig(t = { enabled: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'cmd-emo-'))
  const bookDir = join(dir, 'book')
  mkdirSync(bookDir, { recursive: true })
  const book = createBook({
    dataDir: bookDir,
    log: () => {},
    dshHome: dir,
    bodyHome: join(dir, '.dsh-body'),
    rememberTag: 'dsh-remember',
    bodySourceTag: 'dsh-body',
  })
  loadFeelTracker(book)
  loadEmotionIndex(book)
  const commands = createEmotionCommands({ book, log: () => {}, cfg: () => t, now: () => T0, resolveDshHome: () => dir })
  return { dir, book, commands, emoFile: join(bookDir, 'emotion.jsonl'), bridgeDir: join(dir, '.dsh-qq-bridge') }
}

// ------------------------------------------------- emotion_tune：分支回执逐字

test('emotion_tune 分支回执逐字（批 A 特征钉）', () => {
  const { commands } = rig()
  assert.deepEqual(
    commands.emotionTune({ emotion: '愤怒', to: 1.5, reason: 'r' }),
    { ok: false, id: '', emotion: '愤怒', from: 0, to: 0, note: '只认这七种：warm / pleased / curious / tense / down / restless / lonely' },
    '不认识的 emotion 拒',
  )
  assert.deepEqual(
    commands.emotionTune({ emotion: 'warm', to: 0, reason: 'r' }),
    { ok: false, id: '', emotion: 'warm', from: 0, to: 0, note: '系数得在 0 到 3 之间。' },
    'to=0 拒',
  )
  assert.deepEqual(
    commands.emotionTune({ emotion: 'warm', to: 3.5, reason: 'r' }),
    { ok: false, id: '', emotion: 'warm', from: 0, to: 0, note: '系数得在 0 到 3 之间。' },
    'to>3 拒',
  )
  assert.deepEqual(
    commands.emotionTune({ emotion: 'warm', to: 1.5, reason: '   ' }),
    { ok: false, id: '', emotion: 'warm', from: 0, to: 1.5, note: '改系数得给个理由 —— 写给以后的我看。' },
    '没理由拒',
  )
})

test('emotion_tune 落账：tune 行进 emotion.jsonl，回执带 refs 指回（批 A 特征钉）', () => {
  const { commands, emoFile } = rig()
  const out = commands.emotionTune({ emotion: 'warm', to: 1.5, halfLife: 30, reason: '被夸的时候更暖' })
  assert.equal(out.ok, true, `落成（${out.note}）`)
  assert.equal(out.from, 1, '首改 from=1（种子系数）')
  assert.equal(out.to, 1.5)
  const rows = readFileSync(emoFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
  const tune = rows.find((r) => r.kind === 'tune')
  assert.ok(tune, '账上有一行 tune')
  assert.equal(tune.emotion, 'warm')
  assert.equal(tune.from, 1)
  assert.equal(tune.to, 1.5)
  assert.equal(tune.halfLife, 30)
  assert.equal(tune.reason, '被夸的时候更暖')
  assert.ok(out.note.includes(`refs 指回 ${out.id}`), '回执教了怎么进【我记得的】')
})

test('emotion_tune 关账回执逐字（批 A 特征钉）', () => {
  const { commands } = rig({ enabled: false })
  assert.deepEqual(
    commands.emotionTune({ emotion: 'warm', to: 1.5, reason: 'r' }),
    { ok: false, id: '', emotion: '', from: 0, to: 0, note: '账本现在是关着的（设置 → 记得）。' },
  )
})

// ------------------------------------------------- vikarma：分支 + 落账字段

function seedWillDo(book, id = 'r_seed1') {
  book.nodes.push({
    id, at: T0 - 3600_000, lastAt: T0 - 3600_000, text: '要早点睡', kind: 'seed',
    weight: 0.8, changes: '', conflicts: '', willDo: '23 点前放下手机', known: '',
    tags: [], refs: [], touches: [], audience: 'any', happenedAt: 0, prev: '', prevSelf: '',
    anchor: false, anchorWhy: '', restoredAt: 0, replaces: [], contexts: [], hits: 0,
    answered: false, moodAt: null, sealed: false, sealUntil: 0, sealCond: '', faded: false,
    superseded: false, supersededBy: '', supersededAt: 0, transformed: false, transformedBy: '', transformedAt: 0,
    slot: '', context: '',
  })
  return id
}

test('vikarma 分支回执逐字（批 A 特征钉）', () => {
  const { commands, book } = rig()
  assert.deepEqual(
    commands.vikarma({ seedId: 'r_none', reason: '未触发' }),
    { ok: false, id: 'r_none', note: '没有这条种子：r_none' },
    '没有这条种子',
  )
  const id = seedWillDo(book)
  book.nodes[0].willDo = ''
  assert.deepEqual(
    commands.vikarma({ seedId: id, reason: '未触发' }),
    { ok: false, id, note: '这条种子没写 will_do —— 没有「说会做得不一样」，就谈不上违熏。' },
    '没有 will_do 拒',
  )
  book.nodes[0].willDo = '23 点前放下手机'
  assert.deepEqual(
    commands.vikarma({ seedId: id, reason: '忘了' }),
    { ok: false, id, note: 'reason 只认三个：未触发 / 语气偏离 / 条件不成立' },
    'reason 枚举外拒',
  )
  assert.deepEqual(
    commands.vikarma({ seedId: id, reason: '未触发', echoId: 'x99' }),
    { ok: false, id, note: 'echoId 得是回声行的 id（e_ 开头）：x99' },
    'echoId 形状拒',
  )
})

test('vikarma 落账：vk 行 + 原话层留痕，sessionId/cwd 来自 ctx（批 A 特征钉）', () => {
  const { commands, book, dir } = rig()
  const id = seedWillDo(book)
  const out = commands.vikarma(
    { seedId: id, reason: '未触发', actual: '刷到了一点半' },
    { cwd: 'D:\\work\\测试', sessionId: 'sess-9' },
  )
  assert.equal(out.ok, true, `记下（${out.note}）`)
  assert.ok(out.id.startsWith('vk_'), 'vk_ 票号')
  const vkRows = readFileSync(book.files.vikarma, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
  const row = vkRows[vkRows.length - 1]
  assert.equal(row.seedId, id)
  assert.equal(row.reason, '未触发')
  assert.equal(row.actual, '刷到了一点半')
  assert.ok(row.expected.includes('23 点前放下手机'), 'expected 自动取 will_do')
  assert.equal(row.sessionId, 'sess-9', 'sessionId 来自 ctx')
  assert.equal(row.cwd, 'D:\\work\\测试', 'cwd 来自 ctx')
  const lineRows = readFileSync(book.files.lines, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
  const line = lineRows[lineRows.length - 1]
  assert.equal(line.note, 'vikarma', '原话层留痕行')
  assert.equal(line.sessionId, 'sess-9', '留痕行同样带 ctx')
  assert.ok(line.text.startsWith('违熏：未触发'), '留痕文本')
})

// ------------------------------------------------- emotion_state 关账 + 拉取族闸门

test('emotion_state 关账回执逐字（批 A 特征钉）', () => {
  const { commands } = rig({ enabled: false })
  assert.deepEqual(
    commands.emotionState({}),
    {
      ok: false, dominant: 'calm', label: '平静', level: 0, levels: {}, coefficients: {},
      items: [], note: '账本现在是关着的（设置 → 记得）。',
    },
  )
})

test('拉取族闸门：关着时 pull 全家返回 0（批 A 特征钉）', () => {
  const { commands } = rig({ enabled: false })
  assert.equal(commands.pullFast(), 0, 'pullFast 闸')
  assert.equal(commands.pullIntent(), 0, 'pullIntent 闸')
  assert.equal(commands.pullEmotion(), 0, 'pullEmotion 闸')
})

test('intentSourcePaths：自定义源优先，否则扫桥家分册（批 A 特征钉）', () => {
  const { commands, bridgeDir } = rig()
  const custom = commands.intentSourcePaths({ intentSource: 'C:\\somewhere\\feed.jsonl' })
  assert.deepEqual(custom, ['C:\\somewhere\\feed.jsonl'], '自定义源原样（绝对路径）')
  mkdirSync(bridgeDir, { recursive: true })
  writeFileSync(join(bridgeDir, 'messages-private-2316650553.jsonl'), '')
  writeFileSync(join(bridgeDir, 'messages-group-615628177.jsonl'), '')
  writeFileSync(join(bridgeDir, 'messages.jsonl'), '')
  const auto = commands.intentSourcePaths({ intentSource: '' })
  assert.deepEqual(auto, [join(bridgeDir, 'messages.jsonl'), join(bridgeDir, 'messages-group-615628177.jsonl'), join(bridgeDir, 'messages-private-2316650553.jsonl')], '旧合订本在前 + 分册排序')
})

// ------------------------------------------------- 情绪流索引（D7 语义复钉：命令层同款）

test('emotionLines：外部追加增量拉取不重不漏（批 A 特征钉，命令层）', () => {
  const { commands, book, emoFile } = rig()
  const row = (id, at) =>
    JSON.stringify({ at, kind: 'event', id, source: 'intent', ref: id, key: `intent|${id}`, emotion: 'warm', delta: 0.3, halfLife: 30, intensity: 3, text: `事件 ${id}` })
  writeFileSync(emoFile, row('e1', T0 - 2000) + '\n' + row('e2', T0 - 1000) + '\n')
  loadEmotionIndex(book)
  assert.equal(commands.emotionLines().length, 2, '启动整读 2 行')
  appendFileSync(emoFile, row('e3', T0) + '\n')
  assert.equal(commands.emotionLines().length, 3, '命令层 refresh 增量拉到')
  assert.equal(commands.emotionLines().length, 3, '再调不重复')
  const state = commands.emotionStateRaw(T0)
  assert.equal(state.lines.length, 3, 'emotionState 同源')
  assert.equal(state.dominant, 'warm', '主情绪折出')
})

test('noteEmotion：同 key 去重 + 游标不动（批 A 特征钉，命令层）', () => {
  const { commands, book, emoFile } = rig()
  const first = commands.noteEmotion({ source: 'intent', ref: 'i_1', at: T0 - 5000, kind: 'praise', intensity: 3, text: '夸' })
  assert.ok(first, '首记成')
  assert.ok(first.id.startsWith('e_'), '事件行 id')
  const second = commands.noteEmotion({ source: 'intent', ref: 'i_1', at: T0 - 4000, kind: 'praise', intensity: 3, text: '夸' })
  assert.equal(second, null, '同 key 不重记')
  const rows = readFileSync(emoFile, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  assert.equal(rows.length, 1, '账上只有一行')
})

test('emotion_state 快路径：事件折进 items（批 A 特征钉，命令层直调）', () => {
  const { commands, emoFile } = rig()
  appendFileSync(emoFile, JSON.stringify({ at: T0 - 1000, kind: 'event', id: 'e_x1', source: 'intent', ref: 'i_x1', key: 'intent|i_x1', emotion: 'warm', delta: 0.5, halfLife: 30, intensity: 5, text: '她说了一句特别暖的话' }) + '\n')
  const out = commands.emotionState({ limit: 5 })
  assert.equal(out.ok, true)
  assert.equal(out.dominant, 'warm')
  assert.ok(out.items.some((l) => l.startsWith('e_x1 ')), 'items 带事件行 id 前缀')
  assert.ok(out.coefficients.warm, '系数表带 warm')
})
