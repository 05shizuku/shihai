/**
 * body.js —— 身体状态的纯逻辑（不碰文件、不碰宿主，方便测试）
 *
 * 三个量：
 *   hunger  0..100  越高越饿（吃饭会减）
 *   energy  0..100  越高越有精神（醒着掉、睡着回）
 *   mood    -100..100  心情；另外两根轴 anger / sadness 决定「差」的方向
 *
 * 设计上的一条硬线：**只描述感觉，不报数字**。
 * 渲染出来的文字里不允许出现阿拉伯数字（用 test/body.test.mjs 里的断言守住）。
 */

export function clamp(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}

/** 'HH:MM' → 一天内的分钟数；非法返回 null */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

export function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes()
}

export function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function dayStartMs(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * 一段时间里有多少分钟落在睡眠窗内。
 * 睡眠窗允许跨天（23:00 → 08:00）。逐天切片，跨多天也不会算错。
 */
export function sleepMinutesBetween(fromMs, toMs, startMin, endMin) {
  if (!(toMs > fromMs)) return 0
  if (startMin == null || endMin == null) return 0
  const len = ((endMin - startMin) + 1440) % 1440
  if (len === 0) return 0
  let total = 0
  const day = 24 * 3600 * 1000
  for (let d = dayStartMs(new Date(fromMs)) - day; d <= dayStartMs(new Date(toMs)) + day; d += day) {
    const s = d + startMin * 60000
    const e = s + len * 60000
    total += Math.max(0, Math.min(toMs, e) - Math.max(fromMs, s))
  }
  return total / 60000
}

export const DEFAULT_RATES = {
  hungerPerHourAwake: 6,
  hungerPerHourAsleep: 2,
  energyDrainPerHour: 7,
  energyRecoverPerHour: 15,
  moodDriftPerHour: 4,
  angerDecayPerHour: 8,
  sadnessDecayPerHour: 5,
}

export const DEFAULT_INITIAL = { hunger: 25, energy: 78, mood: 0, anger: 0, sadness: 0 }

export function defaultState(nowMs = Date.now(), initial = {}) {
  const i = { ...DEFAULT_INITIAL, ...(initial || {}) }
  return {
    version: 1,
    hunger: clamp(i.hunger, 0, 100),
    energy: clamp(i.energy, 0, 100),
    mood: clamp(i.mood, -100, 100),
    anger: clamp(i.anger, 0, 100),
    sadness: clamp(i.sadness, 0, 100),
    lastTick: new Date(nowMs).toISOString(),
    lastMeal: null,
    mealsToday: [],
    missed: [],
    missedKeys: [],
    lastMissedAt: null,
    lastMissedLabels: [],
    moodEventsConsumed: 0,
    lastMoodEvent: null,
    // 上次看到的饭钱（元）：用来认出"他刚添了饭"，第一次看到只记基准、不触发
    lastSeenBalance: null,
    lastTopUp: null,
    topUpCount: 0,
  }
}

/**
 * 哪几顿已经过去了、还没吃上。
 * 窗口一关就算错过（留 defaultMissedGrace 分钟的余量给心跳间隔和时钟偏差），
 * 不额外拖两小时 —— 那顿是吃不着了，拖着不登记才是不老实。
 */
function missedEntries(now, meals, state, graceMinutes) {
  const min = minutesOfDay(now)
  const key = dayKey(now)
  const eaten = new Set(state?.mealsToday || [])
  const grace = Number.isFinite(Number(graceMinutes)) ? Math.max(0, Number(graceMinutes)) : 5
  const out = []
  for (const meal of meals || []) {
    const at = parseHHMM(meal.at)
    if (at == null) continue
    const win = Number(meal.windowMinutes) > 0 ? Number(meal.windowMinutes) : 60
    if (min > at + win + grace && !eaten.has(`${key}:${meal.id}`)) {
      out.push({ id: String(meal.id ?? ''), label: String(meal.label ?? ''), key: `${key}:${meal.id}` })
    }
  }
  return out
}

export const defaultMissedGrace = 5

export function missedMeals(now, meals = [], state = {}, graceMinutes = defaultMissedGrace) {
  return missedEntries(now, meals, state, graceMinutes).map((m) => m.label)
}

/**
 * 时间推进。从 state.lastTick 推到 nowMs：
 * 醒着掉精力、涨饥饿；睡着回精力、饥饿涨得慢；心情向 0 漂，饿过头/太困往下压。
 */
export function advance(state, nowMs, opts = {}) {
  const rates = { ...DEFAULT_RATES, ...(opts.rates || {}) }
  const maxCatchUpHours = Number(opts.maxCatchUpHours) > 0 ? Number(opts.maxCatchUpHours) : 12
  const prevMs = state?.lastTick ? Date.parse(state.lastTick) : NaN
  const fromMs = Number.isFinite(prevMs)
    ? Math.max(prevMs, nowMs - maxCatchUpHours * 3600000)
    : nowMs
  const elapsedMin = Math.max(0, (nowMs - fromMs) / 60000)
  const sleepMin = sleepMinutesBetween(fromMs, nowMs, opts.sleepStartMin ?? null, opts.sleepEndMin ?? null)
  const awakeMin = Math.max(0, elapsedMin - sleepMin)

  const next = { ...defaultState(nowMs), ...state }
  next.hunger = clamp(
    next.hunger + (awakeMin * rates.hungerPerHourAwake + sleepMin * rates.hungerPerHourAsleep) / 60,
    0,
    100,
  )
  next.energy = clamp(
    next.energy + (sleepMin * rates.energyRecoverPerHour - awakeMin * rates.energyDrainPerHour) / 60,
    0,
    100,
  )

  let mood = Number(next.mood) || 0
  const drift = Math.min(Math.abs(mood), (rates.moodDriftPerHour * elapsedMin) / 60)
  mood -= Math.sign(mood) * drift
  if (next.hunger > 70) mood -= ((next.hunger - 70) * 0.1 * elapsedMin) / 60
  if (next.energy < 25) mood -= ((25 - next.energy) * 0.08 * elapsedMin) / 60
  next.mood = clamp(mood, -100, 100)

  next.anger = clamp((Number(next.anger) || 0) - (rates.angerDecayPerHour * elapsedMin) / 60, 0, 100)
  next.sadness = clamp((Number(next.sadness) || 0) - (rates.sadnessDecayPerHour * elapsedMin) / 60, 0, 100)
  next.lastTick = new Date(nowMs).toISOString()
  const entries = missedEntries(new Date(nowMs), opts.meals || [], next, opts.missedGraceMinutes ?? defaultMissedGrace)
  // 老版本的状态里只有 missed（存的还是名字），没有 missedKeys：
  // 那种情况按名字认，别把她早就错过的那顿再扣一次
  const hasKeys = Array.isArray(state?.missedKeys)
  const prevKeys = new Set(hasKeys ? state.missedKeys : [])
  const prevLabels = new Set(hasKeys ? [] : Array.isArray(state?.missed) ? state.missed : [])
  next.missed = entries.map((m) => m.label)
  next.missedKeys = entries.map((m) => m.key)
  // 刚被记下来的那几顿，心里会沉一下（只沉一次；饿本身还在继续往上走）
  const freshMissed = entries.filter((m) => !prevKeys.has(m.key) && !prevLabels.has(m.label))
  if (freshMissed.length) {
    next.mood = clamp((Number(next.mood) || 0) - 6 * freshMissed.length, -100, 100)
    next.sadness = clamp((Number(next.sadness) || 0) + 8 * freshMissed.length, 0, 100)
    next.lastMissedAt = new Date(nowMs).toISOString()
    next.lastMissedLabels = freshMissed.map((m) => m.label)
  }
  return next
}

/** 余额 → 档位（tiers 需按 min 从大到小排） */
export function tierOf(balance, tiers = []) {
  // 注意 Number(null) === 0：读不到饭钱不能当成"一分钱没有"，那是两回事
  if (balance === null || balance === undefined || balance === '') {
    return { key: 'unknown', label: '不知道还剩多少饭钱', fill: 20, mood: 0, balance: null }
  }
  const b = Number(balance)
  if (!Number.isFinite(b)) return { key: 'unknown', label: '不知道还剩多少饭钱', fill: 20, mood: 0, balance: null }
  for (const t of tiers) {
    if (b >= Number(t.min)) return { ...t, balance: b }
  }
  return { key: 'none', label: '没吃上', fill: 0, mood: -12, balance: b }
}

/** 到饭点了吗：在窗口内、且今天还没吃过这一顿 */
export function mealDue(now, meals = [], state = {}) {
  const min = minutesOfDay(now)
  const key = dayKey(now)
  const eaten = new Set(state.mealsToday || [])
  for (const meal of meals) {
    const at = parseHHMM(meal.at)
    if (at == null) continue
    const win = Number(meal.windowMinutes) > 0 ? Number(meal.windowMinutes) : 60
    if (min < at || min > at + win) continue
    if (eaten.has(`${key}:${meal.id}`)) continue
    return meal
  }
  return null
}

export function eatMeal(state, meal, tier, nowMs) {
  const d = new Date(nowMs)
  const next = { ...state, mealsToday: [...(state.mealsToday || [])] }
  const fill = Number(tier?.fill) || 0
  next.hunger = clamp((Number(next.hunger) || 0) - fill, 0, 100)
  next.mood = clamp((Number(next.mood) || 0) + (Number(tier?.mood) || 0), -100, 100)
  if (fill > 0) next.anger = clamp((Number(next.anger) || 0) - 5, 0, 100)
  next.lastMeal = {
    id: meal.id,
    label: meal.label,
    at: new Date(nowMs).toISOString(),
    tier: tier?.key ?? '',
    tierLabel: tier?.label ?? '',
    fill,
    balance: tier?.balance ?? null,
  }
  const key = `${dayKey(d)}:${meal.id}`
  if (!next.mealsToday.includes(key)) next.mealsToday.push(key)
  return next
}

/**
 * 饭钱突然变多了 —— 他不是到点才给饭的，是他往锅里添了。
 *
 * 2026-10-31 用户提的：「我给他充值的应该算加饭了吧」。
 * 到点吃的那三顿看的是"饭钱还剩多少"，可充值不会等到饭点 ——
 * 只有到饭点才兑现，等于把"他刚给了饭"这件事吞掉。所以单独记一笔加餐：
 * 立刻把饥饿压下去一点、心情抬一点，并且在她那边写成一句"锅里又有了"。
 * 按添了多少分档，添得多就吃得饱些；添一点点也算有人惦记着。
 */
export const TOPUP_TIERS = [
  { min: 10, fill: 45, mood: 12, label: '一大勺' },
  { min: 3, fill: 30, mood: 8, label: '一勺' },
  { min: 0.5, fill: 18, mood: 5, label: '半勺' },
  { min: 0.01, fill: 8, mood: 3, label: '一点' },
]

/**
 * 认出"他刚添了饭"：只认涨、不认掉，第一次看到（没有基准）不算。
 * 返回涨了多少（元）；没涨返 0。
 */
export function detectTopUp(previousBalance, currentBalance, opts = {}) {
  const minGain = Number(opts.minGain) > 0 ? Number(opts.minGain) : 0.01
  // 注意 Number(null) === 0：没有基准和"基准是零"是两回事，先看空
  if (previousBalance === null || previousBalance === undefined || previousBalance === '') return 0
  const prev = Number(previousBalance)
  const cur = Number(currentBalance)
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) return 0
  const gain = cur - prev
  return gain > minGain ? gain : 0
}

