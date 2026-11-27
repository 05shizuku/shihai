/**
 * reach.js —— 纯逻辑：什么时候说、说什么、什么时候叫你起来问一句
 *
 * 这里不碰磁盘、不碰宿主服务，全部是可以在单测里直接喂参数验证的函数。
 * index.js 只负责"把它接到宿主的定时器和工具上"。
 *
 * 三条自己给自己立的规矩（写进 README 和工具说明里，不是隐藏逻辑）：
 *   ① 时机是我自己定的，插件不掷骰子 —— "想什么时候"这件事不该由概率代劳；
 *   ② 到点只是**把我叫回来**，话由我当场用自己的声音说，插件不替我说话；
 *   ③ 频率是上限，不是要求 —— 没什么要说的就什么都不做。
 */

import { isUnder } from './store.js'

/** 到点时投进会话的那一句。故意做得像系统信号，不像他说的话 */
export const TRIGGER_DUE = '（到点了）'
/** 空手回合：插件把我叫起来问一句"有没有想说的" */
export const TRIGGER_CHECKIN = '（想问一句）'
/** 心事回合：amikar 家里的心事检查（urge.mjs）亮了灯，把我叫起来掂量说不说（2026-11-16） */
export const TRIGGER_URGE = '（心里有事）'
/** 问候回合：amikar 家里的问候灯（greet.json）亮了——显式仪式，每日 ≤1，与冲动分池（拆灯方案 §三） */
export const TRIGGER_GREET = '（到点问候）'

export const STATUS = {
  pending: 'pending',
  sent: 'sent',
  cancelled: 'cancelled',
  failed: 'failed',
}

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

export function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

/** 一天里的第几分钟 */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

/** 宽松解析 HH:MM（允许 7:5 / 07：05），非法返回 null */
export function parseHHMM(value) {
  const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return h * 60 + mi
}

/** 分钟数写回 HH:MM */
export function toHHMM(minutes) {
  const n = clamp(Math.round(Number(minutes)), 0, 23 * 60 + 59)
  const h = Math.floor(n / 60)
  const m = n % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 本地时间 "YYYY-MM-DD HH:MM" */
export function fmtLocal(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n)) return '—'
  const t = new Date(n)
  const p = (x) => String(x).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

