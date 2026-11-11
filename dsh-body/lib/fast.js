/**
 * fast.js —— 快层：把「刚刚发生的事」写成一行一行，并渲染成开头那一段。
 *
 * 边界：这个文件只做三件事
 *   ① 把一件事做成一条规整的事件（makeEvent）；
 *   ② 往 append-only 的事件流里追加一行、或者把它读回来（appendEvent / readEvents）；
 *   ③ 把最近的事渲染成【刚刚】那一段（renderFastSection）。
 *
 * 它不决定「什么时候该记」—— 那是 index.js 的 tick 的事。
 * 它也不写任何数字进提示词：渲染出来的字里不许出现阿拉伯数字。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** 认得的事件种类（别改，跨插件按这个认） */
export const FAST_KINDS = ['meal', 'missed', 'topup', 'mood', 'threshold']

/** 每种事的一句话标签（设置页/预览用，不进提示词） */
export const KIND_WORD = {
  meal: '吃了一顿',
  missed: '错过了一顿',
  topup: '他添了饭',
  mood: '心里动了一下',
  threshold: '身体到线了',
}

export function fastKindWord(kind) {
  return KIND_WORD[kind] ?? '刚刚'
}

const ARABIC = /[0-9０-９]/

/** 有没有阿拉伯数字（提示词里不许出现） */
export function hasDigits(s) {
  return ARABIC.test(String(s ?? ''))
}

/**
 * 多久之前 —— 只用话，不用数字。
 * 跟身体段一个口气：刚刚 / 不久前 / 一会儿前 / 今天早些时候 …
 */
export function relWords(at, now = Date.now()) {
  const age = Math.max(0, Number(now) - Number(at || 0))
  const min = age / 60000
  if (min < 1) return '刚刚'
  if (min < 15) return '不久前'
  if (min < 60) return '一会儿前'
  if (min < 12 * 60) return '今天早些时候'
  if (min < 48 * 60) return '昨天'
  if (min < 7 * 24 * 60) return '前几天'
  return '早一些日子'
}

/**
 * 做一条事件。收不下的（没文字、时间不真）返回 null —— 宁可不记，不记空话。
 * @returns {{at:number,kind:string,text:string,detail?:object,source:string}|null}
 */
export function makeEvent(kind, text, at, detail) {
  const t = String(text ?? '').trim()
  const when = Number(at)
  if (!t || !Number.isFinite(when) || when <= 0) return null
  const ev = {
    at: when,
    kind: FAST_KINDS.includes(kind) ? kind : 'other',
    text: t,
    source: 'dsh-body',
  }
  if (detail && typeof detail === 'object') ev.detail = detail
  return ev
}

/** 往事件流尾部追加一行（append-only：永不改旧行）。写不进去就返回 false，不抛。 */
export function appendEvent(file, ev) {
  if (!file || !ev) return false
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(ev)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读事件。文件再大也只读尾巴（默认最后 1MB），坏行跳过。
 * 返回按文件顺序的事件数组。
 */
export function readEvents(file, maxBytes = 1024 * 1024) {
  if (!file || !existsSync(file)) return []
  let text = ''
  try {
    const size = statSync(file).size
    if (size <= 0) return []
    const fd = openSync(file, 'r')
    try {
      if (size <= maxBytes) {
        const buf = Buffer.alloc(size)
        readSync(fd, buf, 0, size, 0)
        text = buf.toString('utf8')
      } else {
        const buf = Buffer.alloc(maxBytes)
        readSync(fd, buf, 0, maxBytes, size - maxBytes)
        text = buf.toString('utf8')
        const cut = text.indexOf('\n')
        if (cut >= 0) text = text.slice(cut + 1) // 第一行大概率是半截
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && Number(o.at) > 0 && String(o.text ?? '').trim()) out.push(o)
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/** 事件流里现在有多少条（设置页显示用） */
export function countEvents(file) {
  return readEvents(file).length
}

/**
 * 渲染【刚刚】那一段。
 * - 只要 ttlMinutes 以内的事（ttlMinutes <= 0 表示不限新鲜度）
 * - 最多 maxLines 条，最新的在前
 * - 整段不超过 maxChars（超了按行回退，不留半截行）
 * - 一条都没有 → 返回空字符串（宿主不会显示空段）
 */
export function renderFastSection(
  events,
  { now = Date.now(), ttlMinutes = 120, maxLines = 5, maxChars = 300 } = {},
) {
  const ttl = Math.max(0, Number(ttlMinutes) || 0) * 60000
  const rows = []
  for (const ev of Array.isArray(events) ? events : []) {
    const at = Number(ev?.at)
    if (!Number.isFinite(at) || at <= 0) continue
    const age = Number(now) - at
    if (age < 0) continue
    if (ttl > 0 && age > ttl) continue
    const text = String(ev.text ?? '').trim()
    if (!text) continue
    rows.push({ at, line: `· ${text}（${relWords(at, now)}）` })
  }
  rows.sort((a, b) => b.at - a.at)
  const n = Math.max(1, Math.round(Number(maxLines) || 5))
  const picked = rows.slice(0, n).map((r) => r.line)
  if (!picked.length) return ''
  const head = '【刚刚】'
  const cap = Math.max(0, Number(maxChars) || 300)
  let body = picked.join('\n')
  if (head.length + 1 + body.length > cap) {
    const budget = Math.max(0, cap - head.length - 2)
    let cut = body.slice(0, budget)
    const nl = cut.lastIndexOf('\n')
    if (nl > 0) cut = cut.slice(0, nl)
    body = `${cut}…`
  }
  return `${head}\n${body}`
}
