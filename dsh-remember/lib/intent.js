// 意图层：从真实对话里认出「发生了什么」——事件类型 + 强度，纯规则、确定性、可审计。
//
// 为什么第一版不用 LLM：事件分类是情绪流的输入。LLM 判错一次，整条情绪基线就跟着错，
// 而且错法不可复现（同一句话两次不同答案）。所以这里全是关键词/结构的硬规则：
//   · 同一句话、同一份规则，永远同一个结果 —— 可重放、可测试、出问题能指着规则说
//   · 每条事件只记「类型 + 强度 1~5 + 命中了哪些词」，不记推理过程
//   · 认不出来就记 other、强度 1 —— 宁可漏，不可编
// 以后要接 LLM 兜底，也只许它从固定枚举里挑一个 + 报 1~5 的整数；
// 不许自由发挥、不许自己造类型（b178 点评群友丁方案时定下的口径）。

/** 事件类型（固定枚举，顺序即优先级：同分时靠前的赢）。 */
export const INTENT_KINDS = Object.freeze([
  'farewell', // 告别/去睡了
  'greet', // 打招呼
  'praise', // 夸奖/感谢
  'conflict', // 冲突/不满/生气
  'criticize', // 批评/挑刺（就事论事那种）
  'invite', // 邀请/喊人一起
  'teach', // 教我/纠我/给要求
  'ask', // 提问/求助
  'agree', // 赞同/确认/收到
  'share', // 分享（吃了什么、在干嘛、晒图）
  'other', // 认不出来
])

export const INTENT_LABEL = Object.freeze({
  farewell: '告别',
  greet: '打招呼',
  praise: '夸奖',
  conflict: '冲突',
  criticize: '批评',
  invite: '邀请',
  teach: '教我',
  ask: '提问',
  agree: '赞同',
  share: '分享',
  other: '其他',
})

// 每条规则：[类型, 正则, 权重]。权重只用来在多个类型同时命中时排序，
// 不直接当强度 —— 强度另算，免得「一句话里词多」就等于「情绪重」。
const RULES = [
  ['farewell', /(晚安|睡了|去睡|去睡觉|拜拜|再见|先这样|下了|88|回头聊|不聊了)/, 1.2],
  ['greet', /^(早|早安|早上好|中午好|午安|晚上好|哈喽|嗨|hi|hello|你好|在吗|在不在|在么)/i, 1.1],
  ['greet', /(在吗|在不在|在么|你在干嘛|干嘛呢)\s*[?？]?$/, 1.0],
  ['praise', /(厉害|牛逼|牛啊|太强|真强|好棒|很棒|真棒|不错|可以啊|谢谢你|谢谢|辛苦|喜欢|好看|好听|好玩|有意思|真行|靠谱|稳|牛逼|绝了|羡慕)/, 1.0],
  ['conflict', /(生气|烦死|烦人|讨厌|凭什么|别废话|滚|无语|受不了|失望|不满意|吵|闹|气死|凭什么啊|你不懂)/, 1.1],
  ['criticize', /(不行|不对|错了|太差|很差|差劲|垃圾|没用|有问题|问题很大|看不下去|不合适|退步|小气|敷衍)/, 1.0],
  ['invite', /(来吧|一起来|要不要来|一起玩|来玩|进来|加群|邀请|来嘛|试试|你也来)/, 0.9],
  ['teach', /(你应该|你要|你得|记得|下次|别忘|改成|这样写|教你|纠正|不是这样|应该这么|必须)/, 0.9],
  ['ask', /[?？]/, 1.3],
  ['ask', /(怎么|为什么|为啥|是不是|能不能|可不可以|如何|什么|哪里|哪个|多少|有没有)/, 1.0],
  ['agree', /^(嗯+|对+|好+|行|可以|ok|收到|知道了|是的|确实|没错|有道理)/i, 0.9],
  ['share', /(吃了|早饭|午饭|晚饭|宵夜|好吃|喝了|买了|到了|睡了|刚醒|下班|上班|在做|在玩|在看|看看|发了|给你看)/, 0.8],
]

// 强度加成：这些词只改「这句有多重」，不改类型。
const BOOST_RE = /(太|特别|非常|超级|真的|确实|简直|完全|一点都不|很|贼|巨|最)/
const EXCLAIM_RE = /[!！]{1,}/

const clampIntensity = (n) => Math.max(1, Math.min(5, Math.round(n)))

