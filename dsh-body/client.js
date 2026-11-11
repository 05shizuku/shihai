/**
 * client.js —— 设置页里的「身体」那一节（浏览器半边）
 *
 * 为什么有这一半：宿主那半边只负责算数和写文件，界面得有个地方看。
 * 形态选 `settings.section`（跟 dsh-fish 的观测台一样）：在 App 内部同源
 * fetch `/dsh-body/*` 是通的（cookie 天然带着），独立 HTML 页会被信任栅栏挡成 401。
 *
 * 这里只做两件事：
 *   ① 看：心跳、注入、此刻的读数、她真正读到的那段字、日志末尾；
 *   ② 改：睡眠窗 / 三餐 / 补算上限 / 目标会话 —— 白名单字段，服务端再校验一遍。
 * 不提供任何"直接改她饥饿值"的开关：那是身体的事，不是配置。
 */
window.__ModuleLoader__.load({
  id: 'dsh-body',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const API = '/dsh-body'

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
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 },
      bar: { position: 'relative', height: 6, borderRadius: 3, background: 'var(--dsw-alias-border-l2)', overflow: 'hidden', flex: '1 1 120px', minWidth: 120 },
      fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, background: 'var(--dsw-alias-label-primary)', opacity: 0.55 },
      log: { margin: 0, padding: 10, borderRadius: 8, background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))', fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflow: 'auto' },
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

    function num(v, digits = 1) {
      const n = Number(v)
      return Number.isFinite(n) ? n.toFixed(digits) : '—'
    }

    function meter(label, value, hint) {
      const v = Math.max(0, Math.min(100, Number(value) || 0))
      return h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 } },
        h('span', { style: { ...C.k, width: 42 } }, label),
        h('div', { style: C.bar }, h('div', { style: { ...C.fill, width: `${v}%` } })),
        h('span', { style: { ...C.mono, width: 46, textAlign: 'right' } }, num(v)),
        hint ? h('span', { style: { ...C.sub, fontSize: 12 } }, hint) : null,
      )
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

    // ---------------------------------------------------------------- 配置表单
    /** 多行文本读成路径数组（换行 / 逗号 / 分号都算分隔，对齐 dsh-remember）。 */
    function splitPaths(v) {
      return String(v ?? '')
        .split(/[\n,;，；]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    }

    /** 表单里放隔离路径的那一块，读成数组。 */
    function rootsOf(form) {
      return splitPaths(form?.denyRoots)
    }

    /** 勾上／取消一个工作区，返回新的多行文本。 */
    function toggleRoot(text, path) {
      const roots = splitPaths(text)
      const i = roots.indexOf(path)
      if (i >= 0) roots.splice(i, 1)
      else roots.push(path)
      return roots.join('\n')
    }

    function formFrom(status) {
      const cfg = status?.config?.effective ?? {}
      const meals = Array.isArray(cfg.meals) ? cfg.meals : []
      return {
        sleepStart: cfg.sleep?.start ?? '',
        sleepEnd: cfg.sleep?.end ?? '',
        meals: meals.map((m) => ({ id: m.id, label: m.label, at: m.at })),
        maxCatchUpHours: String(cfg.maxCatchUpHours ?? 12),
        missedGraceMinutes: String(cfg.missedGraceMinutes ?? 5),
        topUpEnabled: Boolean(cfg.topUpEnabled),
        debug: Boolean(cfg.debug),
        applyToAll: Boolean(cfg.applyToAll),
        allowRoots: (Array.isArray(cfg.allowRoots) ? cfg.allowRoots : []).join('\n'),
        denyRoots: (Array.isArray(cfg.denyRoots) ? cfg.denyRoots : []).join('\n'),
      }
    }

    function formToPatch(form) {
      return {
        sleep: { start: form.sleepStart, end: form.sleepEnd },
        meals: form.meals.map((m) => ({ id: m.id, at: m.at })),
        maxCatchUpHours: form.maxCatchUpHours,
        missedGraceMinutes: form.missedGraceMinutes,
        topUpEnabled: form.topUpEnabled,
        debug: form.debug,
        applyToAll: form.applyToAll,
        allowRoots: splitPaths(form.allowRoots),
        denyRoots: splitPaths(form.denyRoots),
      }
    }

    function BodySection() {
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
          setError(`${err?.message ?? err}（插件可能还没重启，或者这一页没被信任栅栏放行）`)
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
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
          const rejected = Array.isArray(j.rejected) ? j.rejected : []
          setNote(rejected.length
            ? `有 ${rejected.length} 项没改成功：${rejected.map((x) => `${x.key}（${x.reason}）`).join('；')}`
            : `改了：${(j.accepted ?? []).join('、') || '（没有变化）'}。两秒内生效。`)
          await load()
        } catch (err) {
          setNote(`没改成：${err?.message ?? err}`)
        } finally {
          setBusy(false)
        }
      }, [form, load])

      const head = h('div', null,
        h('h2', { style: C.h2 }, '身体'),
        h('p', { style: C.sub }, status
          ? `dsh-body ${status.plugin?.version ?? ''} · 已经在跑 · ${status.plugin?.dataDir ?? ''}`
          : '给她的那一小副身体：一日三餐看饭钱，精力随作息，心情按听见的话涨落。'),
      )

      if (error) {
        return h('div', { style: C.wrap }, head,
          card('连不上', h('p', { style: C.err }, error), h('button', { style: C.btn, onClick: load }, '再试一次')),
        )
      }
      if (!status) {
        return h('div', { style: C.wrap }, head, h('p', { style: C.sub }, '正在读…'))
      }

      const hb = status.heartbeat ?? {}
      const inj = status.injection ?? {}
      const rd = status.readings ?? {}
      const ml = status.meals ?? {}
      const tp = status.topUp ?? {}
      const cfg = status.config?.effective ?? {}
      const tg = status.targets ?? {}

      const heartbeatCard = card('运行状态',
        kv([
          ['插件', h('span', { style: C.mono }, `${status.plugin?.name ?? 'dsh-body'} ${status.plugin?.version ?? ''}`)],
          ['启动于', fmtWhen(status.plugin?.startedAt)],
          ['已运行', fmtAge(status.plugin?.uptimeMs)],
          ['上次心跳', `${fmtWhen(hb.lastAt)}${hb.ageMs != null ? `（${fmtAge(hb.ageMs)}前）` : ''}`],
          ['下次心跳', fmtWhen(hb.nextAt)],
          ['心跳间隔', fmtAge(hb.tickMs)],
          ['注入次数', `${inj.renderCount ?? 0} 次${inj.lastRenderAt ? `，最近 ${fmtWhen(inj.lastRenderAt)}` : ''}`],
          ['挂着的会话', (inj.sessions ?? []).length
            ? (inj.sessions ?? []).map((s) => `${s.sessionId}${s.cwd ? ` @ ${s.cwd}` : ''}`).join('；')
            : '还没有会话挂上（她要先开一次对话）'],
        ]),
        hb.lastError ? h('p', { style: C.err }, `上次心跳出错：${hb.lastError}`) : null,
        inj.lastError ? h('p', { style: C.err }, `注入出错：${inj.lastError}`) : null,
      )

      const readCard = card('此刻',
        meter('饥饿', rd.hunger),
        meter('精力', rd.energy),
        meter('心情', (Number(rd.mood) || 0) + 50, '中间是平的'),
        rd.anger ? meter('生气', rd.anger) : null,
        rd.sadness ? meter('难过', rd.sadness) : null,
        kv([
          ['饭钱', rd.balance == null ? '读不到（没有用量账本）' : `¥${num(rd.balance, 3)}`],
          ['这顿吃成', rd.tier?.label ?? '—'],
          ['最近一餐', ml.lastMeal ? `${ml.lastMeal.label ?? ml.lastMeal.id ?? '一餐'} · ${fmtWhen(ml.lastMeal.at)}` : '还没吃过'],
          ['下一顿', ml.next ? `${ml.next.label} ${ml.next.at}` : '今天没了'],
          ['错过的', (ml.missed ?? []).length ? (ml.missed ?? []).join('、') : '没有'],
          [
            '最近加饭',
            tp.last
              ? `+¥${num(tp.last.amount, 2)}（${tp.last.tierLabel || '添了些'}）· ${fmtWhen(tp.last.at)}`
              : tp.enabled
                ? '还没添过'
                : '已关掉（饭钱涨了也不加）',
          ],
        ]),
        status.bodyText
          ? h('div', null,
            h('p', { style: { ...C.cardTitle, marginTop: 4 } }, '她此刻读到的（原样）'),
            h('pre', { style: C.log }, status.bodyText))
          : null,
      )

      const cfgRows = [
        ['配置来源', `代码默认值 → 包 patch → ${status.paths?.configFile ?? 'config.json'}（热读，2 秒生效）`],
        ['睡眠窗', `${cfg.sleep?.start ?? '—'} → ${cfg.sleep?.end ?? '—'}`],
        ['一日三餐', (cfg.meals ?? []).map((m) => `${m.label} ${m.at}（${m.windowMinutes} 分钟内算数）`).join('；') || '—'],
        ['饭钱档位', (cfg.tiers ?? []).map((t) => `≥¥${t.min} ${t.label}(−${t.fill})`).join('；') || '—'],
        ['补算上限', `${cfg.maxCatchUpHours ?? '—'} 小时`],
        ['错过判定', `饭点窗口关了再等 ${cfg.missedGraceMinutes ?? '—'} 分钟才记“没吃上”`],
        ['加饭', cfg.topUpEnabled ? '饭钱涨了当场记一顿加饭（不等饭点）' : '已关掉：饭钱涨了也不加'],
        ['段名 / 顺序', `${cfg.sectionName ?? '—'} / ${cfg.sectionOrder ?? '—'}（排在 dsh-fish 身份段之后）`],
        ['只挂给谁', `${tg.root || '（未配置）'}${(tg.ids ?? []).length ? ` + ${(tg.ids ?? []).join(', ')}` : ''}${tg.applyToAll ? '（全部会话）' : ''}`],
        ['隔离目录', (inj.denyRoots ?? []).length ? `${inj.denyRoots.join('、')}（命中的会话一律不挂）` : '（未设置）'],
        ['放行目录', (inj.allowRoots ?? []).length ? inj.allowRoots.join('、') : '（未设置，跟目标目录一样宽）'],
        ['状态文件', status.paths?.stateFile ?? '—'],
        ['日志', status.paths?.logFile ?? '—'],
      ]
      const configCard = card('配置',
        kv(cfgRows),
        h('p', { style: C.cardTitle, marginTop: 6 }, '这些可以直接改'),
        h('div', { style: C.row },
          h('span', { style: C.k }, '睡眠'),
          h('input', { style: C.input, value: form?.sleepStart ?? '', placeholder: '23:00', onChange: (e) => setForm({ ...form, sleepStart: e.target.value }) }),
          h('span', { style: C.k }, '→'),
          h('input', { style: C.input, value: form?.sleepEnd ?? '', placeholder: '08:00', onChange: (e) => setForm({ ...form, sleepEnd: e.target.value }) }),
        ),
        ...(form?.meals ?? []).map((m, i) => h('div', { key: `meal-${m.id}`, style: C.row },
          h('span', { style: { ...C.k, width: 42 } }, m.label),
          h('input', {
            style: C.input,
            value: m.at ?? '',
            onChange: (e) => {
              const meals = [...form.meals]
              meals[i] = { ...meals[i], at: e.target.value }
              setForm({ ...form, meals })
            },
          }),
        )),
        h('div', { style: C.row },
          h('span', { style: C.k }, '补算上限'),
          h('input', { style: { ...C.input, width: 60 }, value: form?.maxCatchUpHours ?? '', onChange: (e) => setForm({ ...form, maxCatchUpHours: e.target.value }) }),
          h('span', { style: C.sub }, '小时'),
          h('span', { style: { ...C.k, marginLeft: 12 } }, '错过宽限'),
          h('input', { style: { ...C.input, width: 60 }, value: form?.missedGraceMinutes ?? '', onChange: (e) => setForm({ ...form, missedGraceMinutes: e.target.value }) }),
          h('span', { style: C.sub }, '分钟'),
        ),
        h('div', { style: C.row },
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: !!form?.debug, onChange: (e) => setForm({ ...form, debug: e.target.checked }) }),
            '把每次注入的原文写进日志'),
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: !!form?.applyToAll, onChange: (e) => setForm({ ...form, applyToAll: e.target.checked }) }),
            '所有会话都挂身体'),
          h('label', { style: { ...C.row, gap: 6, fontSize: 13 } },
            h('input', { type: 'checkbox', checked: !!form?.topUpEnabled, onChange: (e) => setForm({ ...form, topUpEnabled: e.target.checked }) }),
            '饭钱涨了就算加饭'),
        ),
        h('div', { style: C.row },
          h('span', { style: C.k }, '放行目录'),
          h('textarea', { style: { ...C.input, height: 44, width: 340 }, value: form?.allowRoots ?? '', placeholder: '一行一个；留空 = 按目标目录收窄（targetRoot 在配置文件里）', onChange: (e) => setForm({ ...form, allowRoots: e.target.value }) }),
        ),
        h('p', { style: { ...C.cardTitle, marginTop: 6 } }, '隔离（这些工作区看不见身体）'),
        h('p', { style: C.sub }, '勾上的工作区：那里的会话连身体段都不挂，先隔离、后放行。'),
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
          : h('p', { style: C.sub }, '没读到工作区清单，直接在下面写目录也一样。'),
        h('div', { style: C.row, alignItems: 'flex-start' },
          h('span', { style: { ...C.k, paddingTop: 4 } }, '隔离目录'),
          h('textarea', { style: { ...C.input, height: 44, width: 340 }, value: form?.denyRoots ?? '', placeholder: '一行一个目录；勾上面的工作区会写进这里', onChange: (e) => setForm({ ...form, denyRoots: e.target.value }) }),
        ),
        h('div', { style: C.row },
          h('button', { style: C.btn, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          note ? h('span', { style: C.ok }, note) : null,
        ),
      )

      const logCard = card('日志末尾',
        status.logs?.length
          ? h('pre', { style: C.log }, status.logs.slice(-8).join('\n'))
          : h('p', { style: C.sub }, '还没有日志'),
      )

      return h('div', { style: C.wrap }, head, heartbeatCard, readCard, configCard, logCard)
    }

    // ---------------------------------------------------------------- 挂载
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'dsh-body', order: 8, label: () => '身体' },
          BodySection,
        ), 'dsh-body: settings section'),
        'dsh-body: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.BodySection = BodySection
    return module.exports
  },
})
