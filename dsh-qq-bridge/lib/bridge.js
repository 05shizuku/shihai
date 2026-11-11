/**
 * 桥的纯逻辑：OneBot 事件怎么读、白名单怎么挡、递进会话的话怎么压、
 * 回话怎么挑、等多久算过期。零依赖，不碰网络不碰文件 —— index.js 负责接线。
 *
 * 这座桥刻意薄：收 → 递 → 回。不接账本（m00559 定的），
 * QQ 来的话不写记忆；要记，我自己拿 remember 掂量。
 */

/** OneBot v11 的 message 字段（数组或字符串）压成一行人话。 */
export function extractText(message) {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
    switch (seg.type) {
      case 'text':
        if (typeof data.text === 'string' && data.text.trim()) parts.push(data.text)
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push('[文件]')
        break
      case 'json':
        parts.push(describeCard(data))
        break
      case 'forward':
      case 'node':
        parts.push('[转发]')
        break
      case 'at':
        parts.push(data.qq ? `@${data.qq}` : '@某人')
        break
      default:
        break
    }
  }
  return parts.join('').trim()
}

/**
 * 把消息段里的媒体收出来（图直链、群文件），extractText 保持占位不动 ——
 * 递给会话的人话要干净，链接单独走：图片的 data.url 是带 rkey 的直链，
 * 下载就能看（r_1wri69g 的侧门，现在直接进正门）。缺 url 的不收，不编。
 */
export function extractMedia(message) {
  const out = { images: [], files: [] }
  if (typeof message === 'string' || !Array.isArray(message)) return out
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {}
    if (seg.type === 'image' && typeof data.url === 'string' && data.url.trim()) {
      out.images.push({ url: data.url.trim(), file: String(data.file ?? '') })
    } else if (seg.type === 'file') {
      const name = String(data.name ?? data.file ?? '')
      if (name) {
        out.files.push({
          id: String(data.file_id ?? data.id ?? ''),
          name,
          size: Number(data.size) || 0,
          url: typeof data.url === 'string' && data.url.trim() ? data.url.trim() : ''
        })
      }
    }
  }
  return out
}

/**
 * 媒体拼成递话/消息流里的行：图直链一行、文件一行（名字+大小），文件带直链再一行。
 * 消息流里也拼它 —— 群里的图和文件大多不 @ 我，拼进消息流我翻得到、下载得了。
 */
export function mediaLines(media) {
  const lines = []
  for (const img of media?.images ?? []) lines.push(`\n[图片直链] ${img.url}`)
  for (const f of media?.files ?? []) {
    const kb = f.size ? `（${(f.size / 1024).toFixed(0)}KB）` : ''
    lines.push(`\n[文件] ${f.name}${kb}`)
    if (f.url) lines.push(`\n[文件直链] ${f.url}`)
  }
  return lines.join('')
}

/** JSON 卡片尽力学出人话：标题和链接，学不出退回 [卡片]。 */
function describeCard(data) {
  let card = null
  const raw = data?.data
  if (typeof raw === 'string') {
    try {
      card = JSON.parse(raw)
    } catch {
      return '[卡片]'
    }
  } else if (raw && typeof raw === 'object') {
    card = raw
  }
  if (!card || typeof card !== 'object') return '[卡片]'
  const meta = card.meta && typeof card.meta === 'object' ? card.meta : {}
  const firstNews = Array.isArray(meta.news) ? meta.news.find((n) => n && typeof n === 'object') : null
  const miniapp = meta.miniapp && typeof meta.miniapp === 'object' ? meta.miniapp : {}
  const title =
    cleanCardText(firstNews?.title) ||
    cleanCardText(miniapp.title) ||
    cleanCardText(card.prompt) ||
    cleanCardText(card.title) ||
    ''
  const url =
    cleanCardText(firstNews?.qqdocurl) ||
    cleanCardText(firstNews?.url) ||
    cleanCardText(miniapp.jumpUrl) ||
    cleanCardText(card.url) ||
    ''
  if (title && url) return `[卡片]${title}（${url}）`
  if (title) return `[卡片]${title}`
  if (url) return `[卡片]（${url}）`
  return '[卡片]'
}

