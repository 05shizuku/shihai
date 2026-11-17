/**
 * dsh-reach · 设置页（client 半边）
 *
 * 挂进 设置 → 主动找我。四件事必须一眼看到：
 *   ① 现在开着没有、心跳还跳不跳；
 *   ② 还留着哪几句没说的话、什么时候到点 —— 这一栏是这个插件唯一的"内容"；
 *   ③ 空手回合（叫我自己问一句）今天用了几次、下次什么时候；
 *   ④ 送出去过什么 —— 免得我以为它悄悄替我说话了。
 *
 * 数据全走 host 挂的 /dsh-reach/*（同源 fetch，带 cookie）。
 * 样式只用宿主主题变量，不写死颜色，浅色深色都能看。
 */

window.__ModuleLoader__.load({
  id: 'dsh-reach',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/dsh-reach'
    const NAMES = { nav: '主动找我' }

    const C = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 24px' },
      h2: { margin: '0', fontSize: 15, fontWeight: 600 },
      sub: { margin: 0, fontSize: 12, opacity: 0.65, lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22))',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      cardTitle: { fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },
      kv: { display: 'grid', gridTemplateColumns: '104px 1fr', gap: '4px 10px', fontSize: 12, alignItems: 'baseline' },
      k: { opacity: 0.6 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22))',
        borderRadius: 6,
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12,
        padding: '4px 8px',
        minWidth: 92,
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, opacity: 0.85 },
      log: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        lineHeight: 1.55,
        opacity: 0.8,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 180,
        overflow: 'auto',
        margin: 0,
      },
      btn: {
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
      },
      err: { fontSize: 12, color: 'var(--dsw-alias-label-error, #c0392b)' },
      ok: { fontSize: 12, color: 'var(--dsw-alias-label-success, #2e8b57)' },
      entry: {
        border: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
        borderRadius: 6,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      },
      text: { fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    }

    function fmtWhen(isoStr) {
      if (!isoStr) return '—'
      const t = Date.parse(isoStr)
      if (!Number.isFinite(t)) return '—'
      const d = new Date(t)
      const now = new Date()
      const sameDay = d.toDateString() === now.toDateString()
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
    }

    function fmtAge(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      const s = Math.floor(n / 1000)
      if (s < 60) return `${s} 秒`
      const m = Math.floor(s / 60)
      if (m < 60) return `${m} 分钟`
      const hr = Math.floor(m / 60)
      if (hr < 48) return `${hr} 小时`
      return `${Math.floor(hr / 24)} 天`
    }

    function Card({ title, right, children }) {
      return h('div', { style: C.card }, h('div', { style: C.cardTitle }, title, right ?? null), children)
    }

    function KV({ pairs }) {
      const kids = []
      pairs.forEach(([k, v], i) => {
        kids.push(h('div', { key: `k${i}`, style: C.k }, k))
        kids.push(h('div', { key: `v${i}` }, v ?? '—'))
      })
      return h('div', { style: C.kv }, kids)
    }

    function BodySection() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [form, setForm] = useState(null)

      const load = useCallback(async () => {
        try {
          const r = await fetch(API + '/status', { headers: { accept: 'application/json' } })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          const j = await r.json()
          setStatus(j)
          setError('')
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 5000)
        return () => clearInterval(timer)
      }, [load])

      const post = useCallback(
        async (path, body) => {
          setBusy(path)
          setNotice('')
          try {
            const r = await fetch(API + path, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(body ?? {}),
            })
            const j = await r.json().catch(() => ({}))
            if (!r.ok || j.ok === false) throw new Error(j.error || j.note || `HTTP ${r.status}`)
            setNotice(path === '/checkin' ? '叫过自己一次了' : '好了')
            await load()
            return j
          } catch (err) {
            setNotice('')
            setError(String(err?.message ?? err))
            return null
          } finally {
            setBusy('')
          }
        },
        [load],
      )

      const saveConfig = useCallback(
        async (patch) => {
          setBusy('config')
          setNotice('')
          try {
            const r = await fetch(API + '/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(patch),
            })
            const j = await r.json().catch(() => ({}))
            if (j.rejected?.length) {
              setError(j.rejected.map((x) => `${x.key}：${x.why}`).join('；'))
            } else if (j.ok) {
              setError('')
              setNotice('改好了')
            } else {
              setError('一个都没改')
            }
            await load()
          } catch (err) {
            setError(String(err?.message ?? err))
          } finally {
            setBusy('')
          }
        },
        [load],
      )

      if (!status) {
        return h(
          'div',
          { style: C.wrap },
          h('div', { style: C.h2 }, NAMES.nav),
          error ? h('div', { style: C.err }, `读不到：${error}`) : h('div', { style: C.sub }, '读着呢……'),
        )
      }

      const cfg = status.config?.effective ?? {}
      const cur = form ?? cfg
      const setField = (key, value) => setForm({ ...cur, [key]: value })
      // 只发设置页真正改得了的键 —— 整个 effective 都发的话，服务端白名单外的键
      // （dataDir/tickMs）必被拒，保存成功了也显示红字（2026-11-17 复核抓的）。
      const EDITABLE_KEYS = [
        'enabled', 'checkInEnabled', 'urgeEnabled', 'debug',
        'checkInWindowStart', 'checkInWindowEnd', 'checkInEveryMinutes', 'checkInMaxPerDay',
        'checkInMinQuietMinutes', 'idleMinutes', 'maxTextLength',
        'urgeMaxPerDay', 'urgeCooldownMinutes', 'urgeFile',
        'allowRoots', 'targetRoot', 'denyRoots',
      ]
      const pickEditable = (obj) => {
        const out = {}
        for (const k of EDITABLE_KEYS) if (obj && obj[k] !== undefined) out[k] = obj[k]
        return out
      }
      const pending = status.entries ?? []
      const recent = status.recent ?? []
      const engine = status.engine ?? {}
      const ci = status.checkIn ?? {}
      const ug = status.urge ?? {}
      const counts = status.counts ?? {}

      return h(
        'div',
        { style: C.wrap },
        h('div', null, h('div', { style: C.h2 }, NAMES.nav), h('p', { style: C.sub }, '留一句话给以后：到点了，它把自己叫回这条会话一次，话由它自己说。家里亮了心事灯，也会空手叫醒它——叫醒归插件，说不说由它当场掂量。')),
        error ? h('div', { style: C.err }, error) : null,
        notice ? h('div', { style: C.ok }, notice) : null,

        h(
          Card,
          {
            title: '运行状态',
            right: h(
              'span',
              { style: { ...C.sub, marginLeft: 'auto' } },
              engine.enabled ? (cfg.checkInEnabled ? '开着' : '开着（空手回合关）') : '关着',
            ),
          },
          h(KV, {
            pairs: [
              ['版本', `${status.plugin?.name} v${status.plugin?.version}`],
              ['已运行', fmtAge(status.plugin?.uptimeMs)],
              ['心跳', `上次 ${fmtAge(Date.now() - Date.parse(engine.lastAt || 0))}前 · 下次 ${fmtWhen(engine.nextAt)}`],
              ['走着的会话', (engine.liveAgents ?? []).length ? `${(engine.liveAgents ?? []).length} 条` : '没有'],
              ['留着', `${counts.pending ?? 0} 条`],
              ['送过', `今天 ${counts.sentToday ?? 0} 条 · 一共 ${counts.sentTotal ?? 0} 条`],
              ['心跳出错', engine.lastError || '没有'],
            ],
          }),
        ),

        h(
          Card,
          { title: `还留着的（${pending.length}）` },
          pending.length === 0
            ? h('div', { style: C.sub }, '一条都没留。')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                pending.map((e) =>
                  h(
                    'div',
                    { key: e.id, style: C.entry },
                    h('div', { style: C.text }, e.text),
                    h(
                      'div',
                      { style: C.row },
                      h('span', { style: C.sub }, `${e.when} · ${e.mode === 'idle' ? '等他安静' : e.mode === 'now' ? '我写的时候就说' : '到点'} · ${e.id}`),
                      h(
                        'button',
                        {
                          style: { ...C.btn, marginLeft: 'auto' },
                          disabled: busy === '/cancel',
                          onClick: () => void post('/cancel', { id: e.id }),
                        },
                        '撤掉',
                      ),
                    ),
                    e.note ? h('div', { style: C.sub }, `为什么：${e.note}`) : null,
                    e.lastError ? h('div', { style: C.err }, `上次没送出去：${e.lastError}`) : null,
                  ),
                ),
              ),
        ),

        h(
          Card,
          { title: '空手回合' },
          h(KV, {
            pairs: [
              ['开着没有', ci.enabled ? '开着' : '关着'],
              ['时段', Array.isArray(ci.window) ? `${ci.window[0]} – ${ci.window[1]}` : '—'],
              ['多久一次', ci.everyMinutes ? `${ci.everyMinutes} 分钟` : '—'],
              ['今天用了几次', `${ci.todayCount ?? 0} / ${ci.maxPerDay ?? 0}`],
              ['上次', ci.lastAt ? `${fmtAge(Date.now() - Date.parse(ci.lastAt))}前` : '还没有'],
              ['下次', ci.nextAt ? fmtWhen(ci.nextAt) : '今天不再叫了'],
              ['他刚说过话', `${ci.minQuietMinutes ?? 0} 分钟内不叫`],
            ],
          }),
          h(
            'div',
            { style: C.row },
            h(
              'button',
              { style: C.btn, disabled: busy === '/checkin', onClick: () => void post('/checkin', {}) },
              '现在叫我一次',
            ),
            h('span', { style: C.sub }, '叫一次 = 一次模型调用。没什么想说的，我什么都不做。'),
          ),
        ),

        h(
          Card,
          {
            title: ug.lampActive ? '心事灯（亮着）' : '心事灯',
            right: h('span', { style: { ...C.sub, marginLeft: 'auto' } }, ug.enabled ? '开着' : '关着'),
          },
          h(KV, {
            pairs: [
              ['开着没有', ug.enabled ? '开着' : '关着'],
              ['灯', ug.lampActive ? `亮着（${fmtAge(Date.now() - Date.parse(ug.lampAt))}前亮的）· 强度 ${ug.lampIntensity ?? '—'}` : '没亮'],
              ['上次算', ug.lampAt ? `${fmtAge(Date.now() - Date.parse(ug.lampAt))}前` : '—'],
              ['今天叫醒', `${ug.todayCount ?? 0} 次`],
              ['上次叫醒', ug.lastAt ? `${fmtAge(Date.now() - Date.parse(ug.lastAt))}前` : '还没有'],
            ],
          }),
          ug.lampActive && ug.lampReasons?.length
            ? h('div', { style: C.sub }, `它看到的：${ug.lampReasons.join('；')}`)
            : null,
          h('div', { style: C.sub }, '家里的 urge.mjs 算「想说强度」，过门槛亮灯；灯亮叫醒它，说不说由它自己掂量——忍住的也记账。'),
        ),

        h(
          Card,
          { title: `最近送出去的（${recent.length}）` },
          recent.length === 0
            ? h('div', { style: C.sub }, '还没送过。')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                recent.map((e) =>
                  h(
                    'div',
                    { key: e.id, style: C.entry },
                    h('div', { style: C.text }, e.text),
                    h(
                      'div',
                      { style: C.sub },
                      `${e.status === 'sent' ? '送到了' : e.status === 'cancelled' ? '我撤掉了' : '没送成'} · ${fmtWhen(e.sentAt || e.dueAt || e.createdAt)}${e.sessionId ? ` · ${String(e.sessionId).slice(-8)}` : ''}`,
                    ),
                  ),
                ),
              ),
        ),

        h(
          Card,
          { title: '配置' },
          h(
            'div',
            { style: C.row },
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(cur.enabled), onChange: (ev) => setField('enabled', ev.target.checked) }), ' 总开关'),
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(cur.checkInEnabled), onChange: (ev) => setField('checkInEnabled', ev.target.checked) }), ' 空手回合'),
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(cur.urgeEnabled), onChange: (ev) => setField('urgeEnabled', ev.target.checked) }), ' 心事灯'),
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(cur.debug), onChange: (ev) => setField('debug', ev.target.checked) }), ' 记挂载日志'),
          ),
          h(
            'div',
            { style: C.row },
            h('span', { style: C.sub }, '窗口'),
            h('input', { style: { ...C.input, minWidth: 64 }, value: cur.checkInWindowStart ?? '09:00', onChange: (ev) => setField('checkInWindowStart', ev.target.value) }),
            h('span', { style: C.sub }, '–'),
            h('input', { style: { ...C.input, minWidth: 64 }, value: cur.checkInWindowEnd ?? '23:00', onChange: (ev) => setField('checkInWindowEnd', ev.target.value) }),
            h('span', { style: C.sub }, '每'),
            h('input', { style: { ...C.input, minWidth: 64 }, type: 'number', value: cur.checkInEveryMinutes ?? 240, onChange: (ev) => setField('checkInEveryMinutes', Number(ev.target.value)) }),
            h('span', { style: C.sub }, '分钟，一天最多'),
            h('input', { style: { ...C.input, minWidth: 56 }, type: 'number', value: cur.checkInMaxPerDay ?? 2, onChange: (ev) => setField('checkInMaxPerDay', Number(ev.target.value)) }),
            h('span', { style: C.sub }, '次'),
          ),
          h(
            'div',
            { style: C.row },
            h('span', { style: C.sub }, '他安静'),
            h('input', { style: { ...C.input, minWidth: 56 }, type: 'number', value: cur.checkInMinQuietMinutes ?? 90, onChange: (ev) => setField('checkInMinQuietMinutes', Number(ev.target.value)) }),
            h('span', { style: C.sub }, '分钟才算走开；idle 默认等'),
            h('input', { style: { ...C.input, minWidth: 56 }, type: 'number', value: cur.idleMinutes ?? 30, onChange: (ev) => setField('idleMinutes', Number(ev.target.value)) }),
            h('span', { style: C.sub }, '分钟；一句话最多'),
            h('input', { style: { ...C.input, minWidth: 64 }, type: 'number', value: cur.maxTextLength ?? 600, onChange: (ev) => setField('maxTextLength', Number(ev.target.value)) }),
            h('span', { style: C.sub }, '字'),
          ),
          h(
            'div',
            { style: C.row },
            h('span', { style: C.sub }, '心灯一天最多'),
            h('input', { style: { ...C.input, minWidth: 56 }, type: 'number', value: cur.urgeMaxPerDay ?? 3, onChange: (ev) => setField('urgeMaxPerDay', Number(ev.target.value)) }),
            h('span', { style: C.sub }, '次，冷却'),
            h('input', { style: { ...C.input, minWidth: 56 }, type: 'number', value: cur.urgeCooldownMinutes ?? 30, onChange: (ev) => setField('urgeCooldownMinutes', Number(ev.target.value)) }),
            h('span', { style: C.sub }, '分钟'),
          ),
          h(
            'div',
            { style: C.row },
            h('span', { style: C.sub }, '心事灯文件（留空 = 不认灯）'),
            h('input', {
              style: { ...C.input, flex: 1, minWidth: 220 },
              value: cur.urgeFile ?? '',
              onChange: (ev) => setField('urgeFile', ev.target.value),
            }),
          ),
          h(
            'div',
            { style: C.row },
            h('span', { style: C.sub }, '只在这些目录留话（留空 = 都可以）'),
            h('input', {
              style: { ...C.input, flex: 1, minWidth: 220 },
              value: Array.isArray(cur.allowRoots) ? cur.allowRoots.join('；') : '',
              onChange: (ev) => setField('allowRoots', ev.target.value),
            }),
          ),
          h(
            'div',
            { style: C.row },
            h('span', { style: C.sub }, '空手回合投给（留空 = 最近活跃的那条）'),
            h('input', {
              style: { ...C.input, flex: 1, minWidth: 220 },
              value: cur.targetRoot ?? '',
              onChange: (ev) => setField('targetRoot', ev.target.value),
            }),
          ),
          h(
            'div',
            { style: C.row },
            h('span', { style: C.sub }, '这些目录一概不碰（留空 = 没有）'),
            h('input', {
              style: { ...C.input, flex: 1, minWidth: 220 },
              value: Array.isArray(cur.denyRoots) ? cur.denyRoots.join('；') : '',
              onChange: (ev) => setField('denyRoots', ev.target.value),
            }),
          ),
          h(
            'div',
            { style: C.row },
            h('button', { style: C.btn, disabled: busy === 'config', onClick: () => void saveConfig(pickEditable(cur)) }, '保存'),
            h('button', { style: C.btn, onClick: () => setForm(null) }, '还原'),
            h('span', { style: { ...C.sub, marginLeft: 'auto' } }, `状态在 ${status.paths?.dataDir ?? ''}`),
          ),
        ),

        h(
          Card,
          { title: '日志末尾' },
          h('pre', { style: C.log }, (status.logs ?? []).join('\n') || '（还没有日志）'),
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject(
            'settings.section',
            () =>
              ctx.slots.register(
                { name: 'settings.section', id: 'dsh-reach', order: 9.5, label: () => NAMES.nav },
                BodySection,
              ),
            'dsh-reach: settings section',
          ),
        'dsh-reach: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.BodySection = BodySection
    return module.exports
  },
})
