/**
 * commands/remember.mjs —— remember 决策本体（批 A 第五步，G-2 施工稿·写路径最大块）。
 *
 * 从 index.js 闭包搬出：curiosity/habit/skill 的「再写一次」快速通路、self 的锚门/顶位门/
 * supersede、restore 捡回、makeNode 全参数、染色层 moodAt、原话层留痕、refs 触碰（touchNode）、
 * 回执 notes 全家（快层/意图/情绪的「有分量了」分界语、wisdom 后门分界）。
 *
 * 红线：回执逐字不变；ctx = { cwd, sessionId }；scope/enabled 检查留壳（原始顺序）；
 * currentAudience 由 ledger 注入（受众单实现）；emotionState 由 emo 注入（染色层单实现）；
 * import 白名单：core/* + 注入参数。
 */

import { appendJsonLine } from '../../core/protocol/io.js'
import {
  KIND_LABEL,
  UNSETTLED_SLOTS,
  activeSelfNodes,
  anchorSelfNode,
  cleanText,
  curiosityState,
  habitState,
  hasThought,
  makeNode,
  normContext,
  normKind,
  normSlot,
  recordCuriosity,
  recordHabit,
  recordSkill,
  restoreSelfNode,
  selfWeight,
  skillState,
  slotLabel,
  supersedeSelf,
  touchNode,
} from '../../core/memory.js'
import { saveNodes } from '../../core/protocol/book.js'

/** 与 index.js:328 同一版 clamp（就地拷贝保等价） */
function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