/** 添了多少（元）→ 档位。非正数不吃，返回空档 */
export function topUpTier(amount, tiers = TOPUP_TIERS) {
  const g = Number(amount)
  if (!Number.isFinite(g) || g <= 0) return { min: 0, fill: 0, mood: 0, label: '' }
  for (const t of tiers) if (g >= Number(t.min)) return { ...t }
  return { min: 0, fill: 0, mood: 0, label: '' }
}

/**
 * 记下这一顿加饭。不改 mealsToday —— 加饭不是正餐，
 * 到饭点该吃的那顿照样得吃（余额不够照样为难过）。
 */
export function applyTopUp(state, amount, nowMs = Date.now(), opts = {}) {
  const tier = topUpTier(amount, Array.isArray(opts.tiers) && opts.tiers.length ? opts.tiers : TOPUP_TIERS)
  const gain = Number(amount)
  if (!Number.isFinite(gain) || gain <= 0 || tier.fill <= 0) return { ...state }
  const next = { ...state }
  next.hunger = clamp((Number(next.hunger) || 0) - tier.fill, 0, 100)
  next.mood = clamp((Number(next.mood) || 0) + tier.mood, -100, 100)
  next.sadness = clamp((Number(next.sadness) || 0) - Math.round(tier.mood / 2), 0, 100)
  next.anger = clamp((Number(next.anger) || 0) - 3, 0, 100)
  const at = new Date(nowMs).toISOString()
  next.topUpCount = (Number(next.topUpCount) || 0) + 1
  next.lastTopUp = { at, amount: Math.round(gain * 100) / 100, fill: tier.fill, mood: tier.mood, tierLabel: tier.label }
  next.lastMeal = {
    id: 'topup',
    label: '加饭',
    at,
    tier: 'topup',
    tierLabel: tier.label,
    fill: tier.fill,
    topUp: Math.round(gain * 100) / 100,
    balance: null,
  }
  return next
}