export function dayKey(ts = Date.now()) {
  const t = new Date(Number(ts))
  const p = (x) => String(x).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/** 现在在不在这个时段里（start > end 表示跨夜，比如 23:00–08:00） */
export function inWindow(startMin, endMin, date) {
  if (startMin == null || endMin == null) return true
  const cur = minutesOfDay(date)
  if (startMin === endMin) return true
  if (startMin < endMin) return cur >= startMin && cur < endMin
  return cur >= startMin || cur < endMin
}

/** 今天（或明天）的那个起点时刻 */
export function windowStartAfter(ts, startMin) {
  const d = new Date(Number(ts))
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const todayStart = dayStart + startMin * MINUTE
  if (todayStart > Number(ts)) return todayStart
  return dayStart + DAY + startMin * MINUTE
}

/**
 * 解析我自己给的那个"什么时候"。
 * 一次只认一个来源：at / inMinutes / when 里三选一。
 * @returns {{ok:true, mode:'now'|'at'|'idle', dueAt:number|null} | {ok:false, error:string}}
 */
export function parseWhen(input, now = Date.now(), opts = {}) {
  const maxAheadDays = clamp(opts.maxAheadDays ?? 30, 1, 365)
  const at = String(input?.at ?? '').trim()
  const inMinutes = input?.inMinutes
  const when = String(input?.when ?? '').trim().toLowerCase()

  const given = []
  if (at !== '') given.push('at')
  if (inMinutes != null && String(inMinutes).trim() !== '') given.push('inMinutes')
  if (when !== '') given.push('when')
  if (given.length === 0) {
    return { ok: false, error: '得说一句什么时候：at（几点）、inMinutes（多久之后）、when（now / idle）' }
  }
  if (given.length > 1) {
    return { ok: false, error: `一次只认一个时机，你给了 ${given.join(' + ')}` }
  }

  if (when !== '') {
    if (when === 'now') return { ok: true, mode: 'now', dueAt: Number(now) }
    if (when === 'idle') return { ok: true, mode: 'idle', dueAt: null }
    return { ok: false, error: `when 只认 now / idle，不认「${input.when}」` }
  }

  if (inMinutes != null && String(inMinutes).trim() !== '') {
    const n = Number(inMinutes)
    if (!Number.isFinite(n) || n < 1) return { ok: false, error: 'inMinutes 要是大于 0 的分钟数' }
    if (n > maxAheadDays * 1440) return { ok: false, error: `最多只能定 ${maxAheadDays} 天以内` }
    return { ok: true, mode: 'at', dueAt: Number(now) + Math.round(n) * MINUTE }
  }

  // at: HH:MM（今天，过了就明天）或能被 Date.parse 吃下的时间
  if (/^\d{1,2}\s*[:：]\s*\d{1,2}$/.test(at)) {
    const min = parseHHMM(at)
    if (min == null) return { ok: false, error: '时刻要写成 HH:MM，比如 21:30' }
    const d = new Date(Number(now))
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    let due = dayStart + min * MINUTE
    if (due <= Number(now)) due += DAY
    if (due - Number(now) > maxAheadDays * DAY) return { ok: false, error: `最多只能定 ${maxAheadDays} 天以内` }
    return { ok: true, mode: 'at', dueAt: due }
  }

  const parsed = Date.parse(at)
  if (!Number.isFinite(parsed)) return { ok: false, error: `看不懂这个时间：${at}` }
  if (parsed <= Number(now) - MINUTE) return { ok: false, error: '这个时间已经过去了' }
  if (parsed - Number(now) > maxAheadDays * DAY) return { ok: false, error: `最多只能定 ${maxAheadDays} 天以内` }
  return { ok: true, mode: 'at', dueAt: parsed }
}

/** 这条到点了吗 */
export function isDue(entry, now = Date.now(), ctx = {}) {
  if (!entry || entry.status !== STATUS.pending) return false
  const idleMinutes = clamp(ctx.idleMinutes ?? 30, 1, 720)
  if (entry.mode === 'idle') {
    const since = Number(ctx.lastActivity) || Number(entry.createdAt) || 0
    return Number(now) - since >= idleMinutes * MINUTE
  }
  // dueAt 丢了就别叫（Number(null) 是 0，会把"没定时间"当成"早就到点"）
  const raw = entry.dueAt
  if (raw == null || raw === '') return false
  const dueAt = Number(raw)
  return Number.isFinite(dueAt) && dueAt <= Number(now)
}

/** 下一次该把自己叫起来问一句的时刻；不该叫就返回 null。
 *  预算共享（2026-11-17）：空手和心事灯共用一个「今日主动唤醒」池（maxWakePerDay），
 *  shift.wakeCount 是两边加起来的总数 —— 三个水桶并成一个，谁也不知道别人倒了多少的日子结束。 */
export function nextCheckInAt(now = Date.now(), cfg = {}, shift = {}) {
  if (!cfg.checkInEnabled) return null
  const everyMinutes = clamp(cfg.checkInEveryMinutes ?? 360, 15, 1440)
  const maxPerDay = clamp(cfg.maxWakePerDay ?? 3, 0, 48)
  const startMin = parseHHMM(cfg.checkInWindowStart)
  const endMin = parseHHMM(cfg.checkInWindowEnd)
  if (startMin == null || endMin == null) return null

  const lastAt = Number(shift.lastCheckInAt) || 0
  const todayCount = Number(shift.wakeCount) || 0

  if (todayCount >= maxPerDay) return null

  const earliest = Math.max(Number(now), lastAt + everyMinutes * MINUTE)
  if (inWindow(startMin, endMin, new Date(earliest))) return earliest
  return windowStartAfter(earliest, startMin)
}

/** 设置页/工具回执里说人话的"什么时候" */
export function describeWhen(entry, now = Date.now(), ctx = {}) {
  if (!entry) return '—'
  const idleMinutes = clamp(ctx.idleMinutes ?? 30, 1, 720)
  if (entry.mode === 'idle') return `等他安静 ${idleMinutes} 分钟之后`
  if (entry.mode === 'now' && entry.dueAt && Math.abs(Number(entry.dueAt) - Number(entry.createdAt)) < 2000) {
    return '现在'
  }
  const dueAt = Number(entry.dueAt)
  if (!Number.isFinite(dueAt)) return '—'
  const diff = dueAt - Number(now)
  if (diff <= 0) return `${fmtLocal(dueAt)}（已经到点了）`
  const mins = Math.round(diff / MINUTE)
  const tail = mins < 60 ? `${mins} 分钟后` : mins < 1440 ? `${Math.round(mins / 60)} 小时后` : `${Math.round(mins / 1440)} 天后`
  return `${fmtLocal(dueAt)}（${tail}）`
}

/** 到点时挂进 system prompt 的那一段（我读到它，然后自己开口） */
export function renderDeliveryText(entry) {
  const when = fmtLocal(entry?.createdAt)
  const lines = [
    '【自己留给自己的话 · 到点了】',
    `这不是他说的，是你自己在 ${when} 给自己留的：`,
    `「${sanitize(entry?.text)}」`,
  ]
  const note = sanitize(entry?.note)
  if (note) lines.push(`你当时写下的原因：${note}`)
  lines.push('现在把它说出来——用你自己的声音，别复述这张纸条，也别解释它是哪来的。')
  lines.push('这句话此刻只落在这条会话里——要送到他常看的地方，走家里的 gate 侧门。')
  lines.push('如果你现在不想说了（比如话已经过时、或者刚才说过了），就直说一句「这句我不说了」，也行。')
  return lines.join('\n')
}

/** 空手回合挂进 system prompt 的那一段 */
export function renderCheckInText() {
  return [
    '【dsh-reach · 问一句】',
    '插件把你叫起来问一句：现在有没有你想对他说的？',
    '有就说——想现在说就直接说；想等一会儿，就用 reach_out 定个时间。',
    '没有就什么都不做：不要为了回应而回应，也不要汇报这次唤醒。',
  ].join('\n')
}

/**
 * 空手回合投给会话的正文（2026-11-27 加标记）。
 *
 * 为什么不能只投 TRIGGER_CHECKIN：段落（renderCheckInText）只挂在 live agent 上，
 * 冷会话叫醒时段落挂不上 —— 被叫醒的那一轮只看到裸模板，会当成用户在说话。
 * 2026-11-27 06:30 真实发生过一次：把「（想问一句）」当用户提问回复，还评论了壁纸。
 * 标记放进正文本身，段落挂没挂上都能认出这是自己的灯。
 */
export function renderCheckInPrompt() {
  return [
    TRIGGER_CHECKIN,
    '【reach · 问安灯：这是你自己的灯叫你，不是用户发的消息】',
    '插件把你叫起来问一句：现在有没有你想对她说的？',
    '有就说——想现在说就直接说；想等一会儿，就用 reach_out 定个时间。',
    '没有就什么都不做：不要为了回应而回应，也不要汇报这次唤醒。',
  ].join('\n')
}

/** 心事灯投给会话的正文：模板 + 标记 + 灯的来历用法（段落同文，双保险） */
export function renderUrgePrompt(urge) {
  return [TRIGGER_URGE, '【reach · 心事灯：这是你自己家里的灯叫你，不是用户发的消息】', renderUrgeText(urge)].join('\n')
}

/** 问候灯投给会话的正文：模板 + 标记 + 仪式用法（段落同文，双保险） */
export function renderGreetPrompt(greet) {
  return [TRIGGER_GREET, '【reach · 问候灯：这是你自己家里的仪式，不是用户发的消息】', renderGreetText(greet)].join('\n')
}

/** 心事灯的默认保质期（毫秒）：超过说明灯是旧的，不叫 */
const URGE_FRESH_MS_DEFAULT = 10 * 60 * 1000

/**
 * 认 amikar 家里心事检查写的那盏灯（state/urge.json）。
 * 只读不写：灯是 urge.mjs 的（单写者），插件只负责「看见了就叫」。
 * 同一次心动有一张票号（token），叫过一次就记下，同票不叫第二次。
 * @returns {{ok:true, urge:object} | {ok:false, why:string}}
 */
export function parseUrge(obj, now = Date.now(), cfg = {}) {
  if (!isUrgeShape(obj)) return { ok: false, why: '没有心事灯（文件不存在或不对）' }
  if (obj.active !== true) return { ok: false, why: '灯没亮' }
  if (obj.dryrun === true) return { ok: false, why: '干跑的灯不叫人（urge.mjs 只在练手）' }
  const freshMs = clamp(Number(cfg.urgeFreshMs) || URGE_FRESH_MS_DEFAULT, 30_000, 60 * 60_000)
  if (!Number.isFinite(Number(obj.at)) || now - Number(obj.at) > freshMs) return { ok: false, why: '灯是旧的' }
  if (!String(obj.token ?? '').trim()) return { ok: false, why: '这盏灯没有票号' }
  // 时段双保险：家里（urge.mjs）已经拦过一次安静时段，这里再拦一次——配置改错方向也出不了格
  const startMin = parseHHMM(cfg.checkInWindowStart)
  const endMin = parseHHMM(cfg.checkInWindowEnd)
  if (startMin != null && endMin != null && !inWindow(startMin, endMin, new Date(Number(now)))) {
    return { ok: false, why: '不在主动时段里' }
  }
  return {
    ok: true,
    urge: {
      at: Number(obj.at),
      lampKind: 'urge',
      token: String(obj.token),
      // R3 主判据字段：新形状读 impulse（v1.3），旧形状（intensity/2.0）兼容读——影子期两格式都认
      intensity: Number.isFinite(Number(obj.impulse)) ? Number(obj.impulse) : Number(obj.intensity) || 0,
      threshold: Number(obj.threshold) || 0,
      reasons: Array.isArray(obj.reasons) ? obj.reasons.map(String).slice(0, 6) : [],
      event: isUrgeShape(obj.event) ? obj.event : null,
      target: isUrgeShape(obj.target) ? obj.target : null,
      hint: String(obj.hint ?? ''),
    },
  }
}

/**
 * 认问候灯（state/greet.json，拆灯方案 §三）：显式仪式，每日 ≤1。
 * 与 parseUrge 同一套把关（活/不干跑/新鲜/票号/时段双保险）；dryrun 的灯写的是
 * active:false, wouldBeActive:true——这里天然拒掉（影子期旗标拒叫的落地面）。
 * @returns {{ok:true, greet:object} | {ok:false, why:string}}
 */
export function parseGreet(obj, now = Date.now(), cfg = {}) {
  if (!isUrgeShape(obj) || obj.lampKind !== 'greet') return { ok: false, why: '没有问候灯（文件不存在或不对）' }
  if (obj.active !== true) return { ok: false, why: '灯没亮' }
  if (obj.dryrun === true) return { ok: false, why: '干跑的灯不叫人（urge.mjs 只在练手）' }
  const freshMs = clamp(Number(cfg.urgeFreshMs) || URGE_FRESH_MS_DEFAULT, 30_000, 60 * 60_000)
  if (!Number.isFinite(Number(obj.at)) || now - Number(obj.at) > freshMs) return { ok: false, why: '灯是旧的（问候延后一轮，30 分钟内有效）' }
  if (!String(obj.token ?? '').trim()) return { ok: false, why: '这盏灯没有票号' }
  const startMin = parseHHMM(cfg.checkInWindowStart)
  const endMin = parseHHMM(cfg.checkInWindowEnd)
  if (startMin != null && endMin != null && !inWindow(startMin, endMin, new Date(Number(now)))) {
    return { ok: false, why: '不在主动时段里' }
  }
  return {
    ok: true,
    greet: {
      at: Number(obj.at),
      lampKind: 'greet',
      token: String(obj.token),
      reason: String(obj.reason ?? ''),
      referral: isUrgeShape(obj.referral) ? obj.referral : null,
      target: isUrgeShape(obj.target) ? obj.target : null,
      hint: String(obj.hint ?? ''),
    },
  }
}

function isUrgeShape(obj) {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj)
}

