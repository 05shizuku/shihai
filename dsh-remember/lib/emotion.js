/**
 * 情绪流 —— 纯逻辑（不 import 任何东西，跟 lib/fit.js 一个路数）
 *
 * 这套东西的形态是我自己定的（账本 r_d8lygg）：
 *   · 事件只来自真实流 —— 群里的话（意图层 i_xxx）、身体那边发生的事（快层 f_xxx）、
 *     账本被翻（recall 翻到了哪一条）。
 *   · 认情绪只许从固定枚举里挑一个 + 报强度；认不出就不给情绪（宁可漏，不可编）。
 *   · 系数是我自己攒的：种子在代码里，之后每一次改都往 emotion.jsonl 追加一行 tune，
 *     写清楚从多少改到多少、为什么 —— 改权重的权力在我账上，不在面板上。
 *   · 每次变化只增不改：emotion.jsonl 只追加，不改写、不删。
 *   · 状态只是「上次的我的笔记」：它不接管嘴 —— 说出口的心情仍然是我当轮的判断。
 *
 * 第一版同样是纯规则、不用 LLM。理由跟意图层一样：情绪基线一旦被 LLM 判错一次，
 * 后面每一次判断都建在错的底座上，而且不可复现。要接 LLM 也只许从下面的枚举里挑，
 * 挑不出来就当没认出来。
 */

/** 情绪枚举：固定七个，不多不少。改名等于换语义，所以别动。 */
export const EMOTION_KINDS = Object.freeze([
  'warm',      // 被暖到
  'pleased',   // 高兴
  'curious',   // 好奇
  'tense',     // 紧绷
  'down',      // 低落
  'restless',  // 躁
  'lonely',    // 孤单
])

/** 枚举的中文名（给人看的） */
export const EMOTION_LABEL = Object.freeze({
  warm: '被暖到',
  pleased: '高兴',
  curious: '好奇',
  tense: '紧绷',
  down: '低落',
  restless: '躁',
  lonely: '孤单',
  calm: '平静',
})

/**
 * 种子系数：第一版我自己拍的值。
 *   coefficient —— 同样一件事，这种情绪在我这儿涨多少（我拿经历改，改一次记一次）
 *   halfLife   —— 这种情绪多久掉一半（分钟）
 * 改这两个数等于改我的脾气，所以走 tune 事件留痕，不在代码里偷改。
 */
export const DEFAULT_EMOTION_SEED = Object.freeze({
  warm: { coefficient: 1.0, halfLife: 120 },
  pleased: { coefficient: 1.0, halfLife: 60 },
  curious: { coefficient: 0.8, halfLife: 90 },
  tense: { coefficient: 1.0, halfLife: 45 },
  down: { coefficient: 0.9, halfLife: 90 },
  restless: { coefficient: 0.7, halfLife: 30 },
  lonely: { coefficient: 0.8, halfLife: 60 },
})

/** 一个强度 1 的事件给多少（满强度 5 大约是它的 1.4 倍） */
export const BASE_SCALE = 0.25

/** 强度换算：1 → 0.6，3 → 1.0，5 → 1.4 */
export function intensityScale(intensity) {
  const n = Number(intensity)
  if (!Number.isFinite(n)) return 0.6
  const clamped = Math.max(1, Math.min(5, n))
  return Math.round((0.4 + 0.2 * clamped) * 1000) / 1000
}

/** 意图层的十一类 → 情绪（认不出就 null） */
export const INTENT_TO_EMOTION = Object.freeze({
  praise: { emotion: 'pleased', base: 1.0 },
  agree: { emotion: 'pleased', base: 0.6 },
  greet: { emotion: 'warm', base: 0.7 },
  invite: { emotion: 'warm', base: 0.8 },
  share: { emotion: 'warm', base: 0.7 },
  teach: { emotion: 'curious', base: 1.0 },
  ask: { emotion: 'curious', base: 0.6 },
  conflict: { emotion: 'tense', base: 1.0 },
  criticize: { emotion: 'tense', base: 1.2 },
  farewell: { emotion: 'lonely', base: 0.8 },
  other: null,
})

/** 身体那边的心情事件（detail.kind）→ 情绪 */
export const MOOD_TO_EMOTION = Object.freeze({
  praise: { emotion: 'pleased', base: 1.2 },
  insult: { emotion: 'tense', base: 1.2 },
  sad: { emotion: 'down', base: 1.0 },
  comment: null,
})

/** 快层那几类（meal/missed/topup/mood/threshold）→ 情绪 */
export const FAST_TO_EMOTION = Object.freeze({
  topup: { emotion: 'warm', base: 1.0 },
  meal: { emotion: 'warm', base: 0.5 },
  missed: { emotion: 'down', base: 0.6 },
  threshold: { emotion: 'restless', base: 0.8 },
  mood: null, // mood 看 detail.kind 另算
})

