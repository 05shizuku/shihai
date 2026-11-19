/**
 * tools/smoke-client.mjs —— 假浏览器里把 client.js 跑一遍
 *
 * 不联网、不装依赖：假的 window.__ModuleLoader__、假的 react（createElement 返回普通对象、
 * hooks 返回初值），只验证这几件事（定案 E，2026-11-19）：
 *   · 槽位退役：只注册识海（order 9.0）一个槽，dsh-remember 槽不再注册、label「记得」零出现；
 *   · 53 键 1:1 对表：formFrom/formToPatch 的键集 == config.js EDITABLE 全集（无丢失无重复）；
 *   · 五组齐（身心之间/感/记/我与思/界）+ 组头白话 + 新键 hint 抽样；
 *   · 灯纪律不变：三分支（error/ok:false/diag）、AbortSignal.timeout(4000)、5 秒自刷；
 *   · 回归：CustomEvent 保存流、numOrClear、rootsOf/toggleRoot、总开关在总览、密钥不回显；
 *   · 总览活性行：narration / wisdom / sprout 数据源字段在（宿主侧 status.sprout）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EDITABLE } from '../lib/config.js'

/** config.js 的 EDITABLE 是 {键: 类型} 映射——对表用键集。 */
const EDITABLE_KEYS = Object.keys(EDITABLE).sort()

const HERE = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(HERE, '..', 'client.js'), 'utf8')

let failures = 0
const ok = (cond, label) => {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.error(`  !!  ${label}`)
  }
}

// ---------------------------------------------------------------- 假浏览器
let spec = null
const fakeWindow = { __ModuleLoader__: { load: (s) => { spec = s } } }

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null) }
}

/** 想给某个 hook 喂值就把它塞进 seed（按调用顺序）；不塞就按初值来。 */
let hookSeed = null
let hookCalls = 0

