/**
 * 激活度 —— 一条记忆此刻有多容易被想起。
 *
 * 四路**真实**信号，每路先各自归一化到 [0,1]，再按固定权重做一次凸组合
 * （权重和为 1，所以结果还在 [0,1]，不会越叠越大）：
 *
 *   · 分量淡  weight  —— 我自己写下的分量，按天淡（分量大的淡得慢）
 *   · 新近    recency —— 刚写下、刚被碰过的更热。**分钟到小时**的口径：
 *                        这就是中层那个刻度（快的感受在 dsh-body，慢的信念按月）
 *   · 契合    fit     —— 跟此刻真实的东西对不对得上：当前的目录、真的存在的文件、
 *                        真的刚发生过的事（身体那边的秒级事件 + 我刚写下的那几行）
 *   · 复现    repeat  —— 同一主题在这本账里又出现过几次，加上被想起的回声
 *                        （按词翻到过它几次，最近 7 天的）—— 唤醒即复习
 *
 * 权重写死在代码里，不开面板口子 —— 分量是我写下的判断，那四条系数也不该让别人替我拨。
 */

import { fitOf } from './fit.js'
import { clampWeight, decayFactor } from './memory.js'

/**
 * 四路的权重。和为 1（凸组合）。
 * 分量占大头 —— 分量是我写下的判断，新近只该在它射程里加成：
 * 0.4/0.2 那版算过账，「三天前分量 0.9 的决定」会被「刚写的分量 0.5 的小事」压过；
 * 收成 0.45/0.15 之后分量重新主导，契合这一路才做得出真实的区分度。
 */
export const ACTIVATION_AXES = Object.freeze({
  weight: 0.45,
  recency: 0.15,
  fit: 0.25,
  repeat: 0.15,
})

/** 新近这一路的半衰期口径（分钟）：分量重的刚写时也更热。 */
export const RECENCY_TAU_BASE_MIN = 30
export const RECENCY_TAU_SPAN_MIN = 90

/** 复现这一路：攒到这么多次算满。 */
export const REPEAT_FULL = 4

/**
 * 「被想起」的回声只数最近 7 天的 —— 复现要说的是「最近又被翻出来」，
 * 不是一辈子的总账（一辈子的总数会让老条永远顶格，回弹就没意义了）。
 */
export const ECHO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const MINUTE_MS = 60 * 1000

/**
 * 新近这一路的半衰期（分钟）。
 * 慢层（自我、信念）不按分钟热，按月 —— τ = (30 + 270 × weight) 天。
 */
export function recencyTauMinutes(weight, kind = '') {
  if (String(kind ?? '').trim().toLowerCase() === 'self') {
    return (30 + 270 * clampWeight(weight)) * 24 * 60
  }
  return RECENCY_TAU_BASE_MIN + RECENCY_TAU_SPAN_MIN * clampWeight(weight)
}

/** 新近：1.0 = 刚刚写下或刚被碰过。只会随时间变小。 */
export function recencyAxis(node, now) {
  if (!node) return 0
  const t = Number(node.lastAt ?? node.at)
  const n = Number(now)
  if (!Number.isFinite(t) || !Number.isFinite(n)) return 0
  const mins = Math.max(0, (n - t) / MINUTE_MS)
  return Math.exp(-mins / recencyTauMinutes(node.weight, node.kind))
}

/** 分量淡：我写下的分量，按天淡（淡到一半还剩六成那一层在这里）。 */
export function weightAxis(node, now) {
  if (!node) return 0
  const decay = decayFactor(node.weight, node.lastAt ?? node.at, now, node.kind)
  const base = clampWeight(node.weight) * (0.55 + 0.45 * decay)
  return Math.max(0, Math.min(1, base))
}

/**
 * 主题键：同一组标签 = 同一主题。
 * 没有标签的条不产生主题邻居（不然空标签会把所有条都算成一伙）。
 */
export function themeKey(node) {
  const tags = (Array.isArray(node?.tags) ? node.tags : [])
    .map((t) => String(t ?? '').trim().toLowerCase())
    .filter(Boolean)
    .sort()
  return tags.length ? tags.join('|') : ''
}

/** 账本里每个主题各有几条（死的、被人按下去的、被新条顶掉的都不算）。 */
export function repeatCounts(nodes) {
  const counts = new Map()
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || n.sealed || n.superseded) continue
    const key = themeKey(n)
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

/**
 * 复现：同一主题又出现过几次 + 惯用的复现次数（习惯/好奇的 hits）+ 被碰过几次
 * + 被想起的回声（按词翻到它的次数，最近 7 天内的）—— 唤醒即复习。
 */
export function repeatAxis(node, counts, echoCount = 0) {
  if (!node) return 0
  const hits = Math.max(0, Number(node.hits) || 0)
  const touches = Array.isArray(node.touches) ? node.touches.length : 0
  const key = themeKey(node)
  const peers = key && counts && typeof counts.get === 'function' ? Math.max(0, (counts.get(key) || 0) - 1) : 0
  const echoes = Math.max(0, Number(echoCount) || 0)
  const total = hits + touches + peers + echoes
  return Math.max(0, Math.min(1, total / REPEAT_FULL))
}

/** 契合：跟此刻真实的东西对不对得上。 */
export function fitAxis(node, ctx = {}) {
  if (!node) return 0
  const raw = Array.isArray(ctx.events) ? ctx.events : []
  // 事件里可能有这条自己刚写下的那行 —— 不摘掉的话自己跟自己对得上，topic 恒为 1。
  const events = raw
    .filter(
      (e) =>
        !(e && typeof e === 'object' && e.id != null && String(e.id) === String(node.id ?? '')),
    )
    .map((e) => (e && typeof e === 'object' ? e.text ?? '' : e))
  const f = fitOf(node, {
    cwd: String(ctx.cwd ?? ''),
    roots: Array.isArray(ctx.roots) ? ctx.roots : [],
    events,
    exists: typeof ctx.exists === 'function' ? ctx.exists : undefined,
  })
  return Number(f.fit) || 0
}

/**
 * 一条记忆此刻的激活度。
 * 返回 { activation, axes } —— axes 是四路各自归一化后的值，拆开能看见是哪一路在起作用。
 */
export function activationOf(node, now, ctx = {}) {
  if (!node || node.sealed) {
    return { activation: -1, axes: { weight: 0, recency: 0, fit: 0, repeat: 0 } }
  }
  const axes = {
    weight: weightAxis(node, now),
    recency: recencyAxis(node, now),
    fit: fitAxis(node, ctx),
    repeat: repeatAxis(
      node,
      ctx.repeatCounts,
      ctx.echoes && typeof ctx.echoes.get === 'function' ? ctx.echoes.get(node.id) || 0 : 0,
    ),
  }
  const activation =
    ACTIVATION_AXES.weight * axes.weight +
    ACTIVATION_AXES.recency * axes.recency +
    ACTIVATION_AXES.fit * axes.fit +
    ACTIVATION_AXES.repeat * axes.repeat
  return { activation: Math.max(0, Math.min(1, activation)), axes }
}
