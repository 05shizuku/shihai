/**
 * commands/ledger.mjs —— 账本视图命令层（批 A 第二步，G-2 施工稿）。
 *
 * 从 index.js 的 apply 闭包里搬出来的第二批：memory_list 的**决策本体**，外加它依赖的
 * activationCtx 全家（契合路的 cwd/roots/events/exists + 复现路的熏习统计 + 主题复现计数）。
 * recall 那座山与这一套共用——先搬一次，山削一半。
 *
 * 红线（施工稿 §批A + 验收注脚）：
 *   · 回执逐字不变 —— schema/render/output 留在 index.js 壳里；
 *   · ctx 只认 { cwd, sessionId }；agent/scope 概念不进命令层；
 *   · **热路径资产同车**（验收注脚 2026-11-27）：echoStats 的 5 秒缓存挂在 book.echoStatsCache
 *     （ADR-0006）——搬的是函数，缓存不换家，命令层与闭包读同一份缓存；
 *   · 拉取族不二次实现：pulls 由 createEmotionCommands 的实例注入（单实现纪律）；
 *   · import 白名单：core/* + 注入参数，lib/* 不进。
 */

import { isAbsolute, join } from 'node:path'

import {
  ECHO_TAU_MS,
  ECHO_WINDOW_MS,
  activationOf,
  repeatCounts,
} from '../../core/activation.js'
import {
  KINDS,
  KIND_LABEL,
  activeCuriosities,
  activeSelfNodes,
  audienceVisible,
  fastHabits,
  normKind,
  rankNodes,
  relTime,
  renderLine,
  slotLabel,
  summaryOf,
} from '../../core/memory.js'
import { deriveStandingBodyStates, fastSummary, renderFastLine } from '../../core/fast.js'
import { renderIntentLine, summarizeIntents } from '../../core/intent.js'
import {
  exists,
  readJsonLines,
} from '../../core/protocol/io.js'

/** 与 index.js:328 同一版 clamp（就地拷贝保等价，见 commands/emotion.mjs 注） */
function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

