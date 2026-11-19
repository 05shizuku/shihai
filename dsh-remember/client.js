/**
 * client.js —— 设置页里的「识海」那一节（浏览器半边）
 *
 * 为什么有这一半：宿主那半边只算数、写文件，界面得有个地方看。
 * 形态跟 dsh-body / dsh-fish 观测台一样：`settings.section`，在 App 内部同源
 * fetch `/dsh-remember/*`（cookie 天然带着），独立 HTML 页会被信任栅栏挡成 403。
 *
 * 2026-11-19 定案 E：按识的结构，不按考古层——
 *   识海（order 9.0）是唯一入口：三盏灯 → 桥/身总控块 → 总览（含总开关）
 *   → 五组（身心之间 / 感 / 记 / 我与思 / 界）→ 观测台 fold。
 *   旧的「记得」槽（order 9.6）退役。
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

    /** 感的 feel 词（定案 E 组二状态行）：永不报小数——情绪是感觉，不是指标。 */
    const FEEL_WORD = {
      warm: '心头有点暖',
      pleased: '心头有点亮',
      curious: '心头有点动',
      tense: '心头有点紧',
      down: '心头有点沉',
      restless: '心头有点躁',
      lonely: '心头有点空',
      calm: '平静',
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

    /** 折叠区：首屏只留最常用的，其余收进这里（小白不晕，我们要的都在）。 */
    function foldSection(title, hint, open, onToggle, ...children) {
      return h('div', { style: C.card },
        h('div', { style: C.row },
          h('button', { style: C.btn, onClick: onToggle }, `${open ? '▾' : '▸'} ${title}`),
          hint ? h('span', { style: C.meta }, hint) : null,
        ),
        open
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 } }, ...children.filter(Boolean))
          : null,
      )
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
      unsettledEnabled: true,
      unsettledSectionOrder: '8665',
      unsettledMaxChars: '240',
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
      streamEnabled: true,
      streamSectionOrder: '8715',
      streamSectionMaxChars: '360',
      recallOrigin: true,
      sproutBodyEnabled: true,
      sproutBodyMinLevel: '0.5',
      sproutBodyCooldownMinutes: '10',
      sproutBodyDailyCap: '3',
      sproutBodyFeelCooldownMinutes: '30',
      sproutBodyDailyTotalCap: '12',
      narrationEnabled: true,
      narrationIntervalDays: '7',
      narrationSectionOrder: '8662',
      narrationSectionMaxChars: '320',
      recallAudience: 'off',
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
        unsettledEnabled: cfg.unsettledEnabled !== false,
        unsettledSectionOrder: String(cfg.unsettledSectionOrder ?? ''),
        unsettledMaxChars: String(cfg.unsettledMaxChars ?? ''),
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
        streamEnabled: cfg.streamEnabled !== false,
        streamSectionOrder: String(cfg.streamSectionOrder ?? '8715'),
        streamSectionMaxChars: String(cfg.streamSectionMaxChars ?? '360'),
        recallOrigin: cfg.recallOrigin !== false,
        sproutBodyEnabled: cfg.sproutBodyEnabled !== false,
        sproutBodyMinLevel: String(cfg.sproutBodyMinLevel ?? '0.5'),
        sproutBodyCooldownMinutes: String(cfg.sproutBodyCooldownMinutes ?? '10'),
        sproutBodyDailyCap: String(cfg.sproutBodyDailyCap ?? '3'),
        sproutBodyFeelCooldownMinutes: String(cfg.sproutBodyFeelCooldownMinutes ?? '30'),
        sproutBodyDailyTotalCap: String(cfg.sproutBodyDailyTotalCap ?? '12'),
        narrationEnabled: cfg.narrationEnabled !== false,
        narrationIntervalDays: String(cfg.narrationIntervalDays ?? '7'),
        narrationSectionOrder: String(cfg.narrationSectionOrder ?? '8662'),
        narrationSectionMaxChars: String(cfg.narrationSectionMaxChars ?? '320'),
        recallAudience: String(cfg.recallAudience ?? 'off'),
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
        unsettledEnabled: Boolean(form?.unsettledEnabled),
        unsettledSectionOrder: numOrClear(form?.unsettledSectionOrder),
        unsettledMaxChars: numOrClear(form?.unsettledMaxChars),
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
        streamEnabled: Boolean(form?.streamEnabled),
        streamSectionOrder: numOrClear(form?.streamSectionOrder),
        streamSectionMaxChars: numOrClear(form?.streamSectionMaxChars),
        recallOrigin: Boolean(form?.recallOrigin),
        sproutBodyEnabled: Boolean(form?.sproutBodyEnabled),
        sproutBodyMinLevel: numOrClear(form?.sproutBodyMinLevel),
        sproutBodyCooldownMinutes: numOrClear(form?.sproutBodyCooldownMinutes),
        sproutBodyDailyCap: numOrClear(form?.sproutBodyDailyCap),
        sproutBodyFeelCooldownMinutes: numOrClear(form?.sproutBodyFeelCooldownMinutes),
        sproutBodyDailyTotalCap: numOrClear(form?.sproutBodyDailyTotalCap),
        narrationEnabled: Boolean(form?.narrationEnabled),
        narrationIntervalDays: numOrClear(form?.narrationIntervalDays),
        narrationSectionOrder: numOrClear(form?.narrationSectionOrder),
        narrationSectionMaxChars: numOrClear(form?.narrationSectionMaxChars),
        recallAudience: String(form?.recallAudience ?? 'off'),
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

      const load = useCallback(async (force) => {
        try {
          const r = await fetch(`${API}/status`, { headers: { accept: 'application/json' } })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
          setStatus(j)
          setError('')
          setForm((prev) => (force ? formFrom(j) : (prev ?? formFrom(j))))
        } catch (err) {
          setError(`${err?.message ?? err}（插件可能还没起来，或者这一页没过信任栅栏）`)
        }
      }, [])

      useEffect(() => {
        load()
        const t = setInterval(load, 5000)
        return () => clearInterval(t)
      }, [load])

      // 总控卡在别的段落改了配置 → 把表单刷新成最新（带编辑中的字会被盖掉，保存后才会发生）
      useEffect(() => {
        const onChanged = (e) => { if (e?.detail?.plugin === 'remember') load(true) }
        window.addEventListener('dsh-shihai:config-changed', onChanged)
        return () => window.removeEventListener('dsh-shihai:config-changed', onChanged)
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
          try { window.dispatchEvent(new CustomEvent('dsh-shihai:config-changed', { detail: { plugin: 'remember' } })) } catch { /* ignore */ }
        } catch (err) {
          setNote(`没改成：${err?.message ?? err}`)
        } finally {
          setBusy(false)
        }
      }, [form, load])

      // 折叠区（2026-11-19 定案 E：按识的结构，不按考古层——五组 + 观测台）
      const [folds, setFolds] = useState({ body: true, sense: false, memory: true, self: false, bounds: false, observatory: false })
      const toggleFold = useCallback((k) => setFolds((prev) => ({ ...prev, [k]: !prev[k] })), [])
      const [test, setTest] = useState(null)
      const [testBusy, setTestBusy] = useState(false)
      const runSelfTest = useCallback(async () => {
        setTestBusy(true)
        setTest(null)
        try {
          const r = await fetch(`${API}/selftest`, { method: 'POST', headers: { accept: 'application/json' } })
          const j = await r.json().catch(() => ({}))
          setTest(j)
        } catch (err) {
          setTest({ ok: false, note: `没连上：${err?.message ?? err}` })
        } finally {
          setTestBusy(false)
        }
      }, [])

      if (error) {
        return h('div', { style: C.wrap },
          card('连不上', h('p', { style: C.err }, error), h('button', { style: C.btn, onClick: load }, '再试一次')),
        )
      }
      if (!status) {
        return h('div', { style: C.wrap }, h('p', { style: C.sub }, '正在读…'))
      }

      const inj = status.injection ?? {}
      const s = status.summary ?? {}
      const cfg = status.config?.effective ?? {}
      const kinds = s.kinds ?? {}

      // 健康态：一句人话说清现状
      const healthOk = Boolean(cfg.enabled) && inj.enabled !== false
      const healthLine = healthOk
        ? '● 开着，一切正常'
        : inj.enabled === false
          ? '◐ 总开关开着，但开头段没在挂（看组三的挂载设置）'
          : '○ 关着（勾上总开关再保存就行）'

      // 四机制活性行（定案 E）：思量 / 智 / 执受 / 瀑流——数据源全在 status
      const nar = status.narration ?? {}
      const wis = status.wisdom ?? {}
      const spr = status.sprout ?? {}
      const activityLine = `思量 ${nar.count ?? 0} 条${nar.latest?.at ? `（链头 ${fmtWhen(nar.latest.at)}）` : ''} · 智 ${wis.count ?? 0} 条 · 执受今日 ${spr.today ?? 0} 次 · 瀑流段 ${cfg.streamEnabled !== false ? '挂' : '关'}`

      // 组〇 总览（不折叠）：版本行 + 账本行 + 四机制活性行 + 总开关（全页唯一显著旋钮）
      const overviewCard = card('总览',
        h('p', { style: { ...C.text, fontSize: 14.5 } }, healthLine),
        h('p', { style: C.sub },
          `dsh-remember ${status.plugin?.version ?? ''} · 账本 ${s.total ?? 0} 条（活着 ${s.alive ?? 0} · 按住 ${s.sealed ?? 0}）· 原话 ${status.rawLines ?? 0} 行`),
        h('p', { style: C.sub }, activityLine),
        status.ledger?.broken
          ? h('p', { style: C.err },
            `⚠ 账本读不出能认的账，这次启动按空账算。原文备份${status.ledger.backupOk ? '已滚成 .bak（别删，恢复靠它）' : '没滚成 —— 先手动备份再动账本'}。`)
          : null,
        inj.lastError ? h('p', { style: C.err }, `最近一次出错：${inj.lastError}`) : null,
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 8, fontSize: 14 } },
            h('input', { type: 'checkbox', checked: !!form?.enabled, onChange: (e) => setForm({ ...form, enabled: e.target.checked }) }),
            '总开关：账本开着（每次对话开头挂几行记忆）'),
          h('button', { style: C.btn, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          note ? h('span', { style: C.ok }, note) : null,
        ),
        h('div', { style: C.row },
          h('button', { style: C.btn, disabled: testBusy, onClick: runSelfTest }, testBusy ? '测着呢…' : '测一下：读写通不通'),
          test
            ? (test.ok
              ? h('span', { style: C.ok }, `✅ ${test.note ?? '读写都通'}（${test.ms ?? '—'} 毫秒）`)
              : h('span', { style: C.err }, `❌ ${test.note ?? '自检没过'}`))
            : h('span', { style: C.meta }, '按一下当场验证：账本读得到、数据目录写得进。'),
        ),
      )

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
      const kindsCard = card('账本概览',
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
          // 向上的三层（定案 E 观测台增补）：思量链 / 智 / 执受
          ['思量链', nar.latest?.id
            ? `链头 ${nar.latest.id}（${fmtWhen(nar.latest.at)}）· 链长 ${nar.count ?? 0}`
            : '还没有思量'],
          ['智', wis.latest?.id
            ? `${wis.count ?? 0} 条 · 最新 ${wis.latest.id}（从 ${wis.latest.seedId || '—'} 提炼）`
            : '还没有智'],
          ['执受', `今日 ${spr.today ?? 0} 次 · 累计 ${spr.total ?? 0} 次`],
        ]),
      )

      const selfSlots = Array.isArray(status.self?.slots) ? status.self.slots : []
      const selfCard = card('我',
        h('p', { style: C.sub }, '这一格不是「发生过什么」，是「我现在是这样」。走慢钟（按月淡），一个槽位只自称一条：写新的，旧的退下（不删，翻得到）。挂了锚（锚）的条替这个槽说话，不被随手的新值顶掉；挂锚、换锚都要先答三年问（这条三年后还认不认）。三问一条都没答的不算「想过了」，不在这上面。'),
        selfSlots.length
          ? h('div', null, ...selfSlots.map((x) => h('div', { key: `self-${x.id}`, style: C.item },
            h('div', { style: C.text }, `${x.label}：${x.text}${x.anchor ? '（锚）' : ''}`),
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
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, `还没定的（顺序 ${cfg.unsettledSectionOrder ?? '—'}）`),
        inj.unsettledSection
          ? h('pre', { style: C.section }, inj.unsettledSection)
          : h('p', { style: C.sub }, inj.unsettledEnabled === false ? '还没定的这段关着。' : '「还没定的」这段现在读出来是空的（账本里还没有 doubt/open 的条）。'),
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

      // ---------------------------------------------------------------- 五组（定案 E，2026-11-19：按识的结构，不按考古层）
      const toggle = (key, checked, label) => h('div', { style: C.row },
        h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
          h('input', { type: 'checkbox', checked: !!checked, onChange: (e) => setForm({ ...form, [key]: e.target.checked }) }),
          label))
      const field = (key, label, hint, width = 72, placeholder = '') => h('div', { style: C.row },
        h('span', { style: C.k }, label),
        h('input', { style: { ...C.input, width }, value: String(form?.[key] ?? ''), placeholder, onChange: (e) => setForm({ ...form, [key]: e.target.value }) }),
        hint ? h('span', { style: C.sub }, hint) : null)

      // 组一 身心之间（10 键，默认开）：抄送、叫醒、心头一动
      const bodyGroup = [
        toggle('fastEnabled', form?.fastEnabled !== false, '读 dsh-body 的快层事件（只读抄一份，不变成记忆）'),
        field('fastSource', '事件文件', '（留空 = 自动找 body 家）', 340),
        field('fastMaxEvents', '最多留几条', '条（0–5000，超出的沉在文件里还翻得到）', 64),
        toggle('sproutBodyEnabled', form?.sproutBodyEnabled !== false, '执受反射弧——带情绪的现行通知身体（心头一动）'),
        field('sproutBodyMinLevel', '染色门浓度线', '（0.1–1，写下时颜色 ≥ 此线的种子现行时动身）', 64),
        field('sproutBodyCooldownMinutes', '动身冷却', '分钟（1–120，同一条种子两次动身的最小间隔）', 64),
        field('sproutBodyDailyCap', '每日动身', '次/天（1–20，同一条种子一天最多动身几次）', 64),
        field('sproutBodyFeelCooldownMinutes', '同感冷却', '分钟（30–720，同一种感觉两次播报的最小间隔——「心头一暖」说一次就够了）', 64),
        field('sproutBodyDailyTotalCap', '全局日帽', '次/天（3–50，所有种子合计的全局日帽）', 64),
        toggle('wakeEnabled', form?.wakeEnabled !== false, '身体越过线就把我叫醒（叫醒后说不说，我自己定）'),
        field('wakeSessionId', '目标会话', '（留空 = 自己找最近活跃的）', 340),
        field('wakeCooldownMinutes', '冷却', '分钟（0–720，两次叫醒最小间隔）', 64),
      ]

      // 组二 感（8 键，默认收）+ 状态行（feel 词，永不报小数）
      const senseGroup = [
        toggle('emotionEnabled', !!form?.emotionEnabled, '从真事里认情绪（只增不改，折出来的只是上次的笔记）'),
        field('emotionTickMinutes', '心跳间隔', '分钟（1–60，每拍把新落的真事折进情绪流）', 64),
        toggle('emotionSectionEnabled', !!form?.emotionSectionEnabled, '把【情绪】那一段挂到开头（默认关 —— 笔记不该替我说话）'),
        field('emotionSectionOrder', '情绪段顺序', '', 78),
        field('emotionMaxChars', '那段最长', '字（80–2000）', 72),
        toggle('intentEnabled', form?.intentEnabled !== false, '从 QQ 桥的消息流里认「发生了什么」（只读认一遍，不变成记忆）'),
        field('intentSource', '消息文件', '', 340, '留空＝自动扫 QQ 桥家全部分册（messages-*.jsonl）'),
        field('intentMaxEvents', '最多留几条', '条（0 = 不裁旧）', 64),
        h('p', { style: C.sub }, `当前主导：${FEEL_WORD[ec.dominant] ?? ec.label ?? '平静'}`),
      ]

      // 组三 记（12 键，默认开）：挂几条、给多少字、截在哪
      const memoryGroup = [
        field('injectLimit', '挂几条', '条（＋没结的）', 56),
        field('openLimit', '没结的挂几条', '条', 56),
        field('maxChars', '那段最长', '字', 72),
        field('sectionOrder', '段顺序', '', 78),
        field('maxTextLength', '一条最长', '字', 72),
        field('recallMaxChars', '翻账一次最多', '字（工具返回每轮都带着）', 72),
        field('recallItemMax', '每条原文最多', '字（超了截断并标明）', 72),
        toggle('streamEnabled', form?.streamEnabled !== false, '挂「昨日之流」段（读侧聚合，同 UTC 日缓存）'),
        field('streamSectionOrder', '瀑流段顺序', '（8715，习惯之后、账本之前）', 78),
        field('streamSectionMaxChars', '瀑流段最多', '字（80–2000）', 72),
        toggle('recallOrigin', form?.recallOrigin !== false, 'recall 行尾带缘起链（x 前因「…」想起 + 机读 origins）'),
        toggle('debug', !!form?.debug, '把每次挂载写进日志'),
      ]

      // 组四 我与思（18 键，默认收）：我是谁、我在想什么、我明白了什么
      const selfGroup = [
        toggle('selfEnabled', form?.selfEnabled !== false, '挂「我」这一段（排在「我记得的」前面）'),
        field('selfSectionOrder', '「我」段顺序', '', 78),
        field('selfMaxChars', '「我」段最长', '字', 72),
        toggle('unsettledEnabled', form?.unsettledEnabled !== false, '挂「还没定的」这一段（doubt＋open 合一个摊位，固定晒一条）'),
        field('unsettledSectionOrder', '还没定的段顺序', '', 78),
        field('unsettledMaxChars', '还没定的段最长', '字', 72),
        toggle('habitEnabled', form?.habitEnabled !== false, '挂「习惯」这一段（走快通路的那些）'),
        field('habitSectionOrder', '习惯段顺序', '', 78),
        field('habitMaxChars', '习惯段最长', '字', 72),
        field('habitLimit', '快通路留几条', '', 56),
        toggle('curiosityEnabled', form?.curiosityEnabled !== false, '挂「好奇」这一段（我想知道什么）'),
        field('curiositySectionOrder', '好奇段顺序', '', 78),
        field('curiosityMaxChars', '好奇段最长', '字', 72),
        field('curiosityLimit', '活跃留几条', '', 56),
        toggle('narrationEnabled', form?.narrationEnabled !== false, '挂「思量」段（恒审思量是我的动作，系统只给时机）'),
        field('narrationIntervalDays', '思量到期', '天（1–30，超过就提示「有一阵没这么看过自己了」）', 64),
        field('narrationSectionOrder', '思量段顺序', '（8662，紧跟我）', 78),
        field('narrationSectionMaxChars', '思量段最多', '字（80–2000）', 72),
      ]

      // 组五 界（4 键，默认收，敏感）：谁在听、谁能进
      const boundsGroup = [
        h('div', { style: C.row },
          h('span', { style: C.k }, '谁在听'),
          ...['off', 'soft', 'hard'].map((v) => h('label', { key: `ra-${v}`, style: { ...C.row, gap: 4, fontSize: 13 } },
            h('input', { type: 'radio', name: 'recallAudience', checked: (form?.recallAudience ?? 'off') === v, onChange: () => setForm({ ...form, recallAudience: v }) }),
            v === 'off' ? 'off（全可见，现状）' : v === 'soft' ? 'soft（别的场排尾上）' : 'hard（别的场不翻出来）',
          )),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '目标目录'),
          h('input', { style: { ...C.input, width: 300 }, value: form?.targetRoot ?? '', placeholder: '留空 = 哪条会话都挂', onChange: (e) => setForm({ ...form, targetRoot: e.target.value }) }),
        ),
        h('div', { style: C.row, alignItems: 'flex-start' },
          h('span', { style: { ...C.k, paddingTop: 4 } }, '放行的目录'),
          h('textarea', { style: C.area, value: form?.allowRoots ?? '', placeholder: '一行一个；留空 = 只按目标目录收窄', onChange: (e) => setForm({ ...form, allowRoots: e.target.value }) }),
        ),
        h('p', { style: C.sub }, '隔离（这些工作区完全不碰这本账）——勾上的工作区：那里的会话看不到这本账的工具，也不挂段。'),
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
        h('p', { style: C.sub }, '分量不在这里改 —— 那是我自己写下的判断，要动就用 forget（淡 / 按 / 松），会留痕。'),
      ]

      const logCard = card('日志末尾',
        (status.logs ?? []).length
          ? h('pre', { style: C.log }, (status.logs ?? []).slice(-8).join('\n'))
          : h('p', { style: C.sub }, '还没有日志'),
      )

      // 定案 E：总览（不折叠）→ 五组 → 观测台。总开关在总览，全页唯一显著旋钮。
      return h('div', { style: C.wrap },
        overviewCard,
        foldSection('组一 身心之间', '身体和识之间的三根线：抄送、叫醒、心头一动。', folds.body !== false, () => toggleFold('body'), ...bodyGroup),
        foldSection('组二 感', '机器从真事里认情绪、认事——认出来的只是笔记，不接管嘴。', !!folds.sense, () => toggleFold('sense'), ...senseGroup),
        foldSection('组三 记', '账本的旋钮：挂几条、给多少字、截在哪。', folds.memory !== false, () => toggleFold('memory'), ...memoryGroup),
        foldSection('组四 我与思', '我是谁、我在想什么、我明白了什么——这些的旋钮都在这。', !!folds.self, () => toggleFold('self'), ...selfGroup),
        foldSection('组五 界', '谁在听、谁能进——信任的边界。', !!folds.bounds, () => toggleFold('bounds'), ...boundsGroup),
        foldSection('观测台（咱们天天看的）', '账本 · 自我 · 好奇 · 习惯 · 快层 · 意图 · 情绪 · 叫醒 · 按住的 · 原样段 · 日志', !!folds.observatory, () => toggleFold('observatory'),
          statusCard, selfCard, curiosityCard, habitCard, fastCard, intentCard, emotionCard, wakeCard, kindsCard, topCard, sealedCard, sectionCard, logCard),
      )
    }

    // ---------------------------------------------------------------- 识海总控（三件套一页看 / 改）
    const HUB_TARGETS = [
      { key: 'remember', label: '识海记忆', api: '/dsh-remember' },
      { key: 'bridge', label: 'QQ 桥', api: '/dsh-qq-bridge' },
      { key: 'body', label: '身体', api: '/dsh-body' },
    ]
    const HUB_SENSITIVE = /token|secret|password/i
    const HUB_REDACTED = '已配置（不回显）'
    const HS = {
      pill: { display: 'inline-flex', gap: 6, alignItems: 'center', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: 999, padding: '3px 12px', fontSize: 12.5 },
      down: { color: 'var(--dsw-alias-label-tertiary)' },
      inputW: { fontSize: 13, padding: '3px 6px', borderRadius: 6, border: '.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', width: 280 },
      inputN: { fontSize: 13, padding: '3px 6px', borderRadius: 6, border: '.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', width: 120 },
    }

    /** 三份 status → 状态灯。谁没起来谁灰，互不连坐。 */
    function hubPills(results) {
      return HUB_TARGETS.map((t) => {
        const r = results?.[t.key]
        const j = r?.j
        const ok = Boolean(j && typeof j === 'object' && j.ok !== false)
        const version = String(j?.plugin?.version ?? j?.version ?? '')
        let note
        if (!ok) {
          if (r?.error) note = `没起来（${String(r.error).slice(0, 48)}）`
          else if (j && j.ok === false) note = `没起来（ok:false ${String(j.error ?? '').slice(0, 40)}）`
          else note = `没起来（${String(r?.diag ?? '无响应详情').slice(0, 48)}）`
        } else if (t.key === 'bridge') note = j.running ? '桥接着' : '桥没起'
        else if (t.key === 'body') note = '心跳在'
        else note = `账本 ${j?.summary?.total ?? 0} 条`
        return { key: t.key, label: t.label, ok, version, note }
      })
    }

    /** effective+overrides(+editable) → 能在总控里改的行。密钥和复杂值不搬进来，去各自面板改。 */
    function hubRows(effective, overrides, editable) {
      const eff = (effective && typeof effective === 'object') ? effective : {}
      const ov = (overrides && typeof overrides === 'object') ? overrides : {}
      const isScalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      const keys = (Array.isArray(editable) && editable.length) ? editable : Object.keys(eff)
      const rows = []
      let hidden = 0
      for (const key of keys) {
        if (!(key in eff)) continue
        const v = eff[key]
        if (HUB_SENSITIVE.test(key) || v === HUB_REDACTED || (typeof v === 'string' && v.includes('不回显'))) { hidden += 1; continue }
        const overridden = (key in ov) && JSON.stringify(ov[key]) !== JSON.stringify(v)
        if (typeof v === 'boolean') rows.push({ key, type: 'boolean', value: v, overridden })
        else if (typeof v === 'number') rows.push({ key, type: 'number', value: v, overridden })
        else if (Array.isArray(v) && v.every(isScalar)) rows.push({ key, type: 'list', value: v, overridden })
        else if (typeof v === 'string') rows.push({ key, type: 'string', value: v, overridden })
        else hidden += 1 // 对象、混杂数组：不进总控
      }
      return { rows, hidden }
    }

    /** 行 → 表单（列表摊平成逗号串，方便手改）。 */
    function hubFormFrom(rows) {
      const form = {}
      for (const r of rows ?? []) {
        form[r.key] = r.type === 'list' ? (r.value ?? []).join('，') : r.value
      }
      return form
    }

    /** 表单 vs 行：只挑真改了的键拼 patch；列表按逗号/顿号拆回去。 */
    function hubPatch(rows, form) {
      const patch = {}
      for (const r of rows ?? []) {
        const now = form?.[r.key]
        if (now === undefined) continue
        if (r.type === 'list') {
          const arr = String(now ?? '').split(/[,，、]\s*/).map((s) => s.trim()).filter(Boolean)
          if (JSON.stringify(arr) !== JSON.stringify(r.value ?? [])) patch[r.key] = arr
        } else if (r.type === 'number') {
          const n = Number(now)
          if (Number.isFinite(n) && n !== r.value) patch[r.key] = n
        } else if (r.type === 'boolean') {
          if (Boolean(now) !== Boolean(r.value)) patch[r.key] = Boolean(now)
        } else if (String(now ?? '') !== String(r.value ?? '')) {
          patch[r.key] = String(now ?? '')
        }
      }
      return patch
    }

    function HubSection() {
      const [res, setRes] = useState({})
      const [flip, setFlip] = useState({})
      const [cfgs, setCfgs] = useState({})
      const [open, setOpen] = useState({})

      const poll = useCallback(async () => {
        const out = {}
        await Promise.all(HUB_TARGETS.map(async (t) => {
          const s0 = Date.now()
          try {
            const r = await fetch(`${t.api}/status`, {
              headers: { accept: 'application/json' },
              signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(4000) : undefined,
            })
            const raw = await r.text()
            let j = null
            try { j = JSON.parse(raw) } catch { j = null }
            const ctype = (r.headers && r.headers.get) ? (r.headers.get('content-type') ?? '') : ''
            out[t.key] = r.ok
              ? { j, diag: `HTTP ${r.status} ${ctype.slice(0, 24) || '无类型'} ${raw.length}B ${Date.now() - s0}ms` }
              : { error: `${(j && j.error) || `HTTP ${r.status}`}（${ctype.slice(0, 24) || '无类型'} ${String(raw).slice(0, 60) || '空体'}）` }
          } catch (err) {
            out[t.key] = { error: `${String(err?.message ?? err).slice(0, 60)}（${Date.now() - s0}ms）` }
          }
        }))
        try { console.error('[dsh-remember:hub] poll', JSON.stringify(out).slice(0, 500)) } catch { /* 忽略 */ }
        setRes(out)
      }, [])

      const loadCfg = useCallback(async (key, force) => {
        const t = HUB_TARGETS.find((x) => x.key === key)
        if (!t) return
        setCfgs((prev) => ({ ...prev, [key]: { ...prev[key], busy: true } }))
        try {
          const r = await fetch(`${t.api}/config`, { headers: { accept: 'application/json' } })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
          const { rows, hidden } = hubRows(j.effective, j.overrides, j.editable)
          setCfgs((prev) => ({ ...prev, [key]: { rows, hidden, form: force ? hubFormFrom(rows) : (prev[key]?.form ?? hubFormFrom(rows)), loaded: true, error: '', note: prev[key]?.note ?? '' } }))
        } catch (err) {
          setCfgs((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), loaded: prev[key]?.loaded ?? false, error: String(err?.message ?? err) } }))
        }
      }, [])

      useEffect(() => {
        poll()
        const t = setInterval(poll, 5000)
        return () => clearInterval(t)
      }, [poll])

      useEffect(() => {
        const onChanged = (e) => {
          const key = e?.detail?.plugin
          if (HUB_TARGETS.some((t) => t.key === key)) {
            loadCfg(key, true)
            poll()
          }
        }
        window.addEventListener('dsh-shihai:config-changed', onChanged)
        return () => window.removeEventListener('dsh-shihai:config-changed', onChanged)
      }, [loadCfg, poll])

      const save = useCallback(async (key) => {
        const t = HUB_TARGETS.find((x) => x.key === key)
        const c = cfgs[key]
        if (!t || !c?.rows) return
        const patch = hubPatch(c.rows, c.form)
        const changed = Object.keys(patch).length
        if (!changed) {
          setCfgs((prev) => ({ ...prev, [key]: { ...prev[key], note: '没有改动' } }))
          return
        }
        setCfgs((prev) => ({ ...prev, [key]: { ...prev[key], busy: true, note: '' } }))
        try {
          const r = await fetch(`${t.api}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(patch),
          })
          const j = await r.json().catch(() => ({}))
          const rejected = Array.isArray(j.rejected) ? j.rejected : []
          const accepted = Array.isArray(j.accepted) ? j.accepted : []
          setCfgs((prev) => ({ ...prev, [key]: { ...prev[key], note: rejected.length
            ? `有 ${rejected.length} 项没改成功：${rejected.map((x) => `${x.key}（${x.why ?? x.reason}）`).join('；')}`
            : `改了：${accepted.map((x) => x.key).join('、') || '（没有变化）'}` } }))
          await loadCfg(key, true)
          try { window.dispatchEvent(new CustomEvent('dsh-shihai:config-changed', { detail: { plugin: key } })) } catch { /* ignore */ }
        } catch (err) {
          setCfgs((prev) => ({ ...prev, [key]: { ...prev[key], note: `没改成：${err?.message ?? err}` } }))
        }
      }, [cfgs, loadCfg])

      const pills = hubPills(res)
      const pillRow = h('div', { style: C.row },
        ...pills.map((p) => h('span', { key: `pill-${p.key}`, style: p.ok ? HS.pill : { ...HS.pill, ...HS.down } },
          p.ok ? '●' : '○',
          `${p.label}${p.version ? ` ${p.version}` : ''}`,
          h('span', { style: C.meta }, p.note),
        )),
        h('span', { style: C.meta }, '状态灯每 5 秒自刷'),
      )

      // 2026-11-19 定案 E：单一事实源——remember 的键映射撤出总控（识海段自己带总览+五组），
      // bridge/body 部分不动。
      const HUB_MASTER = {
        bridge: { key: 'enabled', label: '总开关', page: 'QQ 薄桥' },
        body: { key: 'topUpEnabled', label: '饭钱到线自动添饭', page: '身体' },
      }

      const summaryLine = (t, j) => {
        if (!j) return '（这拍没读到状态，5 秒后自刷）'
        if (t.key === 'bridge') {
          const m = j.messageLog ?? { enabled: false, stats: [] }
          return j.running
            ? `在跑，消息在递 · 等回的挂起 ${j.pendingSize ?? 0} 条 · 消息流 ${m.enabled ? `${m.stats.length} 册` : '关着'}`
            : '待机——白名单还空着，去「QQ 薄桥」页签走四步向导就活'
        }
        const hb = j.heartbeat ?? {}
        const rd = j.readings ?? {}
        const hbOk = hb.lastError == null && hb.ageMs != null && hb.ageMs <= (Number(hb.tickMs) || 300000) * 2
        return `${hbOk ? '心跳正常' : '心跳不对劲（看「身体」页签红字）'}（上一拍 ${hb.ageMs != null ? Math.round(hb.ageMs / 60000) : '—'} 分钟前）· 饿 ${num(rd.hunger, 0)}% · 精力 ${num(rd.energy, 0)}%`
      }

      const flipMaster = useCallback(async (t) => {
        const j = res[t.key]?.j
        const meta = HUB_MASTER[t.key]
        const cur = j?.config?.effective?.[meta.key]
        if (typeof cur !== 'boolean') return
        setFlip((prev) => ({ ...prev, [t.key]: true }))
        try {
          const r = await fetch(`${t.api}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ [meta.key]: !cur }),
          })
          const j2 = await r.json().catch(() => ({}))
          if (!r.ok && !j2.rejected) throw new Error(j2.error || `HTTP ${r.status}`)
          try { window.dispatchEvent(new CustomEvent('dsh-shihai:config-changed', { detail: { plugin: t.key } })) } catch { /* ignore */ }
        } catch { /* 改没改看下一拍状态灯，它说实话 */ }
        setFlip((prev) => ({ ...prev, [t.key]: false }))
        await poll()
      }, [res, poll])

      // 定案 E：桥/身的总控块照旧；remember 的块退役（识海段自己带总览+五组）
      const blocks = HUB_TARGETS.filter((t) => HUB_MASTER[t.key]).map((t) => {
        const p = pills.find((x) => x.key === t.key)
        const j = res[t.key]?.j
        const meta = HUB_MASTER[t.key]
        const cur = j?.config?.effective?.[meta.key]
        return h('div', { key: `hub-${t.key}`, style: C.card },
          h('div', { style: C.row },
            h('span', { style: { ...C.h2, fontSize: 14.5 } }, `${p?.ok ? '●' : '○'} ${t.label}`),
            p?.version ? h('span', { style: C.meta }, p.version) : null,
            h('span', { style: C.meta }, p?.note ?? ''),
          ),
          h('p', { style: C.sub }, summaryLine(t, j)),
          h('div', { style: C.row },
            h('label', { style: { ...C.row, gap: 8, fontSize: 13.5 } },
              h('input', {
                type: 'checkbox',
                checked: cur === true,
                disabled: typeof cur !== 'boolean' || !!flip[t.key],
                onChange: () => flipMaster(t),
              }),
              meta.label),
            h('span', { style: C.meta }, `细配置去左边「${meta.page}」页签`),
          ),
        )
      })

      return h('div', { style: C.wrap },
        h('div', null,
          h('h2', { style: C.h2 }, '识海'),
          h('p', { style: C.sub }, '三件套一页看：谁在跑、一句话现状。桥和身的总开关在这下面；识海自己的总览、五组旋钮和观测台也都在这一页。'),
        ),
        pillRow,
        ...blocks,
        RememberSection(),
      )
    }

    // ---------------------------------------------------------------- 挂载
    const inject = ['slots']

    function apply(ctx) {
      // 2026-11-19 并入识海段（定案 E）：dsh-remember 槽（order 9.6「记得」）退役，
      // 识海（order 9.0）成为唯一入口——总览 + 五组 + 观测台都在 HubSection 里。
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'dsh-shihai-hub', order: 9.0, label: () => '识海' },
          HubSection,
        ), 'dsh-remember: shihai hub section'),
        'dsh-remember: shihai hub section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.RememberSection = RememberSection
    exports.HubSection = HubSection
    exports.hubPills = hubPills
    exports.hubRows = hubRows
    exports.hubFormFrom = hubFormFrom
    exports.hubPatch = hubPatch
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
