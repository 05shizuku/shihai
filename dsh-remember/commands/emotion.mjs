/**
 * commands/emotion.mjs —— 情绪域命令层（批 A 第一步，G-2 施工稿）。
 *
 * 从 index.js 的 apply 闭包里搬出来的第一组命令：emotion_state / emotion_tune / vikarma
 * 三条命令的**决策本体**，外加它们依赖的拉取族（pullFast/pullIntent/pullEmotion）与
 * 情绪流索引（emotionLines/emotionState/noteEmotion——批 D7 游标语义）。
 *
 * 红线（施工稿 §批A）：
 *   · 回执逐字不变 —— index.js 的 schema/render/output 一字不动，这里的返回值就是回执；
 *   · ctx 只认 { cwd, sessionId } 两个字符串 —— 命令层不认 DSH 概念（agent/scope/会话闸
 *     留在适配层：index.js 的 execute 壳 / 批 C 的 HTTP 壳各自做 scopeOk）；
 *   · wake 编排不进命令层；
 *   · cfg 是活的 getter（getCfg 注入），now 是可注入时钟（测试钉死时间用）。
 *
 * 等价性纪律：本文件每个函数体都是 index.js 闭包的逐字搬运，仅替换注入点
 * （getCfg→cfg()、Date.now()→now()、agentXxx(exec.agent)→ctx.xxx）。
 * index.js 里的同名闭包在后续批次逐域退役（现在还有 buildStatus/recall 等在用，不急）。
 */

import { readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  appendJsonLine,
  exists,
  readJsonLines,
  readJsonSafe,
} from '../../core/protocol/io.js'
import {
  EMOTION_KINDS,
  EMOTION_LABEL,
  emotionCoefficients,
  emotionDelta,
  emotionEventId,
  emotionTuneId,
  foldEmotion,
  normEmotionLine,
  recognizeEmotion,
  renderEmotionLine,
} from '../../core/emotion.js'
import { cleanText, cutByCodePoints } from '../../core/memory.js'
import { normFastEvent } from '../../core/fast.js'
import { normIntentEvent } from '../../core/intent.js'
import {
  pullFast,
  pullIntent,
  noteVikarma,
  refreshEmotion,
} from '../../core/protocol/book.js'

/** 与 index.js:328 同一版 clamp（core/memory.js 只有 clamp01/clampWeight，不同族——就地拷贝保等价） */
function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

