/**
 * commands/recall.mjs —— recall 决策本体（批 A 第三步，G-2 施工稿·第一座真山）。
 *
 * 从 index.js 闭包搬出：recall execute 全身（检索/排名/受众/染色/违熏提醒/缘起链投影/
 * 翻身位/唤醒回弹/执受反射弧/快层与意图层翻到/总量闸/情绪流听翻账）+ 染色层 recolorRecall。
 *
 * 红线：
 *   · 回执逐字不变——**resurrect 是回执的条件字段**（翻身位触发时出现，:2406 现状），
 *     批 C 的 HTTP 面（/recall）原样透传，§0 契约 v:1 冻结清单记「resurrect?: string」；
 *   · ctx = { cwd, sessionId }；activationScorer/currentAudience/intentEventAudience
 *     由 ledger 实例注入（单实现），拉取族/情绪域由 emotion 实例注入；
 *   · import 白名单：core/* + 注入参数。
 */

import {
  appendJsonLine,
} from '../../core/protocol/io.js'
import {
  audienceVisible,
  cutByCodePoints,
  indexNodes,
  isSealed,
  normKind,
  pickResurrect,
  rankNodes,
  relTime,
  renderLine,
  searchNodes,
} from '../../core/memory.js'
import { renderFastLine, searchFastEvents } from '../../core/fast.js'
import { renderIntentLine, searchIntentEvents } from '../../core/intent.js'
import { emotionFeelPhrase } from '../../core/emotion.js'
import { noteEcho, sproutToBody } from '../../core/protocol/book.js'

/** 与 index.js:328 同一版 clamp（就地拷贝保等价） */
function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