/**
 * 群邀请卡片里翻出进群的凭据：QQ 的群邀请是张 json 卡，
 * jumpUrl 里带着 groupcode 和 msgseq——msgseq 就是点头的凭据
 *（SnowLuma 自己发的 invite:… flag 在它那边匹配不上，卡片序号反而是活的）。
 */
export function inviteSeqFromCard(message) {
  const segs = Array.isArray(message) ? message : []
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'json') continue
    const raw = seg.data?.data
    let card = null
    if (typeof raw === 'string') {
      try {
        card = JSON.parse(raw)
      } catch {
        continue
      }
    } else if (raw && typeof raw === 'object') {
      card = raw
    }
    if (!card || typeof card !== 'object') continue
    const biz = String(card.bizsrc ?? '')
    const news = card.meta && typeof card.meta === 'object' && Array.isArray(card.meta.news) ? card.meta.news.find((n) => n && typeof n === 'object') : null
    const url = String(news?.jumpUrl ?? news?.qqdocurl ?? news?.url ?? '')
    if (biz && biz !== 'qun.invite') continue
    if (!url) continue
    const gid = url.match(/groupcode=(\d+)/)?.[1] ?? ''
    const seq = url.match(/msgseq=(\d+)/)?.[1] ?? ''
    if (gid && seq) return { groupId: gid, sequence: seq }
  }
  return null
}

function cleanCardText(v) {
  if (typeof v !== 'string') return ''
  return v.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** 递进会话的那一行。 */
export function formatPrompt({ prefix = '【QQ】', nickname = '', userId = '', text = '' } = {}) {
  const who = nickname ? String(nickname) : String(userId)
  return `${prefix}${who}（${userId}）说：${text}`
}

/** 会话那头回话时，怎么认出「这一条是替 QQ 回的」。 */
export function replyLooksBound(prefix, content) {
  const t = String(content ?? '').trim()
  return t.startsWith(prefix) || t.includes(prefix)
}

/** 群里 @ 我了吗：数组消息看 at 段的 qq，字符串消息看 CQ:at。selfUin 空就一律不算。 */
export function atMe(event, selfUin = '') {
  const me = String(selfUin ?? '').trim()
  if (!me || !event) return false
  const msg = event.message
  if (Array.isArray(msg)) {
    return msg.some((seg) => seg && seg.type === 'at' && String(seg.data?.qq ?? '') === me)
  }
  if (typeof msg === 'string') {
    return new RegExp(`\\[CQ:at,qq=${me}[,\\]]`).test(msg)
  }
  return false
}

/** 群里 @ 我的那一行：带上群号，认得出是哪个群里谁在叫我。 */
export function formatGroupPrompt({ prefix = '【QQ】', nickname = '', userId = '', groupId = '', text = '' } = {}) {
  const who = nickname ? String(nickname) : String(userId)
  return `${prefix}${who}（${userId}）@我（群 ${groupId}）说：${text}`
}

/** 私聊白名单：只处理这些号的字。空名单＝一个字都不递。 */
export function isAllowedPrivate(event, allowUsers = []) {
  if (!event || event.post_type !== 'message' || event.message_type !== 'private') return false
  const list = Array.isArray(allowUsers) ? allowUsers.map((x) => String(x)) : []
  if (list.length === 0) return false
  return list.includes(String(event.user_id))
}

/** 群白名单：名单里的群才进消息流；群 @ 我才递话（递话门槛在 looksGroupAddressed）。 */
export function isAllowedGroup(event, allowGroups = []) {
  if (!event || event.post_type !== 'message' || event.message_type !== 'group') return false
  const list = Array.isArray(allowGroups) ? allowGroups.map((x) => String(x)) : []
  if (list.length === 0) return false
  return list.includes(String(event.group_id))
}

export function formatGroupLog(event, text) {
  return `群 ${event.group_id} · ${event.user_id}：${text}`
}

/** 按码点截断，不切半个 emoji。空话不回。 */
export function clampReply(text, maxChars = 500) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  const max = Math.max(1, Math.floor(Number(maxChars) || 500))
  const chars = Array.from(t)
  if (chars.length <= max) return t
  return chars.slice(0, max).join('') + '…'
}

