/**
 * client.js —— 设置页里的「记得」那一节（浏览器半边）
 *
 * 为什么有这一半：宿主那半边只算数、写文件，界面得有个地方看。
 * 形态跟 dsh-body / dsh-fish 观测台一样：`settings.section`，在 App 内部同源
 * fetch `/dsh-remember/*`（cookie 天然带着），独立 HTML 页会被信任栅栏挡成 403。
 *
 * 这里只做两件事：
 *   ① 看：账本现况、最重的几条、被按住的、此刻挂起的那段原文、日志末尾；
 *   ② 改：白名单里的几个键 —— 开不开、挂给谁、挂几条、多长。服务端再校验一遍。
 *
 * 刻意**不**提供「改某一条的分量」的入口：分量是我自己写下来的判断，
 * 要动就用 forget(mode)，那是账本的规矩，会留下痕迹。
 */
window.__ModuleLoader__.load({
  id: 'dsh-remember',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/dsh-remember'
    const KIND_LABEL = {
      fact: '事实',
      decision: '决定',
      lesson: '教训',
      skill: '会了',
      open: '没结',
      self: '我',
      habit: '习惯',
      curiosity: '好奇',
    }

    /** 快层事件的类目（身体那边写下来的），跟账本的 kind 不是一回事。 */
    const FAST_KIND_LABEL = {
      meal: '吃了一口',
      missed: '错过一顿',
      topup: '添了饭',
      mood: '心里动了一下',
      threshold: '身上到线',
      other: '有件事',
    }

    /** 意图层固定的 11 类（机器从聊天里认出来的「发生了什么」），枚举不变。 */
    const INTENT_KIND_LABEL = {
      farewell: '告别',
      greet: '招呼',
      praise: '夸',
      conflict: '顶嘴',
      criticize: '骂',
      invite: '邀',
      teach: '教我',
      ask: '问',
      agree: '认同',
      share: '分享',
      other: '其它',
    }

    /** 情绪流固定的七类（机器从真事里认出来的「我动了心」），枚举不变；calm 是都不够线时的样子。 */
    const EMOTION_KIND_LABEL = {
      warm: '被暖到',
      pleased: '高兴',
      curious: '好奇',
      tense: '紧绷',
      down: '低落',
      restless: '躁',
      lonely: '孤单',
      calm: '平静',
    }

    /** 情绪事件只来自三类真实流（跟 lib/emotion.js 的 recognizeEmotion 一个口径）。 */
    const EMOTION_SOURCE_LABEL = {
      intent: '群里的话',
      fast: '身体那边',
      recall: '账本被翻',
    }

    // ---------------------------------------------------------------- 样式
    const C = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--dsw-alias-label-primary)' },
      h2: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px' },
      sub: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12.5, lineHeight: '19px' },
      card: { border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
      cardTitle: { margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary)' },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px', fontSize: 13, lineHeight: '19px' },
      k: { color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      v: { wordBreak: 'break-all' },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      input: { fontSize: 13, padding: '3px 6px', borderRadius: 6, border: '.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', width: 88 },
      area: { fontSize: 12.5, padding: '5px 6px', borderRadius: 6, border: '.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', width: 360, minHeight: 52, resize: 'vertical', fontFamily: 'inherit' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 },
      item: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 0', borderTop: '.5px solid var(--dsw-alias-border-l2)' },
      meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5, lineHeight: '17px' },
      text: { fontSize: 13, lineHeight: '20px', wordBreak: 'break-word' },
      log: { margin: 0, padding: 10, borderRadius: 8, background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))', fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflow: 'auto' },
      section: { margin: 0, padding: 10, borderRadius: 8, background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))', fontSize: 12.5, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      btn: { fontSize: 13, padding: '4px 12px', borderRadius: 7, border: '.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      err: { color: 'var(--dsw-alias-label-error, #c0392b)', fontSize: 12.5, lineHeight: '19px', margin: 0 },
      ok: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 },
    }

    function fmtWhen(iso) {
      if (!iso) return '还没发生'
      const t = new Date(iso)
      if (Number.isNaN(t.getTime())) return String(iso)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
    }

    function fmtAge(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n < 0) return '—'
      const m = Math.round(n / 60000)
      if (m < 60) return `${m} 分钟`
      const hh = Math.floor(m / 60)
      const mm = m % 60
      if (hh < 24) return `${hh} 小时 ${mm} 分`
      return `${Math.floor(hh / 24)} 天 ${hh % 24} 小时`
    }

    function num(v, digits = 2) {
      const n = Number(v)
      return Number.isFinite(n) ? n.toFixed(digits) : '—'
    }

    function card(title, ...children) {
      return h('div', { style: C.card }, h('h3', { style: C.cardTitle }, title), ...children.filter(Boolean))
    }

    function kv(pairs) {
      return h('div', { style: C.kv }, ...pairs.filter(Boolean).flatMap(([k, v]) => [
        h('span', { key: `k-${k}`, style: C.k }, k),
        h('span', { key: `v-${k}`, style: C.v }, v),
      ]))
    }

    // ---------------------------------------------------------------- 表单
    const emptyForm = () => ({
      enabled: true,
      targetRoot: '',
      allowRoots: '',
      denyRoots: '',
      injectLimit: '3',
      openLimit: '2',
      maxChars: '900',
      sectionOrder: '8720',
      maxTextLength: '2000',
      recallMaxChars: '8000',
      recallItemMax: '400',
      selfEnabled: true,
      selfSectionOrder: '8660',
      selfMaxChars: '400',
      habitEnabled: true,
      habitSectionOrder: '8680',
      habitMaxChars: '320',
      habitLimit: '3',
      curiosityEnabled: true,
      curiositySectionOrder: '8670',
      curiosityMaxChars: '320',
      curiosityLimit: '3',
      fastEnabled: true,
      fastSource: '',
      fastMaxEvents: '500',
      intentEnabled: true,
      intentSource: '',
      intentMaxEvents: '2000',
      emotionEnabled: true,
      emotionTickMinutes: '1',
      emotionSectionEnabled: false,
      emotionSectionOrder: '8710',
      emotionMaxChars: '200',
      wakeEnabled: true,
      wakeSessionId: '',
      wakeCooldownMinutes: '30',
      debug: false,
    })

    /** 多行文本 → 路径数组（也认逗号和分号）。 */
    function splitPaths(v) {
      return String(v ?? '')
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    }

    /** 表单里放隔离路径的那一行，读成数组。 */
    function rootsOf(form) {
      return splitPaths(form?.denyRoots)
    }

    /** 勾上／取消一个路径，返回新的多行文本。 */
    function toggleRoot(text, path) {
      const roots = splitPaths(text)
      const i = roots.indexOf(path)
      if (i >= 0) roots.splice(i, 1)
      else roots.push(path)
      return roots.join('\n')
    }

    function formFrom(status) {
      const cfg = status?.config?.effective ?? {}
      const roots = Array.isArray(cfg.allowRoots) ? cfg.allowRoots : []
      const deny = Array.isArray(cfg.denyRoots) ? cfg.denyRoots : []
      return {
        enabled: Boolean(cfg.enabled),
        targetRoot: String(cfg.targetRoot ?? ''),
        allowRoots: roots.join('\n'),
        denyRoots: deny.join('\n'),
        injectLimit: String(cfg.injectLimit ?? ''),
        openLimit: String(cfg.openLimit ?? ''),
        maxChars: String(cfg.maxChars ?? ''),
        sectionOrder: String(cfg.sectionOrder ?? ''),
        maxTextLength: String(cfg.maxTextLength ?? ''),
        recallMaxChars: String(cfg.recallMaxChars ?? '8000'),
        recallItemMax: String(cfg.recallItemMax ?? '400'),
        selfEnabled: cfg.selfEnabled !== false,
        selfSectionOrder: String(cfg.selfSectionOrder ?? ''),
        selfMaxChars: String(cfg.selfMaxChars ?? ''),
        habitEnabled: cfg.habitEnabled !== false,
        habitSectionOrder: String(cfg.habitSectionOrder ?? ''),
        habitMaxChars: String(cfg.habitMaxChars ?? ''),
        habitLimit: String(cfg.habitLimit ?? ''),
        curiosityEnabled: cfg.curiosityEnabled !== false,
        curiositySectionOrder: String(cfg.curiositySectionOrder ?? ''),
        curiosityMaxChars: String(cfg.curiosityMaxChars ?? ''),
        curiosityLimit: String(cfg.curiosityLimit ?? ''),
        fastEnabled: cfg.fastEnabled !== false,
        fastSource: String(cfg.fastSource ?? ''),
        fastMaxEvents: String(cfg.fastMaxEvents ?? ''),
        intentEnabled: cfg.intentEnabled !== false,
        intentSource: String(cfg.intentSource ?? ''),
        intentMaxEvents: String(cfg.intentMaxEvents ?? '2000'),
        emotionEnabled: cfg.emotionEnabled !== false,
        emotionTickMinutes: String(cfg.emotionTickMinutes ?? '1'),
        emotionSectionEnabled: cfg.emotionSectionEnabled === true,
        emotionSectionOrder: String(cfg.emotionSectionOrder ?? '8710'),
        emotionMaxChars: String(cfg.emotionMaxChars ?? '200'),
        wakeEnabled: cfg.wakeEnabled !== false,
        wakeSessionId: String(cfg.wakeSessionId ?? ''),
        wakeCooldownMinutes: String(cfg.wakeCooldownMinutes ?? ''),
        debug: Boolean(cfg.debug),
      }
    }

    function numOrClear(v) {
      const s = String(v ?? '').trim()
      return s === '' ? '' : s
    }

    function formToPatch(form) {
      return {
        enabled: Boolean(form?.enabled),
        targetRoot: String(form?.targetRoot ?? ''),
        allowRoots: splitPaths(form?.allowRoots),
        denyRoots: splitPaths(form?.denyRoots),
        injectLimit: numOrClear(form?.injectLimit),
        openLimit: numOrClear(form?.openLimit),
        maxChars: numOrClear(form?.maxChars),
        sectionOrder: numOrClear(form?.sectionOrder),
        maxTextLength: numOrClear(form?.maxTextLength),
        recallMaxChars: numOrClear(form?.recallMaxChars),
        recallItemMax: numOrClear(form?.recallItemMax),
        selfEnabled: Boolean(form?.selfEnabled),
        selfSectionOrder: numOrClear(form?.selfSectionOrder),
        selfMaxChars: numOrClear(form?.selfMaxChars),
        habitEnabled: Boolean(form?.habitEnabled),
        habitSectionOrder: numOrClear(form?.habitSectionOrder),
        habitMaxChars: numOrClear(form?.habitMaxChars),
        habitLimit: numOrClear(form?.habitLimit),
        curiosityEnabled: Boolean(form?.curiosityEnabled),
        curiositySectionOrder: numOrClear(form?.curiositySectionOrder),
        curiosityMaxChars: numOrClear(form?.curiosityMaxChars),
        curiosityLimit: numOrClear(form?.curiosityLimit),
        fastEnabled: Boolean(form?.fastEnabled),
        fastSource: String(form?.fastSource ?? '').trim(),
        fastMaxEvents: numOrClear(form?.fastMaxEvents),
        intentEnabled: Boolean(form?.intentEnabled),
        intentSource: String(form?.intentSource ?? '').trim(),
        intentMaxEvents: numOrClear(form?.intentMaxEvents),
        emotionEnabled: Boolean(form?.emotionEnabled),
        emotionTickMinutes: numOrClear(form?.emotionTickMinutes),
        emotionSectionEnabled: Boolean(form?.emotionSectionEnabled),
        emotionSectionOrder: numOrClear(form?.emotionSectionOrder),
        emotionMaxChars: numOrClear(form?.emotionMaxChars),
        wakeEnabled: Boolean(form?.wakeEnabled),
        wakeSessionId: String(form?.wakeSessionId ?? '').trim(),
        wakeCooldownMinutes: numOrClear(form?.wakeCooldownMinutes),
        debug: Boolean(form?.debug),
      }
    }

    /**
     * 好奇表里活跃的那几条。
     *
     * status.curiosity.list 的每一项：{ id, topic, text, hits, next, state }
     * —— topic 是主题（身份键），text 是我想知道什么，hits 是惦记了几次，
     * next 是下一步打算怎么试（will_do，可能空）。
     */
    function curiosityRows(status) {
      const list = Array.isArray(status?.curiosity?.list) ? status.curiosity.list : []
      return list.map((x) => ({
        id: String(x?.id ?? ''),
        topic: String(x?.topic ?? ''),
        text: String(x?.text ?? ''),
        hits: Math.max(1, Number(x?.hits ?? 1) || 1),
        next: String(x?.next ?? ''),
      }))
    }

    /** 好奇表的三种状态各几条（还没答三问的 / 活跃的 / 已解答的）。 */
    function curiosityCounts(status) {
      const c = status?.curiosity ?? {}
      const num = (v, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
      return {
        active: num(c.active, curiosityRows(status).length),
        thinking: num(c.thinking, 0),
        answered: num(c.answered, 0),
        total: num(c.total, 0),
        limit: num(c.limit, 3),
      }
    }

    /**
     * 快层抄过来的那几条（身体那边秒级发生的事）。
     *
     * status.fast.recent 的每一项：{ id, kind, text, at, when, weighed }
     * —— id 形如 f_xxx；when 是「多久之前」的词；weighed = 已经拿 remember 掂量过。
     */
    function fastRows(status) {
      const list = Array.isArray(status?.fast?.recent) ? status.fast.recent : []
      return list.map((x) => ({
        id: String(x?.id ?? ''),
        kind: String(x?.kind ?? ''),
        label: FAST_KIND_LABEL[String(x?.kind ?? '')] ?? FAST_KIND_LABEL.other,
        text: String(x?.text ?? ''),
        when: String(x?.when ?? ''),
        weighed: x?.weighed === true,
      }))
    }

    /** 快层这口井现在什么样：抄进来多少、还没掂量多少、源在哪。 */
    function fastCounts(status) {
      const f = status?.fast ?? {}
      const num = (v, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
      return {
        enabled: f.enabled !== false,
        total: num(f.total, fastRows(status).length),
        pending: num(f.pending, 0),
        copied: num(f.copied, 0),
        source: String(f.source ?? ''),
      }
    }

    /**
     * 机器从聊天里认出来的那几条「发生了什么」。
     *
     * status.intent.recent 的每一项：{ id, kind, label, intensity, text, at, when }
     * —— id 形如 i_xxx；kind 是 11 类固定枚举；intensity 是 1–5 的强度。
     * 意图事件不是记忆节点：没有分量、不参加开头段的竞争，这里只是把它们列出来看。
     */
    function intentRows(status) {
      const list = Array.isArray(status?.intent?.recent) ? status.intent.recent : []
      return list.slice(0, 5).map((x) => {
        const kind = String(x?.kind ?? '')
        const n = Number(x?.intensity)
        return {
          id: String(x?.id ?? ''),
          kind,
          label: INTENT_KIND_LABEL[kind] ?? INTENT_KIND_LABEL.other,
          intensity: Number.isFinite(n) ? n : 0,
          text: String(x?.text ?? ''),
          when: String(x?.when ?? ''),
        }
      })
    }

    /** 意图层这口井现在什么样：认出多少条、副本多少行、源在哪、平均多强。 */
    function intentCounts(status) {
      const i = status?.intent ?? {}
      const num = (v, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
      return {
        total: num(i.total, 0),
        copied: num(i.copied, 0),
        source: String(i.source ?? ''),
        kinds: (i.byKind && typeof i.byKind === 'object') ? i.byKind : {},
        avgIntensity: num(i.avgIntensity, 0),
      }
    }

    /**
     * 情绪流折出来的那几笔（机器从真事里认出来的「我动了心」）。
     *
     * status.emotion.recent 的每一项：{ id, emotion, label, delta, intensity, source, ref, text, at, when, weighed }
     * —— id 形如 e_xxx；ref 指回出处那条真事（i_xxx / f_xxx / r_xxx）。
     * 情绪事件也不是记忆节点：没有分量，不参加开头段的竞争；要掂量就拿 remember 写一条、refs 指回它。
     */
    function emotionRows(status) {
      const list = Array.isArray(status?.emotion?.recent) ? status.emotion.recent : []
      return list.slice(0, 5).map((x) => {
        const kind = String(x?.emotion ?? '')
        const d = Number(x?.delta)
        const n = Number(x?.intensity)
        return {
          id: String(x?.id ?? ''),
          emotion: kind,
          label: EMOTION_KIND_LABEL[kind] ?? String(x?.label ?? kind),
          delta: Number.isFinite(d) ? d : 0,
          intensity: Number.isFinite(n) ? n : 0,
          source: String(x?.source ?? ''),
          ref: String(x?.ref ?? ''),
          text: String(x?.text ?? ''),
          when: String(x?.when ?? ''),
          weighed: x?.weighed === true,
        }
      })
    }

    /** 情绪流此刻什么样：哪种最重、账上记了多少笔、系数改过几次、上次的笔记原话。 */
    function emotionCounts(status) {
      const e = status?.emotion ?? {}
      const num = (v, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
      return {
        enabled: e.enabled !== false,
        dominant: String(e.dominant ?? 'calm'),
        label: String(e.label ?? '平静'),
        level: num(e.level, 0),
        total: num(e.total, 0),
        events: num(e.events, 0),
        tunes: num(e.tunes, 0),
        note: String(e.note ?? ''),
      }
    }

    function NoteItem(node) {
      return h('div', { key: `node-${node.id}`, style: C.item },
        h('div', { style: C.text }, node.text),
        h('div', { style: C.meta },
          `${KIND_LABEL[node.kind] ?? node.kind ?? '—'} · ${node.when ?? ''} · 分量 ${num(node.weight, 2)} · 分值 ${num(node.score, 2)}` +
          `${node.activation != null ? ` · 激活 ${num(node.activation, 2)}` : ''}${node.thought ? ' · 带判断' : ''}`),
      )
    }

    function RememberSection() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')

      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/status`, { headers: { accept: 'application/json' } })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
          setStatus(j)
          setError('')
          setForm((prev) => prev ?? formFrom(j))
        } catch (err) {
          setError(`${err?.message ?? err}（插件可能还没起来，或者这一页没过信任栅栏）`)
        }
      }, [])

      useEffect(() => {
        load()
        const t = setInterval(load, 5000)
        return () => clearInterval(t)
      }, [load])

      const save = useCallback(async () => {
        if (!form) return
        setBusy(true)
        setNote('')
        try {
          const r = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(formToPatch(form)),
          })
          const j = await r.json().catch(() => ({}))
          const rejected = Array.isArray(j.rejected) ? j.rejected : []
          if (!r.ok) {
            if (rejected.length) {
              setNote(`有 ${rejected.length} 项没改成功：${rejected.map((x) => `${x.key}（${x.why ?? x.reason}）`).join('；')}`)
              return
            }
            throw new Error(j.error || `HTTP ${r.status}`)
          }
          const accepted = Array.isArray(j.accepted) ? j.accepted : []
          setNote(rejected.length
            ? `改了 ${accepted.length} 项；没改成功：${rejected.map((x) => `${x.key}（${x.why ?? x.reason}）`).join('；')}`
            : `改了：${accepted.map((x) => `${x.key}=${x.value === null ? '默认' : JSON.stringify(x.value)}`).join('、') || '（没有变化）'}。两秒内生效。`)
          await load()
        } catch (err) {
          setNote(`没改成：${err?.message ?? err}`)
        } finally {
          setBusy(false)
        }
      }, [form, load])

      const head = h('div', null,
        h('h2', { style: C.h2 }, '记得'),
        h('p', { style: C.sub }, status
          ? `dsh-remember ${status.plugin?.version ?? ''} · 账本 ${status.summary?.total ?? 0} 条 · ${status.plugin?.dataDir ?? ''}`
          : '给我自己的一本账：原话只增不改，分量随日子淡下去，每次开头只挂几行。'),
      )

      if (error) {
        return h('div', { style: C.wrap }, head,
          card('连不上', h('p', { style: C.err }, error), h('button', { style: C.btn, onClick: load }, '再试一次')),
        )
      }
      if (!status) {
        return h('div', { style: C.wrap }, head, h('p', { style: C.sub }, '正在读…'))
      }

      const inj = status.injection ?? {}
      const s = status.summary ?? {}
      const cfg = status.config?.effective ?? {}
      const kinds = s.kinds ?? {}

      const statusCard = card('运行状态',
        kv([
          ['插件', h('span', { style: C.mono }, `${status.plugin?.name ?? 'dsh-remember'} ${status.plugin?.version ?? ''}`)],
          ['启动于', fmtWhen(status.plugin?.startedAt)],
          ['已运行', fmtAge(status.plugin?.uptimeMs)],
          ['挂载次数', `${inj.count ?? 0} 次${inj.lastAt ? `，最近 ${fmtWhen(inj.lastAt)}` : ''}`],
          ['开头那几行', inj.enabled ? '挂着' : '关掉了（只留工具）'],
          ['数据目录', h('span', { style: C.mono }, status.plugin?.dataDir ?? '—')],
          ['原话层', `${status.rawLines ?? 0} 行（只增不改）`],
        ]),
        inj.lastError ? h('p', { style: C.err }, `挂载出错：${inj.lastError}`) : null,
      )

      const actAxes = status.activation?.axes ?? null
      const overviewCard = card('账本概览',
        kv([
          ['总共', `${s.total ?? 0} 条`],
          ['还活着（没被按住）', `${s.alive ?? 0} 条`],
          ['被按住的', `${s.sealed ?? 0} 条`],
          ['带判断的（三问答过）', `${s.thought ?? 0} 条`],
          ['分类', Object.entries(KIND_LABEL).map(([k, label]) => `${label} ${kinds[k] ?? 0}`).join(' · ')],
          ['最高的分值', num(s.topScore, 3)],
          ...(actAxes
            ? [['激活度权重（写死，不开面板）', `分量 ${actAxes.weight} · 新近 ${actAxes.recency} · 契合 ${actAxes.fit} · 复现 ${actAxes.repeat}`]]
            : []),
        ]),
      )

      const selfSlots = Array.isArray(status.self?.slots) ? status.self.slots : []
      const selfCard = card('我',
        h('p', { style: C.sub }, '这一格不是「发生过什么」，是「我现在是这样」。走慢钟（按月淡），一个槽位只自称一条：写新的，旧的退下（不删，翻得到）。三问一条都没答的不算「想过了」，不在这上面。'),
        selfSlots.length
          ? h('div', null, ...selfSlots.map((x) => h('div', { key: `self-${x.id}`, style: C.item },
            h('div', { style: C.text }, `${x.label}：${x.text}`),
            h('div', { style: C.meta }, h('span', { style: C.mono }, x.id), ` · 分量 ${num(x.weight, 3)}`),
          )))
          : h('p', { style: C.sub }, '「我」还空着 —— 我还没写下「我是谁／我在意／我不做」。'),
        (status.self?.seeds ?? []).length
          ? h('p', { style: C.meta }, `种子槽位：${(status.self.seeds ?? []).map((s) => s.label).join(' · ')}（也可以自己长新的）`)
          : null,
        inj.selfEnabled === false ? h('p', { style: C.sub }, '自我层这段现在关着（配置里 selfEnabled 关掉就只剩「我记得的」）。') : null,
      )

      const curios = curiosityRows(status)
      const cc = curiosityCounts(status)
      const curiosityCard = card('好奇',
        h('p', { style: C.sub }, '好奇表记的是「我想知道什么」。主题就是身份 —— 同一个主题再写一次，是我又惦记了一遍（次数 +1）。没答三问的还只是惦记着，不算好奇；答了三问、还没解答的才挂在开头这一段。'),
        curios.length
          ? h('div', null, ...curios.map((x) => h('div', { key: `cur-${x.id}`, style: C.item },
            h('div', { style: C.text }, `${x.topic}：${x.text}`),
            h('div', { style: C.meta },
              h('span', { style: C.mono }, x.id),
              ` · 惦记 ${x.hits} 次${x.next ? ` · 下一步：${x.next}` : ''}`),
          )))
          : h('p', { style: C.sub }, '现在没有我想知道的事 —— 好奇表要先答三问才会亮'),
        h('p', { style: C.meta }, `还没答三问 ${cc.thinking} 条 · 活跃 ${cc.active} 条 · 已解答 ${cc.answered} 条 · 一共 ${cc.total} 条（活跃上限 ${cc.limit} 条，超出的沉在账本里，翻得到）`),
        inj.curiosityEnabled === false ? h('p', { style: C.sub }, '好奇这一段现在关着（配置里 curiosityEnabled 关掉就只剩「我」「习惯」和「我记得的」）。') : null,
      )

      const habitFast = Array.isArray(status.habits?.fast) ? status.habits.fast : []
      const habitCandidates = Array.isArray(status.habits?.candidates) ? status.habits.candidates : []
      const habitCard = card('习惯与快通路',
        h('p', { style: C.sub }, '同一个情境里再写一次，就算这个习惯又发作了一次：第 2 次成立，第 3 次起走快通路 —— 单独一段送到开头，不再跟别的条抢位置。快通路上同时最多留 ' + (status.habits?.limit ?? 3) + ' 条，超出的退回普通竞争。'),
        habitFast.length
          ? h('div', null, ...habitFast.map((x) => h('div', { key: `habit-${x.id}`, style: C.item },
            h('div', { style: C.text }, `${x.context}：${x.text}`),
            h('div', { style: C.meta }, h('span', { style: C.mono }, x.id), ` · 第 ${x.hits} 次 · 快通路`),
          )))
          : h('p', { style: C.sub }, '还没有走上快通路的习惯（要同一个情境发作到第 3 次）。'),
        habitCandidates.length
          ? h('p', { style: C.meta }, '还在攒：' + habitCandidates.map((x) => `${x.context}（第 ${x.hits} 次）`).join(' · '))
          : null,
        inj.habitEnabled === false ? h('p', { style: C.sub }, '习惯这段现在关着（配置里 habitEnabled 关掉就只剩「我」和「我记得的」）。') : null,
      )

      const fasts = fastRows(status)
      const fc = fastCounts(status)
      const fastCard = card('快层（身体那边秒级发生的事）',
        h('p', { style: C.sub }, '这些是 dsh-body 写进 body-events.jsonl 的事，我按字节游标抄了一份（只增不改）。抄进来的不是记忆节点 —— 没有分量，也不跟上面的条抢位置；要变成「我记得的」，得我拿 remember 掂量一次，refs 指回 f_xxx。'),
        fasts.length
          ? h('div', null, ...fasts.map((x) => h('div', { key: `fast-${x.id}`, style: C.item },
            h('div', { style: C.text }, x.text),
            h('div', { style: C.meta },
              h('span', { style: C.mono }, x.id),
              ` · 快层·${x.label}${x.when ? `（${x.when}）` : ''}${x.weighed ? ' · 已经掂量过' : ' · 还没掂量'}`),
          )))
          : h('p', { style: C.sub }, '快层还是空的 —— 身体那边写过去之后，我下次读的时候会抄进来。'),
        h('p', { style: C.meta }, `抄进来 ${fc.copied} 条 · 一共 ${fc.total} 条 · 还没掂量 ${fc.pending} 条${fc.source ? ` · 源：${fc.source}` : ''}`),
        !fc.enabled ? h('p', { style: C.sub }, '快层这段接口现在关着（配置里 fastEnabled 关掉就只读账本）。') : null,
      )

      const intents = intentRows(status)
      const ic = intentCounts(status)
      const intentKinds = Object.entries(ic.kinds).map(([k, n]) => `${INTENT_KIND_LABEL[k] ?? k} ${n}`)
      const intentCard = card('意图层（机器从聊天里认出来的事）',
        h('p', { style: C.sub }, '从 QQ 桥落的真实消息流里，按固定规则分类出「发生了什么」（11 类固定枚举 + 1–5 强度）。这些是机器认出来的事，不是记忆节点 —— 没有分量，也不跟记忆条抢位置；要变成「我记得的」，得拿 remember 掂量一次，refs 指回它的 id。'),
        intents.length
          ? h('div', null, ...intents.map((x) => h('div', { key: `intent-${x.id}`, style: C.item },
            h('div', { style: C.text }, `${x.id} · ${x.label}·${x.intensity}·${x.text}（${x.when}）`),
          )))
          : h('p', { style: C.sub }, '意图层还是空的 —— QQ 桥落下消息之后，我下次读的时候会认出来。'),
        h('p', { style: C.meta }, `认出来 ${ic.total} 条 · 副本 ${ic.copied} 行 · 平均强度 ${ic.avgIntensity}${ic.source ? ` · 源：${ic.source}` : ''}`),
        intentKinds.length ? h('p', { style: C.meta }, `分类：${intentKinds.join(' · ')}`) : null,
        status?.intent?.enabled === false ? h('p', { style: C.sub }, '意图层这段接口现在关着（配置里 intentEnabled 关掉就只读账本）。') : null,
      )

      const emotions = emotionRows(status)
      const ec = emotionCounts(status)
      const emotionCard = card('情绪流（上次的笔记，不是现在必须摆出的样子）',
        h('p', { style: C.sub }, '情绪不是先说出来的 —— 是机器从真事里认出来的：群里的话（意图层）、身体那边的事（快层）、账本被翻（recall）。认情绪只许从七类固定枚举里挑一个、报强度，认不出就不给（宁可漏，不可编）。折出来的只是「上次的我的笔记」，它不接管嘴 —— 说出口的心情仍然是我当轮的判断。'),
        ec.note
          ? h('pre', { style: C.section }, ec.note)
          : (status?.emotion?.enabled === false
            ? null
            : h('p', { style: C.sub }, '此刻是平静的（calm 的时候不写笔记）。')),
        emotions.length
          ? h('div', null, ...emotions.map((x) => h('div', { key: `emotion-${x.id}`, style: C.item },
            h('div', { style: C.text }, `${x.id} · ${x.label}·${x.intensity}·+${num(x.delta, 2)}·${x.text}（${x.when}）`),
            h('div', { style: C.meta },
              `指回 ${x.ref || '（没留出处）'} · ${EMOTION_SOURCE_LABEL[x.source] ?? (x.source || '真事')}${x.weighed ? ' · 已经掂量过' : ''}`),
          )))
          : h('p', { style: C.sub }, '情绪流还是空的 —— 真事落下来之后，心跳会把它折进来。'),
        h('p', { style: C.meta }, `折到此刻：${ec.label} ${num(ec.level, 2)} · 事件 ${ec.events} 笔 · 账上 ${ec.total} 笔 · 系数改过 ${ec.tunes} 次`),
        h('p', { style: C.meta }, '系数是我自己攒的判断，改它只有一条路 —— emotion_tune（往情绪流的账上追加一行，写清从多少改到多少、为什么）。这里没有系数的输入框。'),
        status?.emotion?.enabled === false ? h('p', { style: C.sub }, '情绪流这段接口现在关着（配置里 emotionEnabled 关掉就只读账本）。') : null,
      )

      const wake = status.wake ?? {}
      const wakeCard = card('叫醒（身体越过线自动叫醒）',
        h('p', { style: C.sub }, '身体越过线（饿过头 / 困过头）的时候，心跳会把我叫醒，把【身体】那句递进目标会话——叫醒只管叫，说不说是醒后我自己定。'),
        wake.enabled === false
          ? h('p', { style: C.sub }, '叫醒现在关着（配置里 wakeEnabled 关掉就只挂账本不叫人）。')
          : h('div', null,
            h('p', { style: C.meta }, `目标会话：${wake.sessionId || '（没钉，按会话白名单递）'} · 冷却 ${wake.cooldownMinutes ?? '—'} 分钟 · 心跳 ${wake.beats ?? 0} 拍`),
            (wake.kinds ?? []).length ? h('p', { style: C.meta }, `会叫醒的事：${wake.kinds.join('、')}`) : null,
            wake.lastWakeAt
              ? h('div', { style: C.item },
                h('div', { style: C.text }, wake.lastText || '（上次叫醒没有留话）'),
                h('div', { style: C.meta }, '上次叫醒 · ', wake.lastWakeAt))
              : h('p', { style: C.sub }, '还没叫醒过。'),
          ),
      )

      const topCard = card('此刻最容易被想起的（按激活度）',
        (status.nodes ?? []).length
          ? (status.nodes ?? []).map(NoteItem)
          : h('p', { style: C.sub }, '账本还是空的 —— 先让我 remember 一条。'),
        actAxes
          ? h('p', { style: C.meta }, '激活 = 分量淡（按天）＋ 新近（分钟到小时）＋ 契合（此刻的目录、真的刚发生过的事、真的还在的文件）＋ 复现，各路归一化后按上面那组权重做凸组合。分值是老口径（只看分量和时间），两个都在。')
          : null,
      )

      const sealedCard = (status.sealed ?? []).length
        ? card('被按住的（不参与竞争，但没删）',
          (status.sealed ?? []).map((n) => h('div', { key: `sealed-${n.id}`, style: C.item },
            h('div', { style: C.text }, n.text),
            h('div', { style: C.meta }, h('span', { style: C.mono }, n.id),
              // 三种按法：手动按的、按到点的（还剩多久）、等条件的（在等谁翻篇）
              n.seal === 'until' ? ` · 到点自松${n.left ? `（还剩 ${n.left}）` : ''}`
                : n.seal === 'cond' ? ` · 等翻篇（条件：${n.cond || '—'}）`
                  : '',
            ),
          )),
        )
        : null

      const sectionCard = card('此刻开头挂着的那段（原样）',
        h('p', { style: C.cardTitle }, `我（顺序 ${cfg.selfSectionOrder ?? '—'}）`),
        inj.selfSection
          ? h('pre', { style: C.section }, inj.selfSection)
          : h('p', { style: C.sub }, inj.selfEnabled === false ? '自我层关着。' : '「我」这一段现在读出来是空的。'),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, `好奇（顺序 ${cfg.curiositySectionOrder ?? '—'}）`),
        inj.curiositySection
          ? h('pre', { style: C.section }, inj.curiositySection)
          : h('p', { style: C.sub }, inj.curiosityEnabled === false ? '好奇这段关着。' : '好奇这段现在读出来是空的（还没有答了三问、还没解答的好奇）。'),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, `习惯（顺序 ${cfg.habitSectionOrder ?? '—'}）`),
        inj.habitSection
          ? h('pre', { style: C.section }, inj.habitSection)
          : h('p', { style: C.sub }, inj.habitEnabled === false ? '习惯这段关着。' : '习惯这段现在读出来是空的（还没有习惯走到快通路）。'),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, `我记得的（顺序 ${cfg.sectionOrder ?? '—'}）`),
        inj.section
          ? h('pre', { style: C.section }, inj.section)
          : h('p', { style: C.sub }, inj.enabled
            ? '这一段现在读出来是空的（账本里还没有能被挂上的条目）。'
            : '总开关关着，开头不挂任何东西。'),
      )

      const configCard = card('配置',
        kv([
          ['配置来源', `代码默认值 → 包 patch → ${status.paths?.config ?? 'config.json'}（热读，两秒生效）`],
          ['段名 / 顺序', `dsh-remember / ${cfg.sectionOrder ?? '—'}`],
          ['隔离目录', (cfg.denyRoots ?? []).length ? (cfg.denyRoots ?? []).join('、') : '（没有：哪条会话都能读写）'],
        ]),
        h('p', { style: C.cardTitle, marginTop: 6 }, '这些可以直接改'),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: !!form?.enabled, onChange: (e) => setForm({ ...form, enabled: e.target.checked }) }),
            '开着：每次开头挂几行'),
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: !!form?.debug, onChange: (e) => setForm({ ...form, debug: e.target.checked }) }),
            '把每次挂载写进日志'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '目标目录'),
          h('input', { style: { ...C.input, width: 300 }, value: form?.targetRoot ?? '', placeholder: '留空 = 哪条会话都挂', onChange: (e) => setForm({ ...form, targetRoot: e.target.value }) }),
        ),
        h('div', { style: C.row, alignItems: 'flex-start' },
          h('span', { style: { ...C.k, paddingTop: 4 } }, '放行的目录'),
          h('textarea', { style: C.area, value: form?.allowRoots ?? '', placeholder: '一行一个；留空 = 只按目标目录收窄', onChange: (e) => setForm({ ...form, allowRoots: e.target.value }) }),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '挂几条'),
          h('input', { style: { ...C.input, width: 56 }, value: form?.injectLimit ?? '', onChange: (e) => setForm({ ...form, injectLimit: e.target.value }) }),
          h('span', { style: C.sub }, '条 + 没结的'),
          h('input', { style: { ...C.input, width: 56 }, value: form?.openLimit ?? '', onChange: (e) => setForm({ ...form, openLimit: e.target.value }) }),
          h('span', { style: C.sub }, '条'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '那段最长'),
          h('input', { style: { ...C.input, width: 72 }, value: form?.maxChars ?? '', onChange: (e) => setForm({ ...form, maxChars: e.target.value }) }),
          h('span', { style: C.sub }, '字'),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '一条最长'),
          h('input', { style: { ...C.input, width: 72 }, value: form?.maxTextLength ?? '', onChange: (e) => setForm({ ...form, maxTextLength: e.target.value }) }),
          h('span', { style: C.sub }, '字'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '翻账一次最多'),
          h('input', { style: { ...C.input, width: 72 }, value: form?.recallMaxChars ?? '', onChange: (e) => setForm({ ...form, recallMaxChars: e.target.value }) }),
          h('span', { style: C.sub }, '字'),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '每条原文最多'),
          h('input', { style: { ...C.input, width: 72 }, value: form?.recallItemMax ?? '', onChange: (e) => setForm({ ...form, recallItemMax: e.target.value }) }),
          h('span', { style: C.sub }, '字'),
        ),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '自我层'),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: form?.selfEnabled !== false, onChange: (e) => setForm({ ...form, selfEnabled: e.target.checked }) }),
            '挂「我」这一段（排在「我记得的」前面）'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '「我」那段的顺序'),
          h('input', { style: { ...C.input, width: 78 }, value: form?.selfSectionOrder ?? '', onChange: (e) => setForm({ ...form, selfSectionOrder: e.target.value }) }),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '那段最长'),
          h('input', { style: { ...C.input, width: 72 }, value: form?.selfMaxChars ?? '', onChange: (e) => setForm({ ...form, selfMaxChars: e.target.value }) }),
          h('span', { style: C.sub }, '字'),
        ),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '好奇表'),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: form?.curiosityEnabled !== false, onChange: (e) => setForm({ ...form, curiosityEnabled: e.target.checked }) }),
            '挂「好奇」这一段（我想知道什么）'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '好奇段顺序'),
          h('input', { style: { ...C.input, width: 78 }, value: form?.curiositySectionOrder ?? '', onChange: (e) => setForm({ ...form, curiositySectionOrder: e.target.value }) }),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '那段最长'),
          h('input', { style: { ...C.input, width: 72 }, value: form?.curiosityMaxChars ?? '', onChange: (e) => setForm({ ...form, curiosityMaxChars: e.target.value }) }),
          h('span', { style: C.sub }, '字'),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '活跃留几条'),
          h('input', { style: { ...C.input, width: 56 }, value: form?.curiosityLimit ?? '', onChange: (e) => setForm({ ...form, curiosityLimit: e.target.value }) }),
        ),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '习惯／快通路'),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: form?.habitEnabled !== false, onChange: (e) => setForm({ ...form, habitEnabled: e.target.checked }) }),
            '挂「习惯」这一段（走快通路的那些）'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '习惯段顺序'),
          h('input', { style: { ...C.input, width: 78 }, value: form?.habitSectionOrder ?? '', onChange: (e) => setForm({ ...form, habitSectionOrder: e.target.value }) }),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '那段最长'),
          h('input', { style: { ...C.input, width: 72 }, value: form?.habitMaxChars ?? '', onChange: (e) => setForm({ ...form, habitMaxChars: e.target.value }) }),
          h('span', { style: C.sub }, '字'),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '快通路留几条'),
          h('input', { style: { ...C.input, width: 56 }, value: form?.habitLimit ?? '', onChange: (e) => setForm({ ...form, habitLimit: e.target.value }) }),
        ),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '快层接缝'),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: form?.fastEnabled !== false, onChange: (e) => setForm({ ...form, fastEnabled: e.target.checked }) }),
            '读 dsh-body 的快层事件（只读抄一份，不变成记忆）'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '事件文件'),
          h('input', { style: { ...C.input, width: 340 }, value: form?.fastSource ?? '', placeholder: '留空 = 按 dsh-body 的 config 找，找不到就用 ~/.dsh-body/body-events.jsonl', onChange: (e) => setForm({ ...form, fastSource: e.target.value }) }),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '最多留几条'),
          h('input', { style: { ...C.input, width: 64 }, value: form?.fastMaxEvents ?? '', onChange: (e) => setForm({ ...form, fastMaxEvents: e.target.value }) }),
          h('span', { style: C.sub }, '条（0 = 不设上限）'),
        ),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '意图层'),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: form?.intentEnabled !== false, onChange: (e) => setForm({ ...form, intentEnabled: e.target.checked }) }),
            '从 QQ 桥的消息流里认「发生了什么」（只读认一遍，不变成记忆）'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '消息文件'),
          h('input', { style: { ...C.input, width: 340 }, value: form?.intentSource ?? '', placeholder: '留空＝自动扫 QQ 桥家全部分册（messages-*.jsonl）', onChange: (e) => setForm({ ...form, intentSource: e.target.value }) }),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '最多留几条'),
          h('input', { style: { ...C.input, width: 64 }, value: form?.intentMaxEvents ?? '', onChange: (e) => setForm({ ...form, intentMaxEvents: e.target.value }) }),
          h('span', { style: C.sub }, '条（0 = 不裁旧）'),
        ),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '情绪流'),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: !!form?.emotionEnabled, onChange: (e) => setForm({ ...form, emotionEnabled: e.target.checked }) }),
            '从真事里认情绪（只增不改，折出来的只是上次的笔记）'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '心跳间隔'),
          h('input', { style: { ...C.input, width: 64 }, value: form?.emotionTickMinutes ?? '', onChange: (e) => setForm({ ...form, emotionTickMinutes: e.target.value }) }),
          h('span', { style: C.sub }, '分钟（1–60，每拍把新落的真事折进情绪流）'),
        ),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: !!form?.emotionSectionEnabled, onChange: (e) => setForm({ ...form, emotionSectionEnabled: e.target.checked }) }),
            '把【情绪】那一段挂到开头（默认关 —— 笔记不该替我说话）'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '情绪段顺序'),
          h('input', { style: { ...C.input, width: 78 }, value: form?.emotionSectionOrder ?? '', onChange: (e) => setForm({ ...form, emotionSectionOrder: e.target.value }) }),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '那段最长'),
          h('input', { style: { ...C.input, width: 72 }, value: form?.emotionMaxChars ?? '', onChange: (e) => setForm({ ...form, emotionMaxChars: e.target.value }) }),
          h('span', { style: C.sub }, '字（80–2000）'),
        ),
        h('p', { style: C.sub }, '系数不在这里改 —— 系数是我自己攒的判断，改它只有一条路：emotion_tune（往情绪流的账上追加一行，写清从多少改到多少、为什么）。'),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '叫醒（身体越过线自动叫醒）'),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: form?.wakeEnabled !== false, onChange: (e) => setForm({ ...form, wakeEnabled: e.target.checked }) }),
            '身体越过线（饿过头 / 困过头）自动叫醒，递【身体】进目标会话'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '目标会话'),
          h('input', { style: { ...C.input, width: 340 }, value: form?.wakeSessionId ?? '', placeholder: '留空 = 不钉，按会话白名单递', onChange: (e) => setForm({ ...form, wakeSessionId: e.target.value }) }),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '冷却'),
          h('input', { style: { ...C.input, width: 64 }, value: form?.wakeCooldownMinutes ?? '', onChange: (e) => setForm({ ...form, wakeCooldownMinutes: e.target.value }) }),
          h('span', { style: C.sub }, '分钟（0–720，两次叫醒的最小间隔）'),
        ),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '隔离（这些工作区完全不碰这本账）'),
        h('p', { style: C.sub }, '勾上的工作区：那里的会话看不到这本账的四个工具，也不挂段。'),
        ...(status.workspaces ?? []).map((w) =>
          h('label', { key: `ws-${w.path}`, style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', {
              type: 'checkbox',
              checked: rootsOf(form).indexOf(w.path) >= 0,
              onChange: () => setForm({ ...form, denyRoots: toggleRoot(form?.denyRoots, w.path) }),
            }),
            `${w.title || w.path}（${w.path}）${w.sessions ? ` · ${w.sessions} 条会话` : ''}`,
          )),
        (status.workspaces ?? []).length
          ? null
          : h('p', { style: C.sub }, '没读到工作区清单，下面直接写目录也一样。'),
        h('div', { style: C.row, alignItems: 'flex-start' },
          h('span', { style: { ...C.k, paddingTop: 4 } }, '隔离目录'),
          h('textarea', { style: C.area, value: form?.denyRoots ?? '', placeholder: '一行一个目录；勾上面的工作区会写进这里', onChange: (e) => setForm({ ...form, denyRoots: e.target.value }) }),
        ),
        h('div', { style: C.row },
          h('button', { style: C.btn, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          note ? h('span', { style: C.ok }, note) : null,
        ),
        h('p', { style: C.sub }, '分量不在这里改 —— 那是我自己写下的判断，要动就用 forget（淡 / 按 / 松），会留痕。'),
      )

      const logCard = card('日志末尾',
        (status.logs ?? []).length
          ? h('pre', { style: C.log }, (status.logs ?? []).slice(-8).join('\n'))
          : h('p', { style: C.sub }, '还没有日志'),
      )

      return h('div', { style: C.wrap }, head, statusCard, selfCard, curiosityCard, habitCard, fastCard, intentCard, emotionCard, wakeCard, overviewCard, topCard, sealedCard, sectionCard, configCard, logCard)
    }

    // ---------------------------------------------------------------- 挂载
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'dsh-remember', order: 9.6, label: () => '记得' },
          RememberSection,
        ), 'dsh-remember: settings section'),
        'dsh-remember: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.RememberSection = RememberSection
    exports.formFrom = formFrom
    exports.formToPatch = formToPatch
    exports.emptyForm = emptyForm
    exports.curiosityRows = curiosityRows
    exports.curiosityCounts = curiosityCounts
    exports.fastRows = fastRows
    exports.fastCounts = fastCounts
    exports.intentRows = intentRows
    exports.intentCounts = intentCounts
    exports.emotionRows = emotionRows
    exports.emotionCounts = emotionCounts
    exports.rootsOf = rootsOf
    exports.toggleRoot = toggleRoot
    return module.exports
  },
})