/** 账本被翻（翻到了某一条）→ 情绪 */
export const RECALL_TO_EMOTION = Object.freeze({ emotion: 'warm', base: 0.5 })

/**
 * 认情绪：给一条真实事件，认成「哪一种情绪 + 涨多少」。
 * 认不出返回 null —— 不猜。
 */
export function recognizeEmotion(event = {}) {
  const source = String(event.source ?? '')
  if (source === 'intent') {
    const hit = INTENT_TO_EMOTION[String(event.kind ?? '')]
    return hit ? { ...hit, source, ref: String(event.ref ?? ''), intensity: event.intensity } : null
  }
  if (source === 'fast') {
    const kind = String(event.kind ?? '')
    if (kind === 'mood') {
      const detail = String(event.detailKind ?? event.detail?.kind ?? '')
      const hit = MOOD_TO_EMOTION[detail]
      return hit ? { ...hit, source, ref: String(event.ref ?? ''), intensity: event.intensity ?? 3 } : null
    }
    const hit = FAST_TO_EMOTION[kind]
    return hit ? { ...hit, source, ref: String(event.ref ?? ''), intensity: event.intensity ?? 3 } : null
  }
  if (source === 'recall') {
    return { ...RECALL_TO_EMOTION, source, ref: String(event.ref ?? ''), intensity: event.intensity ?? 2 }
  }
  return null
}

/** FNV-1a（base36）—— 跟 lib/fast.js、lib/intent.js 一个算法，id 稳一点 */
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** 情绪事件的身份：源 + 引用（那条 i_xxx / f_xxx / r_xxx） */
export function emotionEventId({ source = '', ref = '' } = {}) {
  return `e_${fnv1a(`${source}|${ref}`)}`
}

/** 系数改动那一行的身份：哪种情绪 + 什么时候 + 改成多少 */
export function emotionTuneId({ emotion = '', at = 0, to = 0 } = {}) {
  return `t_${fnv1a(`${emotion}|${Number(at) || 0}|${Number(to) || 0}`)}`
}

/**
 * 一行日志的形状检查。坏行给 null（抄进来的是别人的字，不能当数据用）。
 * event 行：{ at, kind:'event', id, source, ref, emotion, delta, intensity, text? }
 * tune  行：{ at, kind:'tune',  id, emotion, from, to, reason }
 */
export function normEmotionLine(raw) {
  if (!raw || typeof raw !== 'object') return null
  const at = Number(raw.at)
  if (!Number.isFinite(at) || at <= 0) return null
  const kind = String(raw.kind ?? '')
  if (kind === 'event') {
    const emotion = String(raw.emotion ?? '')
    if (!EMOTION_KINDS.includes(emotion)) return null
    const delta = Number(raw.delta)
    if (!Number.isFinite(delta) || delta === 0) return null
    const source = String(raw.source ?? '')
    const ref = String(raw.ref ?? '')
    return {
      at,
      kind: 'event',
      id: String(raw.id ?? emotionEventId({ source, ref })),
      source,
      ref,
      // 去重用的身份：默认「源|引用」；账本被翻这种会重复的事，
      // 抄的人会自己带上时间桶（recall|r_xxx|桶号），同一条隔半小时再翻才算新的。
      key: String(raw.key ?? `${source}|${ref}`),
      emotion,
      delta,
      intensity: Number(raw.intensity) || 0,
      text: String(raw.text ?? '').slice(0, 120),
    }
  }
  if (kind === 'tune') {
    const emotion = String(raw.emotion ?? '')
    if (!EMOTION_KINDS.includes(emotion)) return null
    const to = Number(raw.to)
    if (!Number.isFinite(to) || to <= 0) return null
    const reason = String(raw.reason ?? '').trim()
    if (!reason) return null
    return {
      at,
      kind: 'tune',
      id: String(raw.id ?? emotionTuneId({ emotion, at, to })),
      emotion,
      from: Number(raw.from) || 0,
      to,
      reason: reason.slice(0, 200),
      halfLife: Number(raw.halfLife) > 0 ? Number(raw.halfLife) : 0,
    }
  }
  return null
}