/** 去掉零宽字符、压掉多余空白，只留前 200 个字参与分类（长的后面不影响类型）。 */
export function normalizeForIntent(text) {
  if (text == null) return ''
  return String(text)
    .replace(/[\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * 认一句话是什么事。
 * @returns {{kind: string, intensity: number, matched: string[], score: number}} 空文本给 other/0
 */
export function classifyIntent(text) {
  const s = normalizeForIntent(text)
  if (!s) return { kind: 'other', intensity: 0, matched: [], score: 0 }

  const hits = new Map() // kind -> { score, words[] }
  for (const [kind, re, weight] of RULES) {
    const m = s.match(re)
    if (!m) continue
    const cur = hits.get(kind) ?? { score: 0, words: [] }
    cur.score += weight
    const word = String(m[0] ?? '').trim()
    if (word && !cur.words.includes(word)) cur.words.push(word)
    hits.set(kind, cur)
  }

  if (!hits.size) return { kind: 'other', intensity: 1, matched: [], score: 0 }

  // 按分数降序；同分按 INTENT_KINDS 的顺序（规则表本身就是优先级）
  let best = ''
  let bestScore = -1
  for (const kind of INTENT_KINDS) {
    const h = hits.get(kind)
    if (!h) continue
    if (h.score > bestScore) {
      best = kind
      bestScore = h.score
    }
  }
  const matched = hits.get(best)?.words ?? []

  // 强度：基础 2；夸奖/冲突/批评/告别的底子重一点（3）；有加强词 +1；有感叹号 +1。
  let base = 2
  if (best === 'praise' || best === 'conflict' || best === 'criticize' || best === 'farewell') base = 3
  if (best === 'ask' && /[?？]/.test(s)) base = 2
  let intensity = base
  if (BOOST_RE.test(s)) intensity += 1
  if (EXCLAIM_RE.test(s)) intensity += 1
  // 一句话同时命中两种对立类型（又夸又骂）也是重的一类：矛盾本身算强度
  if (hits.has('praise') && (hits.has('conflict') || hits.has('criticize'))) intensity += 1

  return { kind: best, intensity: clampIntensity(intensity), matched: matched.slice(0, 4), score: Number(bestScore.toFixed(2)) }
}

/** 打成一条可以落盘的事件（append-only）。文本截 120 字，别让群聊长篇把账本撑大。 */
export function makeIntentEvent(text, { at = Date.now(), source = 'chat', chatType = '', from = '' } = {}) {
  const s = normalizeForIntent(text)
  if (!s) return null
  const c = classifyIntent(s)
  return {
    at: Number(at) || Date.now(),
    kind: c.kind,
    intensity: c.intensity,
    text: s.slice(0, 120),
    matched: c.matched,
    source: String(source || 'chat'),
    chatType: String(chatType || ''),
    from: String(from || ''),
  }
}

/** 一段事件流里各类型各几条、平均强度多少（给 status / memory_list 用）。 */
export function summarizeIntents(events = []) {
  const list = Array.isArray(events) ? events.filter((e) => e && e.kind) : []
  const byKind = {}
  let sum = 0
  for (const e of list) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
    sum += Number(e.intensity) || 0
  }
  return {
    total: list.length,
    byKind,
    avgIntensity: list.length ? Number((sum / list.length).toFixed(2)) : 0,
  }
}

/**
 * 意图事件的稳定 id：同一条消息永远同一个 id。
 *
 * 为什么必须有：源文件（桥那边的消息流）会被裁旧重写，字节游标会失效重读；
 * 重读时靠这个 id 认出「这条我抄过了」，不然同一条消息会变成两条事件。
 *
 * 身份里**不含类型**：id 认的是「那条消息」，不是「我怎么读它」。
 * 规则改了、重读了，同一条消息还是同一件事 —— 只是我的读法换了。
 */
export function intentEventId({ source = '', at = 0, text = '', from = '', mid = '' } = {}) {
  const raw = `${source}|${Number(at) || 0}|${String(mid)}|${String(from)}|${String(text)}`
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `i_${h.toString(36).padStart(7, '0')}`
}

/** 把一行原始事件归一化。坏行返回 null（不因为一行坏了丢整批）。 */
export function normIntentEvent(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const at = Number(raw.at)
  if (!Number.isFinite(at) || at <= 0) return null
  const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const kind = INTENT_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'other'
  const source = String(raw.source ?? 'chat').trim() || 'chat'
  const from = String(raw.from ?? '').trim()
  const mid = String(raw.mid ?? '').trim()
  const intensity = Math.max(0, Math.min(5, Math.round(Number(raw.intensity) || 0)))
  const ev = {
    id: String(raw.id ?? '') || intentEventId({ source, at, text, from, mid }),
    at,
    kind,
    intensity,
    text: text.slice(0, 200),
    source,
    from,
  }
  if (mid) ev.mid = mid
  if (raw.chatType) ev.chatType = String(raw.chatType)
  if (raw.nickname) ev.nickname = String(raw.nickname).slice(0, 40)
  if (raw.groupId) ev.groupId = String(raw.groupId)
  if (Array.isArray(raw.matched) && raw.matched.length) ev.matched = raw.matched.slice(0, 4).map(String)
  return ev
}

/**
 * 一条消息的身份（不分类也能算）。
 *
 * 抄的时候先算 id、认出「这条我见过」就不必再分类一遍 —— 分类是规则活，
 * 身份是那件事本身，两者不该混在一起。
 */
export function intentIdFromMessage(row, { source = 'qq-bridge' } = {}) {
  if (!row || typeof row !== 'object') return ''
  const at = Number(row.at)
  if (!Number.isFinite(at) || at <= 0) return ''
  const text = normalizeForIntent(row.text)
  if (!text) return ''
  return intentEventId({
    source: String(source || 'qq-bridge'),
    at,
    text,
    from: String(row.userId ?? '').trim(),
    mid: String(row.mid ?? '').trim(),
  })
}

/**
 * 把桥那边落下来的一条原始消息认成一条意图事件。
 *
 * 认不出来就是 other、强度 1 —— 宁可漏，不可编。
 * 身份（id）算的是「那条消息」，不是「我怎么读它」：规则改了，重读还是同一件事。
 */
export function intentEventFromMessage(row, { source = 'qq-bridge' } = {}) {
  if (!row || typeof row !== 'object') return null
  const at = Number(row.at)
  if (!Number.isFinite(at) || at <= 0) return null
  const text = normalizeForIntent(row.text)
  if (!text) return null
  const src = String(source || 'qq-bridge')
  const userId = String(row.userId ?? '').trim()
  const mid = String(row.mid ?? '').trim()
  const c = classifyIntent(text)
  const ev = {
    id: intentEventId({ source: src, at, text, from: userId, mid }),
    at,
    kind: c.kind,
    intensity: c.intensity,
    text: text.slice(0, 120),
    matched: c.matched,
    source: src,
    from: userId,
  }
  if (mid) ev.mid = mid
  const chatType = String(row.chatType ?? '').trim()
  if (chatType) ev.chatType = chatType
  const nickname = String(row.nickname ?? '').trim()
  if (nickname) ev.nickname = nickname.slice(0, 40)
  const groupId = String(row.groupId ?? '').trim()
  if (groupId) ev.groupId = groupId
  if (row.atMe === true) ev.atMe = true
  return ev
}

/**
 * 索引：按 id 去重，按时间新的在前，最多留 max 条。
 * 满了就把最老的挤出去（文件里还在，只是内存里不翻了）。
 */
export function pushIntentIndex(index, ev, max = 1000) {
  if (!ev || !ev.id) return Array.isArray(index) ? index : []
  const out = Array.isArray(index) ? index.filter((x) => x && x.id !== ev.id) : []
  out.push(ev)
  out.sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))
  const cap = Math.max(1, Number(max) || 1000)
  return out.length > cap ? out.slice(0, cap) : out
}

