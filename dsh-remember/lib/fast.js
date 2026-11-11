/**
 * 快层 —— 秒级发生的事，在中层这一侧的表示。
 *
 * 快层本体在 dsh-body 那边（身体的心跳：吃了没吃上、他添了饭、被夸被骂、饿过头）。
 * 那边只把最近一小会儿的事写进自己的 body-events.jsonl，TTL 一过就从开头撤掉。
 *
 * 这一侧要做的是让这些秒级的事**别只是一闪**：
 *   · 只读那边的 append-only 事件流，按游标增量抄进我们自己的 fast.jsonl（也只增不改）；
 *   · 抄进来的事**不变成节点** —— 节点代表我的理解、带我写的分量、要参加开头的竞争；
 *     秒级的事只有发生的时间，没有分量。所以它不跟账本里的条抢位置。
 *   · 但它能被翻到（recall 按词、memory_list 列最近），也能由我拿 remember 掂量一次，
 *     掂量出来的那条 refs 指回 f_xxx（边指向原话）。
 *
 * 原则跟账本那边一致：分量是我写下的判断，谁都不该替我拨。
 * 所以这里只做「收着、找得到、等着被掂量」，不替我决定哪件事重要。
 */

export const FAST_KINDS = ['meal', 'missed', 'topup', 'mood', 'threshold']

const KIND_LABEL = {
  meal: '吃了一口',
  missed: '错过一顿',
  topup: '他添了饭',
  mood: '心里动了一下',
  threshold: '身体到线了',
}

export function fastKindLabel(kind) {
  return KIND_LABEL[String(kind ?? '')] ?? '有件事'
}

/** 快层事件的稳定 id：同一个来源事件永远同一个 id（重抄、重启都对得上）。 */
export function fastEventId({ source = '', at = 0, kind = '', text = '' } = {}) {
  const raw = `${source}|${Number(at) || 0}|${String(kind)}|${String(text)}`
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `f_${h.toString(36).padStart(7, '0')}`
}

/**
 * 把一行原始事件归一化。坏行返回 null（不因为一行坏了丢整批）。
 * text 不许带阿拉伯数字 —— 那是身体那边的规矩，抄过来也守着。
 */
export function normFastEvent(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const at = Number(raw.at)
  if (!Number.isFinite(at) || at <= 0) return null
  const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const kind = FAST_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'other'
  const source = String(raw.source ?? 'dsh-body').trim() || 'dsh-body'
  const ev = {
    id: fastEventId({ source, at, kind, text }),
    at,
    kind,
    text,
    source,
  }
  if (raw.detail && typeof raw.detail === 'object') ev.detail = raw.detail
  return ev
}

/** 相对时间：这一层不写数字，跟身体那边一个口气（刚刚／不久前／一会儿前…）。 */
export function fastRelTime(at, now = Date.now()) {
  const t = Number(at)
  const n = Number(now)
  if (!Number.isFinite(t) || !Number.isFinite(n)) return ''
  const mins = Math.floor(Math.max(0, n - t) / 60000)
  if (mins < 2) return '刚刚'
  if (mins < 15) return '不久前'
  if (mins < 60) return '一会儿前'
  const hours = Math.floor(mins / 60)
  if (hours < 6) return '今天早些时候'
  if (hours < 24) return '今天早些时候'
  if (hours < 48) return '前天'
  return '前几天'
}

/** 一行快层事件长什么样（recall / memory_list 里用）。 */
export function renderFastLine(ev, now = Date.now()) {
  if (!ev) return ''
  const when = fastRelTime(ev.at, now)
  const label = fastKindLabel(ev.kind)
  return `· 快层·${label}·${ev.text}${when ? `（${when}）` : ''}`
}

/**
 * 索引：按 id 去重，按时间新的在前，最多留 max 条。
 * 满了就把最老的挤出去（文件里还在，只是内存里不翻了）。
 */
export function pushFastIndex(index, ev, max = 1000) {
  if (!ev || !ev.id) return Array.isArray(index) ? index : []
  const out = Array.isArray(index) ? index.filter((x) => x && x.id !== ev.id) : []
  out.push(ev)
  out.sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
  const cap = Math.max(1, Number(max) || 1000)
  return out.length > cap ? out.slice(0, cap) : out
}

/** 按词翻快层：词打在 text、kind 或者 detail 里都算。 */
export function searchFastEvents(events, query, { limit = 5 } = {}) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const out = []
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev) continue
    const hay = `${ev.text ?? ''} ${ev.kind ?? ''} ${fastKindLabel(ev.kind)} ${JSON.stringify(ev.detail ?? {})}`.toLowerCase()
    if (terms.every((t) => hay.includes(t))) out.push(ev)
    if (out.length >= Math.max(1, Number(limit) || 5)) break
  }
  return out
}

/** 快层现在攒了多少、按什么分的。 */
export function fastSummary(events, { weighed = new Set() } = {}) {
  const list = Array.isArray(events) ? events : []
  const byKind = {}
  let pending = 0
  for (const ev of list) {
    if (!ev) continue
    const key = fastKindLabel(ev.kind)
    byKind[key] = (byKind[key] ?? 0) + 1
    if (!weighed.has(ev.id)) pending += 1
  }
  return { total: list.length, pending, byKind }
}