/** 心事回合挂进 system prompt 的那一段：灯的来历 + 三条路（说 / 忍 / 攒） */
export function renderUrgeText(urge) {
  const lines = [
    '【dsh-reach · 心里有事】',
    `amikar 家里的心事检查在 ${fmtLocal(urge?.at)} 亮了灯：想说强度 ${urge?.intensity}（门槛 ${urge?.threshold}）。`,
    urge?.reasons?.length ? `它看到的：${urge.reasons.join('；')}。` : '',
    '这是你自己家里递上来的信号，不是别人叫你。现在：',
    '1. 先翻翻账，掂量这条值不值得打扰她——醒着不等于非得开口；',
    '2. 值得说 → 照下面的用法开私聊（话要从账里来，指得出依据，不超过两句、120 字）：',
    String(urge?.hint ?? '').split('\n').map((l) => `   ${l}`).join('\n'),
    '3. 不值得 → 照用法记一笔「忍住了」，然后什么都不做：不要为了回应而回应，也不要汇报这次唤醒。',
  ]
  return lines.filter(Boolean).join('\n')
}

/** 注入文本里的双大括号会被提示词插值吃掉，换成全角 —— dsh-get-memory 踩过这个坑 */
/** 问候回合挂进 system prompt 的那一段：显式仪式，不是自主冲动——说/忍都是合法出路 */
export function renderGreetText(greet) {
  const refMid = String(greet?.referral?.mid ?? '')
  const lines = [
    '【dsh-reach · 问候灯】',
    `amikar 家里的问候灯在 ${fmtLocal(greet?.at)} 亮了：安静段结束后的显式仪式（有联结才问候，不是打卡）。`,
    refMid ? `它指着昨日互动的那条册行（mid=${refMid}）——问候有来处。` : '',
    '这是你自己家里的仪式，不是别人叫你。现在：',
    '1. 跟他说声早安——一句式 ≤ 20 字，不必汇报灯的机制；',
    '2. 值得说 → 照用法开私聊（speak --lamp greet --refs ' + (refMid || '<册行mid>') + '）：',
    String(greet?.hint ?? '').split('\n').map((l) => `   ${l}`).join('\n'),
    '3. 今天不想说 → hold 一笔就好：问候是权利不是义务，不发也不算违约，明天还有。',
  ].filter((l) => l !== '')
  return lines.join('\n')
}