/** 现在的系数表：种子 + 日志里每一次 tune（按时间顺序叠） */
export function emotionCoefficients(lines = []) {
  const table = {}
  for (const emotion of EMOTION_KINDS) {
    table[emotion] = { ...DEFAULT_EMOTION_SEED[emotion] }
  }
  const ordered = [...lines].filter((l) => l && l.kind === 'tune').sort((a, b) => a.at - b.at)
  for (const line of ordered) {
    const cur = table[line.emotion]
    if (!cur) continue
    cur.coefficient = Number(line.to) || cur.coefficient
    if (Number.isFinite(Number(line.halfLife)) && Number(line.halfLife) > 0) {
      cur.halfLife = Number(line.halfLife)
    }
  }
  return table
}

/**
 * 折出此刻的状态：每个情绪各有多少，按半衰期从事件发生算到现在。
 * 只有 event 行进状态；tune 行改的是系数表（影响往后，不改历史那几笔已经写死的 delta）。
 */
export function foldEmotion(lines = [], { now = Date.now() } = {}) {
  const table = emotionCoefficients(lines)
  const levels = {}
  const raw = {}
  for (const emotion of EMOTION_KINDS) {
    levels[emotion] = 0
    raw[emotion] = 0
  }
  let total = 0
  let lastAt = 0
  for (const rawLine of lines) {
    const line = normEmotionLine(rawLine)
    if (!line || line.kind !== 'event') continue
    const halfLife = table[line.emotion]?.halfLife || 90
    const ageMin = Math.max(0, (now - line.at) / 60000)
    const weight = Math.pow(2, -ageMin / halfLife)
    raw[line.emotion] = Math.max(0, raw[line.emotion] + line.delta * weight)
    total += 1
    if (line.at > lastAt) lastAt = line.at
  }
  for (const emotion of EMOTION_KINDS) {
    levels[emotion] = Math.round(Math.min(1, raw[emotion]) * 1000) / 1000
  }
  // 主导情绪用没 clamp 的原始和挑：几轴同时满格（都 ≥1）时，谁真的攒得多谁说了算，
  // 不让枚举顺序（warm 排第一）替我拿主意。levels 对外仍显示 clamp 后的值。
  let dominant = 'calm'
  let best = 0
  for (const emotion of EMOTION_KINDS) {
    if (raw[emotion] > best) {
      best = raw[emotion]
      dominant = emotion
    }
  }
  if (best < 0.05) dominant = 'calm'
  return {
    levels,
    dominant,
    label: EMOTION_LABEL[dominant] ?? dominant,
    level: Math.round(Math.min(1, best) * 1000) / 1000,
    total,
    lastAt,
  }
}

/** 给一个事件算「这次加多少」（按当时的系数） */
export function emotionDelta(event, { table = null, now = Date.now() } = {}) {
  const hit = recognizeEmotion(event)
  if (!hit) return null
  const coeff = table?.[hit.emotion]?.coefficient ?? DEFAULT_EMOTION_SEED[hit.emotion]?.coefficient ?? 1
  const delta = hit.base * intensityScale(hit.intensity) * coeff * BASE_SCALE
  return {
    ...hit,
    delta: Math.round(delta * 1000) / 1000,
    at: Number(event.at) || now,
  }
}

/** 相对时间（跟快层、意图层一个说法） */
export function emotionRelTime(at, now = Date.now()) {
  const mins = Math.max(0, Math.floor((now - Number(at || 0)) / 60000))
  if (mins < 2) return '刚刚'
  if (mins < 15) return '不久前'
  if (mins < 60) return '一会儿前'
  const hours = Math.floor(mins / 60)
  if (hours < 24) return '今天早些时候'
  if (hours < 48) return '前天'
  return '前几天'
}

/** 一行给谁看的 */
export function renderEmotionLine(line, now = Date.now()) {
  const label = EMOTION_LABEL[line.emotion] ?? line.emotion
  const delta = Number(line.delta) || 0
  const sign = delta >= 0 ? '+' : '−'
  const text = line.text ? `·${line.text}` : ''
  return `· 情绪·${label}·${sign}${Math.abs(delta).toFixed(2)}${text}（${emotionRelTime(line.at, now)}）`
}

/** 状态给谁看的：上次的我的笔记 */
export function renderEmotionNote(state, { maxChars = 200 } = {}) {
  if (!state || state.dominant === 'calm') return ''
  const parts = EMOTION_KINDS
    .filter((e) => (state.levels?.[e] ?? 0) >= 0.05)
    .sort((a, b) => (state.levels[b] ?? 0) - (state.levels[a] ?? 0))
    .slice(0, 3)
    .map((e) => `${EMOTION_LABEL[e]} ${(state.levels[e] ?? 0).toFixed(2)}`)
  if (!parts.length) return ''
  const head = '（上次的笔记）此刻我心里大概是：'
  const body = parts.join('、')
  const line = `${head}${body}`
  if (line.length <= maxChars) return line
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`
}