/**
 * 群里的回话必须「点着名」才发：正文要以 @ 开头。
 * 我在一轮里会顺手写内部小结（retcode、seq 之类），那种不点名的字
 * 不该漏进群里 —— 2026-11-05 真漏过一次，他把截图丢回来我才看见。
 */
export function looksGroupAddressed(text) {
  const t = String(text ?? '').trim()
  return t.startsWith('@') || t.startsWith('＠')
}

/**
 * QQ 上一句一个气泡：按「空行」（段落）拆 —— 段落里的单换行留在同一个
 * 气泡里。2026-11-07 群里反馈（814660817）：原来按每个换行拆，长句子
 * 一换行就被碎成好几条。空行丢掉，最多 maxBubbles 条（防刷屏），
 * 超出的并进最后一条。
 */
export function splitBubbles(text, { maxBubbles = 8 } = {}) {
  const cap = Math.max(1, Math.floor(Number(maxBubbles) || 8))
  const paras = String(text ?? '')
    .split(/\r?\n[ \t]*(?:\r?\n)+/)
    .map((s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n'))
    .filter(Boolean)
  if (paras.length <= cap) return paras
  const head = paras.slice(0, cap - 1)
  const tail = paras.slice(cap - 1).join(' ')
  head.push(tail)
  return head
}

/**
 * 从攒的正文里把「点名回话」抠出来：先按空行拆成气泡，再从第一个 @ 开头
 * 的气泡起整段带上（点名的那几句通常成串地排在后面）。
 * 2026-11-10 真事：MC 答复整条是一段，头一句是写给自己的过程话，@ 在后面的
 * 气泡里 —— 旧的点名闸按「整段是否 @ 开头」判，整段作废，群里一个字没收到；
 * 同一天群友乙改判/群友甲转达/群友丙/群友戊四条同病（bridge.log 九次「这轮没有点名」）。
 * 找不到 @ 气泡就返回空串 —— 调用方按「没点名」处理。
 */
export function groupReplyText(texts, { maxBubbles = 8 } = {}) {
  const list = Array.isArray(texts) ? texts : []
  for (let i = list.length - 1; i >= 0; i--) {
    const bubbles = splitBubbles(list[i], { maxBubbles })
    const at = bubbles.findIndex((b) => looksGroupAddressed(b))
    if (at >= 0) return bubbles.slice(at).join('\n\n')
  }
  return ''
}


/**
 * 等回话的小状态机。
 * 收到白名单消息 → mark（挂着等）；我们递进去的话以 user/message 回流 →
 * bindTurn 把那条 turn 认下；同一条 turn 的 assistant/message → takeReply。
 * 过期的等下一律作废 —— 宁可不回，不把十年前的话翻出来回。
 */
export class PendingReplies {
  constructor({ staleMs = 5 * 60 * 1000, inFlightMs = 0, keepMs = 0, initial = [], onChange = null } = {}) {
    this.staleMs = Math.max(1000, Math.floor(Number(staleMs) || 300000))
    // 已经被宿主认领（正在答）的那条：过期时钟从「认领那一刻」起算，并给足窗口。
    // 2026-11-07 真事：一条群消息 13:54 收到，宿主 14:44 才开始答，我干到 15:00
    // 才收尾 —— 按「收到时刻」算已经 66 分钟 > staleSeconds(3600)，
    // 回话在最后一刻被当成过期丢掉，一个字没发出去。
    this.inFlightMs = Math.max(this.staleMs, Math.floor(Number(inFlightMs) || 0) || 6 * 60 * 60 * 1000)
    // 挂起的保留期：清得慢不要紧（能不能发由 _expired 说了算），
    // 免得宿主回显我们的递话晚了几小时，挂起已经被扫掉、回话再也接不上。
    this.keepMs = Math.max(this.staleMs, Math.floor(Number(keepMs) || 0) || 24 * 60 * 60 * 1000)
    /** Map<key, {userId, text, turn|null, at}> */
    this.map = new Map()
    this.seq = 0
    this.onChange = typeof onChange === 'function' ? onChange : null
    for (const item of Array.isArray(initial) ? initial : []) {
      if (item && typeof item === 'object' && item.key) {
        this.map.set(String(item.key), {
          userId: String(item.userId ?? ''),
          text: String(item.text ?? ''),
          turn: Number.isFinite(item.turn) ? item.turn : null,
          at: Number(item.at) || Date.now(),
          primedAt: Number.isFinite(item.primedAt) ? item.primedAt : null,
          boundAt: Number.isFinite(item.boundAt) ? item.boundAt : null,
          meta: item.meta && typeof item.meta === 'object' ? item.meta : {}
        })
        const n = Number(String(item.key).split('-')[1])
        if (Number.isFinite(n) && n > this.seq) this.seq = n
      }
    }
  }

  _changed() {
    if (this.onChange) {
      try {
        this.onChange(this)
      } catch {
        /* 存档失败不拦路 */
      }
    }
  }

  /** 过期判定：认领过的（宿主正在答这一条）从认领时刻起算，给 inFlightMs 的宽窗；
   *  没认领过的按 staleMs 算 —— 等着回话等太久就作废。 */
  _expired(p, now) {
    const base = Number.isFinite(p.boundAt) ? p.boundAt : p.at
    const win = Number.isFinite(p.boundAt) ? this.inFlightMs : this.staleMs
    return now - base >= win
  }

  mark(userId, text, now = Date.now(), meta = {}) {
    const key = `q-${now}-${++this.seq}`
    this.map.set(key, {
      userId: String(userId),
      text: String(text ?? ''),
      turn: null,
      at: now,
      meta: meta && typeof meta === 'object' ? meta : {}
    })
    this.sweep(now)
    this._changed()
    return key
  }

  /** 我们递进去的话以 user/message 流回来时，把 turn 认给没主的 pending。
   *  宿主保证：prompt 的 requestId 会作为 source.rpcId 回显在 user/message 上（app.asar :364116）
   *  —— 先按 rpcId 精确认；没带 rpcId 的再看原文是不是当时递进去的那行；
   *  turn 参数宿主常常不给（user/message 事件里没有 turn），那就先记 primedAt，
   *  等同一条线的 turn/start 来认（bindTurnStart），绝不认错主。 */
  bindTurn(prefix, content, turn, now = Date.now(), rpcId = '') {
    if (!replyLooksBound(prefix, content)) return null
    const setBind = (p, primed = true) => {
      if (Number.isFinite(turn)) p.turn = turn
      else if (primed) p.primedAt = now
      // 宿主开始答这一条了：过期时钟从这一刻起算（不再从消息收到时刻算）。
      // 兜底认领（原文对不上、也没 rpcId）不写 primedAt —— 它没被证实是我们的，
      // 不能让 turn/start 抢走（GUI 里开的转不该动我们的挂起）。
      p.boundAt = now
    }
    if (rpcId) {
      for (const [key, p] of this.map) {
        if (p.turn === null && p.meta?.requestId === rpcId) {
          setBind(p, true)
          this._changed()
          return key
        }
      }
    }
    const t = String(content ?? '').trim()
    if (t) {
      for (const [key, p] of this.map) {
        if (p.turn === null && now - p.at < this.staleMs && p.text && p.text === t) {
          setBind(p, true)
          this._changed()
          return key
        }
      }
    }
    for (const [key, p] of this.map) {
      if (p.turn === null && now - p.at < this.staleMs) {
        setBind(p, false)
        this._changed()
        return key
      }
    }
    return null
  }

  /** turn/start {turn}：正在开的那一转，认给最近被 rpcId 精确认下、还没等到 turn 的挂起。
   *  只认 rpcId 确认过的（primedAt）—— GUI 里打字开的转不能抢我们的挂起。 */
  bindTurnStart(turn, now = Date.now()) {
    if (!Number.isFinite(turn)) return null
    let bestKey = null
    let bestPrimedAt = Infinity
    for (const [key, p] of this.map) {
      if (p.turn === null && Number.isFinite(p.primedAt) && p.primedAt < bestPrimedAt) {
        bestKey = key
        bestPrimedAt = p.primedAt
      }
    }
    if (bestKey === null) return null
    const p = this.map.get(bestKey)
    p.turn = turn
    p.boundAt = now
    delete p.primedAt
    this._changed()
    return bestKey
  }

  /** 同一条 turn 的 assistant 回话；拿到就摘掉。 */
  takeReply(turn, now = Date.now()) {
    for (const [key, p] of this.map) {
      if (p.turn === turn) {
        this.map.delete(key)
        this._changed()
        if (this._expired(p, now)) return null
        p.key = key
        return p
      }
    }
    return null
  }
  dropTurn(turn) {
    let dropped = false
    for (const [key, p] of this.map) {
      if (p.turn === turn) {
        this.map.delete(key)
        dropped = true
      }
    }
    if (dropped) this._changed()
  }

  /** 按钥匙精确取（认领路径）：取到就摘掉，过期当没有。 */
  takeByKey(key, now = Date.now()) {
    const k = String(key ?? '')
    if (!k) return null
    const p = this.map.get(k)
    if (!p) return null
    this.map.delete(k)
    this._changed()
    if (this._expired(p, now)) return null
    p.key = k
    return p
  }

  /** user/message 事件没带 turn 时的兜底：按先后，最早挂起的先回。
   *  被 rpcId 精认过、还在等 turn/start 的（primedAt）排最前 —— 它们才是「正在被回的那批」。 */
  takeAwaiting(now = Date.now()) {
    let bestKey = null
    let bestOrder = Infinity
    let bestAt = Infinity
    for (const [key, p] of this.map) {
      if (p.turn !== null) continue
      const order = Number.isFinite(p.primedAt) ? p.primedAt : p.at
      if (order < bestOrder || (order === bestOrder && p.at < bestAt)) {
        bestKey = key
        bestOrder = order
        bestAt = p.at
      }
    }
    if (bestKey === null) return null
    const p = this.map.get(bestKey)
    this.map.delete(bestKey)
    this._changed()
    if (this._expired(p, now)) return null
    return p
  }

  /** 递话失败，撤掉挂起。 */
  fail(key) {
    if (this.map.delete(key)) this._changed()
  }

  /** v0.8.7 作废放回：挂起被领走但这轮没发出去（没人话 / 群里没点名 / 串台），
   *  不没收 —— 原样放回，等真正的回话轮来领。
   *  2026-11-10 真事：中间轮把群友甲 16:14 点名的挂起领走又作废，扩展榜没发进群。 */
  revive(entry) {
    if (!entry || typeof entry.key !== 'string' || !entry.key) return false
    if (this.map.has(entry.key)) return false
    this.map.set(entry.key, entry)
    this._changed()
    return true
  }

  sweep(now = Date.now()) {
    let dropped = false
    for (const [key, p] of this.map) {
      // 清的是「久到不可能再有人认领」的：留够 keepMs（默认一天），
      // 免得宿主回显我们的递话晚了几小时，挂起已经被扫掉、回话再也接不上。
      if (now - p.at >= this.keepMs) {
        this.map.delete(key)
        dropped = true
      }
    }
    if (dropped) this._changed()
  }

  /** 存档用的平铺快照。 */
  entries() {
    return [...this.map.entries()].map(([key, p]) => ({
      key,
      userId: p.userId,
      text: p.text,
      turn: p.turn,
      at: p.at,
      primedAt: Number.isFinite(p.primedAt) ? p.primedAt : null,
      boundAt: Number.isFinite(p.boundAt) ? p.boundAt : null,
      meta: p.meta ?? {}
    }))
  }

  /** 诊断用：已经认下我们的递话（primedAt 有值）、却还没被任何一轮领走的挂起有几条。
   *  2026-11-08 夜里真事：热重载失败把桥的会话事件订阅打断了，这些挂起
   *  一夜没人领，回话全静默丢了 —— 有了这个数，日志能一眼看出「有话没人接」。 */
  primedWaitingCount() {
    let n = 0
    for (const p of this.map.values()) {
      if (p.turn === null && Number.isFinite(p.primedAt)) n++
    }
    return n
  }

  /**
   * 收尾兜底（v0.8.6）：精确路（takeReply / turnPendingMap）都没接上时，
   * 领「最近刚认下、还没人领」的那条。
   * 2026-11-10 真事：她 08:15 说「早～」，turn/end(508) 却报「回话没接上」，
   * 话静默丢了 —— 精确路依赖内存里那个认领队（热重载会把它清空；队头也可能
   * 是一条早过期的旧挂起，shift 出来就被判过期）。所以补这条按「认下时刻最近」
   * 挑的兜底。窗口卡在 5 分钟：只领刚刚递进来的那条，绝不翻旧账 ——
   * 2026-11-05 盲取真事：兜底取错挂起，把给群里的答复发进了私信。
   */
  takeLatestPrimed(now = Date.now(), withinMs = 5 * 60 * 1000) {
    const win = Math.max(1000, Math.floor(Number(withinMs) || 5 * 60 * 1000))
    let bestKey = null
    let bestAt = -Infinity
    for (const [key, p] of this.map) {
      if (p.turn !== null) continue
      const stamp = Number.isFinite(p.boundAt) ? p.boundAt : p.primedAt
      if (!Number.isFinite(stamp)) continue
      if (now - stamp > win) continue
      if (this._expired(p, now)) continue
      if (stamp > bestAt) {
        bestAt = stamp
        bestKey = key
      }
    }
    if (bestKey === null) return null
    const p = this.map.get(bestKey)
    this.map.delete(bestKey)
    this._changed()
    p.key = bestKey
    return p
  }

  get size() {
    return this.map.size
  }
}

/** 会话那头的 assistant 消息抽出人话。只认 type==='text' 的正文块 ——
 * thinking 块（type==='thinking'）是思考过程，绝不往外发（2026-11-04 教训：
 * 旧版把整个 content 里带 text 的块都拼了，思考全发进了群里）。 */
export function assistantText(message) {
  const c = message && message.content
  if (typeof c === 'string') return c.trim()
  const blocks = Array.isArray(c) ? c : []
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b.text !== 'string') continue
    if (b.type === 'text' || b.type === undefined) parts.push(b.text)
  }
  return parts.join('').trim()
}

/**
 * 工具调用标记不是人话。
 * 宿主把工具步的 assistant 消息回显成「<｜DSML｜ calls>」这类标记；
 * 2026-11-08 真事：它被桥当回话原样发进了她的私聊（她收到一条乱码似的标记）。
 * 这种段一律不攒、不发。
 */
export function isToolCallMarker(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  // 只认「长得像个标签」的：整段是 <…>
  if (!/^<[^<>]*>$/.test(t)) return false
  if (/DSML/i.test(t) && /calls?/i.test(t)) return true
  if (/tool[_\s-]?calls?/i.test(t)) return true
  return false
}

/** 我们递进去的那条 user/message 抽出首行文本（认前缀用）。宿主有时给字符串、有时给块数组，都接。 */
export function userText(message) {
  const c = message && message.content
  if (typeof c === 'string') return c.trim()
  const blocks = Array.isArray(c) ? c : []
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text.trim()
  }
  for (const b of blocks) {
    if (b && typeof b.text === 'string' && b.text.trim()) return b.text.trim()
  }
  if (c && typeof c === 'object' && typeof c.text === 'string' && c.text.trim()) return c.text.trim()
  return ''
}