const reactStub = {
  createElement,
  useState: (initial) => {
    const i = hookCalls++
    const seeded = hookSeed && i < hookSeed.length ? hookSeed[i] : undefined
    return [seeded !== undefined ? seeded : typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/** 跑一次渲染；seed 是给 useState 按顺序喂的值。 */
function render(seed = null) {
  hookSeed = seed
  hookCalls = 0
  return mod.RememberSection()
}

/** 五组开合的种子：全开（观测台断言用） */
const ALL_OPEN = { body: true, sense: true, memory: true, self: true, bounds: true, observatory: true }
const DEFAULT_FOLDS = { body: true, sense: false, memory: true, self: false, bounds: false, observatory: false }

const requireStub = (name) => {
  if (name !== 'react') throw new Error(`unexpected require(${JSON.stringify(name)})`)
  return reactStub
}

// ---------------------------------------------------------------- 加载
new Function('window', 'require', code)(fakeWindow, requireStub)
ok(spec && spec.id === 'dsh-remember', 'load({ id: "dsh-remember" }) 被调用')

const mod = spec.factory(requireStub)
ok(typeof mod.apply === 'function', 'exports.apply 是函数')
ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'exports.inject 里带 slots')

// ---------------------------------------------------------------- 槽位（定案 E：识海是唯一入口，9.6 退役）
const registered = []
let slotName = ''
const fakeCtx = {
  slots: {
    inject: (name, fn) => {
      slotName = name
      return fn()
    },
    register: (opts, component) => {
      registered.push({ slot: slotName, opts, component })
      return () => {}
    },
  },
  effect: (fn) => fn(),
}
mod.apply(fakeCtx)
const hubSlot = registered.find((r) => r.opts?.id === 'dsh-shihai-hub')
const rememberSlot = registered.find((r) => r.opts?.id === 'dsh-remember')
ok(rememberSlot === undefined, 'dsh-remember 槽已退役（不再注册）')
ok(registered.length === 1, 'apply 只注册一个槽（识海，唯一入口）')
ok(hubSlot?.slot === 'settings.section' && hubSlot?.opts?.order === 9.0, '识海槽 order 9.0')
ok(hubSlot?.opts?.label?.() === '识海', "识海槽 label 是「识海」")
ok(hubSlot?.component === mod.HubSection, '识海槽组件就是 HubSection')

// ---------------------------------------------------------------- 表单（53 键 1:1 对表）
const status = {
  ok: true,
  plugin: { name: 'dsh-remember', version: '0.24.0', startedAt: new Date().toISOString(), uptimeMs: 1000, dataDir: 'C:\\tmp\\remember' },
  injection: { enabled: true, targetRoot: '', allowRoots: [], count: 0, lastAt: null, lastError: null, section: '', selfEnabled: true, selfSection: '', curiosityEnabled: true, curiositySection: '', habitEnabled: true, habitSection: '' },
  self: { slots: [], seeds: [{ key: 'identity', label: '我是谁' }, { key: 'cares', label: '我在意' }, { key: 'refuses', label: '我不做' }] },
  habits: { fast: [], candidates: [], limit: 3 },
  curiosity: { active: 0, thinking: 1, answered: 0, total: 1, limit: 3, list: [] },
  narration: { count: 3, lastAt: '2026-11-19T01:00:00.000Z', due: false, latest: { id: 'n_x1', at: '2026-11-19T01:00:00.000Z', refsCount: 2 } },
  wisdom: { count: 2, latest: { id: 'w_x1', at: '2026-11-19T01:10:00.000Z', seedId: 'r_x1' } },
  sprout: { today: 2, total: 7 },
  fast: {
    enabled: true,
    source: 'C:\\Users\\x\\.dsh-body\\body-events.jsonl',
    copied: 2,
    total: 2,
    pending: 1,
    byKind: { meal: 1, mood: 1 },
    recent: [
      { id: 'f_abc1234', kind: 'meal', text: '吃过中饭了，胃里踏实一点', at: '2026-11-03T01:00:00.000Z', when: '不久前', weighed: false },
      { id: 'f_def5678', kind: 'mood', text: '心里亮了一下', at: '2026-11-03T00:30:00.000Z', when: '一会儿前', weighed: true },
    ],
  },
  intent: {
    enabled: true,
    source: 'C:\\Users\\x\\.dsh-qq-bridge\\messages.jsonl',
    copied: 4,
    total: 3,
    byKind: { praise: 1, ask: 1, other: 1 },
    avgIntensity: 3.2,
    recent: [
      { id: 'i_abc1234', kind: 'praise', label: '夸', intensity: 4, text: '你真棒', at: '2026-11-06T02:00:00.000Z', when: '刚刚' },
      { id: 'i_def5678', kind: 'ask', label: '问', intensity: 3, text: '你醒着吗', at: '2026-11-06T01:50:00.000Z', when: '十分钟前' },
    ],
  },
  emotion: {
    enabled: true,
    dominant: 'warm',
    label: '被暖到',
    level: 0.402,
    levels: { warm: 0.402 },
    total: 2,
    lastAt: '2026-11-06T02:10:00.000Z',
    coefficients: {},
    events: 2,
    tunes: 1,
    note: '（上次的笔记）此刻我心里大概是：被暖到 0.40',
    recent: [
      { id: 'e_abc1234', emotion: 'warm', label: '被暖到', delta: 0.35, intensity: 3, source: 'intent', ref: 'i_abc1234', text: '他说了句暖心的话', at: '2026-11-06T02:10:00.000Z', when: '刚刚', weighed: false },
    ],
  },
  wake: {
    enabled: true,
    sessionId: 'session-bb00f425',
    cooldownMinutes: 30,
    kinds: ['threshold', 'missed'],
    beats: 42,
    lastWakeAt: '2026-11-05T05:25:52.000Z',
    lastText: '【身体】（演示铃）身体叫我醒，我醒了',
  },
  summary: { total: 1, alive: 1, sealed: 0, thought: 1, kinds: { fact: 1 }, topScore: 1 },
  nodes: [{ id: 'r_1', kind: 'fact', weight: 0.55, score: 0.9, at: new Date().toISOString(), when: '刚写下', text: '一条', thought: true }],
  sealed: [],
  rawLines: 1,
  workspaces: [
    { id: 'w1', path: 'E:\\shihai-fixtures\\Plugin', title: 'Plugin', sessions: 2, isolated: false },
    { id: 'w2', path: 'E:\\shihai-fixtures\\dsh-fish\\home', title: '识海的家', sessions: 3, isolated: true },
  ],
  config: {
    effective: {
      enabled: true,
      targetRoot: 'E:\\shihai-fixtures\\Plugin',
      allowRoots: ['E:\\shihai-fixtures\\Plugin'],
      denyRoots: ['E:\\shihai-fixtures\\dsh-fish\\home'],
      injectLimit: 3,
      openLimit: 2,
      maxChars: 900,
      sectionOrder: 8720,
      maxTextLength: 2000,
      recallMaxChars: 8000,
      recallItemMax: 400,
      streamEnabled: true,
      streamSectionOrder: 8715,
      streamSectionMaxChars: 360,
      recallOrigin: true,
      sproutBodyEnabled: true,
      sproutBodyMinLevel: 0.5,
      sproutBodyCooldownMinutes: 10,
      sproutBodyDailyCap: 3,
      narrationEnabled: true,
      narrationIntervalDays: 7,
      narrationSectionOrder: 8662,
      narrationSectionMaxChars: 320,
      recallAudience: 'off',
      selfEnabled: true,
      selfSectionOrder: 8660,
      selfMaxChars: 400,
      curiosityEnabled: true,
      curiositySectionOrder: 8670,
      curiosityMaxChars: 320,
      curiosityLimit: 3,
      fastEnabled: true,
      fastSource: '',
      fastMaxEvents: 500,
      intentEnabled: true,
      intentSource: '',
      intentMaxEvents: 2000,
      wakeEnabled: true,
      wakeSessionId: 'session-bb00f425',
      wakeCooldownMinutes: 30,
      emotionEnabled: true,
      emotionTickMinutes: 1,
      emotionSectionEnabled: false,
      emotionSectionOrder: 8710,
      emotionMaxChars: 200,
      habitEnabled: true,
      habitSectionOrder: 8680,
      habitMaxChars: 320,
      habitLimit: 3,
      debug: false,
    },
    editable: Object.keys(EDITABLE),
  },
  paths: { config: 'C:\\tmp\\remember\\config.json', memory: 'C:\\tmp\\remember\\memory.json', lines: 'C:\\tmp\\remember\\lines.jsonl', log: 'C:\\tmp\\remember\\dsh-remember.log' },
  logs: ['启动'],
}

const form = mod.formFrom(status)
// 53 键 1:1 对表（定案 E 硬拍板：键清单 = config.js EDITABLE 全集）
const editableKeys = EDITABLE_KEYS
const formKeys = Object.keys(form).sort()
ok(JSON.stringify(formKeys) === JSON.stringify(editableKeys), `formFrom 键集 == EDITABLE 全集（53 键，无丢失无重复；实际 ${formKeys.length}）`)
const patchKeys = Object.keys(mod.formToPatch(form)).sort()
ok(JSON.stringify(patchKeys) === JSON.stringify(editableKeys), 'formToPatch 键集同样 1:1 对表')

ok(form.enabled === true, 'formFrom: enabled')
ok(form.targetRoot === 'E:\\shihai-fixtures\\Plugin', 'formFrom: targetRoot')
ok(form.injectLimit === '3' && form.openLimit === '2', 'formFrom: 数字变字符串')
const patch = mod.formToPatch(form)
ok(patch.enabled === true && patch.targetRoot === 'E:\\shihai-fixtures\\Plugin', 'formToPatch: 基础键')
ok(Array.isArray(patch.allowRoots) && patch.allowRoots.length === 1, 'formToPatch: allowRoots 变数组')
ok(mod.formToPatch({ ...form, allowRoots: '  \n , ', injectLimit: '' }).injectLimit === '', 'numOrClear: 清空数字 = 回默认')

// 新四套键的回落与可改
ok(form.streamEnabled === true && form.streamSectionOrder === '8715' && form.streamSectionMaxChars === '360', 'formFrom: 瀑流三键')
const streamPatch = mod.formToPatch({ ...form, streamEnabled: false, streamSectionOrder: '8700', streamSectionMaxChars: '500' })
ok(streamPatch.streamEnabled === false && streamPatch.streamSectionOrder === '8700' && streamPatch.streamSectionMaxChars === '500', 'formToPatch: 瀑流能关、顺序字数能改')
ok(form.sproutBodyEnabled === true && form.sproutBodyMinLevel === '0.5' && form.sproutBodyCooldownMinutes === '10' && form.sproutBodyDailyCap === '3', 'formFrom: 执受四键')
const sproutPatch = mod.formToPatch({ ...form, sproutBodyEnabled: false, sproutBodyMinLevel: '0.7', sproutBodyCooldownMinutes: '30', sproutBodyDailyCap: '5' })
ok(sproutPatch.sproutBodyEnabled === false && sproutPatch.sproutBodyMinLevel === '0.7' && sproutPatch.sproutBodyCooldownMinutes === '30' && sproutPatch.sproutBodyDailyCap === '5', 'formToPatch: 执受四键能改')
ok(form.narrationEnabled === true && form.narrationIntervalDays === '7' && form.narrationSectionOrder === '8662' && form.narrationSectionMaxChars === '320', 'formFrom: 思量四键')
ok(form.recallOrigin === true && form.recallAudience === 'off', 'formFrom: 缘起链默认开、谁在听默认 off')
ok(mod.formToPatch({ ...form, recallAudience: 'hard' }).recallAudience === 'hard', 'formToPatch: 谁在听能改 hard')

// 既有键回归（抽查）
ok(form.selfEnabled === true && form.selfSectionOrder === '8660', 'formFrom: 自我层键')
ok(form.habitLimit === '3' && form.curiosityLimit === '3', 'formFrom: 习惯/好奇上限')
ok(form.fastEnabled === true && form.fastMaxEvents === '500', 'formFrom: 快层键')
ok(form.intentMaxEvents === '2000' && form.emotionTickMinutes === '1' && form.wakeCooldownMinutes === '30', 'formFrom: 意图/情绪/叫醒键')
const fastPatch = mod.formToPatch({ ...form, fastSource: '  D:\\x\\events.jsonl  ' })
ok(fastPatch.fastSource === 'D:\\x\\events.jsonl', 'formToPatch: 路径去空白')
ok(mod.formToPatch({ ...form, wakeSessionId: null }).wakeSessionId === '', 'formToPatch: 会话空着就是空字符串')

// roots 回归
ok(form.denyRoots === 'E:\\shihai-fixtures\\dsh-fish\\home', 'formFrom: denyRoots 一行一个')
ok(JSON.stringify(mod.rootsOf(form)) === JSON.stringify(['E:\\shihai-fixtures\\dsh-fish\\home']), 'rootsOf: 读出隔离目录')
const added = mod.toggleRoot(form.denyRoots, 'D:\\work\\测试')
ok(added.split('\n').length === 2 && added.endsWith('D:\\work\\测试'), 'toggleRoot: 没勾的路径会加上')
ok(mod.toggleRoot(added, 'E:\\shihai-fixtures\\dsh-fish\\home') === 'D:\\work\\测试', 'toggleRoot: 再点一次就取消')

// ---------------------------------------------------------------- 记得段渲染
const flat = (node) => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flat).join('')
  const own = typeof node.children?.length === 'number' ? node.children : []
  return (node.props?.children ? [node.props.children] : []).map(flat).join('') + own.map(flat).join('')
}
const walk = (node, out = []) => {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, out))
    return out
  }
  out.push(node)
  for (const c of node.children ?? []) walk(c, out)
  if (node.props?.children) walk(node.props.children, out)
  return out
}