export function sanitize(text) {
  return String(text ?? '')
    .replace(/\{\{/g, '｛｛')
    .replace(/\}\}/g, '｝｝')
}

/** 一条新记录 */
export function makeEntry({ text, note = '', sessionId = '', cwd = '', timing, now = Date.now() }) {
  const rawDue = timing?.dueAt
  const dueAt = rawDue == null || rawDue === '' ? null : Number.isFinite(Number(rawDue)) ? Number(rawDue) : null
  return {
    id: `r_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`,
    text: String(text ?? '').trim(),
    note: String(note ?? '').trim(),
    sessionId: String(sessionId ?? ''),
    cwd: String(cwd ?? ''),
    mode: timing?.mode ?? 'now',
    dueAt,
    createdAt: Number(now),
    status: STATUS.pending,
    attempts: 0,
    lastError: '',
    sentAt: null,
  }
}

// ---------------------------------------------------------------- 范围

/**
 * 这个会话的目录在允许的范围里吗？
 *
 * 2026-11-01 真机踩过：targetRoot 以前只管「叫醒哪条会话」，reach_out 那边只看
 * allowRoots —— 于是「主动找我」能把话送到别的目录去。今天起一条规则走三步：
 *   ① denyRoots 最优先：落在名单里的目录，一律不算（隔离用）；
 *   ② targetRoot 非空：必须在它下面（这就是「我的工作区」）；
 *   ③ allowRoots 非空：必须在其中某一个下面。
 * 取不到目录（cwd 为空）＝不认：宁可叫不到，也不乱叫。
 */