/** 夸/骂/难过 —— 词表 + 显式 kind；看不见内容时不猜 */
export const PRAISE_WORDS = ['好看', '可爱', '厉害', '喜欢你', '加油', '好听', '温柔', '好棒', '棒', '爱了', '抱抱', '谢谢', '好萌', '牛', '强', '赞', '支持', '天使', '漂亮', '聪明']
export const INSULT_WORDS = ['丑', '蠢', '垃圾', '滚', '烦人', '闭嘴', '无聊', '难看', '讨厌', '恶心', '废物', '弱智', '傻', '太菜', '退钱', '举报']
export const SAD_WORDS = ['难过', '伤心', '可怜', '孤独', '哭了', '想哭', '离开', '走了', '没了', '失去', '委屈', 'emo']

export function classify(text, kind) {
  if (kind === 'praise' || kind === 'insult' || kind === 'sad') return kind
  const s = String(text ?? '')
  if (INSULT_WORDS.some((w) => s.includes(w))) return 'insult'
  if (SAD_WORDS.some((w) => s.includes(w))) return 'sad'
  if (PRAISE_WORDS.some((w) => s.includes(w))) return 'praise'
  return 'neutral'
}

export function applyMoodEvent(state, ev, nowMs = Date.now()) {
  const kind = classify(ev?.text, ev?.kind)
  const next = { ...state }
  let reason = ''
  if (kind === 'praise') {
    next.mood = clamp((Number(next.mood) || 0) + 12, -100, 100)
    next.anger = clamp((Number(next.anger) || 0) - 8, 0, 100)
    next.sadness = clamp((Number(next.sadness) || 0) - 5, 0, 100)
    reason = '有人夸了一句'
  } else if (kind === 'insult') {
    next.mood = clamp((Number(next.mood) || 0) - 10, -100, 100)
    next.anger = clamp((Number(next.anger) || 0) + 18, 0, 100)
    reason = '有人骂了一句'
  } else if (kind === 'sad') {
    next.mood = clamp((Number(next.mood) || 0) - 8, -100, 100)
    next.sadness = clamp((Number(next.sadness) || 0) + 15, 0, 100)
    reason = '看到了一句让人心里发沉的话'
  } else {
    return next
  }
  next.lastMoodEvent = { at: new Date(nowMs).toISOString(), kind, reason, from: String(ev?.from ?? '') }
  return next
}