export function createEmotionCommands({ book, log, cfg, now = () => Date.now(), resolveDshHome: resolveHome }) {
  if (typeof resolveHome !== 'function') throw new Error('createEmotionCommands：resolveDshHome 必填注入（家目录解析是宿主关切，core 归位前不默认）')

  /* ---------------- 情绪流常驻索引（批 D7 语义，闭包同款） ---------------- */

  function emotionLines() {
    try {
      refreshEmotion(book)
    } catch {
      /* 拉不动就用手上的旧索引——情绪笔记宁可旧一拍，不能空一轮 */
    }
    return book.emotionRows
  }

  function emotionState(t = now()) {
    const lines = emotionLines()
    const state = foldEmotion(lines, { now: t })
    return { ...state, coefficients: emotionCoefficients(lines), lines }
  }

  function noteEmotion({ source, ref, at, kind, intensity, detailKind, text, dedupeKey, lines, seenKeys }) {
    if (!cfg().enabled || cfg().emotionEnabled === false) return null
    const t = now()
    const ts = Number(at) || t
    const key = dedupeKey ?? `${source}|${ref}`
    if (seenKeys?.has(key)) return null
    // 批量收事件时（pullEmotion）把账本行一次性读好传进来 —— 2026-11-13 抓到过：
    // 这里每件事都重读整本情绪账（4MB），几万件事×4MB=一次 /status 四十多秒。
    const local = Array.isArray(lines) ? lines : emotionLines()
    if (local.some((l) => l.kind === 'event' && l.key === key)) return null
    const hit = recognizeEmotion({
      source,
      ref: String(ref ?? ''),
      kind,
      at: ts,
      intensity,
      detailKind,
    })
    if (!hit) return null
    const table = emotionCoefficients(local)
    const d = emotionDelta({ source, ref: String(ref ?? ''), kind, intensity: hit.intensity, detailKind, at: ts }, { table, now: t })
    if (!d || !d.delta) return null
    const line = {
      at: ts,
      kind: 'event',
      id: emotionEventId({ source, ref: key }),
      source: String(source ?? ''),
      ref: String(ref ?? ''),
      key,
      emotion: d.emotion,
      delta: d.delta,
      halfLife: Number(table[d.emotion]?.halfLife) || 0,
      intensity: Number(hit.intensity) || 0,
      text: String(text ?? '').slice(0, 120),
    }
    try {
      appendJsonLine(book.files.emotion, line) // 批 D7：游标不动，行进内存靠下面 push + refresh 按 id 去重
    } catch (err) {
      log(`情绪流记不进去：${String(err?.message ?? err).slice(0, 200)}`)
      return null
    }
    // 批 A 修正（同 index.js）：去重集只在行真进了常驻索引时才记——无 lines 的调用
    //（recall 路径）靠 refresh 进内存，提前记集会让行永久进不了索引。
    if (Array.isArray(lines)) {
      lines.push(line)
      if (lines === book.emotionRows) book.emotionRowIds.add(String(line.id ?? ''))
    }
    seenKeys?.add(key)
    return line
  }

  /** 已经被我掂量过的情绪事件（账本里有条 refs 指着它，e_ 前缀）——闭包同款搬入（status/recall 共用） */
  function weighedEmotionIds() {
    const out = new Set()
    for (const n of book.nodes) {
      for (const r of n.refs ?? []) {
        const id = String(r ?? '').trim()
        if (id.startsWith('e_')) out.add(id)
      }
    }
    return out
  }

  /* ---------------- 拉取族（宿主侧绑定：cfg 闸门 + 源路径解析） ---------------- */

  function fastSourcePath(c = cfg()) {
    const custom = String(c.fastSource ?? '').trim()
    if (custom) return isAbsolute(custom) ? custom : join(resolveHome(), custom)
    const bodyCfg = readJsonSafe(join(resolveHome(), '.dsh-body', 'config.json'), {})
    const fromBody = String(bodyCfg?.eventsFile ?? '').trim()
    if (fromBody) return isAbsolute(fromBody) ? fromBody : join(resolveHome(), '.dsh-body', fromBody)
    return join(resolveHome(), '.dsh-body', 'body-events.jsonl')
  }

  function pullFast(t = now()) {
    const c = cfg()
    if (!c.enabled || c.fastEnabled === false) return 0
    return pullFast(book, t, c, fastSourcePath(c))
  }

  function intentSourcePaths(c = cfg()) {
    const custom = String(c.intentSource ?? '').trim()
    if (custom) {
      const p = isAbsolute(custom) ? custom : join(resolveHome(), custom)
      return [p]
    }
    const bridgeDir = join(resolveHome(), '.dsh-qq-bridge')
    const out = []
    const legacy = join(bridgeDir, 'messages.jsonl')
    if (exists(legacy)) out.push(legacy) // 旧合订本：抄完为止（游标到尾就不再有新行）
    try {
      const names = readdirSync(bridgeDir).filter((n) => /^messages-(group|private|misc)-.+\.jsonl$/.test(n) || n === 'messages-misc.jsonl').sort()
      for (const n of names) out.push(join(bridgeDir, n))
    } catch {
      /* 桥家扫不动就算了 */
    }
    return out
  }

  function intentSourceLabel(source) {
    const s = String(source ?? '')
    const name = s.split(/[\\/]/).pop() ?? ''
    const defDir = join(resolveHome(), '.dsh-qq-bridge')
    if (name.startsWith('messages-') || s.startsWith(defDir)) return 'qq-bridge'
    return 'chat'
  }

  function pullIntent(t = now()) {
    const c = cfg()
    if (!c.enabled || c.intentEnabled === false) return 0
    return pullIntent(book, t, c, intentSourcePaths(c), intentSourceLabel)
  }

  /** 副本里全部的快层事件（翻的时候用，不受索引上限管） */
  function fastAllEvents(t = now()) {
    const out = []
    for (const raw of readJsonLines(book.files.fast)) {
      const ev = normFastEvent(raw, { now: t, defaultSource: 'dsh-body' }) // 副本行缺 source 的旧行按身体算（批 D11）
      if (ev) out.push(ev)
    }
    return out
  }

  /** 副本里全部的意图事件（翻的时候用，不受索引上限管）。被撤回的原话在这里盖住。 */
  function intentAllEvents(t = now()) {
    const out = []
    for (const raw of readJsonLines(book.files.intent)) {
      const ev = normIntentEvent(raw, { now: t })
      if (!ev) continue
      if (ev.mid && book.intentTombstoned.has(ev.mid)) continue
      out.push(ev)
    }
    return out
  }

  function pullEmotion(t = now()) {
    const c = cfg()
    if (!c.enabled || c.emotionEnabled === false) return 0
    let added = 0
    try {
      // 整本情绪账只读一次，几十件事共用 —— 每件事重读 4MB 是 43 秒 /status 的根因
      const lines = emotionLines()
      const seenKeys = new Set()
      for (const l of lines) {
        if (l.kind === 'event' && l.key) seenKeys.add(l.key)
      }
      for (const ev of intentAllEvents(t)) {
        const line = noteEmotion({
          source: 'intent',
          ref: ev.id,
          at: ev.at,
          kind: ev.kind,
          intensity: ev.intensity,
          text: ev.text,
          lines,
          seenKeys,
        })
        if (line) added += 1
      }
      for (const ev of fastAllEvents(t)) {
        const line = noteEmotion({
          source: 'fast',
          ref: ev.id,
          at: ev.at,
          kind: ev.kind,
          detailKind: ev.detail?.kind,
          text: ev.text,
          lines,
          seenKeys,
        })
        if (line) added += 1
      }
    } catch (err) {
      log(`情绪流收事件出错：${String(err?.message ?? err).slice(0, 200)}`)
      return added
    }
    if (added) log(`情绪流记了 ${added} 笔`)
    return added
  }

  /* ---------------- 命令本体（回执 = index.js 原 execute 的逐字搬） ---------------- */

  function emotionStateCmd(args) {
    const t = now()
    const c = cfg()
    if (!c.enabled) {
      return {
        ok: false,
        dominant: 'calm',
        label: '平静',
        level: 0,
        levels: {},
        coefficients: {},
        items: [],
        note: '账本现在是关着的（设置 → 记得）。',
      }
    }
    // 先接一次：刚发生的事得能算进来
    try {
      pullFast(t)
    } catch {
      /* 接不上就算了 */
    }
    try {
      pullIntent(t)
    } catch {
      /* 接不上就算了 */
    }
    try {
      pullEmotion(t)
    } catch {
      /* 算不出来就算了 */
    }
    const state = emotionState(t)
    const limit = clamp(args?.limit ?? 8, 1, 50)
    const events = state.lines
      .filter((l) => l.kind === 'event')
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
    const items = events.map((l) => `${l.id} ${renderEmotionLine(l, t)}`)
    const coeff = {}
    for (const [k, v] of Object.entries(state.coefficients ?? {})) {
      coeff[k] = { coefficient: v.coefficient, halfLife: v.halfLife }
    }
    return {
      ok: true,
      dominant: state.dominant,
      label: state.label,
      level: state.level,
      levels: state.levels,
      coefficients: coeff,
      items,
      note: '',
    }
  }

  function emotionTuneCmd(args) {
    const c = cfg()
    if (!c.enabled) {
      return { ok: false, id: '', emotion: '', from: 0, to: 0, note: '账本现在是关着的（设置 → 记得）。' }
    }
    const emotion = String(args?.emotion ?? '')
    if (!EMOTION_KINDS.includes(emotion)) {
      return {
        ok: false,
        id: '',
        emotion,
        from: 0,
        to: 0,
        note: `只认这七种：${EMOTION_KINDS.join(' / ')}`,
      }
    }
    const to = Number(args?.to)
    if (!Number.isFinite(to) || to <= 0 || to > 3) {
      return { ok: false, id: '', emotion, from: 0, to: 0, note: '系数得在 0 到 3 之间。' }
    }
    const reason = cleanText(args?.reason, 200)
    if (!reason) {
      return {
        ok: false,
        id: '',
        emotion,
        from: 0,
        to,
        note: '改系数得给个理由 —— 写给以后的我看。',
      }
    }
    let halfLife = 0
    if (args?.halfLife !== undefined && args?.halfLife !== null && args?.halfLife !== '') {
      halfLife = clamp(args?.halfLife, 5, 1440)
    }
    const lines = emotionLines()
    const table = emotionCoefficients(lines)
    const from = table[emotion]?.coefficient ?? 1
    const t = now()
    const line = {
      at: t,
      kind: 'tune',
      id: emotionTuneId({ emotion, at: t, to }),
      emotion,
      from,
      to,
      reason,
      ...(halfLife ? { halfLife } : {}),
    }
    try {
      appendJsonLine(book.files.emotion, line) // 批 D7：游标不动，tune 行由下次 refresh 进内存（按 id 去重不双记）
    } catch (err) {
      return {
        ok: false,
        id: '',
        emotion,
        from,
        to,
        note: `写不进情绪流的账：${String(err?.message ?? err).slice(0, 120)}`,
      }
    }
    log(`情绪系数改了 ${emotion} ${from} → ${to}${halfLife ? `（半衰期 ${halfLife} 分）` : ''}：${reason}`)
    const note =
      `把「${EMOTION_LABEL[emotion] ?? emotion}」的系数从 ${from} 改成 ${to}` +
      (halfLife ? `，半衰期 ${halfLife} 分钟` : '') +
      `。理由：${reason}。改动只对往后的事生效 —— 已经记下的那几笔还是当时那个数。` +
      `想让它进【我记得的】就拿 remember 写一条，refs 指回 ${line.id}。`
    return { ok: true, id: line.id, emotion, from, to, note }
  }

  /** 违熏。scope 判断在适配层（壳）；ctx = { cwd, sessionId } 只是落账字段。 */
  function vikarmaCmd(args, ctx = {}) {
    if (!cfg().enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
    const seedId = String(args?.seedId ?? '').trim()
    const key = String(seedId ?? '').trim()
    const node = key ? book.nodes.find((n) => n.id === key) ?? null : null
    if (!node) return { ok: false, id: seedId, note: `没有这条种子：${seedId || '（空）'}` }
    if (!String(node.willDo ?? '').trim()) {
      return { ok: false, id: seedId, note: '这条种子没写 will_do —— 没有「说会做得不一样」，就谈不上违熏。' }
    }
    const reason = String(args?.reason ?? '').trim()
    const VIKARMA_REASONS = ['未触发', '语气偏离', '条件不成立']
    if (!VIKARMA_REASONS.includes(reason)) {
      return { ok: false, id: seedId, note: `reason 只认三个：${VIKARMA_REASONS.join(' / ')}` }
    }
    const t = now()
    // echoId 不填：走内存索引拿最近一次现行的行 id —— 不全量扫 echo.jsonl
    let echoId = String(args?.echoId ?? '').trim()
    if (echoId && !echoId.startsWith('e_')) {
      return { ok: false, id: seedId, note: `echoId 得是回声行的 id（e_ 开头）：${echoId.slice(0, 40)}` }
    }
    if (!echoId) {
      echoId = String(book.latestEchoRow.get(seedId)?.rowId ?? '')
    }
    const willDoAll = String(node.willDo ?? '')
    const row = {
      id: `vk_${t.toString(36)}`,
      at: t,
      kind: 'vikarma',
      seedId,
      echoId,
      // 按码点截：长句的 will_do 不劈代理对，超了补 …（2026-11-16 复核建议）
      expected: `${cutByCodePoints(willDoAll, 200)}${Array.from(willDoAll).length > 200 ? '…' : ''}`,
      actual: String(args?.actual ?? '').slice(0, 200),
      reason,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
    }
    try {
      noteVikarma(book, row) // 违熏写入点（批③子步 2 收 core/protocol；失败回执文案不变）
    } catch (err) {
      return { ok: false, id: seedId, note: `违熏写不进去：${String(err?.message ?? err).slice(0, 120)}` }
    }
    // 原话层留痕，跟 forget 一个路数
    try {
      appendJsonLine(book.files.lines, {
        id: seedId,
        at: t,
        kind: node.kind,
        text: `违熏：${reason}${args?.actual ? ` —— ${String(args.actual).slice(0, 80)}` : ''}`,
        note: 'vikarma',
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      })
    } catch {
      /* 原话层写不进去不影响违熏已记 */
    }
    log(`违熏 ${seedId} · ${reason} · echo=${echoId || '（未关联）'}`)
    return {
      ok: true,
      id: row.id,
      note: `「${String(node.text).slice(0, 40)}」这次没做到（${reason}）—— 下次 recall 翻到它时行尾会提醒`,
    }
  }

  return {
    // 命令
    emotionState: emotionStateCmd,
    emotionTune: emotionTuneCmd,
    vikarma: vikarmaCmd,
    // 域助手（后续批次 list/recall/status 迁移时复用，不另拷贝）
    emotionLines,
    emotionStateRaw: emotionState,
    noteEmotion,
    pullFast,
    pullIntent,
    pullEmotion,
    fastSourcePath,
    intentSourcePaths,
    weighedEmotionIds,
    fastAllEvents,
    intentAllEvents,
  }
}