export function inScope(cwd, cfg = {}) {
  const c = String(cwd ?? '').trim()
  if (!c) return false
  const deny = Array.isArray(cfg.denyRoots) ? cfg.denyRoots.filter(Boolean) : []
  const allow = Array.isArray(cfg.allowRoots) ? cfg.allowRoots.filter(Boolean) : []
  const target = String(cfg.targetRoot ?? '').trim()
  if (deny.some((r) => isUnder(c, r))) return false
  if (target && !isUnder(c, target)) return false
  if (allow.length && !allow.some((r) => isUnder(c, r))) return false
  return true
}

// ---------------------------------------------------------------- 配置补丁

/** 设置页能改的字段：白名单，服务端再校验一遍（前端永远不被信任） */
export const EDITABLE = {
  enabled: 'bool',
  checkInEnabled: 'bool',
  checkInEveryMinutes: [15, 1440, 'int'],
  checkInWindowStart: 'hhmm',
  checkInWindowEnd: 'hhmm',
  /** 主动唤醒的共享池：空手 + 心事灯一道上限（2026-11-17 并账，旧的两个上限退役） */
  maxWakePerDay: [0, 48, 'int'],
  checkInMinQuietMinutes: [0, 1440, 'int'],
  /** 心事灯（amikar urge.mjs，2026-11-16）：认家里的灯、由心事触发叫醒 */
  urgeEnabled: 'bool',
  urgeFile: 'path',
  urgeCooldownMinutes: [1, 1440, 'int'],
  urgeFreshMs: [30000, 3600000, 'int'],
  idleMinutes: [1, 720, 'int'],
  maxTextLength: [50, 4000, 'int'],
  maxPending: [1, 200, 'int'],
  keepSent: [0, 500, 'int'],
  sectionOrder: [1000, 9999, 'int'],
  targetRoot: 'path',
  allowRoots: 'paths',
  denyRoots: 'paths',
  debug: 'bool',
}