export function createRecallCommands({ book, log, cfg, now = () => Date.now(), pulls, ledger, emo }) {
  if (!pulls || typeof pulls.pullFast !== 'function') {
    throw new Error('createRecallCommands：pulls 必填注入（来自 createEmotionCommands 实例）')
  }
  if (!ledger || typeof ledger.activationScorer !== 'function') {
    throw new Error('createRecallCommands：ledger 必填注入（来自 createLedgerCommands 实例——activationCtx 全家单实现）')
  }
  if (!emo || typeof emo.emotionStateRaw !== 'function') {
    throw new Error('createRecallCommands：emo 必填注入（情绪域单实现）')
  }
  const { pullFast, pullIntent, fastAllEvents, intentAllEvents } = pulls
  const { activationScorer, currentAudience, intentEventAudience } = ledger

  /** 一笔回声/一次染色最多带几条（跟 recall 的默认 limit 对齐；noteEcho 在 core/protocol 另持一份同值） */
  const RECALL_ECHO_MAX = 5
  /** 染色层限流：一条一周最多染一次 */
  const RECOLOR_GAP_MS = 7 * 24 * 60 * 60 * 1000
  /** 染色层：情绪明显变了才染 */
  const RECOLOR_LEVEL_DELTA = 0.3

  /** 染色层（whale-card P0-4）：翻到旧事时心里有颜色，才在条目后补一句「现在想起它」。
   * 限流（饭桶④）：一条一周最多染一次 + 情绪明显变了才染。正文一字不动，只在 echo.jsonl 记行。 */
  function recolorRecall(list, state, t = now(), dir = null) {
    const out = new Map()
    if (!state || state.dominant === 'calm') return out
    // dir 同 noteEcho：cond 按住要查另一条还在不在（'out' 字符串曾经被当成目录传进来）
    const ids = list.filter((n) => !isSealed(n, t, dir)).slice(0, RECALL_ECHO_MAX).map((n) => n.id)
    for (const id of ids) {
      const last = book.recolorAt.get(id)
      const changed =
        !last || state.dominant !== last.dominant || Math.abs(state.level - (last.level || 0)) >= RECOLOR_LEVEL_DELTA
      if (!changed) continue
      if (last && t - last.at < RECOLOR_GAP_MS) continue
      try {
        appendJsonLine(book.files.echo, {
          id: `rc_${t.toString(36)}_${String(id).slice(-4)}`,
          at: t,
          kind: 'recolor',
          ref: id,
          dominant: state.dominant,
          level: state.level,
          note: emotionFeelPhrase(state),
          source: 'recall',
        })
        book.recolorAt.set(id, { at: t, dominant: state.dominant, level: state.level })
        const note = emotionFeelPhrase(state)
        if (note) out.set(id, note)
      } catch {
        /* 染色失败不挡 recall */
      }
    }
    return out
  }

  function findNode(id) {
    const key = String(id ?? '').trim()
    if (!key) return null
    return book.nodes.find((n) => n.id === key) ?? null
  }

  /* ---------------- 命令本体：recall（回执 = index.js 原 execute 逐字搬） ---------------- */

  function recall(args, ctx = {}) {
    const t = now()
    const limit = clamp(args?.limit ?? 5, 1, 50)
    const kind = args?.kind ? normKind(args.kind) : ''
    // 原文优先，但有字数闸：每条截到 recallItemMax，一次总共 recallMaxChars。
    // （吴晓观提的第三条：工具返回会进对话历史，每轮都带着 —— 我自己能管住的是别一次掏太多。）
    const c = cfg()
    const wantFull = Boolean(args?.full)
    const itemMax = wantFull ? 0 : clamp(c.recallItemMax ?? 400, 100, 4000)
    const budget = clamp(c.recallMaxChars ?? 8000, 1000, 200000)
    // 排名用激活度：此刻的目录、快层刚发生的事、原话层最近写下的行都算数
    const scoreOf = activationScorer({ cwd: ctx?.cwd ?? '' }, t)
    // 翻之前先把快层新发生的事接过来 —— 不然翻到的是上一次的
    try {
      pullFast(t)
    } catch {
      /* 接不上就算了，不该因为快层把翻账本弄坏 */
    }
    // 意图层同理：机器刚认出来的那几句，也得能翻到
    try {
      pullIntent(t)
    } catch {
      /* 接不上就算了，不该因为意图层把翻账本弄坏 */
    }
    // 条件封存也算按住：到点/翻篇之前，不给 include_sealed 就不翻出来。
    const dir = indexNodes(book.nodes)
    const wantSealed = Boolean(args?.include_sealed)
    let list = args?.query
      ? searchNodes(book.nodes, args.query, { limit, now: t, scoreOf, byId: dir, includeSealed: wantSealed }).map((h) => h.node)
      : rankNodes(book.nodes, t, {
          limit,
          includeSealed: wantSealed,
          kind,
          scoreOf,
          byId: dir,
        }).map((h) => h.node)
    if (kind) list = list.filter((n) => normKind(n.kind) === kind)
    if (!wantSealed) list = list.filter((n) => !isSealed(n, t, dir))
    // 受众过滤（借自晴猫）：群轮/私聊轮不翻别的场的账。
    // off = 现状；soft = 别的场的条排到尾上；hard = 别的场不翻出来。
    // solo 轮（桌面打字/自己醒来）全可见。
    const audienceTurn = currentAudience(t)
    const audienceMode = String(c.recallAudience ?? 'off')
    const audienceActive = audienceMode !== 'off' && audienceTurn !== 'solo'
    if (audienceActive) {
      const visible = list.filter((n) => audienceVisible(n.audience, audienceTurn))
      if (audienceMode === 'hard') {
        list = visible
      } else {
        list = [...visible, ...list.filter((n) => !audienceVisible(n.audience, audienceTurn))]
      }
    }
    // 染色层（whale-card P0-4）：这次翻账时心里有颜色、且到了再染的时机，才在条目后带一句
    let recolors = new Map()
    if (list.length) {
      try {
        recolors = recolorRecall(list, emo.emotionStateRaw(t), t, dir)
      } catch {
        /* 折不出情绪就不染 */
      }
    }
    let clipped = 0
    const origins = {} // 缘起链的机读投影（定案 B）：id → 最近一次现行的 {lastSproutAt, lastQuery, with}
    const items = list.map((n) => {
      const text = String(n.text ?? '')
      const recolor = recolors.get(n.id)
      const recolorSuffix = recolor ? `\n（现在想起它：${recolor}）` : ''
      // 违熏提醒：只挂 recall 返回的条上 —— 注入是系统自动挂的，不是主动记忆，
      // 提醒了未必接得住；recall 是主动翻找，此刻提醒才有校正意义。
      // 30 天窗：超了就不再提醒 —— 久了就变成唠叨，不是校正（账还在 vikarma.jsonl 里）
      const vk = book.vikarmaAt.get(n.id)
      const vkSuffix =
        vk && t - vk.at < 30 * 24 * 60 * 60 * 1000
          ? `\n（上次现行时没兑现：${vk.reason}，${relTime(vk.at, t)}）`
          : ''
      // 缘起链投影（定案 B）：最近一次现行的缘（query）与同现种子——
      // 人读尾巴在 vikarma 之后；机读 origins 跟着 output 走。echo 行本就带 query/refs，零回填。
      const le = c.recallOrigin === false ? null : book.latestEchoRow.get(n.id)
      let originSuffix = ''
      if (le) {
        origins[n.id] = {
          lastSproutAt: new Date(le.at).toISOString(),
          lastQuery: le.query ?? '',
          with: Array.isArray(le.with) ? le.with : [],
        }
        const withNames = (Array.isArray(le.with) ? le.with : [])
          .map((id) => {
            const w = findNode(id)
            return w ? `「${cutByCodePoints(w.text, 12)}」` : null
          })
          .filter(Boolean)
          .slice(0, 3)
        originSuffix = `\n（${relTime(le.at, t)}前因「${String(le.query || '（无缘）').slice(0, 24)}」想起${
          withNames.length ? `，当时与 ${withNames.join('、')} 一起浮上来` : ''
        }）`
      }
      const suffix = recolorSuffix + vkSuffix + originSuffix
      if (itemMax && Array.from(text).length > itemMax) {
        clipped += 1
        // 判断和切都按码点 —— UTF-16 的 length/slice 会把 emoji 当两个字，劈出半个代理对
        const remaining = Math.max(0, Array.from(text).length - itemMax)
        const cut = { ...n, text: `${cutByCodePoints(text, itemMax)}…（原文还有 ${remaining} 字，要全文说 full=true）` }
        return `${n.id} ${renderLine(cut, t, { byId: dir })}${suffix}`
      }
      return `${n.id} ${renderLine(n, t, { byId: dir })}${suffix}`
    })
    // 翻身位（批 B1）：从没被现行过的老账，每次检索给一次被想起的机会
    // —— 被埋是排程问题不是价值问题；真相关会被再想起，不相关的 14 天 τ 内自然衰减回零，自平衡。
    let resurrectPick = null
    if (args?.query && !kind) { // 带 kind 的检索不占翻身位（批 C3）：池子不分 kind，混进 kind 检索违反工具契约
      const pick = pickResurrect(book.nodes, book.echoAt, t, { audienceTurn, audienceActive, byId: dir })
      if (pick && !list.some((x) => x.id === pick.id)) {
        list.unshift(pick) // 保位进 echo 名单（批 C2）：noteEcho slice(0,5) 只认前五，push 在尾会被切
        resurrectPick = pick
        // 每条字数闸照走（批 C6-N9）：翻身位不豁免 recallItemMax
        const pt = String(pick.text ?? '')
        const pLen = Array.from(pt).length
        const pShown = itemMax && pLen > itemMax
        const pCut = pShown
          ? { ...pick, text: `${cutByCodePoints(pt, itemMax)}…（原文还有 ${pLen - itemMax} 字，要全文说 full=true）` }
          : pick
        if (pShown) clipped += 1
        items.push(`${pick.id} ${renderLine(pCut, t, { byId: dir })}（翻身位：这条从来没被翻出来过）`)
      }
    }
    // 唤醒回弹：按词翻到的都记一笔「被想起」（原话层只增不改；节点本身不动）。
    let echoed = false
    if (args?.query && list.length) echoed = noteEcho(book, list, args.query, t, dir)
    // 执受（定案 C）：带情绪的现行通知身体 —— 反射弧，不是思量。写完 echo 就发。
    if (list.length) {
      try {
        sproutToBody(book, list, emo.emotionStateRaw(t), t, cfg())
      } catch {
        /* 执受写不进去不影响 recall 本身 */
      }
    }
    // 快层也翻得到：它不是节点（没有分量、不跟账本里的条抢位置），但秒级发生的事不该只闪一下
    if (args?.query && !kind) {
      const fastHits = searchFastEvents(fastAllEvents(t), args.query, { limit })
      for (const ev of fastHits) items.push(`${ev.id} ${renderFastLine(ev, t)}`)
    }
    // 意图层同理：机器认出来的那几句话也翻得到（它没有分量，翻到的是「发生过这句」）
    // args.group：点名只要某个场 —— 群号，或 'private' 只翻私聊（v0.15.0 分册）。
    // hard 档在群/私聊轮也盖意图层 —— 事件行自带场，零回填（soft 档不筛：本来就在尾上）。
    if (args?.query && !kind) {
      // 群流定死（批 B3）：recall 的意图段硬关群事件——过了就弃，翻旧账的门关上。
      // 群流 = 知悉（会话内看完就散）；要记住 → 显式 remember 掂量。args.group 点名群号 → 空。
      const intentPoolNoGroup = intentAllEvents(t).filter((ev) => ev?.chatType !== 'group')
      const intentPool =
        audienceActive && audienceMode === 'hard'
          ? intentPoolNoGroup.filter((ev) => audienceVisible(intentEventAudience(ev), audienceTurn))
          : intentPoolNoGroup
      const intentHits = searchIntentEvents(intentPool, args.query, { limit, group: args?.group })
      for (const ev of intentHits) items.push(`${ev.id} ${renderIntentLine(ev, t)}`)
    }
    // 总量闸：超了从尾巴省（最不相关的先走），省了多少写在 note 里 —— 不装没发生。
    let dropped = 0
    const totalChars = () => items.reduce((a, s) => a + s.length, 0)
    while (items.length > 1 && totalChars() > budget) {
      items.pop()
      dropped += 1
    }
    const noteParts = []
    if (clipped) noteParts.push(`${clipped} 条原文截短了（要全文说 full=true）`)
    if (dropped) noteParts.push(`还有 ${dropped} 条没给出来（问具体点我单翻）`)
    if (audienceActive) {
      noteParts.push(
        `这一轮是${audienceTurn === 'private' ? '私聊' : audienceTurn.replace('group:', '群 ')}在听，别的场${
          audienceMode === 'hard' ? '没翻' : '排到了后面'
        }`,
      )
    }
    const note = noteParts.join('；')
    // 账本被翻也是一件真事 —— 情绪流听这个。
    // 同一分钟里翻同一条只算一次；隔了半小时再翻，算新的（人被提醒一次和被提醒十次不一样）。
    if (list.length) {
      const bucket = Math.floor(t / (30 * 60_000))
      for (const n of list.slice(0, 5)) {
        emo.noteEmotion({
          source: 'recall',
          ref: n.id,
          at: t,
          text: String(n.text ?? '').slice(0, 120),
          dedupeKey: `recall|${n.id}|${bucket}`,
        })
      }
    }
    return { ok: true, items, echoed, note, origins, ...(resurrectPick ? { resurrect: resurrectPick.id } : {}) }
  }

  return { recall, recolorRecall }
}

