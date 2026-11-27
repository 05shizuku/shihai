/**
 * commands/status.mjs —— status 与七段命令层（批 A 收官步，G-2 施工稿）。
 *
 * buildStatus（设置页数据全量）+ 八个段渲染器（主池/我/还没定的/习惯/好奇/情绪/思量/瀑流）
 * + hardAudNodes（段级受众闸，批 D13b）。
 *
 * 红线与注入面：
 *   · 回执逐字不变；ctx = { cwd }（主段激活度的契合路；null = status 预览口径）；
 *   · **唤醒编排不进命令层**（施工稿红线）：buildStatus 的 wake 块由 env.wakeSnapshot() 注入；
 *   · **宿主身份与设置页面板不进命令层**：plugin 身份（name/version/dataDir）、editable
 *     名单、workspaces 由 identity/editable/env.listWorkspaces 注入；
 *   · 热路径资产同车：echoStats 5 秒缓存（book）、瀑流日缓存（book.streamCache）——
 *     搬函数不换家（ADR-0006）；
 *   · 拉取族/激活Ctx/情绪域由 pulls/ledger/emo 注入（单实现）；
 *   · import 白名单：core/* + 注入参数。
 */

import {
  ACTIVATION_AXES,
  ECHO_WINDOW_MS,
  RECENCY_TAU_BASE_MIN,
  RECENCY_TAU_SPAN_MIN,
  REPEAT_FULL,
  activationOf,
  repeatCounts,
} from '../../core/activation.js'
import {
  SELF_SLOTS,
  activeSelfNodes,
  audienceVisible,
  clipSection,
  curiosityStats,
  cutByCodePoints,
  fastHabits,
  habitState,
  hasThought,
  indexNodes,
  isSealed,
  normKind,
  rankNodes,
  relSealLeft,
  relTime,
  renderCuriositySection,
  renderHabitSection,
  renderLine,
  renderSelfSection,
  renderUnsettledSection,
  renderYesterdayStream,
  score,
  selfWeight,
  slotLabel,
  renderSection,
  summaryOf,
  unsettledNodes,
} from '../../core/memory.js'
import { fastRelTime, fastSummary, renderFastLine } from '../../core/fast.js'
import { INTENT_LABEL, intentRelTime, renderIntentLine, summarizeIntents } from '../../core/intent.js'
import { EMOTION_LABEL, emotionRelTime, renderEmotionNote } from '../../core/emotion.js'
import { countLines, tailLines } from '../../core/protocol/io.js'
import { noteDisplay } from '../../core/protocol/book.js'

/** 与 index.js:328 同一版 clamp（就地拷贝保等价） */
function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