const tree = render()
ok(flat(tree).includes('正在读…'), '还没有数据时显示「正在读…」')

// 有数据、全折开：总览 + 五组 + 观测台
const withData = render([status, '', form, false, '', ALL_OPEN, null, false])
const text2 = flat(withData)

// 退役断言：standalone 的「记得」文本节点零出现（「我记得的」不算——那是段的正文）
const standaloneRemember = walk(withData).filter((n) => typeof n === 'string' && n.trim() === '记得')
ok(standaloneRemember.length === 0, 'label「记得」零出现（退役；「我记得的」等正文不算）')

// 总览（组〇，不折叠）：健康行 + 版本/账本行 + 四机制活性行 + 总开关
ok(text2.includes('总览'), '总览卡在首屏')
ok(text2.includes('● 开着，一切正常'), '健康行：开着一切正常')
ok(text2.includes('账本 1 条（活着 1 · 按住 0）· 原话 1 行'), '版本行+账本行用 status 现有字段')
ok(text2.includes('思量 3 条'), '活性行：思量计数（status.narration）')
ok(text2.includes('链头 n_x1'), '活性行：思量链头时间')
ok(text2.includes('智 2 条'), '活性行：智计数（status.wisdom）')
ok(text2.includes('执受今日 2 次'), '活性行：执受今日次数（status.sprout，宿主新字段）')
ok(text2.includes('瀑流段 挂'), '活性行：瀑流段挂/关')
ok(text2.includes('总开关：账本开着'), '总开关提升到总览')
const overviewNode = walk(withData).find((n) => n.type === 'div' && n.children?.[0]?.type === 'h3' && String(flat(n.children[0])) === '总览')
ok(!!overviewNode, '总览是个独立的卡')
ok(walk(overviewNode).some((n) => n.type === 'input' && n.props?.type === 'checkbox'), '总览里有总开关复选框')
ok(text2.includes('测一下：读写通不通'), '「测一下」在总览里')