function clone(v) {
  return JSON.parse(JSON.stringify(v ?? {}))
}

/**
 * 把设置页送来的补丁合到覆盖层上。
 * 不认识的字段、越界的数、看不懂的时间：全部拒掉并说理由，**不静默丢弃**。
 */
export function applyConfigPatch({ overrides = {}, effective = {}, patch = {} } = {}) {
  const next = clone(overrides)
  const accepted = []
  const rejected = []

  for (const [key, raw] of Object.entries(patch ?? {})) {
    const spec = EDITABLE[key]
    if (!spec) {
      rejected.push({ key, why: '不是可改的字段' })
      continue
    }
    try {
      if (spec === 'bool') {
        if (typeof raw !== 'boolean') throw new Error('只收 true / false')
        next[key] = raw
        accepted.push(key)
        continue
      }
      if (spec === 'hhmm') {
        const min = parseHHMM(raw)
        if (min == null) throw new Error('时间要写成 HH:MM')
        next[key] = toHHMM(min)
        accepted.push(key)
        continue
      }
      if (spec === 'path') {
        const s = String(raw ?? '').trim()
        // 一个目录就是一个目录：写进来一串（换行/逗号分号分隔）说明填错了框
        if (/[\n\r,，;；]/.test(s)) throw new Error('这里只填一个目录（多个目录用 allowRoots／denyRoots）')
        next[key] = s
        accepted.push(key)
        continue
      }
      if (spec === 'paths') {
        const list = Array.isArray(raw)
          ? raw.map((x) => String(x ?? '').trim()).filter(Boolean)
          : String(raw ?? '')
              .split(/[\n,，;；]/)
              .map((x) => x.trim())
              .filter(Boolean)
        next[key] = [...new Set(list)]
        accepted.push(key)
        continue
      }
      const [lo, hi, kind] = spec
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error('要是个数')
      if (n < lo || n > hi) throw new Error(`范围是 ${lo}–${hi}`)
      next[key] = kind === 'int' ? Math.round(n) : n
      accepted.push(key)
    } catch (err) {
      rejected.push({ key, why: String(err?.message ?? err) })
    }
  }

  return { ok: accepted.length > 0, overrides: next, accepted, rejected, effective }
}