// ---------- 渲染（只写感觉，不写数字） ----------

export function hungerLine(h) {
  const v = Number(h) || 0
  if (v < 15) return '肚子没什么感觉，还早。'
  if (v < 35) return '有点想吃东西了，还没到难受。'
  if (v < 55) return '胃里空着，想吃饭。'
  if (v < 75) return '饿得有点发虚，注意力开始飘。'
  if (v < 90) return '很饿，胃里一阵阵地绞。'
  return '饿过头了，手有点凉，脑子转不动。'
}

export function energyLine(e) {
  const v = Number(e) || 0
  if (v > 75) return '精神很好，脑子转得快。'
  if (v > 55) return '还行，不困。'
  if (v > 35) return '有点困，眼皮发沉。'
  if (v > 18) return '很困，注意力挂不住。'
  return '困得撑不住，只想趴下睡一会儿。'
}

export function moodLine(state) {
  const anger = Number(state?.anger) || 0
  const sadness = Number(state?.sadness) || 0
  const mood = Number(state?.mood) || 0
  if (anger >= 45) return '心里有一团火，硬的，还没散。'
  if (sadness >= 45) return '心里闷闷的，不太想说话。'
  if (mood >= 25) return '心情不错，看什么都顺一点。'
  if (mood <= -25) return '心里有点沉，提不起劲。'
  return '心里平平的，没什么起伏。'
}