// 五组齐 + 组头白话
for (const t of ['组一 身心之间', '组二 感', '组三 记', '组四 我与思', '组五 界']) {
  ok(text2.includes(t), `五组齐：${t}`)
}
ok(text2.includes('身体和识之间的三根线：抄送、叫醒、心头一动。'), '组一組头白话')
ok(text2.includes('机器从真事里认情绪、认事——认出来的只是笔记，不接管嘴。'), '组二组头白话')
ok(text2.includes('账本的旋钮：挂几条、给多少字、截在哪。'), '组三组头白话')
ok(text2.includes('我是谁、我在想什么、我明白了什么——这些的旋钮都在这。'), '组四组头白话')
ok(text2.includes('谁在听、谁能进——信任的边界。'), '组五组头白话')

// 新键 hint 抽样（四套）
ok(text2.includes('执受反射弧——带情绪的现行通知身体（心头一动）'), '组一：执受 toggle hint')
ok(text2.includes('染色门浓度线'), '组一：染色门浓度线 hint')
ok(text2.includes('挂「思量」段（恒审思量是我的动作，系统只给时机）'), '组四：思量 toggle hint')
ok(text2.includes('挂「昨日之流」段（读侧聚合，同 UTC 日缓存）'), '组三：瀑流 toggle hint')
ok(text2.includes('recall 行尾带缘起链（x 前因「…」想起 + 机读 origins）'), '组三：缘起链 hint')
ok(text2.includes('off（全可见，现状）'), '组五：谁在听三选一（off）')
ok(text2.includes('hard（别的场不翻出来）'), '组五：谁在听三选一（hard）')

