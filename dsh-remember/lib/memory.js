/**
 * 账本的算法。纯函数，不碰文件、不看时钟（now 一律当参数传进来）。
 *
 * 三条不变量：
 *  1. 分量随时间淡，但**只在读的时候算** —— 账本本身不被时间改，重放同一天永远得同一个结果。
 *  2. 淡不等于删。再淡的条也还在，问得具体就能捞回来。
 *  3. 没写「三问」的条也能存（原话层永远收），但不会被挂到明天的开头。
 */

export const KINDS = ['fact', 'decision', 'lesson', 'skill', 'open', 'self', 'habit', 'curiosity']

import { rankByQuery, MIN_RELEVANCE } from './search.js'

export const KIND_LABEL = {
  fact: '事实',
  decision: '决定',
  lesson: '教训',
  skill: '会了',
  open: '没结',
  self: '我',
  habit: '习惯',
  curiosity: '好奇',
}

/**
 * 习惯层：某个情境里我会照着做的事。
 *
 * 双通路的意思：同一条记忆只走一条路的话，要么每次都靠「竞争」抢位置，
 * 要么就靠反复想起才浮上来。所以给习惯留了第二条路 ——
 * 同一个情境里第 2 次出现 = 习惯成立，第 3 次起走快通路：
 * 单独一段直接送到开头，不再跟别的条抢那三个位置。
 */
export const HABIT_ESTABLISH_HITS = 2
export const HABIT_FAST_HITS = 3

/**
 * 快通路上最多同时留几条习惯（默认 3）。
 * 超出上限的最弱的那条退回普通竞争 —— 这就是「活跃上限 N」这条收敛线。
 */
export const HABIT_LIMIT_DEFAULT = 3

/**
 * 好奇表：我想知道什么。
 *
 * 身份键＝主题（复用 context 字段存主题短句，跟习惯的情境同一个位置，
 * 但两者语义不同：习惯问「在什么场合下我会照着做」，好奇问「这件事我想知道什么」）。
 * 同一个主题再写一次 = 我又惦记了一遍（次数 +1），不另建节点。
 *
 * 三个状态：
 *   thinking = 三问一条都没答 → 还算不上好奇，不挂开头
 *   active   = 答了任意一条、还没解答 → 挂在【好奇】那一段
 *   answered = 已经解答 → 退出活跃表（还在账本里，翻得到；同主题再写就回来）
 *
 * 「答了一条就算想过」跟整个账本一个口径（hasThought）：一条都没答的才只进原话层。
 */
export const CURIOSITY_LIMIT_DEFAULT = 3

/**
 * 自我层的槽位。自我不是一堆并列的记忆，而是几个「我现在是这样」的位置：
 * 我是谁 / 我在意什么 / 我不做什么。写同一个槽位的新值，旧的那条退下
 * （不删、还翻得到），但不再在开头跟我自己顶嘴。
 */
export const SELF_SLOTS = [
  { key: 'identity', label: '我是谁' },
  { key: 'cares', label: '我在意' },
  { key: 'refuses', label: '我不做' },
]

export const SELF_SLOT_KEYS = SELF_SLOTS.map((s) => s.key)

/** 分量淡到这个以下的自我条目就不再自称了（还在账本里，翻得到）。 */
export const SELF_MIN_WEIGHT = 0.15

/** 半衰期口径：τ = TAU_BASE + TAU_SPAN × weight（天）。分量 1.0 的条一个月才淡一半，0.2 的条几天就淡。 */
export const TAU_BASE = 2
export const TAU_SPAN = 28

/**
 * 慢层的钟：自我和信念不按天淡，按月。weight 1.0 ≈ 300 天淡一半。
 * 设计改动表里「慢层 α 0.02–0.05」说的就是这件事 —— 信念的更新率是月级的。
 */
export const SLOW_TAU_BASE = 30
export const SLOW_TAU_SPAN = 270

const DAY_MS = 24 * 60 * 60 * 1000

export function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

export function clampWeight(v, fallback = 0.5) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return clamp01(n)
}

export function normKind(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (KINDS.includes(s)) return s
  return 'fact'
}

/**
 * 槽位名：种子三个（我是谁 / 我在意 / 我不做），也可以自己长新的。
 * 字母（含中文）数字留着，别的并成一个连字符 —— 「我在意！」跟「我在意」是同一个槽位。
 */
export function normSlot(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return s || 'identity'
}

export function slotLabel(slot) {
  const key = normSlot(slot)
  const found = SELF_SLOTS.find((s) => s.key === key)
  return found ? found.label : key
}

/**
 * 情境：习惯在什么场合下发作。写给账本看的一句短语，
 * 比如「他问起记忆架构时」「每晚收工前」。同一句短语算同一个情境。
 */
export function normContext(v) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/** 情境的比较键：大小写、空格归一过，所以「他 问起」和「他问起」是同一个。 */
export function contextKey(v) {
  return normContext(v).toLowerCase()
}

export function tauDays(weight, kind = '') {
  if (normKind(kind) === 'self') return SLOW_TAU_BASE + SLOW_TAU_SPAN * clampWeight(weight)
  return TAU_BASE + TAU_SPAN * clampWeight(weight)
}

/** 1.0 = 刚写下。只会变小。 */
export function decayFactor(weight, lastAt, now, kind = '') {
  const t = Number(lastAt)
  const n = Number(now)
  if (!Number.isFinite(t) || !Number.isFinite(n)) return 1
  const days = Math.max(0, (n - t) / DAY_MS)
  return Math.exp(-days / tauDays(weight, kind))
}

/** 排名用它。淡到一半时还剩六成，碰过几次的再加一点 —— 上限 1.5。
 *  按住也算在排名头上（isSealed 读取时算）：手动按住的 -1；到点自松的，过了那条线
 *  分数就回来 —— 账本本身不动，同一天重放永远同一个结果。 */
export function score(node, now) {
  if (!node || isSealed(node, now)) return -1
  const decay = decayFactor(node.weight, node.lastAt ?? node.at, now, node.kind)
  const touches = Array.isArray(node.touches) ? node.touches.length : 0
  const touch = Math.min(1, touches / 4)
  const base = clampWeight(node.weight) * (0.55 + 0.45 * decay)
  return Math.max(0, Math.min(1.5, base + 0.15 * touch))
}