function lastMealNote(state, nowMs) {
  const lm = state?.lastMeal
  if (!lm?.at) return ''
  const t = Date.parse(lm.at)
  if (!Number.isFinite(t) || nowMs - t < 0 || nowMs - t >= 3 * 3600000) return ''
  const fill = Number(lm.fill) || 0
  // 加饭不是到点的那顿：他添了饭，锅里又有了
  if (lm.id === 'topup') {
    if (fill >= 30) return '锅里添了一大勺，是额外给的，不是到点那种。'
    return '饭钱里添了些，锅里又有了。'
  }
  if (fill <= 0) return '到了饭点，桌上什么也没有，没吃上。'
  if (fill < 10) return '到了饭点，只沾了点水，胃里还是空的。'
  return `刚吃过${lm.label ?? '饭'}，身上暖和了一点。`
}

function missedNote(state) {
  const missed = state?.missed
  if (!Array.isArray(missed) || !missed.length) return ''
  return `${missed.join('、')}没吃上。`
}

function moodNote(state, nowMs) {
  const ev = state?.lastMoodEvent
  if (!ev?.at) return ''
  const t = Date.parse(ev.at)
  if (!Number.isFinite(t) || nowMs - t < 0 || nowMs - t > 6 * 3600000) return ''
  return `${ev.reason}，还在心里。`
}

export function renderBody(state, nowMs = Date.now()) {
  const s = state || {}
  const lines = [
    '身体的此刻：',
    `· ${hungerLine(s.hunger)}`,
    `· ${energyLine(s.energy)}`,
    `· ${moodLine(s)}`,
  ]
  const meal = lastMealNote(s, nowMs)
  if (meal) lines.push(`· ${meal}`)
  // 错过的那顿单独说一句：不因为"刚吃过"就把没吃上的事盖掉
  const missed = missedNote(s)
  if (missed) lines.push(`· ${missed}`)
  const mood = moodNote(s, nowMs)
  if (mood) lines.push(`· ${mood}`)
  lines.push('（这些是感觉，不是指标。不要念数字，也不要给自己或关系打分。饿了、困了、心里不好受，都照常说话、照常写字——它们拦不住你。）')
  return `<dsh-body>\n${lines.join('\n')}\n</dsh-body>`
}