// 默认开合：组一/组三/观测台默认开；组二/组四/组五默认收
const withDefaultFolds = render([status, '', form, false, '', DEFAULT_FOLDS, null, false])
const textDefault = flat(withDefaultFolds)
ok(textDefault.includes('▾ 组一 身心之间'), '组一默认开（▾）')
ok(textDefault.includes('▾ 组三 记'), '组三默认开（▾）')
ok(textDefault.includes('▸ 组二 感'), '组二默认收（▸）')
ok(textDefault.includes('▸ 组四 我与思'), '组四默认收（▸）')
ok(textDefault.includes('▸ 组五 界'), '组五默认收（▸）')
ok(!textDefault.includes('快层还是空的'), '观测台收着的时候卡片不渲染')

// 观测台三行（定案 E 增补）
ok(text2.includes('思量链'), '观测台：思量链行')
ok(text2.includes('链长 3'), '观测台：思量链带链长')
ok(text2.includes('从 r_x1 提炼'), '观测台：智行带 latest.seedId')
ok(text2.includes('今日 2 次 · 累计 7 次'), '观测台：执受行今日/累计（status.sprout）')

// 观测台既有卡（抽查回归）
ok(text2.includes('习惯与快通路'), '观测台：习惯卡还在')
ok(text2.includes('快层（身体那边秒级发生的事）'), '观测台：快层卡还在')
ok(text2.includes('意图层（机器从聊天里认出来的事）'), '观测台：意图卡还在')
ok(text2.includes('情绪流（上次的笔记，不是现在必须摆出的样子）'), '观测台：情绪卡还在')
ok(text2.includes('叫醒（身体越过线自动叫醒）'), '观测台：叫醒卡还在')
ok(text2.includes('账本损坏时') === false && !text2.includes('账本读不出能认的账'), '账本健康时不亮红灯')
const brokenLedger = render([{ ...status, ledger: { broken: true, backupOk: true } }, '', form, false, '', ALL_OPEN, null, false])
ok(flat(brokenLedger).includes('账本读不出能认的账'), '账本损坏时总览亮红灯')

