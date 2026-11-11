/**
 * client.js —— 设置页里的「QQ 薄桥」那一节（浏览器半边）
 *
 * 形态跟 dsh-body 一样：settings.section + 同源 fetch `/dsh-qq-bridge/*`。
 * 这里只做两件事：
 *   ① 看：跑没跑、挂起几条、消息流几册、隔离栅栏现在是什么口径；
 *   ② 改：连接 / 白名单 / 行为 / 消息流 / 隔离三口子 —— 白名单字段，服务端（lib/report.js）再校验一遍。
 * token 只显示「配没配」，值不回显也不让在这里改（要改直接改 config.json）。
 * 改动写进 config.json，热重载/重启后生效 —— 页面上写清楚，不装作即时生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/dsh-qq-bridge'

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
      input: { fontSize: 13, padding: '3px 6px', borderRadius: 6, border: '.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', width: 220 },
      area: { fontSize: 12.5, padding: '6px 8px', borderRadius: 6, border: '.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', width: '100%', minHeight: 54, fontFamily: 'ui-monospace, Consolas, monospace', resize: 'vertical' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 },
      btn: { fontSize: 13, padding: '4px 12px', borderRadius: 7, border: '.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      err: { color: 'var(--dsw-alias-label-error, #c0392b)', fontSize: 12.5, lineHeight: '19px', margin: 0 },
      ok: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 },
      label: { fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary)' },
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

    function textRow(label, value, onChange, placeholder) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        h('span', { style: C.label }, label),
        h('input', { style: C.input, value, placeholder: placeholder || '', onChange: (e) => onChange(e.target.value) }),
      )
    }

    function areaRow(label, value, onChange, hint) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        h('span', { style: C.label }, label),
        h('textarea', { style: C.area, value, onChange: (e) => onChange(e.target.value) }),
        hint ? h('span', { style: C.label }, hint) : null,
      )
    }

    function checkRow(label, checked, onChange, hint) {
      return h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
        h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }),
        h('span', null, label),
        hint ? h('span', { style: C.label }, hint) : null,
      )
    }

    // ---------------------------------------------------------------- 配置表单
    /** 多行文本读成数组（换行 / 逗号 / 分号都算分隔，对齐 dsh-remember）。 */
    function splitLines(v) {
      return String(v ?? '')
        .split(/[\n,;，；]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    }

    function formFrom(effective) {
      const c = effective ?? {}
      return {
        enabled: c.enabled !== false,
        onebotHttp: c.onebotHttp ?? '',
        onebotWs: c.onebotWs ?? '',
        selfUin: c.selfUin ?? '',
        sessionId: c.sessionId ?? '',
        promptPrefix: c.promptPrefix ?? '【QQ】',
        allowUsers: (c.allowUsers ?? []).join('\n'),
        allowGroups: (c.allowGroups ?? []).join('\n'),
        pokeBack: c.pokeBack !== false,
        replyMaxChars: String(c.replyMaxChars ?? 500),
        staleSeconds: String(c.staleSeconds ?? 300),
        messageLogEnabled: c.messageLogEnabled !== false,
        messageLogMaxLines: String(c.messageLogMaxLines ?? 2000),
        targetRoot: c.targetRoot ?? '',
        allowRoots: (c.allowRoots ?? []).join('\n'),
        denyRoots: (c.denyRoots ?? []).join('\n'),
      }
    }

    function formToPatch(form) {
      return {
        enabled: form.enabled,
        onebotHttp: form.onebotHttp,
        onebotWs: form.onebotWs,
        selfUin: form.selfUin,
        sessionId: form.sessionId,
        promptPrefix: form.promptPrefix,
        allowUsers: splitLines(form.allowUsers),
        allowGroups: splitLines(form.allowGroups),
        pokeBack: form.pokeBack,
        replyMaxChars: form.replyMaxChars,
        staleSeconds: form.staleSeconds,
        messageLogEnabled: form.messageLogEnabled,
        messageLogMaxLines: form.messageLogMaxLines,
        targetRoot: form.targetRoot,
        allowRoots: splitLines(form.allowRoots),
        denyRoots: splitLines(form.denyRoots),
      }
    }

    function BridgeSection() {
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
          setForm((prev) => prev ?? formFrom(j?.config?.effective))
        } catch (err) {
          setError(`${err?.message ?? err}（桥可能没起，或这一页没被信任栅栏放行）`)
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
          if (!r.ok && !j.rejected) throw new Error(j.error || `HTTP ${r.status}`)
          const rejected = Array.isArray(j.rejected) ? j.rejected : []
          setNote(rejected.length
            ? `有 ${rejected.length} 项没改成功：${rejected.map((x) => `${x.key}（${x.reason}）`).join('；')}`
            : `改了：${(j.accepted ?? []).join('、') || '（没有变化）'}。写进了 config.json，热重载/重启后生效。`)
          await load()
        } catch (err) {
          setNote(`没改成：${err?.message ?? err}`)
        } finally {
          setBusy(false)
        }
      }, [form, load])

      const head = h('div', null,
        h('h2', { style: C.h2 }, 'QQ 薄桥'),
        h('p', { style: C.sub }, status
          ? `dsh-qq-bridge ${status.plugin?.version ?? ''} · ${status.running ? '在跑' : '待机'} · ${status.homeDir ?? ''}`
          : '收 QQ 的私聊和群 @，递进会话；回话按挂起精确认主发回去。'),
      )

      if (error) {
        return h('div', { style: C.wrap }, head,
          card('连不上', h('p', { style: C.err }, error), h('button', { style: C.btn, onClick: load }, '再试一次')),
        )
      }
      if (!status || !form) {
        return h('div', { style: C.wrap }, head, h('p', { style: C.sub }, '正在读…'))
      }

      const set = (key) => (v) => setForm((f) => ({ ...f, [key]: v }))
      const ml = status.messageLog ?? { enabled: false, stats: [] }
      const fence = status.fence ?? {}

      const statusCard = card('运行状态',
        kv([
          ['插件', h('span', { style: C.mono }, `dsh-qq-bridge ${status.plugin?.version ?? ''}`)],
          ['状态', status.running ? '在跑（白名单有人，WS 连着）' : '待机（enabled=false 或白名单空）'],
          ['等回的挂起', `${status.pendingSize ?? 0} 条（${status.staleSeconds ?? 300} 秒没回话就算过期）`],
          ['消息流', ml.enabled
            ? `${ml.stats.length} 册，共 ${ml.stats.reduce((n, x) => n + (x.lines || 0), 0)} 行（一个群/一个人一册）`
            : '关着（messageLogEnabled=false）'],
        ]),
        ml.stats.length
          ? h('div', { style: { ...C.mono, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'pre-wrap' } },
              ml.stats.map((x) => `${x.lines} 行  ${x.file}`).join('\n'))
          : null,
      )

      const connectCard = card('连接',
        textRow('OneBot HTTP 动作口', form.onebotHttp, set('onebotHttp'), 'http://127.0.0.1:3000'),
        textRow('OneBot WS 事件口', form.onebotWs, set('onebotWs'), 'ws://127.0.0.1:3001'),
        textRow('桥自己的号（防自环，可空）', form.selfUin, set('selfUin')),
        textRow('目标会话（可空 = 最近活跃那条）', form.sessionId, set('sessionId')),
        textRow('话前缀（认「这轮是替 QQ 回的」的记号）', form.promptPrefix, set('promptPrefix')),
        h('p', { style: C.label }, 'token 的配没配：' +
          `HTTP ${status.config?.effective?.httpToken || '未配置'} · WS ${status.config?.effective?.wsToken || '未配置'}（值不回显，要改直接改 config.json）`),
      )

      const whitelistCard = card('白名单',
        areaRow('允许私聊的 QQ 号（每行一个；空 = 一个字都不递）', form.allowUsers, set('allowUsers')),
        areaRow('允许记录的群号（每行一个；群 @ 我才会递话）', form.allowGroups, set('allowGroups')),
      )

      const behaviorCard = card('行为',
        checkRow('桥总开关（enabled）', form.enabled, set('enabled')),
        checkRow('有人戳我时戳回去', form.pokeBack, set('pokeBack'), '同一人一分钟内只回一次'),
        textRow('回话最长多少字', form.replyMaxChars, set('replyMaxChars')),
        textRow('等回话多久算过期（秒）', form.staleSeconds, set('staleSeconds')),
      )

      const messageLogCard = card('消息流',
        checkRow('把放行过的消息结构化记一份（意图层的事件源）', form.messageLogEnabled, set('messageLogEnabled'),
          '只记放行过的；不是记忆，没有分量'),
        textRow('每册最多留多少行（超了裁旧的）', form.messageLogMaxLines, set('messageLogMaxLines')),
      )

      const fenceCard = card('会话隔离',
        h('p', { style: C.label }, '先 denyRoots（黑名单，优先于一切）→ 再 allowRoots（填了就只放行名单）→ 最后 targetRoot（兜底根，留空不收窄）。管的是数据文件（消息流/挂起/seen/日志）；config.json 豁免。'),
        textRow('targetRoot（兜底放行根，可空）', form.targetRoot, set('targetRoot')),
        areaRow('allowRoots（显式白名单，每行一个；可空）', form.allowRoots, set('allowRoots')),
        areaRow('denyRoots（黑名单，每行一个）', form.denyRoots, set('denyRoots')),
        h('p', { style: { ...C.mono, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'pre-wrap' } },
          `现在：deny=${(fence.denyRoots ?? []).join(',') || '无'} allow=${(fence.allowRoots ?? []).join(',') || '无'} target=${fence.targetRoot || '未收窄'}`),
      )

      return h('div', { style: C.wrap },
        head,
        statusCard,
        connectCard,
        whitelistCard,
        behaviorCard,
        messageLogCard,
        fenceCard,
        h('div', { style: C.row },
          h('button', { style: C.btn, onClick: save, disabled: busy }, busy ? '在写…' : '保存（写 config.json，热重载后生效）'),
          note ? h('p', { style: C.ok }, note) : null,
        ),
      )
    }

    // ---------------------------------------------------------------- 挂载
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'dsh-qq-bridge', order: 9.7, label: () => 'QQ 薄桥' },
          BridgeSection,
        ), 'dsh-qq-bridge: settings section'),
        'dsh-qq-bridge: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.BridgeSection = BridgeSection
    return module.exports
  },
})