export function createStatusCommands({ book, log, cfg, now = () => Date.now(), pulls, ledger, emo, identity, editable, env }) {
  if (!pulls || typeof pulls.pullFast !== 'function') {
    throw new Error('createStatusCommands：pulls 必填注入')
  }
  if (!ledger || typeof ledger.activationScorer !== 'function') {
    throw new Error('createStatusCommands：ledger 必填注入（activationCtx 全家单实现）')
  }
  if (!emo || typeof emo.emotionStateRaw !== 'function') {
    throw new Error('createStatusCommands：emo 必填注入（情绪域单实现）')
  }
  if (!env || typeof env.wakeSnapshot !== 'function' || typeof env.listWorkspaces !== 'function') {
    throw new Error('createStatusCommands：env 必填注入（{ wakeSnapshot, listWorkspaces }——唤醒编排与宿主面板留在壳）')
  }
  const { pullFast, pullIntent, pullEmotion, fastAllEvents, intentAllEvents, fastSourcePath, intentSourcePaths, weighedEmotionIds } = pulls
  const { activationScorer, currentAudience, echoStats, echoCounts, intentEventAudience } = ledger

  /** hard 档的段级受众闸（批 D13b）：各分段与主池同一条判定——群/私聊轮不挂别的场的条。
   *  soft 档不动分段（开头本来就几条，降存在感没有排位可让，与主段同口径）。 */
  function hardAudNodes(nodes, t = now()) {
    const turnAud = currentAudience(t)
    if (cfg().recallAudience !== 'hard' || turnAud === 'solo') return nodes
    return nodes.filter((n) => audienceVisible(n.audience, turnAud))
  }

  /* ---------------- 主池段（含展示观测——唯一写侧：noteDisplay 只记展示不喂排名） ---------------- */

  function currentSection(t = now(), cwd = null) {
    const c = cfg()
    if (!c.enabled) return ''
    try {
      const picked = []
      // 受众过滤（hard 档）：群轮/私聊轮的开头不挂别的场的条（solo 轮全可见 = 现状；
      // soft 档不动开头 —— 开头本来就只有几条，降存在感没有排位可让）
      const turnAud = currentAudience(t)
      const poolNodes =
        c.recallAudience === 'hard' && turnAud !== 'solo'
          ? book.nodes.filter((n) => audienceVisible(n.audience, turnAud))
          : book.nodes
      const text = renderSection(poolNodes, {
        now: t,
        limit: clamp(c.injectLimit, 0, 10),
        openLimit: clamp(c.openLimit, 0, 10),
        maxChars: clamp(c.maxChars, 120, 4000),
        title: '我记得的',
        // 上了快通路的习惯不跟这些条抢位置（两段用同一个上限，才对得上）
        habitLimit: clamp(c.habitLimit, 0, 10),
        // 排名用激活度（此刻的目录、刚发生的事都算数）—— 读取路径上不写账本
        //（唯一的例外是下面的展示观测行，它不喂排名）
        scoreOf: activationScorer({ cwd: cwd ?? '' }, t),
        // 展示观测：挂了谁记一笔（不算现行，不进复现轴 —— 判据见 docs/philosophy.md）
        onPick: (n) => picked.push(n),
      })
      // 只记「真的挂给会话」的那次 —— status 轮询（cwd=null）是预览，
      // 记它会污染观测（null 的打分上下文和真实注入不是一回事，集合也随激活度漂移）
      if (picked.length && cwd) noteDisplay(book, picked, t)
      book.meta.lastRenderAt = t
      book.meta.renderCount += 1
      book.meta.lastRenderError = null
      return text
    } catch (err) {
      book.meta.lastRenderError = String(err?.message ?? err).slice(0, 200)
      log(`渲染失败：${book.meta.lastRenderError}`)
      return ''
    }
  }

  /* ---------------- 分段六件 ---------------- */

  function currentSelfSection(t = now()) {
    const c = cfg()
    if (!c.enabled || c.selfEnabled === false) return ''
    try {
      return renderSelfSection(hardAudNodes(book.nodes, t), {
        now: t,
        maxChars: clamp(c.selfMaxChars, 80, 2000),
        title: '我',
      })
    } catch (err) {
      log(`自我层渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /** 「还没定的」那一段：doubt（还没认下的我）+ open（没结的事）合成一个摊位，固定晒一条（饭桶②）。 */
  function currentUnsettledSection(t = now()) {
    const c = cfg()
    if (!c.enabled || c.unsettledEnabled === false) return ''
    try {
      return renderUnsettledSection(hardAudNodes(book.nodes, t), {
        now: t,
        maxChars: clamp(c.unsettledMaxChars, 80, 2000),
        title: '还没定的',
      })
    } catch (err) {
      log(`「还没定的」段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /** 快通路那一段：这里的条不参加竞争 —— 习惯该像身体反应一样，到点就送到开头。 */
  function currentHabitSection(t = now()) {
    const c = cfg()
    if (!c.enabled || c.habitEnabled === false) return ''
    try {
      return renderHabitSection(hardAudNodes(book.nodes, t), {
        now: t,
        limit: clamp(c.habitLimit, 0, 10),
        maxChars: clamp(c.habitMaxChars, 80, 2000),
        title: '习惯',
      })
    } catch (err) {
      log(`习惯段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /** 好奇表那一段：好奇条不参加竞争 —— 我想知道什么，该由惦记的次数和分量决定。 */
  function currentCuriositySection(t = now()) {
    const c = cfg()
    if (!c.enabled || c.curiosityEnabled === false) return ''
    try {
      return renderCuriositySection(hardAudNodes(book.nodes, t), {
        now: t,
        limit: clamp(c.curiosityLimit, 0, 10),
        maxChars: clamp(c.curiosityMaxChars, 80, 2000),
        title: '好奇',
      })
    } catch (err) {
      log(`好奇段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /** 情绪笔记段。默认不挂：写的是「上次的我的笔记」——不替我说话，更不该每次都在开头。 */
  function currentEmotionSection(t = now()) {
    const c = cfg()
    if (!c.enabled || c.emotionEnabled === false || c.emotionSectionEnabled === false) return ''
    try {
      const state = emo.emotionStateRaw(t)
      const note = renderEmotionNote(state, { maxChars: clamp(c.emotionMaxChars, 80, 2000) })
      if (!note) return ''
      return `${note}\n（这是上次的笔记，不是现在必须摆出的样子 —— 说出口的心情仍然是我当轮的判断。）`
    } catch (err) {
      log(`情绪段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /** 思量段（定案 A）：链头最新一条的摘要 + 引种子数；due 时提示一句。
   *  思量由 AI 显式 narrate，系统只给时机——段里出现的一切都来自她自己的落笔。 */
  function currentNarrationSection(t = now()) {
    const c = cfg()
    if (!c.enabled || c.narrationEnabled === false) return ''
    try {
      const all = hardAudNodes(book.nodes, t).filter((n) => n && normKind(n.kind) === 'narration')
      if (!all.length) return ''
      const newest = all.reduce((a, b) => ((Number(b.at) || 0) > (Number(a.at) || 0) ? b : a))
      // 链头要答过四问才挂（hasThought 闸门原样适用）；没答的翻得到、不挂段
      const head = all
        .filter((n) => hasThought(n))
        .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0] ?? null
      const intervalMs = clamp(c.narrationIntervalDays, 1, 30) * 24 * 60 * 60 * 1000
      const todayKey = new Date(t).toISOString().slice(0, 10)
      const writtenToday = all.some((n) => new Date(Number(n.at)).toISOString().slice(0, 10) === todayKey)
      const isDue = t - Number(newest.at) > intervalMs && !writtenToday
      if (!head) return isDue ? '【思量】\n（有一阵没这么看过自己了）' : ''
      const refsCount = Array.isArray(head.refs) ? head.refs.length : 0
      const text = Array.from(head.text).length > 120 ? `${cutByCodePoints(head.text, 120)}…` : head.text
      const lines = [`· ${text}（引 ${refsCount} 条种子）`]
      if (isDue) lines.push('（有一阵没这么看过自己了）')
      return clipSection('【思量】', lines.join('\n'), clamp(c.narrationSectionMaxChars, 80, 2000))
    } catch (err) {
      log(`思量段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /** 瀑流段（定案 B）：昨日之流是读侧聚合——同 UTC 日内缓存流文本（缓存挂 book.streamCache）。
   *  hub 每 5 秒拉一次 status，重算就是灯案第二。段空就是没得说，不硬凑叙述。 */
  function currentStreamSection(t = now()) {
    const c = cfg()
    if (!c.enabled || c.streamEnabled === false) return ''
    try {
      const day = new Date(t).toISOString().slice(0, 10)
      if (book.streamCache.day === day) return book.streamCache.text
      const dayMs = 24 * 60 * 60 * 1000
      const we = Math.floor(t / dayMs) * dayMs // 今日 UTC 起点 = 昨日窗口终点
      const yesterdayKey = new Date(we - 1).toISOString().slice(0, 10)
      const vikarmaYesterday = Number(book.vikarmaAgg.byDay[yesterdayKey] ?? 0)
      const text = renderYesterdayStream({
        nodes: book.nodes,
        echoTimes: book.echoAt,
        vikarmaNewCount: vikarmaYesterday,
        now: t,
        maxChars: clamp(c.streamSectionMaxChars, 80, 2000),
      })
      book.streamCache = { day, text }
      return text
    } catch (err) {
      log(`瀑流段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /* ---------------- buildStatus（设置页数据全量；身份/wake/workspaces 由注入面给） ---------------- */

  function buildStatus() {
    const c = cfg()
    const t = now()
    // 设置页每几秒拉一次 status —— 顺手把快层的新事件抄进来，页面上的「快层」才是活的
    try {
      pullFast(t)
    } catch {
      /* 抄不动不该让 status 挂掉 */
    }
    try {
      pullIntent(t)
    } catch {
      /* 同上 */
    }
    try {
      pullEmotion(t)
    } catch {
      /* 同上 */
    }
    // 熏习势力统计：算一次，echoes 与 display 两块共用 —— scanMs 是代价观测点
    const echoStatsT0 = performance.now()
    const eStats = echoStats(t)
    const echoScanMs = Math.round((performance.now() - echoStatsT0) * 100) / 100
    // status 这层拿不到具体的会话（cwd=null），契合这一路按「没有当前目录」算；
    // 排名仍用激活度 —— 跟真机会话里看到的顺序一致（差的那点只是 fit 的目录分量）。
    const scoreOf = activationScorer({ cwd: '' }, t)
    const s = summaryOf(book.nodes, t, { scoreOf })
    const top = rankNodes(book.nodes, t, { limit: 8, scoreOf }).map((h) => {
      const { activation, axes } = activationOf(h.node, t, {
        repeatCounts: repeatCounts(book.nodes),
        echoes: echoCounts(t),
      })
      return {
        id: h.node.id,
        kind: h.node.kind,
        weight: Number(h.node.weight.toFixed(2)),
        // 分值 = 老 score（只看分量和时间）；激活 = 四路凸组合（还看契合和复现）
        score: Number(score(h.node, t).toFixed(3)),
        activation: Number(activation.toFixed(3)),
        axes: {
          weight: Number(axes.weight.toFixed(3)),
          recency: Number(axes.recency.toFixed(3)),
          fit: Number(axes.fit.toFixed(3)),
          repeat: Number(axes.repeat.toFixed(3)),
        },
        at: new Date(h.node.at).toISOString(),
        when: relTime(h.node.at, t),
        text: h.node.text.slice(0, 200),
        thought: hasThought(h.node),
      }
    })
    // 按住的列出来三种都算：手动按的、按到点的（带还剩多久）、等条件的（带在等谁）
    const dirNow = indexNodes(book.nodes)
    const sealed = book.nodes
      .filter((n) => isSealed(n, t, dirNow))
      .slice(-8)
      .map((n) => ({
        id: n.id,
        text: n.text.slice(0, 120),
        seal: n.sealed ? 'plain' : n.sealCond ? 'cond' : 'until',
        left: n.sealUntil ? relSealLeft(n.sealUntil, t) : '',
        cond: n.sealCond || '',
      }))
    return {
      ok: true,
      now: new Date(t).toISOString(),
      plugin: { name: identity.name, version: identity.version, startedAt: new Date(book.meta.startedAt).toISOString(), uptimeMs: t - book.meta.startedAt, dataDir: identity.dataDir },
      // 账本健康：损坏红灯别只写在日志里，面板要看得见。
      ledger: { broken: book.broken, backupOk: book.backupOk },
      injection: {
        enabled: c.enabled,
        targetRoot: c.targetRoot,
        allowRoots: c.allowRoots,
        denyRoots: Array.isArray(c.denyRoots) ? c.denyRoots : [],
        count: book.meta.renderCount,
        lastAt: book.meta.lastRenderAt ? new Date(book.meta.lastRenderAt).toISOString() : null,
        lastError: book.meta.lastRenderError,
        section: currentSection(t),
        selfEnabled: c.selfEnabled !== false,
        selfSection: currentSelfSection(t),
        unsettledEnabled: c.unsettledEnabled !== false,
        unsettledSection: currentUnsettledSection(t),
        curiosityEnabled: c.curiosityEnabled !== false,
        curiositySection: currentCuriositySection(t),
        habitEnabled: c.habitEnabled !== false,
        habitSection: currentHabitSection(t),
      },
      self: {
        slots: activeSelfNodes(book.nodes, t).map((n) => ({
          id: n.id,
          slot: n.slot,
          label: slotLabel(n.slot),
          text: n.text.slice(0, 300),
          weight: Number(selfWeight(n, t).toFixed(3)),
          anchor: Boolean(n.anchor),
        })),
        seeds: SELF_SLOTS.map((s) => ({ key: s.key, label: s.label })),
        unsettled: unsettledNodes(book.nodes, t).length,
      },
      habits: {
        fast: fastHabits(book.nodes, t, { limit: clamp(c.habitLimit, 0, 10) }).map((n) => ({
          id: n.id,
          context: n.context,
          hits: n.hits,
          state: habitState(n),
          text: n.text.slice(0, 200),
        })),
        candidates: book.nodes
          .filter(
            (n) =>
              normKind(n.kind) === 'habit' &&
              !isSealed(n, t, dirNow) &&
              !n.superseded &&
              habitState(n) !== 'fast',
          )
          .map((n) => ({
            id: n.id,
            context: n.context,
            hits: n.hits,
            state: habitState(n),
            text: n.text.slice(0, 200),
          })),
        limit: clamp(c.habitLimit, 0, 10),
      },
      curiosity: curiosityStats(book.nodes, t, { limit: clamp(c.curiosityLimit, 0, 10) }),
      fast: (() => {
        const source = fastSourcePath(c)
        const events = fastAllEvents(t)
        const weighed = ledger.weighedFastIds()
        const sum = fastSummary(events, { weighed })
        return {
          enabled: c.enabled && c.fastEnabled !== false,
          source,
          copied: countLines(book.files.fast),
          ...sum,
          recent: book.fastIndex.slice(0, 5).map((ev) => ({
            id: ev.id,
            kind: ev.kind,
            text: String(ev.text ?? '').slice(0, 160),
            at: new Date(ev.at).toISOString(),
            when: fastRelTime(ev.at, t),
            weighed: weighed.has(ev.id),
          })),
        }
      })(),
      intent: (() => {
        const sources = intentSourcePaths(c)
        const events = intentAllEvents(t)
        const sum = summarizeIntents(events)
        // 按场分组计数（v0.15.0 分册）：群按群号，私聊归 'private'
        const byGroup = {}
        for (const ev of events) {
          const g = ev.chatType === 'private' ? 'private' : String(ev.groupId ?? '') || 'unknown'
          byGroup[g] = (byGroup[g] || 0) + 1
        }
        return {
          enabled: c.enabled && c.intentEnabled !== false,
          sources,
          source: sources[0] ?? '',
          byGroup,
          copied: countLines(book.files.intent),
          ...sum,
          recent: book.intentIndex.slice(0, 5).map((ev) => ({
            id: ev.id,
            kind: ev.kind,
            label: INTENT_LABEL[ev.kind] ?? ev.kind,
            intensity: ev.intensity,
            text: String(ev.text ?? '').slice(0, 160),
            at: new Date(ev.at).toISOString(),
            when: intentRelTime(ev.at, t),
          })),
        }
      })(),
      emotion: (() => {
        // 情绪流的状态：机器从真事里认出来的那些情绪，折到此刻的样子。
        // 这只是笔记 —— 不接管嘴（说出口的心情还是我当轮的判断）。
        const state = emo.emotionStateRaw(t)
        const events = state.lines.filter((l) => l.kind === 'event')
        const tunes = state.lines.filter((l) => l.kind === 'tune')
        const weighed = pulls.weighedEmotionIds()
        return {
          enabled: c.enabled && c.emotionEnabled !== false,
          dominant: state.dominant,
          label: state.label,
          level: state.level,
          levels: state.levels,
          unresolved: Boolean(state.unresolved),
          mixed: Array.isArray(state.mixed) ? state.mixed : [],
          total: state.total,
          lastAt: state.lastAt ? new Date(state.lastAt).toISOString() : null,
          /** 系数表：种子 + 账上改过的（tune 行只增不改） */
          coefficients: Object.fromEntries(
            Object.entries(state.coefficients ?? {}).map(([k, v]) => [
              k,
              { coefficient: v.coefficient, halfLife: v.halfLife },
            ]),
          ),
          events: events.length,
          tunes: tunes.length,
          note: renderEmotionNote(state, { maxChars: clamp(c.emotionMaxChars, 80, 2000) }),
          recent: [...events]
            .sort((a, b) => b.at - a.at)
            .slice(0, 5)
            .map((ev) => ({
              id: ev.id,
              emotion: ev.emotion,
              label: EMOTION_LABEL[ev.emotion] ?? ev.emotion,
              delta: ev.delta,
              intensity: ev.intensity,
              source: ev.source,
              ref: ev.ref,
              text: String(ev.text ?? '').slice(0, 160),
              at: new Date(ev.at).toISOString(),
              when: emotionRelTime(ev.at, t),
              weighed: weighed.has(ev.id),
            })),
        }
      })(),
      summary: s,
      nodes: top,
      activation: {
        /** 四路的权重，和为 1。写死在代码里，不开面板口子。 */
        axes: { ...ACTIVATION_AXES },
        /** 两把钟：分量淡按天（老 score 那层），新近按分钟到小时（中层的刻度），自我按月。 */
        recencyTau: { baseMin: RECENCY_TAU_BASE_MIN, spanMin: RECENCY_TAU_SPAN_MIN, full: REPEAT_FULL },
        /** 唤醒回弹：被想起的回声只数最近几天的。 */
        echoWindowDays: Math.round(ECHO_WINDOW_MS / 86400000),
      },
      echoes: (() => {
        // count = 次数（给人看），strength = 熏习势力（真信号）—— 按 strength 排。
        let total = 0
        for (const st of eStats.values()) total += st.count
        const topE = [...eStats.entries()]
          .sort((a, b) => b[1].strength - a[1].strength)
          .slice(0, 5)
          .map(([id, st]) => ({ id, count: st.count, strength: Number(st.strength.toFixed(2)) }))
        return { windowDays: Math.round(ECHO_WINDOW_MS / 86400000), total, top: topE, scanMs: echoScanMs }
      })(),
      // 展示观测（不算现行，只记账）：谁常挂但从不被想起 —— 死重或 recall 词表覆盖不到的候选。
      // cold = 展示 ≥3 天但熏习势力为 0 的条。只观测，不改排名；跑两周看分布。
      display: (() => {
        const rows = []
        let total = 0
        for (const [id, days] of book.displayDays) {
          total += days.size
          rows.push({ id, days: days.size })
        }
        rows.sort((a, b) => b.days - a.days)
        const cold = rows.filter((r) => r.days >= 3 && !eStats.has(r.id)).slice(0, 5)
        return { total, top: rows.slice(0, 5), cold }
      })(),
      // 违熏（校正质量的账，不进复现轴）—— 从内存索引聚合（vikarma.jsonl 只增不减）
      vikarma: (() => {
        const topV = [...book.vikarmaAt.entries()]
          .map(([seedId, v]) => ({ seedId, count: v.count, lastAt: v.at }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
        return { total: book.vikarmaAgg.total, byReason: { ...book.vikarmaAgg.byReason }, top: topV }
      })(),
      // 受众（借自晴猫）：三档开关 + 打了标的新条数（旧条是 any，不计数）
      audience: {
        mode: String(c.recallAudience ?? 'off'),
        stamped: book.nodes.filter((n) => n.audience && n.audience !== 'any').length,
      },
      // 思量（定案 A）：全内存算（hub 每 5 秒拉一次 status，别读文件——灯案教训）
      narration: (() => {
        const all = hardAudNodes(book.nodes, t).filter((n) => n && normKind(n.kind) === 'narration')
        const newest = all.reduce((a, b) => {
          const aa = Number(a?.at) || 0
          const bb = Number(b?.at) || 0
          return bb > aa ? b : a
        }, null)
        const intervalMs = clamp(c.narrationIntervalDays, 1, 30) * 24 * 60 * 60 * 1000
        const todayKey = new Date(t).toISOString().slice(0, 10)
        const writtenToday = all.some((n) => new Date(Number(n.at)).toISOString().slice(0, 10) === todayKey)
        return {
          count: all.length,
          lastAt: newest ? new Date(newest.at).toISOString() : null,
          due: all.length === 0 || (t - Number(newest.at) > intervalMs && !writtenToday),
          latest: newest
            ? { id: newest.id, at: new Date(newest.at).toISOString(), refsCount: Array.isArray(newest.refs) ? newest.refs.length : 0 }
            : null,
        }
      })(),
      // 转识成智（定案 D）：全内存算（灯案纪律）
      wisdom: (() => {
        const all = book.nodes.filter((n) => n && normKind(n.kind) === 'wisdom')
        const newest = all.reduce((a, b) => {
          const aa = Number(a?.at) || 0
          const bb = Number(b?.at) || 0
          return bb > aa ? b : a
        }, null)
        return {
          count: all.length,
          latest: newest
            ? { id: newest.id, at: new Date(newest.at).toISOString(), seedId: (newest.refs ?? [])[0] ?? '' }
            : null,
        }
      })(),
      // 唤醒（宿主编排面）：快照由壳注入（唤醒编排不进命令层——施工稿红线）
      wake: env.wakeSnapshot(),
      // 执受（定案 E，v0.24.0）：观测耳目——book.sproutAgg 内存求和，零文件读
      sprout: { today: book.sproutAgg.today, total: book.sproutAgg.total },
      sealed,
      workspaces: env.listWorkspaces(),
      // 计数走 countLines（只数行不 parse）—— status 每几秒被拉一次，别为它整本解析
      rawLines: countLines(book.files.lines),
      rawEchoes: countLines(book.files.echo),
      // 统一时间锚的原始数据：上次写账本 / 上次有情绪（emotion.lastAt）/ 上次被叫醒（wake.lastWakeAt）
      lastLineAt: (() => {
        try {
          const last = tailLines(book.files.lines, 1)[0]
          const at = Number(JSON.parse(last ?? '')?.at)
          return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null
        } catch {
          return null
        }
      })(),
      config: { effective: c, editable },
      paths: book.files,
      logs: tailLines(book.files.log, 8),
    }
  }

  return {
    buildStatus,
    // 七段 + 主池段（注入注册区与 /sections 共用；批 C 的段挂载钉与此同源）
    currentSection,
    currentSelfSection,
    currentUnsettledSection,
    currentHabitSection,
    currentCuriositySection,
    currentEmotionSection,
    currentNarrationSection,
    currentStreamSection,
    hardAudNodes,
  }
}