/** 相对时间：跟快层一个口气（刚刚／不久前／一会儿前…），不写数字。 */
export function intentRelTime(at, now = Date.now()) {
  const t = Number(at)
  const n = Number(now)
  if (!Number.isFinite(t) || !Number.isFinite(n)) return ''
  const mins = Math.floor(Math.max(0, n - t) / 60000)
  if (mins < 2) return '刚刚'
  if (mins < 15) return '不久前'
  if (mins < 60) return '一会儿前'
  const hours = Math.floor(mins / 60)
  if (hours < 24) return '今天早些时候'
  if (hours < 48) return '前天'
  return '前几天'
}

/** 一行意图事件长什么样（recall / memory_list 里用）。 */
export function renderIntentLine(ev, now = Date.now()) {
  if (!ev) return ''
  const when = intentRelTime(ev.at, now)
  const label = INTENT_LABEL[ev.kind] ?? '有件事'
  const strength = ev.intensity >= 4 ? '重' : ev.intensity >= 3 ? '中' : ev.intensity >= 2 ? '轻' : ''
  return `· 意图·${label}${strength ? `·${strength}` : ''}·${ev.text}${when ? `（${when}）` : ''}`
}

/** 按词翻意图事件：词打在 text、kind、标签或来源里都算。
 *  opts.group：只翻某个来源 —— 群号（'222222222'）或 'private'（私聊），不传翻全部。
 *  （v0.15.0 分册：消息流按场分册落盘，事件行自带 chatType/groupId，翻的时候可以点名要哪个场的。） */
export function searchIntentEvents(events, query, { limit = 5, group = '' } = {}) {
  const q = String(query ?? '').trim().toLowerCase()
  const g = String(group ?? '').trim()
  if (!q && !g) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const out = []
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev) continue
    if (g) {
      if (g === 'private') {
        if (String(ev.chatType ?? '') !== 'private') continue
      } else if (String(ev.groupId ?? '') !== g) {
        continue
      }
    }
    if (!terms.length) {
      out.push(ev)
      if (out.length >= Math.max(1, Number(limit) || 5)) break
      continue
    }
    const hay = `${ev.text ?? ''} ${ev.kind ?? ''} ${INTENT_LABEL[ev.kind] ?? ''} ${ev.source ?? ''} ${ev.from ?? ''}`.toLowerCase()
    if (terms.every((t) => hay.includes(t))) {
      out.push(ev)
      if (out.length >= Math.max(1, Number(limit) || 5)) break
    }
  }
  return out
}