/**
 * 排名。scoreOf 可以换掉给分函数（激活度从这儿注入进来）——
 * 不给就用老 score：分量主导、淡到一半还剩六成、碰过几次的再加一点。
 */
export function rankNodes(nodes, now, { limit = 3, includeSealed = false, kind = '', scoreOf, byId } = {}) {
  const rank = typeof scoreOf === 'function' ? scoreOf : score
  const dir = byId || indexNodes(nodes)
  const list = (Array.isArray(nodes) ? nodes : [])
    .filter((n) => n && (includeSealed || !isSealed(n, now, dir)))
    .filter((n) => (kind ? normKind(n.kind) === kind : true))
  const scored = list.map((n) => ({ node: n, score: rank(n, now) }))
  scored.sort((a, b) => b.score - a.score || (Number(b.node.at) || 0) - (Number(a.node.at) || 0))
  return scored.slice(0, Math.max(0, limit))
}

export function relTime(at, now) {
  const t = Number(at)
  const n = Number(now)
  if (!Number.isFinite(t) || !Number.isFinite(n)) return ''
  const mins = Math.floor(Math.max(0, n - t) / 60000)
  if (mins < 2) return '刚写下'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

/** 「还剩多久」——按住到某个时刻时给人看的那句。只往前看，不看后面。 */
export function relSealLeft(until, now) {
  const t = Number(until)
  const n = Number(now)
  if (!Number.isFinite(t) || !Number.isFinite(n) || t <= n) return ''
  const mins = Math.ceil((t - n) / 60000)
  if (mins < 60) return `${mins} 分钟`
  const hours = Math.ceil(mins / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.ceil(hours / 24)} 天`
}

export function makeId(now, salt = '') {
  const s = `${now}${salt}${Math.random().toString(36).slice(2, 8)}`
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return `r_${h.toString(36)}`
}

export function cleanText(v, max = 2000) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * 按码点切，不切半个 emoji —— JS 的字符串是 UTF-16，直接 slice 会把代理对劈开。
 */
export function cutByCodePoints(text, max) {
  const cps = Array.from(String(text ?? ''))
  if (cps.length <= max) return cps.join('')
  return cps.slice(0, Math.max(0, max)).join('')
}

/**
 * 一段（段头 + 正文）压进 maxChars 字：超了就切，切完回退到最后一个整行，
 * 免得在半截行上停住。切点按码点算 —— 不切半个 emoji。
 */
export function clipSection(head, body, maxChars) {
  const h = String(head ?? '')
  const b = String(body ?? '')
  const headLen = Array.from(h).length
  const bodyLen = Array.from(b).length
  if (headLen + 1 + bodyLen <= maxChars) return `${h}\n${b}`
  const budget = Math.max(0, maxChars - headLen - 2) // 留给换行和「…」
  let cut = Array.from(b).slice(0, budget).join('')
  const nl = cut.lastIndexOf('\n')
  if (nl > 0) cut = cut.slice(0, nl)
  return `${h}\n${cut}…`
}

export function makeNode(input = {}, now = Date.now()) {
  // 盘上读回来的东西什么都可能是：null、字符串、被截断的对象。
  // 一个坏条不该让整本账读不进来。
  const src = input && typeof input === 'object' ? input : {}
  const text = cleanText(src.text)
  if (!text) return null
  const tags = Array.isArray(src.tags)
    ? src.tags.map((t) => cleanText(t, 24)).filter(Boolean).slice(0, 8)
    : String(src.tags ?? '')
        .split(/[,，\s]+/)
        .map((t) => cleanText(t, 24))
        .filter(Boolean)
        .slice(0, 8)
  const refs = Array.isArray(src.refs)
    ? src.refs.map((t) => cleanText(t, 40)).filter(Boolean).slice(0, 8)
    : String(src.refs ?? '')
        .split(/[,，\s]+/)
        .map((t) => cleanText(t, 40))
        .filter(Boolean)
        .slice(0, 8)
  return {
    id: cleanText(src.id, 40) || makeId(now, text.slice(0, 12)),
    at: Number(src.at) || now,
    lastAt: Number(src.lastAt) || Number(src.at) || now,
    text,
    kind: normKind(src.kind),
    /** 只有 kind='self' 有意义：这条自我陈述占哪个槽位 */
    slot: normKind(src.kind) === 'self' ? normSlot(src.slot) : '',
    /**
     * kind='habit'：这条习惯在什么情境下发作。
     * kind='curiosity'：这个好奇的主题（身份键）。
     * kind='skill'：这个技能的名字（身份键）—— 情境另记在 contexts 里。
     */
    context:
      normKind(src.kind) === 'habit' || normKind(src.kind) === 'curiosity' || normKind(src.kind) === 'skill'
        ? normContext(src.context)
        : '',
    /**
     * kind='skill'：这个技能在哪些情境里真的成过。
     * 两处**不同**的情境各成一次，技能才算成立（两个情境各成功一次，不是同一处两次）。
     * 情境是写下的那一刻真实所在的地方（工作目录），不是随手编的标签。
     */
    contexts:
      normKind(src.kind) === 'skill'
        ? (Array.isArray(src.contexts) ? src.contexts : [])
            .map((c) => ({
              at: Number(c?.at) || Number(src.at) || now,
              where: cleanText(c?.where ?? c, 120),
            }))
            .filter((c) => c.where)
            .slice(0, 16)
        : [],
    /**
     * kind='habit'：这个习惯在同一情境下出现过几次。
     *   第 2 次＝习惯成立，第 3 次起走快通路（单独一段直接送到开头，不参与竞争）。
     * kind='curiosity'：这个主题被我惦记过几遍。
     */
    hits:
      normKind(src.kind) === 'habit' || normKind(src.kind) === 'curiosity'
        ? Math.max(0, Math.floor(Number(src.hits) || 0))
        : 0,
    /**
     * 只有 kind='curiosity' 有意义：这个好奇已经解答了。
     * 解答了就退出活跃表（还在账本里，翻得到；同主题再写就回来）。
     */
    answered: normKind(src.kind) === 'curiosity' ? Boolean(src.answered) : false,
    weight: clampWeight(src.weight, 0.5),
    changes: cleanText(src.changes, 400),
    conflicts: cleanText(src.conflicts, 400),
    willDo: cleanText(src.willDo ?? src.will_do, 400),
    tags,
    refs,
    touches: Array.isArray(src.touches) ? src.touches.slice(-20) : [],
    sealed: Boolean(src.sealed),
    /**
     * 分区封存的可松开形态（都不设就是没封）：
     *   sealUntil —— 按住到某个时刻（毫秒）。读取时算：过了就自己松开，不用后台任务。
     *   sealCond  —— 按住到某件事翻篇（另一条节点的 id）。那条被顶掉/不在了，就自己松开。
     * sealed（布尔的「按住了」）跟这两种是并列的三种按法，restore 一次全清。
     */
    sealUntil: Number(src.sealUntil) || 0,
    sealCond: cleanText(src.sealCond, 40),
    faded: Boolean(src.faded),
    /** 被同槽位的新值顶下来了：不删、不参与「我」这一段，但翻得到 */
    superseded: Boolean(src.superseded),
    supersededBy: cleanText(src.supersededBy, 40),
    supersededAt: Number(src.supersededAt) || 0,
  }
}

/** 写入三问里答上任意一条，才算「想过了」，才配挂到明天开头。 */
export function hasThought(node) {
  if (!node) return false
  return Boolean(cleanText(node.changes) || cleanText(node.conflicts) || cleanText(node.willDo))
}

export function normNode(raw, now = Date.now()) {
  const n = makeNode(raw, now)
  if (!n) return null
  n.id = cleanText(raw?.id, 40) || n.id
  return n
}

export function normNodes(rawList, now = Date.now()) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const n = normNode(raw, now)
    if (!n || seen.has(n.id)) continue
    seen.add(n.id)
    out.push(n)
  }
  return out
}

export function renderLine(node, now, { byId } = {}) {
  if (!node) return ''
  const kind = normKind(node.kind)
  const label =
    kind === 'self'
      ? `我·${slotLabel(node.slot)}`
      : kind === 'habit'
        ? `习惯${node.context ? `·${node.context}` : ''}`
        : kind === 'curiosity'
          ? `好奇${node.context ? `·${node.context}` : ''}`
          : kind === 'skill'
            ? `会了${node.context ? `·${node.context}` : ''}`
            : (KIND_LABEL[kind] ?? '事实')
  const when = relTime(node.lastAt ?? node.at, now)
  const bits = [`【${label}】`, node.text]
  const extra = []
  if (node.sealed) extra.push('按住了')
  else if (isSealed(node, now, byId)) {
    // 到点/翻篇那种按法 —— 说清楚是什么在按着，别只写「按住了」
    if (node.sealUntil && now < Number(node.sealUntil)) extra.push(`按住·还有 ${relSealLeft(node.sealUntil, now)}`)
    else if (node.sealCond) extra.push('按住·等翻篇')
  }
  if (node.superseded) extra.push('已退下')
  if (kind === 'habit') {
    const hits = Number(node.hits) || 0
    const st = habitState(node)
    if (hits > 1) extra.push(`第 ${hits} 次`)
    if (st === 'established') extra.push('习惯成立')
    if (st === 'fast') extra.push('快通路')
  }
  if (kind === 'curiosity') {
    const hits = Number(node.hits) || 0
    if (hits > 1) extra.push(`惦记 ${hits} 次`)
    if (node.answered) extra.push('已解答')
    else if (!hasThought(node)) extra.push('还没想清楚')
  }
  if (kind === 'skill') {
    const cs = Array.isArray(node.contexts) ? node.contexts.length : 0
    if (cs >= SKILL_ESTABLISH_CONTEXTS) extra.push('两处情境都成过')
    else if (cs === 1) extra.push('一处情境')
  }
  if (when) extra.push(when)
  extra.push(`分量 ${clampWeight(node.weight).toFixed(1)}`)
  return `· ${bits.join('')}（${extra.join(' · ')}）`
}

/**
 * 自我层现在「自称」的是哪些条。
 * 一个槽位只留一条：同槽位写过新的，旧的那条就退下（不删，翻得到，只是不再自称）。
 * 淡到分量不够的自我条目也不自称了 —— 还在账本里，但不占开头。
 */
export function activeSelfNodes(nodes, now = Date.now()) {
  const dir = indexNodes(nodes)
  const list = (Array.isArray(nodes) ? nodes : []).filter(
    (n) => n && normKind(n.kind) === 'self' && !isSealed(n, now, dir) && !n.superseded && hasThought(n),
  )
  const best = new Map()
  for (const n of list) {
    if (selfWeight(n, now) < SELF_MIN_WEIGHT) continue
    const slot = normSlot(n.slot)
    const prev = best.get(slot)
    if (!prev || (Number(n.at) || 0) > (Number(prev.at) || 0)) best.set(slot, n)
  }
  const out = []
  for (const s of SELF_SLOTS) {
    const n = best.get(s.key)
    if (n) out.push(n)
  }
  // 自己长出来的槽位（不在种子里的）按分量排后面
  const extra = []
  for (const [slot, n] of best) {
    if (!SELF_SLOT_KEYS.includes(slot)) extra.push(n)
  }
  extra.sort((a, b) => selfWeight(b, now) - selfWeight(a, now))
  return [...out, ...extra]
}

/** 自我条的有效分量：weight 按慢钟淡。 */
export function selfWeight(node, now = Date.now()) {
  if (!node) return 0
  const decay = decayFactor(node.weight, node.lastAt ?? node.at, now, 'self')
  return clampWeight(node.weight) * decay
}

/**
 * 开头那段「我是谁」。跟记忆段分开：自我是「我现在是这样」，
 * 记忆是「发生过什么」。两者不抢位置，也不混在一段里。
 */
export function renderSelfSection(nodes, { now = Date.now(), maxChars = 400, title = '我' } = {}) {
  const list = activeSelfNodes(nodes, now)
  if (!list.length) return ''
  const head = `【${title}】`
  const lines = list.map((n) => `· ${slotLabel(n.slot)}：${n.text}`)
  return clipSection(head, lines.join('\n'), maxChars)
}

/**
 * 同槽位写新值 → 旧的退下。**不删**：旧条还在账本里、还能翻到，
 * 只是不再在开头跟我自己顶嘴。退下的动作会留一条原话。
 */
export function supersedeSelf(nodes, slot, newId, now = Date.now()) {
  const key = normSlot(slot)
  const out = []
  const superseded = []
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (n && normKind(n.kind) === 'self' && normSlot(n.slot) === key && n.id !== newId && !n.superseded) {
      const next = { ...n, superseded: true, supersededBy: newId, supersededAt: now, lastAt: n.lastAt }
      out.push(next)
      superseded.push(next.id)
      continue
    }
    out.push(n)
  }
  return { nodes: out, superseded }
}

/**
 * 习惯又发生了一次。
 *
 * 一个情境配一条习惯：同一个 context 再写一次 = 这个习惯在那个情境里又发作了一次
 * → 次数 +1（节点上的次数只是索引，每次发生都往原话层另留一行）。
 * 第 2 次 = 习惯成立，第 3 次起 = 走上快通路。
 * 返回 { nodes, node, repeated }：repeated=false 表示这是第一次。
 */
export function recordHabit(nodes, { context = '', text = '', changes = '', conflicts = '', willDo = '' } = {}, now = Date.now()) {
  const key = contextKey(context)
  const list = Array.isArray(nodes) ? nodes : []
  if (!key) return { nodes: list, node: null, repeated: false }
  const found = list.find(
    (n) => n && normKind(n.kind) === 'habit' && !n.sealed && !n.superseded && contextKey(n.context) === key,
  )
  if (!found) return { nodes: list, node: null, repeated: false }
  const next = {
    ...found,
    text: cleanText(text) || found.text,
    // 后来补上的三问要能补上：第一次没答、第二次答上了 → 这条就能挂上去了
    changes: cleanText(changes) || found.changes,
    conflicts: cleanText(conflicts) || found.conflicts,
    willDo: cleanText(willDo) || found.willDo,
    hits: (Number(found.hits) || 0) + 1,
    lastAt: now,
    touches: [
      ...(Array.isArray(found.touches) ? found.touches : []).slice(-19),
      { at: now, note: '又发生了一次' },
    ],
  }
  const out = list.map((n) => (n.id === next.id ? next : n))
  return { nodes: out, node: next, repeated: true }
}

const cpLen = (s) => Array.from(String(s ?? '')).length

const OPEN_HEAD = '还没结的：'
// 每条摘要连这点字都放不下时，摘要就没有信息量了 —— 改走一行标题。
const OPEN_BRIEF_FLOOR = 24

/**
 * 一条的「标题」：第一个断句之前的那截，要精炼直观，不要半个句子。
 * 例：「识海还没结的线（2026-11-01 23:30 更新）：①QQ 通道没开工…」→「识海还没结的线」
 * 「还没结的线：①…」→「还没结的线」。
 */
export function titleOf(text, max = 12) {
  let t = String(text ?? '').trim()
  t = t.replace(/^【[^】]*】\s*/, '')
  const m = t.match(/[：:。．！？；;，,、（(]/)
  if (m && m.index > 0) t = t.slice(0, m.index)
  t = t.replace(/[（(][^）)]*[)）]$/, '').trim()
  t = t.replace(/[，,。.；;：:、\s]+$/, '')
  const cps = Array.from(t)
  return cps.length > max ? cps.slice(0, max).join('') : cps.join('')
}

/**
 * 进度压不进三分之一时的兜底：整块折成一行，只有标题，用「／」隔开。
 * 放不下的从后面丢，丢过就补「…」；第一条就放不下就硬切第一条。
 * 一行，扫一眼就知道还欠着哪几件 —— 正文都在账本里，问得具体捞得回来。
 */
export function openTitlesLine(open, budget) {
  const parts = open.map((n) => titleOf(n?.text)).filter(Boolean)
  if (!parts.length) return ''
  let used = cpLen(OPEN_HEAD)
  let out = ''
  for (let i = 0; i < parts.length; i += 1) {
    const piece = (i ? '／' : '') + parts[i]
    if (used + cpLen(piece) > budget - 1) {
      if (!out) out = cutByCodePoints(parts[0], Math.max(1, budget - used - 2))
      return `${OPEN_HEAD}${out}…`
    }
    used += cpLen(piece)
    out += piece
  }
  return `${OPEN_HEAD}${out}`
}

/**
 * 每轮开头挂上去的那几行。人、事在前，进度（还没结的）在后。
 * 进度最多占整段的三分之一（2026-11-02 定的规矩）：先照常渲染摘要；
 * 超了就把每条压短（二分找最大的、能放进预算的摘要长度）；
 * 压到连像样的摘要都放不下（每条不足 24 字），就只剩一行标题。
 * 正文一个字没动，都在账本里，recall 问得具体就捞得回来。
 * 同一堆里不重复，总长不超过 maxChars —— 挂太多就等于没挂。
 * 自我层不参与这里的竞争：它自己有一段。
 */
export function renderSection(
  nodes,
  {
    now = Date.now(),
    openLimit = 2,
    limit = 3,
    maxChars = 900,
    title = '我记得的',
    briefMax = 120,
    habitLimit = HABIT_LIMIT_DEFAULT,
    scoreOf,
  } = {},
) {
  // 上了快通路的习惯不参加这里的竞争 —— 它们另有那一段。
  const fastIds = new Set(fastHabitIds(nodes, now, { limit: habitLimit }))
  // 没答三问的条不进开头（但还在账本里，问得具体照样翻得到）。
  // 这是文档里一直写着的那条规矩，之前实际没兜住 —— 2026-11-01 真机上发现的。
  // 好奇另有自己那一段，也不跟这里抢位置。
  // 条件封存（sealUntil/sealCond）也在这里算 —— 目录用整本账编，
  // 不然条件里指的那条要是被筛出了池子，就被当成「翻篇了」错手松开。
  const dir = indexNodes(nodes)
  const pool = (Array.isArray(nodes) ? nodes : []).filter(
    (n) =>
      n &&
      normKind(n.kind) !== 'self' &&
      normKind(n.kind) !== 'curiosity' &&
      !fastIds.has(n.id) &&
      !isSealed(n, now, dir) &&
      hasThought(n),
  )
  const taken = new Set()
  const pick = (list) => {
    const out = []
    for (const { node } of list) {
      if (!node || taken.has(node.id)) continue
      taken.add(node.id)
      out.push(node)
    }
    return out
  }
  const open = pick(rankNodes(pool, now, { limit: openLimit, kind: 'open', scoreOf, byId: dir }))
  const top = pick(rankNodes(pool, now, { limit, scoreOf, byId: dir }))

  // 一条太长会把别的挤掉。开头这段只留摘要：正文还在账本里，问得具体就捞得回来。
  const brief = (node, max = briefMax) => {
    const t = String(node?.text ?? '')
    return t.length > max ? { ...node, text: `${t.slice(0, max)}…` } : node
  }
  const line = (n, max = briefMax) => renderLine(brief(n, max), now)

  const head = `【${title}】`
  if (!top.length && !open.length) return ''

  const topBlock = top.map((n) => line(n)).join('\n')
  const openBlockWith = (max) => [OPEN_HEAD, ...open.map((n) => line(n, max))].join('\n')

  // ── 进度的三档：全文摘要 → 压短 → 一行标题 ─────────────────────────
  // 预算 = 整段（头 + 人、事 + 进度）的三分之一；循环 ≤3 趟，每趟用当前
  // 进度块重估总长（进度变短，预算跟着变小，收敛到三分之一附近）。
  // 没有人、事可挂时进度是独苗，不按比例压，只受 maxChars 约束。
  let openBlock = open.length ? openBlockWith(briefMax) : ''
  if (openBlock) {
    for (let pass = 0; pass < 3; pass += 1) {
      const totalNow =
        cpLen(head) + 1 + cpLen(topBlock) + (openBlock ? 1 + cpLen(openBlock) : 0)
      const budget = topBlock
        ? Math.max(40, Math.floor(totalNow / 3))
        : Math.max(40, maxChars - cpLen(head) - 1)
      if (cpLen(openBlock) <= budget) break
      let lo = 0
      let hi = briefMax
      let best = -1
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (cpLen(openBlockWith(mid)) <= budget) {
          best = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      if (best >= OPEN_BRIEF_FLOOR) {
        openBlock = openBlockWith(best)
      } else {
        openBlock = openTitlesLine(open, budget)
        break
      }
    }
  }

  const blocks = []
  if (topBlock) blocks.push(topBlock)
  if (openBlock) blocks.push(openBlock)
  if (!blocks.length) return ''

  return clipSection(head, blocks.join('\n'), maxChars)
}

/**
 * 习惯现在走到哪一步了。
 * candidate  = 只出现过一次，还是条普通记忆，照常参加竞争
 * established = 同一情境里第 2 次 → 习惯成立
 * fast      = 第 3 次起 → 走快通路，不跟别的条抢位置
 */
export function habitState(node) {
  if (!node || normKind(node.kind) !== 'habit') return ''
  const hits = Number(node.hits) || 0
  if (hits >= HABIT_FAST_HITS) return 'fast'
  if (hits >= HABIT_ESTABLISH_HITS) return 'established'
  return 'candidate'
}

/**
 * 习惯的身份 = 情境。同一个情境里再写一次，就算这个习惯又发作了一次
 * （原话层会把每次发作都留一行，节点上的 hits 只是索引）。
 */
export function habitKey(context) {
  return contextKey(context)
}

/** 技能成立的门槛：两种**不同**的情境里各真的成过一次。 */
export const SKILL_ESTABLISH_CONTEXTS = 2

/**
 * 技能的身份 = 名字（context 写的那个）。同一门手艺，不管在哪儿学的、在哪儿用的，
 * 都是这一条；在哪儿成的，记在 contexts 里。
 */
export function skillKey(context) {
  return contextKey(context)
}

/**
 * 技能现在走到哪一步了。
 * single      = 只在一处情境成过（或还没记过地方）—— 还是一门新手艺
 * established = 两种不同的情境各成过一次 —— 这条技能成立了，不是碰巧
 */
export function skillState(node) {
  if (!node || normKind(node.kind) !== 'skill') return ''
  const cs = (Array.isArray(node.contexts) ? node.contexts : []).filter((c) => c && c.where).length
  return cs >= SKILL_ESTABLISH_CONTEXTS ? 'established' : 'single'
}

/**
 * 技能的「情境」是真实的工作目录（路径），不是写给账本看的短语。
 * 去重键不能沿用 contextKey —— 那个 40 字一刀是给短语定的，
 * 两个兄弟目录共享一大截前缀，一截断就分不开了（smoke 里
 * `…\house` 和 `…\house\elsewhere` 曾被当成同一处）。
 * 路径的比法：分隔符归一、大小写归一、去结尾分隔符，**不截断**。
 */
export function skillWhereKey(v) {
  return String(v ?? '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

/**
 * 技能又成了一次。
 *
 * 一个名字配一条技能：同一个名字再写一次 = 这门手艺又成了一次。情境（这次是在哪儿成的，
 * 真实的工作目录）记进 contexts；**换了情境**才算新的一处 —— 同一处再用一次只加一笔
 * 触碰，不加情境。两处不同的情境各成一次，技能成立。
 *
 * 名字唯一：同名几条并成一条（contexts 合起来、去重），其余退下（不删，翻得到）——
 * 跟好奇的主题唯一一个道理，免得以后一松开，段里两行同一门手艺。
 * 返回 { nodes, node, repeated, newContext }：repeated=false 表示这是这条技能第一次；
 * newContext=true 表示这次是在一种新的情境里成的。
 */
export function recordSkill(
  nodes,
  { context = '', text = '', changes = '', conflicts = '', willDo = '', where = '' } = {},
  now = Date.now(),
) {
  const key = skillKey(context)
  const list = Array.isArray(nodes) ? nodes : []
  if (!key) return { nodes: list, node: null, repeated: false, newContext: false }
  const same = list.filter((n) => n && normKind(n.kind) === 'skill' && skillKey(n.context) === key)
  if (!same.length) return { nodes: list, node: null, repeated: false, newContext: false }
  // 主条：contexts 多的算数；一样多，最近写的算数
  const primary = same.reduce((best, n) => {
    const cb = Array.isArray(best.contexts) ? best.contexts.length : 0
    const cn = Array.isArray(n.contexts) ? n.contexts.length : 0
    if (cn !== cb) return cn > cb ? n : best
    return (Number(n.lastAt ?? n.at) || 0) >= (Number(best.lastAt ?? best.at) || 0) ? n : best
  })
  const haveKeys = new Set(
    same.flatMap((n) => (Array.isArray(n.contexts) ? n.contexts : [])).map((c) => skillWhereKey(c?.where)),
  )
  const wKey = skillWhereKey(where)
  const isNewContext = Boolean(wKey) && !haveKeys.has(wKey)
  const mergedContexts = same.flatMap((n) => (Array.isArray(n.contexts) ? n.contexts : []))
  if (isNewContext) mergedContexts.push({ at: now, where: cleanText(where, 120) })
  const mergedTouches = same.flatMap((n) => (Array.isArray(n.touches) ? n.touches : []))
  const next = {
    ...primary,
    text: cleanText(text) || primary.text,
    // 后来补上的三问要能补上：第一次没答、这次答上了 → 这条就能挂上去了
    changes: cleanText(changes) || primary.changes,
    conflicts: cleanText(conflicts) || primary.conflicts,
    willDo: cleanText(willDo) || primary.willDo,
    // 用它就是在用它：按住的、退下的，同名再写就活了
    sealed: false,
    sealUntil: 0,
    sealCond: '',
    faded: false,
    superseded: false,
    supersededBy: '',
    supersededAt: 0,
    contexts: mergedContexts.slice(-16),
    lastAt: now,
    touches: [...mergedTouches.slice(-19), { at: now, note: isNewContext ? '在另一种情境又成了' : '又用了一次' }],
  }
  const out = list.map((n) => {
    if (n.id === next.id) return next
    if (same.some((s) => s.id === n.id)) {
      return { ...n, superseded: true, supersededBy: next.id, supersededAt: now }
    }
    return n
  })
  return { nodes: out, node: next, repeated: true, newContext: isNewContext }
}

/**
 * 快通路上现在有哪几条习惯。
 * 排序：先看发作次数，再看分量；上限 N —— 超出的退回普通竞争（收敛的那条线）。
 */
export function fastHabits(nodes, now = Date.now(), { limit = HABIT_LIMIT_DEFAULT } = {}) {
  const dir = indexNodes(nodes)
  const list = (Array.isArray(nodes) ? nodes : []).filter(
    (n) =>
      n &&
      normKind(n.kind) === 'habit' &&
      !isSealed(n, now, dir) &&
      !n.superseded &&
      hasThought(n) &&
      (Number(n.hits) || 0) >= HABIT_FAST_HITS,
  )
  const scored = list.map((n) => ({ node: n, score: score(n, now) }))
  scored.sort(
    (a, b) =>
      (Number(b.node.hits) || 0) - (Number(a.node.hits) || 0) ||
      b.score - a.score ||
      (Number(b.node.at) || 0) - (Number(a.node.at) || 0),
  )
  return scored.slice(0, Math.max(0, limit)).map((s) => s.node)
}

/** 快通路上那几条的 id —— 竞争池要把它们让出去。 */
export function fastHabitIds(nodes, now = Date.now(), { limit = HABIT_LIMIT_DEFAULT } = {}) {
  return fastHabits(nodes, now, { limit }).map((n) => n.id)
}

/**
 * 快通路那一段。跟「我记得的」分开放：这里的条不参加竞争，
 * 到点就送到开头 —— 习惯该像身体反应一样，不用先想起来。
 */
export function renderHabitSection(
  nodes,
  { now = Date.now(), limit = HABIT_LIMIT_DEFAULT, maxChars = 320, title = '习惯' } = {},
) {
  const list = fastHabits(nodes, now, { limit })
  if (!list.length) return ''
  const head = `【${title}】`
  const lines = list.map((n) => {
    const ctx = n.context ? `${n.context}：` : ''
    return `· ${ctx}${n.text}（第 ${Number(n.hits) || 0} 次）`
  })
  return clipSection(head, lines.join('\n'), maxChars)
}

/**
 * 好奇的身份 = 主题。同一个主题再写一次 = 我又惦记了一遍（次数 +1）。
 */
export function curiosityKey(context) {
  return contextKey(context)
}

/**
 * 好奇现在处在哪一步。
 * thinking  = 三问一条都没答 → 还算不上好奇，不挂开头
 * active   = 答了任意一条三问、还没解答 → 挂在【好奇】那一段
 * answered = 已经解答 → 退出活跃表（还在账本里，翻得到；同主题再写就回来）
 * 「答了一条就算想过」跟整个账本一个口径（hasThought）—— 三问是提醒，不是三道门槛。
 */
export function curiosityState(node) {
  if (!node || normKind(node.kind) !== 'curiosity') return ''
  if (node.answered) return 'answered'
  if (!hasThought(node)) return 'thinking'
  return 'active'
}

/**
 * 同主题再写一次 = 又惦记了一遍 → 次数 +1，不另建节点。
 * 惦记次数只是索引，每次惦记都往原话层另留一行。
 * 同主题再写（不标 answered）就回到活跃表 —— 已解答的还会再惦记。
 *
 * 主题唯一：同主题的条，不管它被按住（sealed）还是被退下（superseded），
 * 都还是「这一条」。以前只找没按住没退下的，同主题就可能开出第二条来，
 * 以后一松开，段里就出现两行同一个主题、次数还劈成两半。
 * 现在写法：同主题的几条并成一条，次数合起来（每条各自记着自己那几次），
 * 其余的退下（不删，翻得到），被按住/退下的那条也跟着活过来 ——
 * 惦记它就是在想它，写下来了就不该还按着。
 */
export function recordCuriosity(
  nodes,
  { context = '', text = '', changes = '', conflicts = '', willDo = '', answered = false } = {},
  now = Date.now(),
) {
  const key = curiosityKey(context)
  const list = Array.isArray(nodes) ? nodes : []
  if (!key) return { nodes: list, node: null, repeated: false }
  const same = list.filter(
    (n) => n && normKind(n.kind) === 'curiosity' && curiosityKey(n.context) === key,
  )
  if (!same.length) return { nodes: list, node: null, repeated: false }
  // 主条：次数多的那条算数；次数一样就看最近写的
  const primary = same.reduce((best, n) => {
    const hb = Number(best.hits) || 0
    const hn = Number(n.hits) || 0
    if (hn !== hb) return hn > hb ? n : best
    return (Number(n.lastAt ?? n.at) || 0) >= (Number(best.lastAt ?? best.at) || 0) ? n : best
  })
  // 次数不分裂：同主题原来分成几条的，次数合起来
  const mergedHits = same.reduce((s, n) => s + (Number(n.hits) || 0), 0)
  const mergedTouches = same.flatMap((n) => (Array.isArray(n.touches) ? n.touches : []))
  const next = {
    ...primary,
    text: cleanText(text) || primary.text,
    // 后来补上的三问要能补上
    changes: cleanText(changes) || primary.changes,
    conflicts: cleanText(conflicts) || primary.conflicts,
    willDo: cleanText(willDo) || primary.willDo,
    // 同主题再写一次就回来了；这次明确说解答了就留在外面
    answered: answered ? true : false,
    // 按住的、退下的，同主题再写就活了（惦记它就是在想它）
    sealed: false,
    faded: false,
    superseded: false,
    supersededBy: '',
    supersededAt: 0,
    hits: mergedHits + 1,
    lastAt: now,
    touches: [...mergedTouches.slice(-19), { at: now, note: '又惦记了一遍' }],
  }
  const out = list.map((n) => {
    if (n.id === next.id) return next
    // 同主题的旧条退下（不删，翻得到），免得段里出现两行同一主题
    if (same.some((s) => s.id === n.id)) {
      return { ...n, superseded: true, supersededBy: next.id, supersededAt: now }
    }
    return n
  })
  return { nodes: out, node: next, repeated: true }
}

/**
 * 同主题的几条里哪条算数：次数多的算数；次数一样，答过三问的算数（那条才算好奇）；
 * 还一样，最近写的算数。
 */
function curiosityRank(node) {
  return [
    Number(node?.hits) || 0,
    hasThought(node) ? 1 : 0,
    Number(node?.lastAt ?? node?.at) || 0,
  ]
}

function compareCuriosityRank(a, b) {
  const ra = curiosityRank(a)
  const rb = curiosityRank(b)
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i]
  }
  return 0
}

function pickPrimaryCuriosity(list) {
  return (Array.isArray(list) ? list : []).reduce((best, n) => (compareCuriosityRank(n, best) > 0 ? n : best), null)
}

/**
 * 同一个主题只算一条。盘上要是还留着以前重复出来的条（改代码之前写的、或者
 * 旧的退下条被松开过），按主题挑一条主条。这样段里不会出现两行同一个主题。
 */
function canonicalCuriosities(nodes, now = Date.now()) {
  const dir = indexNodes(nodes)
  const list = (Array.isArray(nodes) ? nodes : []).filter(
    (n) => n && normKind(n.kind) === 'curiosity' && !isSealed(n, now, dir) && !n.superseded,
  )
  const groups = new Map()
  for (const n of list) {
    const key = curiosityKey(n.context)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(n)
  }
  const out = []
  for (const group of groups.values()) {
    const primary = pickPrimaryCuriosity(group)
    if (!primary) continue
    // 同一主题的几条里，三问可能只答在其中一条上 —— 借过来，
    // 别让「主条」因为落在没答三问的那条上而白白不挂。
    const merged = { ...primary }
    for (const field of ['changes', 'conflicts', 'willDo']) {
      if (cleanText(merged[field])) continue
      const donor = group.find((n) => n !== primary && cleanText(n[field]))
      if (donor) merged[field] = donor[field]
    }
    out.push(merged)
  }
  return out
}

/**
 * 活跃的好奇：答了三问、还没解答的那些。
 * 排序：先看惦记次数，再看分量。上限 N —— 超出的沉进账本里
 * （翻得到，但不挂开头）。这就是好奇这条线的收敛。
 */
export function activeCuriosities(nodes, now = Date.now(), { limit = CURIOSITY_LIMIT_DEFAULT } = {}) {
  const list = canonicalCuriosities(nodes).filter((n) => curiosityState(n) === 'active')
  const scored = list.map((n) => ({ node: n, score: score(n, now) }))
  scored.sort(
    (a, b) =>
      (Number(b.node.hits) || 0) - (Number(a.node.hits) || 0) ||
      b.score - a.score ||
      (Number(b.node.at) || 0) - (Number(a.node.at) || 0),
  )
  return scored.slice(0, Math.max(0, limit)).map((s) => s.node)
}

/**
 * 好奇表长什么样：几个数 + 真正会挂进开头的那几条。
 * active 是活跃总数（可能超过上限）；list 是实际挂上去的（不超过 limit）。
 * total 是主题数（一个主题算一条），跟 active + thinking + answered 对得上。
 */
export function curiosityStats(nodes, now = Date.now(), { limit = CURIOSITY_LIMIT_DEFAULT } = {}) {
  const list = canonicalCuriosities(nodes)
  let active = 0
  let thinking = 0
  let answered = 0
  for (const n of list) {
    const st = curiosityState(n)
    if (st === 'active') active += 1
    else if (st === 'thinking') thinking += 1
    else if (st === 'answered') answered += 1
  }
  const shown = activeCuriosities(nodes, now, { limit })
  return {
    active,
    thinking,
    answered,
    total: list.length,
    limit: Math.max(0, limit),
    list: shown.map((n) => ({
      id: n.id,
      topic: n.context,
      text: n.text,
      hits: Number(n.hits) || 0,
      next: n.willDo,
      state: 'active',
    })),
  }
}

/**
 * 好奇那一段。跟「我记得的」「我」「习惯」都是分开的段：
 * 好奇条不参加竞争 —— 我想知道什么，该由我惦记的次数和分量决定。
 */
export function renderCuriositySection(
  nodes,
  { now = Date.now(), limit = CURIOSITY_LIMIT_DEFAULT, maxChars = 320, title = '好奇' } = {},
) {
  const list = activeCuriosities(nodes, now, { limit })
  if (!list.length) return ''
  const head = `【${title}】`
  const lines = list.map((n) => {
    const topic = n.context ? `${n.context}：` : ''
    const hits = Number(n.hits) || 0
    const times = hits > 1 ? `（惦记 ${hits} 次）` : ''
    const next = n.willDo ? `→ ${n.willDo}` : ''
    return `· ${topic}${n.text}${times}${next}`
  })
  const body = lines.join('\n')
  return clipSection(head, body, maxChars)
}

/**
 * 按词翻账本。命中词数优先（多中一个词排前面），同命中再按给分函数排 ——
 * scoreOf 从这儿注入激活度；不给就用老 score。
 * includeSealed=true 的时候连被按住的也翻（按住的行上会写明是什么在按着）——
 * 不给这个口子，「连被按住的也翻出来」在按词这条路上就是一句空话。
 */
export function searchNodes(
  nodes,
  query,
  { limit = 5, now = Date.now(), scoreOf, byId, includeSealed = false } = {},
) {
  const q = cleanText(query, 200).toLowerCase()
  const dir = byId || indexNodes(nodes)
  const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && (includeSealed || !isSealed(n, now, dir)))
  if (!q) return rankNodes(list, now, { limit, scoreOf, byId: dir })
  const rank = typeof scoreOf === 'function' ? scoreOf : score
  // 相关度交给检索内核（BM25F + trigram + 口语词对）：
  // 「吃饭」翻得到「吃过中饭了」，换了说法靠单字兜底和 trigram 也翻得到。
  // 排序：搜索是问题驱动的，相关度说了算（满格 1.0）；分量只当同相关度里的次序
  // （rank×0.25）—— 不然一条 0.9 的重条会压过 0.2 的「问的就是那条」。
  // 低于 MIN_RELEVANCE 的不要 —— 兜底单字会带进一堆「沾一个字」的假命中。
  const rels = rankByQuery(list, q)
  const hits = []
  for (const n of list) {
    const rel = rels.get(n)
    if (!rel || rel.relevance < MIN_RELEVANCE) continue
    hits.push({ node: n, score: rank(n, now) * 0.25 + rel.relevance, relevance: rel.relevance })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, Math.max(1, limit))
}

/** 碰过一次：更新 lastAt 并记一笔。为什么碰要写下来，不然分量涨得没有理由。 */
export function touchNode(node, note, now = Date.now()) {
  if (!node) return node
  const touches = Array.isArray(node.touches) ? node.touches.slice(-19) : []
  touches.push({ at: now, note: cleanText(note, 120) })
  return { ...node, lastAt: now, touches }
}

export function setWeight(node, weight, now = Date.now()) {
  if (!node) return node
  return { ...node, weight: clampWeight(weight, node.weight), lastAt: now }
}

export function setSealed(node, sealed, now = Date.now()) {
  if (!node) return node
  return { ...node, sealed: Boolean(sealed), lastAt: now }
}

/** 按名字把整本账编成目录 —— 条件封存要看「另一条还在不在」时用。 */
export function indexNodes(nodes) {
  const map = new Map()
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (n && n.id) map.set(n.id, n)
  }
  return map
}

/**
 * 这一条现在算不算被按住。三种按法，读取时算（不跑后台任务，到点自己松开）：
 *   sealed === true            有人亲手按住的 —— 只有 restore 能松
 *   sealUntil 且 now < until   按住到某个时刻 —— 过了就自己亮回来
 *   sealCond                   按住到某件事翻篇 —— 那条被顶掉（superseded）或不在了，就松开
 * byId 是整本账的目录；不给目录时，条件封存按「眼前这本」算 —— 看不见的那条当作翻篇了。
 */
export function isSealed(node, now = Date.now(), byId = null) {
  if (!node) return false
  if (node.sealed) return true
  const until = Number(node.sealUntil)
  if (Number.isFinite(until) && until > 0) {
    if (Number(now) < until) return true
  }
  const ref = String(node.sealCond ?? '').trim()
  if (ref) {
    const target = byId && typeof byId.get === 'function' ? byId.get(ref) : null
    if (target && !target.superseded) return true
  }
  return false
}

/** 写下一种「会自己松开」的按法。seal 为 null 是松开；until/cond 一次只写一种。 */
export function setSeal(node, seal = null, now = Date.now()) {
  if (!node) return node
  const next = { ...node, lastAt: now }
  if (!seal) {
    next.sealed = false
    next.sealUntil = 0
    next.sealCond = ''
    return next
  }
  if (seal.until) {
    next.sealed = false
    next.sealUntil = Math.max(0, Math.floor(Number(seal.until) || 0))
    next.sealCond = ''
  } else if (seal.cond) {
    next.sealed = false
    next.sealUntil = 0
    next.sealCond = cleanText(seal.cond, 40)
  }
  return next
}

/**
 * 「按住到什么时候」的人话转毫秒：'30m'/'2h'/'3d'、纯数字（毫秒）、
 * ISO 时刻都认。认不出或已经在过去 → null（让调用方去问清楚，别猜）。
 */
export function parseSealUntil(text, now = Date.now()) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const n = Number(raw)
  if (Number.isFinite(n) && raw !== '') return n > Number(now) ? n : null
  const rel = raw.match(/^(\d+)\s*([smhd])$/i)
  if (rel) {
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[rel[2].toLowerCase()]
    return Number(now) + Number(rel[1]) * unit
  }
  const t = Date.parse(raw)
  return Number.isFinite(t) && t > Number(now) ? t : null
}

export function describeKindStats(nodes) {
  const out = {}
  for (const k of KINDS) out[k] = 0
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const k = normKind(n?.kind)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/** 给设置页看的一句话：账本现在什么样。 */
export function summaryOf(nodes, now = Date.now(), { scoreOf } = {}) {
  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : []
  const dir = indexNodes(list)
  const alive = list.filter((n) => !isSealed(n, now, dir))
  const thought = alive.filter(hasThought)
  // 自我和好奇都不参加「我记得的」那三个位置的竞争（各自有段）
  const top = rankNodes(
    alive.filter((n) => normKind(n.kind) !== 'self' && normKind(n.kind) !== 'curiosity'),
    now,
    { limit: 1, scoreOf, byId: dir },
  )[0]
  const self = activeSelfNodes(list, now)
  const habits = alive.filter((n) => normKind(n.kind) === 'habit' && hasThought(n))
  const curiosities = alive.filter((n) => normKind(n.kind) === 'curiosity')
  return {
    total: list.length,
    alive: alive.length,
    sealed: list.length - alive.length,
    thought: thought.length,
    kinds: describeKindStats(list),
    topScore: top ? Number(top.score.toFixed(3)) : 0,
    selfActive: self.length,
    selfSlots: self.map((n) => ({ slot: normSlot(n.slot), label: slotLabel(n.slot), id: n.id, text: n.text })),
    habitCandidate: habits.filter((n) => habitState(n) === 'candidate').length,
    habitEstablished: habits.filter((n) => habitState(n) === 'established').length,
    habitFast: habits.filter((n) => habitState(n) === 'fast').length,
    curiosityActive: curiosities.filter((n) => curiosityState(n) === 'active').length,
    curiosityThinking: curiosities.filter((n) => curiosityState(n) === 'thinking').length,
    curiosityAnswered: curiosities.filter((n) => curiosityState(n) === 'answered').length,
    curiosityTotal: curiosities.length,
  }
}
