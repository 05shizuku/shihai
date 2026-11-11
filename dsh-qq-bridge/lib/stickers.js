/**
 * 表情包标记（v0.8.0）：回话正文里的 [表情:名字] 变成真图片段发出去。
 *
 * 表情库在 <DSH_HOME>/.dsh-qq-bridge/stickers/：
 *   manifest.jsonl —— 一行一张，{at, name, file, from, via, note}
 *   001-yaobeibei.jpg —— 图本体，file 字段写的就是这个文件名
 *
 * 名字是 Amikar 自己取的（她分享图，名字不外包）：她写什么，这里就照着查什么。
 * 查不到不静默吞掉 —— 回话里会带一句「表情库里没有「xxx」」，让人知道她想发什么。
 *
 * 零依赖：只用 node 内置模块；图片段的形状直接借 lib/photos.js（不另写一套）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toSegments } from './photos.js'

/** 回话里的 [表情:名字] 标记。2026-11-07 真事：我把半角冒号打成了全角「：」，
 * 标记没被认出来、原样发了出去 —— 中文输入法下全角冒号是常态，两种都认；
 * 全角方括号［表情：xxx］也顺手认。 */
export const STICKER_MARK_RE = /[［\[]\s*表情\s*[:：]\s*([^\]］\r\n]+?)\s*[］\]]/g

/** 库里没有就出声时用的话（名字排在里面）。 */
export const STICKER_MISSING_REASON = '表情库里没有'

/** 全角括号 → 半角，统一了名字才好对。 */
const BRACKET_MAP = {
  '（': '(',
  '）': ')',
  '［': '[',
  '］': ']',
  '【': '[',
  '】': ']',
  '｛': '{',
  '｝': '}'
}

/**
 * 名字规范化：去空白、全角括号折半角、外层的括号去掉。
 * 这样 【偷笑】、（偷笑）、偷笑 指的是同一张。
 */
export function normalizeStickerName(name) {
  let s = String(name ?? '')
  s = s.replace(/\s+/g, '')
  s = s.replace(/[（）［］【】｛｝]/g, (ch) => BRACKET_MAP[ch] ?? ch)
  s = s.replace(/^[([]+/, '').replace(/[)\]]+$/, '')
  return s.trim()
}

/**
 * 读表情库。
 * - dir 为空/目录不存在/文件不在 → 空表，不抛（库里没有表情不是事故）；
 * - 坏行、缺 name、缺 file 的行跳过；
 * - 同名后者不覆盖前者（先到的赢），重名只记一笔，不抛。
 * 返回 { byName: Map<规范化名字, {name,file,path,note}>, list: [...] }
 */
export function loadStickers(dir, opts = {}) {
  const { log = () => {} } = opts
  const byName = new Map()
  const list = []
  const dirPath = String(dir ?? '').trim()
  if (!dirPath) return { byName, list }
  let raw = ''
  try {
    raw = readFileSync(join(dirPath, 'manifest.jsonl'), 'utf8')
  } catch {
    return { byName, list }
  }
  for (const line of String(raw).split(/\r?\n/)) {
    const t = String(line ?? '').trim()
    if (!t) continue
    let row = null
    try {
      row = JSON.parse(t)
    } catch {
      continue // 坏行跳过：库里有一行坏的不该让整个库瘫掉
    }
    if (!row || typeof row !== 'object') continue
    const name = String(row.name ?? '').trim()
    const file = String(row.file ?? '').trim()
    if (!name || !file) continue
    const key = normalizeStickerName(name)
    if (!key) continue
    const entry = { name, file, path: join(dirPath, file), note: String(row.note ?? '') }
    list.push(entry)
    if (byName.has(key)) {
      log(`表情库：名字重了「${name}」（先到的那份算数，后来的不覆盖）`)
      continue
    }
    byName.set(key, entry)
  }
  return { byName, list }
}

/**
 * 抠出正文里的 [表情:名字]。
 * 返回 { text: 去掉标记后的正文, stickers: [{name,path}], missing: [名字...] }
 * - index 为空/没有这一张 → 进 missing（不是静默吞掉，是回话里会说出来）；
 * - 同一个名字出现两次只取一次。
 */
export function parseStickerMarkers(text, index) {
  const src = String(text ?? '')
  const stickers = []
  const missing = []
  const seen = new Set()
  let marked = false
  const clean = src.replace(STICKER_MARK_RE, (_m, raw) => {
    const name = String(raw ?? '').trim()
    if (!name) return ''
    const key = normalizeStickerName(name)
    if (!key) return ''
    if (seen.has(key)) return '' // 同一个名字只取一次
    seen.add(key)
    marked = true
    const hit = index?.byName?.get?.(key)
    if (hit?.path) stickers.push({ name: hit.name, path: hit.path })
    else missing.push(name)
    return ''
  })
  // 抠掉标记留下的空档收一收（只在这一轮真抠过标记时才动正文）
  const tidy = marked ? clean.replace(/[ \t]{2,}/g, ' ') : clean
  return { text: tidy.replace(/[ \t]+$/gm, '').trim(), stickers, missing }
}

/**
 * 表情 → OneBot 图片段（本地路径）。
 * 形状直接借 lib/photos.js 的 toSegments（不另写一套）。
 */
export function stickerSegments(stickers) {
  const paths = (stickers ?? []).map((s) => String(s?.path ?? '')).filter(Boolean)
  return toSegments('', paths)
}

/** 库里没有的名字凑成一句要说出去的话：表情库里没有「偷笑」。 */
export function missingStickerText(missing) {
  const names = (missing ?? []).map((n) => `「${String(n ?? '').trim()}」`).filter((s) => s !== '「」')
  if (!names.length) return ''
  return `（${STICKER_MISSING_REASON}${names.join('')}）`
}