export function createLedgerCommands({ book, log, cfg, now = () => Date.now(), pulls }) {
  if (!pulls || typeof pulls.pullFast !== 'function') {
    throw new Error('createLedgerCommands：pulls 必填注入（{ pullFast, pullIntent, fastAllEvents, intentAllEvents }，来自 createEmotionCommands 实例——拉取族单实现）')
  }
  const { pullFast, pullIntent, fastAllEvents, intentAllEvents } = pulls

  /* ---------------- 受众（借自晴猫，2026-11-17；判定本体在 core/memory.js） ---------------- */

  /** 多久之内的来话还算「这一轮的缘」 */
  const AUDIENCE_WINDOW_MS = 10 * 60 * 1000

  /** 这一轮谁在听：'solo'（只有她，全可见）/ 'private' / 'group:群号' */
  function currentAudience(t = now()) {
    try {
      // 索引按时间新的在前 —— 从头找第一条窗内的来话
      for (const ev of book.intentIndex) {
        if (t - Number(ev.at) > AUDIENCE_WINDOW_MS) break
        if (ev.chatType === 'private') return 'private'
        if (ev.chatType === 'group' && ev.atMe === true && ev.groupId) return `group:${ev.groupId}`
      }
    } catch {
      /* 算不出按 solo —— 跟现状一个样 */
    }
    return 'solo'
  }

  /** 意图事件的受众：事件行自带场（chatType/groupId），零回填 */
  const intentEventAudience = (ev) =>
    ev?.chatType === 'group' && ev.groupId ? `group:${ev.groupId}` : ev?.chatType === 'private' ? 'private' : 'any'

  /* ---------------- 掂量过没（refs 扫描，闭包同款） ---------------- */

  /** 已经被我掂量过的快层事件（账本里有条 refs 指着它） */
  function weighedFastIds() {
    const out = new Set()
    for (const n of book.nodes) {
      for (const r of n.refs ?? []) {
        const id = String(r ?? '').trim()
        if (id.startsWith('f_')) out.add(id)
      }
    }
    return out
  }

  function weighedIntentIds() {
    const out = new Set()
    for (const n of book.nodes) {
      for (const r of n.refs ?? []) {
        const id = String(r ?? '').trim()
        if (id.startsWith('i_')) out.add(id)
      }
    }
    return out
  }

  /* ---------------- 激活度要的「此刻」（activationCtx 全家，cwd 来自 ctx） ---------------- */

  /** 原话层最近写下的几行 —— 真的刚发生过的事，我自己写的那份。 */
  function recentLineEvents(maxLines = 12) {
    try {
      return readJsonLines(book.files.lines, maxLines)
        .filter((r) => r && typeof r.text === 'string' && r.text.trim())
        .map((r) => ({ id: r.id ?? '', text: r.text }))
    } catch {
      return []
    }
  }

  /** 契合这一路的事件池：身体那边的秒级事件 + 原话层最近写下的行。
   *  批 B2 刀 b：身体源（source 标注 dsh-body，含 mood 情绪源）最多取最新 3 条进契合路
   *  ——情绪对「翻出什么」的影响封顶。原话层自己的行不在此限。 */
  function realEvents(t = now(), max = 12) {
    let fast = []
    try {
      fast = fastAllEvents(t)
        .filter((ev) => String(ev?.source ?? 'dsh-body') === 'dsh-body')
        .slice(-3)
    } catch {
      fast = []
    }
    return [...fast, ...recentLineEvents(max)]
  }

  /** 「这个文件还在吗」只查够得着的地方：相对路径按当前目录拼，绝对路径原样；
   *  超出账本允许的范围一律答「不在」——不拿这个问题去探工作区外有什么。
   *  （ctx 两字符串的用武之地：cwd 从 ctx 来，roots 从 cfg 来，agent 概念不进命令层。） */
  function scopedExists(cwd, roots) {
    return (p) => {
      try {
        const raw = String(p ?? '').trim()
        if (!raw) return false
        const abs = isAbsolute(raw) ? raw : cwd ? join(cwd, raw) : ''
        if (!abs) return false
        const inScope = roots.some((r) => isUnder(abs, r)) || (cwd ? isUnder(abs, cwd) : false)
        if (!inScope) return false
        return exists(abs) === true
      } catch {
        return false
      }
    }
  }

  /** 谁能往这本账里写。allowRoots 是名单；名单空但设了 targetRoot 时按 targetRoot 收窄。 */
  function scopeRoots(c = cfg()) {
    if (c.allowRoots?.length) return c.allowRoots
    if (c.targetRoot) return [c.targetRoot]
    return []
  }

  /** 窗口内每条的回声统计（现行熏种子）：count = 被想起几次，strength = 熏习势力。
   *  **热路径资产同车（验收注脚）**：5 秒缓存挂在 book.echoStatsCache（ADR-0006）——
   *  命令层与闭包读同一份缓存，搬家不换家。 */
  function echoStats(t = now()) {
    if (t - book.echoStatsCache.at < 5000 && t >= book.echoStatsCache.at) return book.echoStatsCache.stats
    const stats = new Map()
    for (const [id, list] of book.echoAt) {
      let count = 0
      let strength = 0
      for (const at of list) {
        if (t - at >= ECHO_WINDOW_MS || at > t + 60_000) continue
        count += 1
        strength += Math.exp(-(t - at) / ECHO_TAU_MS)
      }
      if (count) stats.set(id, { count, strength })
    }
    book.echoStatsCache = { at: t, stats }
    return stats
  }

  /** 复现轴吃的形状：每条一个熏习势力数（activation.js 不关心次数）。 */
  function echoCounts(t = now()) {
    const out = new Map()
    for (const [id, s] of echoStats(t)) out.set(id, s.strength)
    return out
  }

  /** 激活度要的「此刻」：目录、范围、刚发生的事、文件在不在、每个主题几条、最近被想起几次。 */
  function activationCtx(ctx, t = now()) {
    // 身→识（定案 C）：身体现状折成契合路的事件词——进 topic 匹配，不进激活权重
    const standing = deriveStandingBodyStates(fastAllEvents(t), t)
    return {
      cwd: ctx?.cwd ?? '',
      roots: scopeRoots(),
      events: [...realEvents(t), ...standing],
      exists: scopedExists(ctx?.cwd ?? '', scopeRoots()),
      repeatCounts: repeatCounts(book.nodes),
      echoes: echoCounts(t),
    }
  }

  /** 给分函数：某条此刻的激活度。rankNodes／renderSection／searchNodes 都吃这一个。 */
  function activationScorer(ctx, t = now()) {
    const actx = activationCtx(ctx, t)
    return (node, at = t) => activationOf(node, at, actx).activation
  }

  /* ---------------- 命令本体：memory_list（回执 = index.js 原 execute 逐字搬） ---------------- */

  function memoryList(_args, ctx = {}) {
    const t = now()
    const c = cfg()
    // 受众过滤（批 A3，外部审查 P1-3）：各源集合在组装行之前套一层过滤——
    // 判定复用 recall 的同一条函数（currentAudience + audienceVisible，两边一致才不出大肥鱼式偏差）；
    // 只在 hard 档过滤；off / soft 全显——listing 是全景视图，soft 的降位语义不适用（拍板，不是遗漏）。
    // 意图事件的受众字段走 intentEventAudience（recall 同款）；快层事件行自带 body 场、没有受众字段，不过滤。
    const turnAud = currentAudience(t)
    const hardAud = c.recallAudience === 'hard' && turnAud !== 'solo'
    const nodeVisible = (n) => !hardAud || audienceVisible(n?.audience, turnAud)
    const eventVisible = (ev) => !hardAud || audienceVisible(intentEventAudience(ev), turnAud)
    // 最重的几条按激活度排（此刻的目录、刚发生的事都算数），行尾把激活值标出来
    const scoreOf = activationScorer({ cwd: ctx?.cwd ?? '' }, t)
    const s = summaryOf(book.nodes, t, { scoreOf })
    const top = rankNodes(
      book.nodes.filter((n) => nodeVisible(n) && normKind(n.kind) !== 'self' && normKind(n.kind) !== 'curiosity'),
      t,
      { limit: 5, scoreOf },
    ).map((h) => `${h.node.id} ${renderLine(h.node, t)} · 激活 ${scoreOf(h.node, t).toFixed(2)}`)
    const self = activeSelfNodes(book.nodes.filter(nodeVisible), t)
    const fast = fastHabits(book.nodes.filter(nodeVisible), t, { limit: clamp(c.habitLimit, 0, 10) })
    const curiosities = activeCuriosities(book.nodes.filter(nodeVisible), t, { limit: clamp(c.curiosityLimit, 0, 10) })
    // 快层：先接过来最新的那几条，别让它们只闪一下
    try {
      pullFast(t)
    } catch {
      /* 接不上就算了 */
    }
    // 意图层：机器刚认出来的那几句，也得能列出来
    try {
      pullIntent(t)
    } catch {
      /* 接不上就算了 */
    }
    const fastEvents = book.fastIndex.slice(0, 5)
    const fastSum = fastSummary(fastAllEvents(t), { weighed: weighedFastIds() })
    const intentEvents = book.intentIndex.filter(eventVisible).slice(0, 5)
    const intentAll = intentAllEvents(t)
    const intentSum = summarizeIntents(intentAll)
    const intentWeighed = weighedIntentIds()
    const intentPending = intentAll.filter((ev) => !intentWeighed.has(ev.id)).length
    const recent = book.nodes.filter(nodeVisible).slice(-3).map((n) => {
      const when = relTime(n.at, t)
      return `${n.id}（${when === '刚写下' ? '刚写下' : `${when}写的`}）${n.text.slice(0, 40)}`
    })
    const summary =
      `一共 ${s.total} 条（活着 ${s.alive}，按住 ${s.sealed}，想过三问的 ${s.thought}）；` +
      `最重的现在 ${s.topScore}（激活值，0 到 1）；` +
      KINDS.map((k) => `${KIND_LABEL[k]} ${s.kinds[k] ?? 0}`).join('、') +
      `；快层 ${fastSum.total} 条（还没掂量 ${fastSum.pending} 条）` +
      `；意图 ${intentSum.total} 条（还没掂量 ${intentPending} 条）`
    const selfLines = self.length
      ? ['现在我是：', ...self.map((n) => `· ${slotLabel(n.slot)}：${n.text}`)]
      : []
    // 我执演化史（定案 A）：自我槽位沿 prevSelf、思量沿 prev 走链——退下不是终点，是链条上的一环
    const chainLines = []
    const walkChain = (id, depth) => {
      const out = []
      let cur = String(id ?? '').trim()
      for (let i = 0; i < depth && cur; i += 1) {
        const n = book.nodes.find((x) => x && x.id === cur)
        if (!n) break
        out.push(n)
        cur = n.prevSelf || n.prev || ''
      }
      return out
    }
    for (const n of self) {
      const chain = walkChain(n.prevSelf, 4)
      if (chain.length) {
        chainLines.push(`· ${slotLabel(n.slot)}：现行「${n.text.slice(0, 24)}」← ${chain.map((c) => `「${c.text.slice(0, 20)}」`).join(' ← ')}`)
      }
    }
    const narrHead = book.nodes
      .filter((x) => x && normKind(x.kind) === 'narration')
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0]
    if (narrHead) {
      const chain = walkChain(narrHead.prev, 4)
      chainLines.push(
        `· 思量链：现行「${narrHead.text.slice(0, 24)}」` +
          (chain.length ? ` ← ${chain.map((c) => `「${c.text.slice(0, 20)}」`).join(' ← ')}` : '（链的第一环）'),
      )
    }
    const selfChainLines = chainLines.length ? ['我执演化史：', ...chainLines] : []
    const habitLines = fast.length
      ? [
          '走快通路的习惯：',
          ...fast.map((n) => `· ${n.context}：${n.text.slice(0, 80)}（第 ${n.hits} 次）`),
        ]
      : []
    const curiosityLines = curiosities.length
      ? [
          '现在好奇的：',
          ...curiosities.map(
            (n) => `· ${n.context}：${n.text.slice(0, 80)}${n.hits > 1 ? `（惦记 ${n.hits} 次）` : ''}`,
          ),
          `（上限 ${clamp(c.curiosityLimit, 0, 10)} 条，超出的沉在账本里，翻得到）`,
        ]
      : []
    const fastLines = fastEvents.length
      ? [
          '刚刚发生的（快层，没有分量，不跟上面的条抢位置）：',
          ...fastEvents.map((ev) => `${ev.id} ${renderFastLine(ev, t)}`),
          `（快层一共 ${fastSum.total} 条，还没掂量 ${fastSum.pending} 条 —— 掂量一次就是拿 remember 写一条，refs 指回它的 id）`,
        ]
      : []
    const intentLines = intentEvents.length
      ? [
          '刚刚认出来的（意图层，机器认的，没有分量，不跟上面的条抢位置）：',
          ...intentEvents.map((ev) => `${ev.id} ${renderIntentLine(ev, t)}`),
          `（意图层一共 ${intentSum.total} 条，还没掂量 ${intentPending} 条 —— 掂量一次就是拿 remember 写一条，refs 指回它的 id）`,
        ]
      : []
    return {
      ok: true,
      summary,
      items: [
        ...selfLines,
        ...selfChainLines,
        ...curiosityLines,
        ...habitLines,
        ...fastLines,
        ...intentLines,
        ...top,
        ...(recent.length ? ['最近写的：', ...recent] : []),
      ],
      note: '',
    }
  }

  return {
    // 命令
    memoryList,
    // 域助手（recall 山与 /sections 共用；activationCtx 全家在此单实现）
    currentAudience,
    intentEventAudience,
    weighedFastIds,
    weighedIntentIds,
    activationCtx,
    activationScorer,
    echoStats,
    echoCounts,
    scopeRoots,
    realEvents,
    recentLineEvents,
  }
}

