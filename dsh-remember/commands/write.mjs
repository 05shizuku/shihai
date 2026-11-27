/**
 * commands/write.mjs —— 写路径命令层（批 A 第四步，G-2 施工稿）。
 *
 * forget / narrate / transform 三命令的决策本体（remember 单独一批，它是写路径里最大的块）。
 * 共同件：replaceNode / findNode（book.nodes 的两个 3 行原语，就地实现——不造第二份抽象）。
 *
 * 红线：
 *   · 回执逐字不变——schema/render/output 留壳；
 *   · ctx = { cwd, sessionId }（原话层留痕行的落款字段）；scope 判断在壳；
 *   · saveNodes 失败的内存回滚（批 C4）逐行保真；
 *   · import 白名单：core/* + 注入参数（currentAudience 由 ledger 注入——受众判定单实现）。
 */

import { appendJsonLine } from '../../core/protocol/io.js'
import {
  cleanText,
  makeNode,
  normKind,
  parseSealUntil,
  relSealLeft,
  setSeal,
  setSealed,
  relTime,
  setWeight,
} from '../../core/memory.js'
import { saveNodes } from '../../core/protocol/book.js'

/** 与 index.js:328 同一版 clamp（就地拷贝保等价） */
function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

export function createWriteCommands({ book, log, cfg, now = () => Date.now(), ledger }) {
  if (!ledger || typeof ledger.currentAudience !== 'function') {
    throw new Error('createWriteCommands：ledger 必填注入（currentAudience 单实现）')
  }
  const { currentAudience } = ledger

  function findNode(id) {
    const key = String(id ?? '').trim()
    if (!key) return null
    return book.nodes.find((n) => n.id === key) ?? null
  }

  function replaceNode(next) {
    const i = book.nodes.findIndex((n) => n.id === next.id)
    if (i < 0) book.nodes.push(next)
    else book.nodes[i] = next
  }

  /* ---------------- forget：淡/按/松（没有删除） ---------------- */

  function forget(args, ctx = {}) {
    if (!cfg().enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
    const node = findNode(args?.id)
    if (!node) return { ok: false, id: '', note: `没有这条：${String(args?.id ?? '').trim() || '（空）'}` }
    const t = now()
    const mode = String(args?.mode ?? '').trim()
    let next = node
    let note = ''
    let sealKind = ''
    if (mode === 'fade') {
      next = setWeight(node, node.weight * 0.5, t)
      next = { ...next, faded: true }
      note = '调轻到分量'
    } else if (mode === 'seal') {
      // 按法有三种：到点自松（until）、等一条翻篇（cond）、不设条件（老语义）。
      const untilText = cleanText(args?.until, 40)
      const condId = cleanText(args?.cond, 40)
      if (untilText && condId) {
        return { ok: false, id: node.id, note: 'until 和 cond 挑一个 —— 到点自松，或者等一条翻篇，别两头都写。' }
      }
      if (untilText) {
        const until = parseSealUntil(untilText, t)
        if (!until) {
          return { ok: false, id: node.id, note: 'until 认不出来：给 30m／2h／3d 这种，或者一个未来的毫秒数。' }
        }
        next = setSeal(node, { until }, t)
        note = `按住了，到点自己松（还剩 ${relSealLeft(until, t)}）`
        sealKind = 'until'
      } else if (condId) {
        const target = findNode(condId)
        if (!target) {
          return { ok: false, id: node.id, note: `条件里指的那条不存在：${condId}` }
        }
        if (target.id === node.id) {
          return { ok: false, id: node.id, note: '条件不能指它自己 —— 那样它永远不会松开。' }
        }
        next = setSeal(node, { cond: target.id }, t)
        note = `按住了，等「${String(target.text ?? '').slice(0, 24)}${Array.from(String(target.text ?? '')).length > 24 ? '…' : ''}」翻篇就自己松开`
        sealKind = 'cond'
      } else {
        next = setSealed(node, true, t)
        note = '按住了'
        sealKind = 'plain'
      }
    } else if (mode === 'restore') {
      // 松开要三样一起清：手动按的、按到点的、等条件的 —— 不然留着半截还会把条压住
      next = setSeal(node, null, t)
      next = setSealed(next, false, t)
      next = { ...next, faded: false }
      // 松开的同时，如果这条是被新值顶下来的，也让它重新自称
      if (next.superseded) {
        next = { ...next, superseded: false, supersededBy: '', supersededAt: 0 }
      }
      note = '松开了'
    } else {
      return { ok: false, id: '', note: `不认识的 mode：${mode || '（空）'}` }
    }
    const snapshotF = [...book.nodes]
    replaceNode(next)
    if (!saveNodes(book)) {
      book.nodes = snapshotF // 内存回滚与盘一致（批 C4）
      return { ok: false, id: next.id, note: `账本没写进去：${book.meta.saveError}` }
    }
    try {
      appendJsonLine(book.files.lines, {
        id: next.id,
        at: t,
        kind: next.kind,
        weight: next.weight,
        text: next.text,
        note: `forget:${mode}${sealKind ? `:${sealKind}` : ''}`,
        why: cleanText(args?.why, 200),
        sealUntil: next.sealUntil ?? 0,
        sealCond: next.sealCond ?? '',
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      })
    } catch {
      /* 原话层写不进去不影响节点已改 */
    }
    const sealBit = sealKind === 'until' ? ` until=${next.sealUntil}` : sealKind === 'cond' ? ` cond=${next.sealCond}` : ''
    log(`forget ${mode}${sealKind ? `:${sealKind}` : ''} ${next.id}${sealBit} → 分量 ${next.weight.toFixed(2)} sealed=${next.sealed}`)
    return { ok: true, id: next.id, note: next.weight && mode === 'fade' ? `${note} ${next.weight.toFixed(2)}` : note }
  }

  /* ---------------- narrate：思量（逐条相续，不覆盖） ---------------- */

  function narrate(args, ctx = {}) {
    if (!cfg().enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
    const narrative = cleanText(args?.narrative, clamp(cfg().maxTextLength, 40, 8000))
    if (!narrative) return { ok: false, id: '', note: '思量是空的。' }
    // refs 只收账上真存在的种子（r_）——事件（f_/i_）与 ghost 剔除并在回执说明（A5-1）。
    // 定案 F5：refs 空/缺 → 照收（无根之思）；给了 refs 但全被剔空 → 照旧拒。
    const rawRefs = Array.isArray(args?.refs) ? args.refs : String(args?.refs ?? '').split(/[,，\s]+/)
    const hadRefs = rawRefs.some((r) => cleanText(r, 40))
    const kept = []
    const dropped = []
    for (const r of rawRefs) {
      const id = cleanText(r, 40)
      if (!id) continue
      if (id.startsWith('r_') && findNode(id)) {
        if (!kept.includes(id)) kept.push(id)
      } else {
        dropped.push(id)
      }
    }
    if (!kept.length && hadRefs) {
      return {
        ok: false,
        id: '',
        note: dropped.length
          ? `refs 里没有账上的种子（${dropped.slice(0, 3).join('、')}${dropped.length > 3 ? '…' : ''} 是事件或不存在）——事件不是种子，要引用先 remember 成种子。`
          : 'refs 里没有有效引用。',
      }
    }
    const t = now()
    // 链头：当前最新的思量条（写时自动接链，逐条相续，不覆盖）
    const head = book.nodes
      .filter((n) => n && normKind(n.kind) === 'narration')
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0] ?? null
    const node = makeNode(
      {
        text: narrative,
        kind: 'narration',
        refs: kept,
        prev: head?.id ?? '',
        weight: args?.weight,
        changes: args?.changes,
        conflicts: args?.conflicts,
        willDo: args?.will_do,
        known: args?.known,
        audience: currentAudience(t),
      },
      t,
    )
    node.id = `n_${node.id.slice(2)}` // 思量的 id 前缀（定案 A）
    const snapshotN = [...book.nodes]
    replaceNode(node)
    if (!saveNodes(book)) {
      book.nodes = snapshotN // 内存回滚与盘一致（批 C4）
      return { ok: false, id: node.id, note: `账本没写进去：${book.meta.saveError}` }
    }
    try {
      appendJsonLine(book.files.lines, {
        id: node.id,
        at: t,
        kind: 'narration',
        weight: node.weight,
        text: node.text,
        changes: node.changes,
        conflicts: node.conflicts,
        willDo: node.willDo,
        known: node.known,
        prev: node.prev,
        refs: node.refs,
        audience: node.audience,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      })
    } catch (err) {
      log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
    }
    const droppedNote = dropped.length
      ? `（剔除了 ${dropped.length} 条事件/未知引用：${dropped.slice(0, 3).join('、')}${dropped.length > 3 ? '…' : ''}）`
      : ''
    // 无根之思（定案 F5）：refs 没给的思量在回执上标出来——链照接，根留白
    const rootNote = kept.length ? `引 ${kept.length} 条种子` : '无根之思（思量不必都从种子长出来，但长出来的要留 refs）'
    const prevNote = node.prev ? ` · 上一条 ${node.prev}（${relTime(head.at, t)}）` : ' · 链的第一环'
    log(`思量 ${node.id} · ${rootNote}${node.prev ? ` · 接 ${node.prev}` : ''}`)
    return { ok: true, id: node.id, note: `${rootNote}${prevNote}${droppedNote}` }
  }

  /* ---------------- transform：转识成智（一种子一转化，链式升华） ---------------- */

  function transform(args, ctx = {}) {
    if (!cfg().enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
    const seedId = String(args?.seedId ?? '').trim()
    const seed = findNode(seedId)
    if (!seed) return { ok: false, id: seedId, note: `没有这条种子：${seedId || '（空）'}` }
    const kind = normKind(seed.kind)
    if (['self', 'habit', 'curiosity', 'skill'].includes(kind)) {
      const why = { self: 'self 的演化走 supersedeSelf 和锚门', habit: '习惯靠同情境再发生', curiosity: '好奇靠解答（answered）', skill: '技能靠两处情境' }
      return { ok: false, id: seedId, note: `「${kind}」不走转化 —— ${why[kind]}。` }
    }
    if (seed.transformed) {
      return { ok: false, id: seedId, note: `已转化过，智在 ${seed.transformedBy}；真要再提炼，对智本身 transform。` }
    }
    const insight = cleanText(args?.insight, clamp(cfg().maxTextLength, 40, 8000))
    if (!insight) return { ok: false, id: seedId, note: 'insight 是空的 —— 「我从中明白了什么」得写下来。' }
    const t = now()
    const node = makeNode(
      {
        text: insight,
        kind: 'wisdom',
        refs: [seed.id],
        changes: insight,
        conflicts: args?.conflicts,
        willDo: args?.will_do,
        known: args?.known,
        weight: args?.weight ?? 0.8,
        audience: currentAudience(t),
      },
      t,
    )
    node.id = `w_${node.id.slice(2)}`
    const flagged = { ...seed, transformed: true, transformedBy: node.id, transformedAt: t }
    const snapshotT = [...book.nodes]
    replaceNode(flagged)
    replaceNode(node)
    if (!saveNodes(book)) {
      book.nodes = snapshotT // 旗与智一起回滚（批 C4）：原种子不能挂着「已转化」的空旗
      return { ok: false, id: node.id, note: `账本没写进去：${book.meta.saveError}` }
    }
    try {
      appendJsonLine(book.files.lines, {
        id: node.id,
        at: t,
        kind: 'wisdom',
        weight: node.weight,
        text: node.text,
        changes: node.changes,
        conflicts: node.conflicts,
        willDo: node.willDo,
        known: node.known,
        refs: node.refs,
        audience: node.audience,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      })
    } catch (err) {
      log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
    }
    log(`转识成智 ${node.id} ← ${seed.id}（${kind}）`)
    return { ok: true, id: node.id, note: `从 ${seed.id} 提炼 · 已盖转化旗` }
  }

  return { forget, narrate, transform }
}