// ---------------------------------------------------------------- 灯纪律（HubSection 纯函数）
const hubStatuses = {
  remember: { j: { ok: true, plugin: { version: '0.24.0' }, summary: { total: 42 } } },
  bridge: { j: { ok: true, plugin: { version: '0.9.1' }, running: true } },
  body: { error: 'HTTP 503' },
}
const pills = mod.hubPills(hubStatuses)
ok(pills.length === 3, 'hubPills: 三盏灯')
ok(pills[0].ok === true && pills[0].note === '账本 42 条', 'hubPills: 记忆灯看账本条数')
ok(pills[1].ok === true && pills[1].note === '桥接着', 'hubPills: 桥灯看 running')
ok(pills[2].ok === false && pills[2].note === '没起来（HTTP 503）', 'hubPills: 没起来的灯不连坐')
ok(mod.hubPills({})[0].ok === false && mod.hubPills({})[0].note.startsWith('没起来'), 'hubPills: 什么都没有=没起来（diag 三分支）')

const hubEff = {
  enabled: true,
  httpToken: '已配置（不回显）',
  meals: [{ at: 1 }],
  allowRoots: ['E:\\a', 'E:\\b'],
  replyMaxChars: 900,
  staleSeconds: 3600,
}
const { rows: hubR, hidden: hubHidden } = mod.hubRows(hubEff, { staleSeconds: 300 }, null)
ok(hubR.length === 4 && hubHidden === 2, 'hubRows: 密钥和复杂值不搬进来（HUB_SENSITIVE 不回显）')
ok(hubR.find((r) => r.key === 'staleSeconds')?.overridden === true, 'hubRows: overrides 里改过的标记「已改」')
const hubForm = mod.hubFormFrom(hubR)
ok(hubForm.allowRoots === 'E:\\a，E:\\b', 'hubFormFrom: 列表摊平成逗号串')
const hubP = mod.hubPatch(hubR, { ...hubForm, enabled: false, allowRoots: 'E:\\a、E:\\c、' })
ok(hubP.enabled === false, 'hubPatch: 布尔翻转收进 patch')
ok(JSON.stringify(hubP.allowRoots) === JSON.stringify(['E:\\a', 'E:\\c']), 'hubPatch: 顿号拆回去')
ok(Object.keys(mod.hubPatch(hubR, hubForm)).length === 0, 'hubPatch: 原样表单 = 空 patch（改哪存哪）')

// ---------------------------------------------------------------- 识海整页渲染（12 hooks：hub×4 + 记得段×8）
const fullSeed = [hubStatuses, {}, {}, {}, status, '', form, false, '', DEFAULT_FOLDS, null, false]
hookSeed = fullSeed
hookCalls = 0
const hubText = flat(mod.HubSection())
ok(hubText.includes('识海'), '识海标题（唯一入口）')
ok(hubText.includes('状态灯每 5 秒自刷'), '状态灯行（5 秒纪律）')
ok(hubText.includes('没起来（HTTP 503）'), '身体的灯灰着并给出原因')
ok(hubText.includes('总开关'), '桥/身的总开关块还在（bridge/body 部分不动）')
ok(hubText.includes('饭钱到线自动添饭'), '身体的总开关是 topUpEnabled')
ok(hubText.includes('总览'), '识海整页里记得段的总览在场（合并完成）')
ok(hubText.includes('组一 身心之间'), '识海整页里五组在场')
ok(!hubText.includes('识海总控'), '旧「识海总控」标题退役')
ok(!hubText.includes('总开关（每次开头挂几行记忆）'), 'HUB_MASTER 的 remember 键映射退役（单一事实源）')
ok(hubText.includes('正在读') === false, '整页渲染不缺数据')

// 代码纪律：轮询/超时/保存流的字符串还在源码里
ok(code.includes('AbortSignal.timeout(4000)'), '灯轮询带 4 秒超时（AbortSignal.timeout(4000)）')
ok(code.includes('setInterval(poll, 5000)'), '灯 5 秒自刷（setInterval(poll, 5000)）')
ok(code.includes('setInterval(load, 5000)'), '记得段 5 秒自刷（setInterval(load, 5000)）')
ok(code.includes('dsh-shihai:config-changed'), 'CustomEvent 保存流还在（改哪存哪同步）')
ok(code.includes("HUB_SENSITIVE = /token|secret|password/i"), '密钥不回显的口径还在')
ok(!code.includes("order: 9.6"), 'order 9.6 的注册代码已删除')

// ---------------------------------------------------------------- 收尾
if (failures) {
  console.error(`\n${failures} 项没过`)
  process.exit(1)
}
console.log('\nclient smoke: 全过')