export function createRememberCommands({ book, log, cfg, now = () => Date.now(), ledger, emo }) {
  if (!ledger || typeof ledger.currentAudience !== 'function') {
    throw new Error('createRememberCommands：ledger 必填注入（currentAudience 单实现）')
  }
  if (!emo || typeof emo.emotionStateRaw !== 'function') {
    throw new Error('createRememberCommands：emo 必填注入（emotionState 单实现）')
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

  /* ---------------- 命令本体：remember（回执 = index.js 原 execute 逐字搬） ---------------- */

  function remember(args, ctx = {}) {
    const c = cfg()
    const t = now()
    if (!c.enabled) return { ok: false, id: '', note: '账本现在是关着的（设置 → 记得）。' }
    const text = cleanText(args?.text, clamp(c.maxTextLength, 40, 8000))
    if (!text) return { ok: false, id: '', note: '要记的是空的。' }
    const kind = normKind(args?.kind)
    const context =
      kind === 'habit' || kind === 'curiosity' || kind === 'skill' ? normContext(args?.context) : ''
    if (kind === 'habit' && !context) {
      return { ok: false, id: '', note: '习惯得带上情境（context）：「在什么场合下我会照着做」。没有情境就算不上一条习惯。' }
    }
    if (kind === 'curiosity' && !context) {
      return { ok: false, id: '', note: '好奇得带上主题（context）：「这件事我想知道什么」。没有主题就攒不成一条好奇。' }
    }
    if (kind === 'skill' && !context) {
      return { ok: false, id: '', note: '技能得带名字（context）：这门手艺叫什么。名字就是它的身份，不然两次成功对不上是同一件事。' }
    }
    // 思量的侧门关上（定案 F5）：kind:narration 走 remember 接不上链——
    // 链（prev）只在 narrate 里自动接。已有侧门思量（历史上从 remember 进来的）保留不撤。
    if (kind === 'narration') {
      return { ok: false, id: '', note: '思量走 narrate，链才接得上；已有侧门思量保留。' }
    }
    // 好奇：同一个主题再写一次 = 我又惦记了一遍 → 次数 +1，不另建节点。
    if (kind === 'curiosity') {
      const res = recordCuriosity(
        book.nodes,
        {
          context,
          text,
          changes: args?.changes,
          conflicts: args?.conflicts,
          willDo: args?.will_do,
          answered: args?.answered === true,
        },
        t,
      )
      if (res.repeated && res.node) {
        book.nodes = res.nodes
        const cu = res.node
        try {
          appendJsonLine(book.files.lines, {
            id: cu.id,
            at: t,
            kind: 'curiosity',
            context: cu.context,
            hits: cu.hits,
            weight: cu.weight,
            text: text || cu.text,
            changes: cu.changes,
            conflicts: cu.conflicts,
            willDo: cu.willDo,
            answered: cu.answered,
            sessionId: ctx.sessionId,
            cwd: ctx.cwd,
            note: 'curiosity:又惦记了一遍',
          })
        } catch (err) {
          log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
        }
        const snapshotC = [...book.nodes]
        replaceNode(cu)
        if (!saveNodes(book)) {
          book.nodes = snapshotC // 内存回滚与盘一致（批 C4）：重试不产生重复节点
          return { ok: false, id: cu.id, note: `账本没写进去：${book.meta.saveError}` }
        }
        const st = curiosityState(cu)
        const tail =
          st === 'answered'
            ? '这个问题已经解答了：退出活跃表（还在账本里，翻得到；同主题再写就回来）'
            : st === 'thinking'
              ? `第 ${cu.hits} 次惦记；还没答四问，先不进开头（答一问我才挂它）`
              : `第 ${cu.hits} 次惦记`
        log(`好奇又惦记了一遍 ${cu.id} · ${cu.context} · 第 ${cu.hits} 次 · ${st}`)
        return { ok: true, id: cu.id, note: tail }
      }
    }
    // 习惯：同一个情境再写一次 = 又发作了一次 → 次数 +1，不另建节点。
    // 每次发作都往原话层留一行（append-only），节点上的 hits 只是索引。
    if (kind === 'habit') {
      const res = recordHabit(
        book.nodes,
        {
          context,
          text,
          changes: args?.changes,
          conflicts: args?.conflicts,
          willDo: args?.will_do,
        },
        t,
      )
      if (res.repeated && res.node) {
        book.nodes = res.nodes
        const h = res.node
        try {
          appendJsonLine(book.files.lines, {
            id: h.id,
            at: t,
            kind: 'habit',
            context: h.context,
            hits: h.hits,
            weight: h.weight,
            text: text || h.text,
            changes: h.changes,
            conflicts: h.conflicts,
            willDo: h.willDo,
            sessionId: ctx.sessionId,
            cwd: ctx.cwd,
            note: 'habit:又发生了一次',
          })
        } catch (err) {
          log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
        }
        const snapshotH = [...book.nodes]
        replaceNode(h)
        if (!saveNodes(book)) {
          book.nodes = snapshotH // 内存回滚与盘一致（批 C4）
          return { ok: false, id: h.id, note: `账本没写进去：${book.meta.saveError}` }
        }
        const st = habitState(h)
        const tail =
          st === 'fast'
            ? '第 3 次起走上快通路：单独一段送到开头，不跟别的条抢位置'
            : st === 'established'
              ? '第 2 次，这个习惯成立了'
              : `第 ${h.hits} 次`
        // 上了快通路也得答过三问才真的挂得上 —— 回执要说清楚，别让人以为已经在开头里了
        const note = hasThought(h) ? tail : `${tail}；但还没答四问，先不进开头（答一问我才挂它）`
        log(`习惯又发作了一次 ${h.id} · ${h.context} · 第 ${h.hits} 次 · ${st}`)
        return { ok: true, id: h.id, note }
      }
    }
    // 技能：同一个名字再写一次 = 又成了一次。这次所在的工作目录记进 contexts，
    // 换了情境才算新的一处；两处不同的情境各成一次，这条技能成立（不是碰巧）。
    if (kind === 'skill') {
      const where = String(ctx.cwd ?? '').trim()
      // 没有 cwd 的环境会静默失效：where 空 → isNewContext 恒 false → 永远 single，
      // 一句提示都没有（2026-11-16 修的）。宁可拒了说清楚 —— 不是限制，是让失效可见。
      if (!where) {
        return {
          ok: false,
          id: '',
          note: '技能要在有工作目录的会话里记 —— 情境就是这个目录，没有目录就分不出「两处不同的地方」。',
        }
      }
      const res = recordSkill(
        book.nodes,
        {
          context,
          text,
          changes: args?.changes,
          conflicts: args?.conflicts,
          willDo: args?.will_do,
          where,
        },
        t,
      )
      if (res.repeated && res.node) {
        book.nodes = res.nodes
        const k = res.node
        try {
          appendJsonLine(book.files.lines, {
            id: k.id,
            at: t,
            kind: 'skill',
            context: k.context,
            weight: k.weight,
            text: text || k.text,
            changes: k.changes,
            conflicts: k.conflicts,
            willDo: k.willDo,
            contexts: k.contexts,
            sessionId: ctx.sessionId,
            cwd: ctx.cwd,
            note: res.newContext ? 'skill:在另一种情境又成了' : 'skill:又用了一次',
          })
        } catch (err) {
          log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
        }
        const snapshotK = [...book.nodes]
        replaceNode(k)
        if (!saveNodes(book)) {
          book.nodes = snapshotK // 内存回滚与盘一致（批 C4）
          return { ok: false, id: k.id, note: `账本没写进去：${book.meta.saveError}` }
        }
        const st = skillState(k)
        const cs = (Array.isArray(k.contexts) ? k.contexts : []).length
        // 回执把两件事都说清：这条技能成立没有；这次是换了个地方，还是老地方又用了一次
        const tail =
          st !== 'established'
            ? res.newContext
              ? `第 ${cs} 处情境成过；再换一个地方成一次它就成立`
              : `还是那处情境（${where ? where.slice(-40) : '没记地方'}）里又用了一次；换个情境再成一次它就成立`
            : res.newContext
              ? cs === 2
                ? '两种不同的情境各成过一次 —— 这条技能成立了，不是碰巧'
                : `第 ${cs} 处情境都成过 —— 这条技能站得很稳`
              : `还是那处情境（${where ? where.slice(-40) : '没记地方'}）里又用了一次 —— 这条技能成立（两处情境都成过）`
        log(`技能又成了一次 ${k.id} · ${k.context} · ${cs} 处情境 · ${st}`)
        return { ok: true, id: k.id, note: hasThought(k) ? tail : `${tail}；但还没答四问，先不进开头` }
      }
    }
    // 两个时间（借自晴猫）：at 是「得知」（写下的时刻）；淡忘实际从 lastAt 算（decayFactor）——
    // 被想起过的条多活一阵。happenedAt 是「发生」——refs 指向的来话/快层事件的发生时刻。
    // 只在内存索引里找（找得到才标，老到沉出索引的就不标 —— 宁可漏，不可编）。
    let happenedAt = 0
    for (const r of String(args?.refs ?? '').split(/[,，\s]+/)) {
      const id = r.trim()
      if (!/^(i_|f_)/.test(id)) continue
      const ev = [...book.intentIndex, ...book.fastIndex].find((x) => x && x.id === id)
      if (ev && Number(ev.at) > 0) happenedAt = happenedAt ? Math.min(happenedAt, Number(ev.at)) : Number(ev.at)
    }
    // 把退下的自我条捡回来（饭桶五条之五：捡回来要出声，没人知道等于没捡）
    if (kind === 'self' && args?.restore) {
      const res = restoreSelfNode(book.nodes, String(args.restore ?? '').trim(), t)
      if (!res.restored) {
        return { ok: false, id: String(args?.restore ?? ''), note: res.note }
      }
      const snapshotR = book.nodes
      book.nodes = res.nodes
      if (!saveNodes(book)) {
        book.nodes = snapshotR // res.nodes 是新数组，引用回滚即可（批 C4）
        return { ok: false, id: res.restored.id, note: `账本没写进去：${book.meta.saveError}` }
      }
      try {
        appendJsonLine(book.files.lines, {
          id: res.restored.id,
          at: t,
          kind: 'self',
          slot: res.restored.slot,
          weight: res.restored.weight,
          text: `把 ${res.restored.id} 捡回来了：${res.restored.text}`,
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          note: 'remember-restore',
        })
      } catch (err) {
        log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
      }
      log(`捡回来 ${res.restored.id} · 我·${slotLabel(res.restored.slot)} · ${res.restored.text.slice(0, 60)}`)
      return {
        ok: true,
        id: res.restored.id,
        note: `把 ${res.restored.id} 捡回来了：它重新替「${slotLabel(res.restored.slot)}」说话${
          res.restored.anchor ? '（锚也回来了）' : ''
        }`,
      }
    }
    const node = makeNode(
      {
        text,
        kind,
        slot: args?.slot,
        anchor: args?.anchor === true,
        anchorWhy: args?.anchor_why,
        context,
        hits: kind === 'habit' || kind === 'curiosity' ? 1 : 0,
        answered: kind === 'curiosity' && args?.answered === true,
        // 技能首写：这次所在的工作目录就是第一处情境（真实的地方，不是编的）
        contexts: kind === 'skill' ? [{ at: t, where: String(ctx.cwd ?? '').trim() }] : [],
        // 两个时间：refs 指向的事件什么时候发生的（0 = 不标）
        happenedAt,
        // 受众：写下这一刻「谁在听」（solo=只有她 / private / group:群号）—— 群轮的过滤按这个算
        audience: currentAudience(t),
        weight: args?.weight,
        changes: args?.changes,
        conflicts: args?.conflicts,
        willDo: args?.will_do,
        known: args?.known,
        tags: args?.tags,
        refs: args?.refs,
      },
      t,
    )
    if (!node) return { ok: false, id: '', note: '没组成一条。' }
    // 自我层：同槽位写新值 → 旧的退下（不删，翻得到，只是不再自称）。
    // 挂了锚的槽例外（anchor 门）：锚在位时不被没挂锚的新值顶掉；
    // 挂锚必须答三年问；换锚要 replace_anchor（先让她点头，这是规矩不是开关）。
    let supersededIds = []
    const anchorNotes = []
    if (node.kind === 'self') {
      const wantAnchor = args?.anchor === true
      const existing = anchorSelfNode(book.nodes, node.slot, t)
      const replaces = Boolean(wantAnchor && existing && args?.replace_anchor === true)
      if (wantAnchor && !node.anchorWhy) {
        node.anchor = false
        anchorNotes.push(
          '想挂锚先答三年问（anchor_why：这条三年后你还认不认、凭什么）——答不上来不给挂，这条先记成普通一条',
        )
      } else if (wantAnchor && existing && !replaces) {
        node.anchor = false
        anchorNotes.push(
          `这个槽已有锚「${existing.text.slice(0, 40)}」（${existing.id}）——一个槽最多一条锚；` +
            '要换锚先让她点头，再带 replace_anchor=true + 三年问',
        )
      } else {
        node.anchor = wantAnchor
        if (replaces) {
          anchorNotes.push(
            `换锚：旧锚「${existing.text.slice(0, 40)}」（${existing.id}）退下——restore ${existing.id} 随时能捡回来`,
          )
        } else if (wantAnchor) {
          anchorNotes.push('挂锚：三年问答了，这条现在替这个槽说话')
        } else if (existing) {
          anchorNotes.push(`这个槽有锚在位（${existing.id}）：这条没挂锚，记在旁边，不顶锚`)
        }
      }
      // 顶位门（whale-card P0-2）：槽里在位的比这条重、又没带 confirmed → 不硬顶，
      // 这条先挂「还没定的」（doubt 槽）——我的身份允许重写，但要掂过才行。
      let redirected = false
      if (!wantAnchor && !existing && args?.confirmed !== true) {
        const holder = activeSelfNodes(book.nodes, t).find((n) => normSlot(n.slot) === node.slot && !n.anchor)
        if (holder && selfWeight(holder, t) > node.weight) {
          node.slot = UNSETTLED_SLOTS[0]
          redirected = true
          anchorNotes.push(
            `这条比「${slotLabel(holder.slot)}」位上那条轻，先挂在「还没定的」旁边；掂过之后还是想顶：confirmed=true`,
          )
        }
      }
      // 锚在位而这条没挂成锚 → 不退位；重定向到「还没定的」的也不退位；其余照旧：新的把旧的顶下来
      const gateBlocking = Boolean(existing && node.id !== existing.id && !node.anchor) || redirected
      if (!gateBlocking) {
        const res = supersedeSelf(book.nodes, node.slot, node.id, t)
        book.nodes = res.nodes
        supersededIds = res.superseded
      }
    }
    // 染色层（whale-card P0-4）：写下这条时我心里是什么颜色——只记当时那一眼，正文一个字不动
    try {
      const emoNow = emo.emotionStateRaw(t)
      if (emoNow && emoNow.dominant && emoNow.dominant !== 'calm') {
        node.moodAt = { dominant: emoNow.dominant, level: emoNow.level }
      }
    } catch {
      /* 折不出情绪就不染，别挡住记账 */
    }
    // 原话层的失败维持「log 不炸」（批 A2）——但要出声：节点记上了、
    // 溯源缺一行，回执的 notes 里要提，不许装没发生。
    let lineWriteFailed = false
    try {
      appendJsonLine(book.files.lines, {
        id: node.id,
        at: t,
        kind: node.kind,
        slot: node.slot,
        context: node.context,
        hits: node.hits,
        weight: node.weight,
        text: node.text,
        changes: node.changes,
        conflicts: node.conflicts,
        willDo: node.willDo,
        known: node.known,
        answered: node.answered,
        anchor: node.anchor,
        anchorWhy: node.anchorWhy,
        // 两个时间：refs 指向的事件的发生时刻（0 = 不标；旧行没有这字段）
        happenedAt: node.happenedAt || 0,
        // 受众：写下这一刻谁在听（any = 旧行/没记到，两边都给）
        audience: node.audience || 'any',
        tags: node.tags,
        refs: node.refs,
        contexts: node.contexts,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        note: 'remember',
      })
    } catch (err) {
      lineWriteFailed = true
      log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
    }
    // 新条引用了哪条旧的，那条就是真的又被想起了一次 —— 给它记一笔。
    // 复现那一路少数诚实的自动来源：不是我随手翻到就算，是写下的那一刻明确指过去。
    const refNotes = []
    for (const rid of (node.refs ?? []).map((r) => String(r ?? '').trim()).filter(Boolean)) {
      if (rid === node.id) continue
      const old = findNode(rid)
      if (!old || old.sealed) continue
      const touched = touchNode(old, `被 ${node.id} 引用`, t)
      if (touched && touched !== old) {
        replaceNode(touched)
        refNotes.push(rid)
      }
    }
    const snapshotM = [...book.nodes]
    replaceNode(node)
    if (!saveNodes(book)) {
      book.nodes = snapshotM // 内存回滚与盘一致（批 C4）
      return { ok: false, id: node.id, note: `账本没写进去：${book.meta.saveError}` }
    }
    log(
      `记下 ${node.id} · ${node.kind === 'self' ? `我·${slotLabel(node.slot)}` : KIND_LABEL[node.kind]} · 分量 ${node.weight.toFixed(2)} · ${node.text.slice(0, 60)}`,
    )
    const notes = []
    if (lineWriteFailed) notes.push('原话层这行没写上（节点已记，溯源缺一行）')
    if (!hasThought(node)) notes.push('没写三问，只进了原话层，不会挂到明天开头')
    if (supersededIds.length) notes.push(`${slotLabel(node.slot)}这个槽位上旧的 ${supersededIds.length} 条退下了（还在，翻得到）`)
    notes.push(...anchorNotes)
    // refs 指回快层的一条事 = 那件事被掂量过了（从「只有发生的时间」变成「有分量的一条」）
    const fastRefs = (node.refs ?? []).filter((r) => String(r).startsWith('f_'))
    if (fastRefs.length) {
      notes.push(`边指向快层 ${fastRefs.join('、')} —— 那条秒级的事现在有分量了（它自己那条还是原样，翻得到）`)
    }
    // refs 指回意图事件 = 机器认出来的那句话，我认下了（同类：事情还是原样，分量是我给的）
    const intentRefs = (node.refs ?? []).filter((r) => String(r).startsWith('i_'))
    if (intentRefs.length) {
      notes.push(`边指向意图事件 ${intentRefs.join('、')} —— 那句话的事现在有分量了（它自己那条还是原样，翻得到）`)
    }
    // refs 指回情绪事件 = 那一刻在我心里的动静，我认下了（那笔账还是原样，翻得到）
    const emotionRefs = (node.refs ?? []).filter((r) => String(r).startsWith('e_'))
    if (emotionRefs.length) {
      notes.push(`边指向情绪流 ${emotionRefs.join('、')} —— 那一刻的动静现在有分量了（它自己那条还是原样，翻得到）`)
    }
    if (refNotes.length) {
      notes.push(`${refNotes.join('、')} 被这条引用，记了一笔「被引用」（它们此刻更热一点）`)
    }
    if (node.kind === 'habit') {
      notes.push(`第 1 次：还只是一条普通记忆；同一个情境再写一次就是第 2 次（习惯成立），第 3 次起走快通路`)
    }
    if (node.kind === 'skill') {
      notes.push(`第 1 处情境（${node.contexts?.[0]?.where ? String(node.contexts[0].where).slice(-40) : '没记地方'}）记下了；换个情境再写一次它就成立（两处不同的地方各成过一次才算手艺，不是碰巧）`)
      if (!hasThought(node)) notes.push('还没答四问：先不进开头（答一问我才挂它）')
    }
    if (node.kind === 'curiosity') {
      notes.push(`第 1 次惦记「${node.context}」；同一个主题再写一次就是又惦记了一遍（次数 +1）`)
      if (node.answered) notes.push('这个已经解答了：不挂活跃表（还在账本里，翻得到；同主题再写就回来）')
      else if (!hasThought(node)) notes.push('还没答四问：先不进开头（答一问我才挂它）')
    }
    // 智的分界（定案 F5）：新明白 ≠ 转化——转化走 transform（有原种子、盖旗），
    // 无根的新明白才走 remember。后门保留，但回执要把分界说清。
    if (node.kind === 'wisdom') {
      notes.push('分界：新明白 ≠ 转化——要转化有原种子的，走 transform（原种子会盖「已转化」旗）；无根的新明白走这里就对了')
    }
    return {
      ok: true,
      id: node.id,
      note: notes.join('；'),
    }
  }

  return { remember }
}
