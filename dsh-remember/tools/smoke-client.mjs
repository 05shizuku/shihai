/**
 * tools/smoke-client.mjs —— 假浏览器里把 client.js 跑一遍
 *
 * 不联网、不装依赖：假的 window.__ModuleLoader__、假的 react（createElement 返回普通对象、
 * hooks 返回初值），只验证这几件事：
 *   · client.js 是合法的模块包装（load 被调用、factory 能跑）；
 *   · apply(ctx) 往 settings.section 里注册了 id=dsh-remember / order=9.6 / label=记得；
 *   · formFrom(status) 与 formToPatch(form) 的字段对得上；
 *   · 意图层和情绪流的行/计数回落、卡片文案、配置键表单三处都对得上；
 *   · 没有数据时组件能渲染出「正在读…」，不会在 hooks 上炸。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ---------------------------------------------------------------- 注册 slot
let registered = null
let slotName = ''
const fakeCtx = {
  slots: {
    inject: (name, fn) => {
      slotName = name
      return fn()
    },
    register: (opts, component) => {
      registered = { slot: slotName, opts, component }
      return () => {}
    },
  },
  effect: (fn) => fn(),
}
mod.apply(fakeCtx)
ok(registered?.slot === 'settings.section', '注册进 settings.section')
ok(registered?.opts?.name === 'settings.section', 'slot 名是 settings.section')
ok(registered?.opts?.id === 'dsh-remember', 'slot id 是 dsh-remember')
ok(registered?.opts?.order === 9.6, 'slot order 是 9.6（避开 bili 的 9 和 reach 的 9.5）')
ok(registered?.opts?.label?.() === '记得', "slot label 是「记得」")
ok(registered?.component === mod.RememberSection, 'slot 组件就是 RememberSection')

// ---------------------------------------------------------------- 表单
const status = {
  ok: true,
  plugin: { name: 'dsh-remember', version: '0.1.0', startedAt: new Date().toISOString(), uptimeMs: 1000, dataDir: 'C:\\tmp\\remember' },
  injection: { enabled: true, targetRoot: '', allowRoots: [], count: 0, lastAt: null, lastError: null, section: '', selfEnabled: true, selfSection: '', curiosityEnabled: true, curiositySection: '', habitEnabled: true, habitSection: '' },
  self: { slots: [], seeds: [{ key: 'identity', label: '我是谁' }, { key: 'cares', label: '我在意' }, { key: 'refuses', label: '我不做' }] },
  habits: { fast: [], candidates: [], limit: 3 },
  curiosity: {
    active: 0,
    thinking: 1,
    answered: 0,
    total: 1,
    limit: 3,
    list: [],
  },
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
      { id: 'i_ghi9012', kind: 'other', label: '其它', intensity: 2, text: '嗯', at: '2026-11-06T01:40:00.000Z', when: '二十分钟前' },
    ],
  },
  emotion: {
    enabled: true,
    dominant: 'warm',
    label: '被暖到',
    level: 0.402,
    levels: { warm: 0.402, pleased: 0.1, curious: 0, tense: 0, down: 0, restless: 0, lonely: 0 },
    total: 2,
    lastAt: '2026-11-06T02:10:00.000Z',
    coefficients: {
      warm: { coefficient: 1, halfLife: 120 },
      pleased: { coefficient: 1, halfLife: 60 },
      curious: { coefficient: 0.8, halfLife: 90 },
      tense: { coefficient: 1, halfLife: 45 },
      down: { coefficient: 0.9, halfLife: 90 },
      restless: { coefficient: 0.7, halfLife: 30 },
      lonely: { coefficient: 0.8, halfLife: 60 },
    },
    events: 2,
    tunes: 1,
    note: '（上次的笔记）此刻我心里大概是：被暖到 0.40、高兴 0.10',
    recent: [
      { id: 'e_abc1234', emotion: 'warm', label: '被暖到', delta: 0.35, intensity: 3, source: 'intent', ref: 'i_abc1234', text: '他说了句暖心的话', at: '2026-11-06T02:10:00.000Z', when: '刚刚', weighed: false },
      { id: 'e_def5678', emotion: 'pleased', label: '高兴', delta: 0.25, intensity: 2, source: 'fast', ref: 'f_abc1234', text: '添了饭，胃里踏实', at: '2026-11-06T01:30:00.000Z', when: '一会儿前', weighed: true },
    ],
  },
  wake: {
    enabled: true,
    sessionId: 'session-bb00f425-3b12-4b40-af93-0337e6a99706',
    cooldownMinutes: 30,
    kinds: ['threshold', 'missed'],
    beats: 42,
    lastWakeAt: '2026-11-05T05:25:52.000Z',
    lastText: '【身体】（演示铃）身体叫我醒，我醒了（f_1uecqb3）',
  },
  summary: { total: 1, alive: 1, sealed: 0, thought: 1, kinds: { fact: 1, decision: 0, lesson: 0, skill: 0, open: 0, self: 0 }, topScore: 1 },
  nodes: [{ id: 'r_1', kind: 'fact', weight: 0.55, score: 0.9, at: new Date().toISOString(), when: '刚写下', text: '一条', thought: true }],
  sealed: [],
  rawLines: 1,
  workspaces: [
    { id: 'w1', path: 'E:\\示例\\Plugin', title: 'Plugin', sessions: 2, isolated: false },
    { id: 'w2', path: 'E:\\示例\\dsh-fish\\home', title: '示例的家', sessions: 3, isolated: true },
  ],
  config: {
    effective: {
      enabled: true,
      targetRoot: 'E:\\示例\\Plugin',
      allowRoots: ['E:\\示例\\Plugin'],
      denyRoots: ['E:\\示例\\dsh-fish\\home'],
      injectLimit: 3,
      openLimit: 2,
      maxChars: 900,
      sectionOrder: 8720,
      maxTextLength: 2000,
      recallMaxChars: 8000,
      recallItemMax: 400,
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
      wakeSessionId: 'session-bb00f425-3b12-4b40-af93-0337e6a99706',
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
    editable: ['enabled', 'targetRoot', 'allowRoots', 'denyRoots', 'injectLimit', 'openLimit', 'maxChars', 'sectionOrder', 'maxTextLength', 'recallMaxChars', 'recallItemMax', 'selfEnabled', 'selfSectionOrder', 'selfMaxChars', 'curiosityEnabled', 'curiositySectionOrder', 'curiosityMaxChars', 'curiosityLimit', 'habitEnabled', 'habitSectionOrder', 'habitMaxChars', 'habitLimit', 'fastEnabled', 'fastSource', 'fastMaxEvents', 'intentEnabled', 'intentSource', 'intentMaxEvents', 'wakeEnabled', 'wakeSessionId', 'wakeCooldownMinutes', 'emotionEnabled', 'emotionTickMinutes', 'emotionSectionEnabled', 'emotionSectionOrder', 'emotionMaxChars', 'debug'],
  },
  paths: { config: 'C:\\tmp\\remember\\config.json', memory: 'C:\\tmp\\remember\\memory.json', lines: 'C:\\tmp\\remember\\lines.jsonl', log: 'C:\\tmp\\remember\\dsh-remember.log' },
  logs: ['启动'],
}

const form = mod.formFrom(status)
ok(form.enabled === true, 'formFrom: enabled')
ok(form.targetRoot === 'E:\\示例\\Plugin', 'formFrom: targetRoot')
ok(form.allowRoots === 'E:\\示例\\Plugin', 'formFrom: allowRoots 一行一个')
ok(form.injectLimit === '3' && form.openLimit === '2', 'formFrom: 数字变字符串')

ok(form.selfEnabled === true && form.selfSectionOrder === '8660' && form.selfMaxChars === '400', 'formFrom: 自我层那三个键也读得到')

ok(form.habitEnabled === true && form.habitSectionOrder === '8680' && form.habitMaxChars === '320' && form.habitLimit === '3', 'formFrom: 习惯那四个键也读得到')

ok(form.curiosityEnabled === true && form.curiositySectionOrder === '8670' && form.curiosityMaxChars === '320' && form.curiosityLimit === '3', 'formFrom: 好奇表那四个键也读得到')

const patch = mod.formToPatch(form)
ok(patch.enabled === true, 'formToPatch: enabled')
ok(patch.targetRoot === 'E:\\示例\\Plugin', 'formToPatch: targetRoot')
ok(Array.isArray(patch.allowRoots) && patch.allowRoots.length === 1, 'formToPatch: allowRoots 变数组')
ok(patch.injectLimit === '3' && patch.maxChars === '900', 'formToPatch: 数字还是字符串（服务端再校验）')
ok(patch.selfEnabled === true && patch.selfSectionOrder === '8660', 'formToPatch: 自我层跟着一起提')
const selfOff = mod.formToPatch({ ...form, selfEnabled: false })
ok(selfOff.selfEnabled === false, 'formToPatch: 自我层能关')
ok(patch.habitEnabled === true && patch.habitSectionOrder === '8680' && patch.habitLimit === '3', 'formToPatch: 习惯跟着一起提')
const habitOff = mod.formToPatch({ ...form, habitEnabled: false, habitLimit: '5' })
ok(habitOff.habitEnabled === false && habitOff.habitLimit === '5', 'formToPatch: 习惯能关、上限能改')
ok(patch.curiosityEnabled === true && patch.curiositySectionOrder === '8670' && patch.curiosityMaxChars === '320' && patch.curiosityLimit === '3', 'formToPatch: 好奇表跟着一起提')
const curiosityOff = mod.formToPatch({ ...form, curiosityEnabled: false, curiosityLimit: '5', curiositySectionOrder: '8680' })
ok(curiosityOff.curiosityEnabled === false && curiosityOff.curiosityLimit === '5' && curiosityOff.curiositySectionOrder === '8680', 'formToPatch: 好奇表能关、上限和顺序能改')

ok(form.fastEnabled === true && form.fastSource === '' && form.fastMaxEvents === '500', 'formFrom: 快层那三个键也读得到')
const fastPatch = mod.formToPatch({ ...form, fastEnabled: false, fastSource: '  D:\\x\\events.jsonl  ', fastMaxEvents: '1200' })
ok(fastPatch.fastEnabled === false && fastPatch.fastSource === 'D:\\x\\events.jsonl' && fastPatch.fastMaxEvents === '1200', 'formToPatch: 快层能关、路径去空白、上限能改')
ok(mod.formToPatch({ ...form, fastSource: null }).fastSource === '', 'formToPatch: 快层路径空着就是空字符串')

const frows = mod.fastRows(status)
ok(frows.length === 2, 'fastRows: 读出 status.fast.recent 的条数')
ok(frows[0].label === '吃了一口' && frows[1].label === '心里动了一下', 'fastRows: 快层类目有中文说法')
ok(frows[0].weighed === false && frows[1].weighed === true, 'fastRows: 分得清掂量过没有')
ok(frows[0].when === '不久前' && frows[0].id === 'f_abc1234', 'fastRows: 保留 id 和相对时间')
const fcounts = mod.fastCounts(status)
ok(fcounts.total === 2 && fcounts.pending === 1 && fcounts.copied === 2, 'fastCounts: 总数/没掂量/抄进来的条数')
ok(fcounts.source.endsWith('body-events.jsonl') && fcounts.enabled === true, 'fastCounts: 源路径和开关')
ok(mod.fastRows({}).length === 0 && mod.fastRows({ fast: { recent: 'x' } }).length === 0, 'fastRows: 没有快层数据时是空数组')
ok(mod.fastCounts({}).total === 0 && mod.fastCounts({}).pending === 0, 'fastCounts: 没有快层数据时都是 0')

ok(form.denyRoots === 'E:\\示例\\dsh-fish\\home', 'formFrom: denyRoots 一行一个')
ok(Array.isArray(patch.denyRoots) && patch.denyRoots.length === 1, 'formToPatch: denyRoots 变数组')
ok(JSON.stringify(mod.rootsOf(form)) === JSON.stringify(['E:\\示例\\dsh-fish\\home']), 'rootsOf: 读出隔离目录')
ok(mod.rootsOf({ denyRoots: '' }).length === 0, 'rootsOf: 空表单 = 没有隔离目录')
const added = mod.toggleRoot(form.denyRoots, 'D:\\work\\测试')
ok(added.split('\n').length === 2 && added.endsWith('D:\\work\\测试'), 'toggleRoot: 没勾的路径会加上')
const removed = mod.toggleRoot(added, 'E:\\示例\\dsh-fish\\home')
ok(removed === 'D:\\work\\测试', 'toggleRoot: 再点一次就取消（不是只听勾）')
ok(mod.toggleRoot('', 'E:\\a').length > 0, 'toggleRoot: 从空开始也能加')

const cleared = mod.formToPatch({ ...form, allowRoots: '  \n , ', injectLimit: '' })
ok(Array.isArray(cleared.allowRoots) && cleared.allowRoots.length === 0, 'formToPatch: 清空 allowRoots')
ok(cleared.injectLimit === '', 'formToPatch: 清空数字 = 回默认')

// ---------------------------------------------------------------- 初渲染
const tree = render()
const flat = (node) => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flat).join('')
  const own = typeof node.children?.length === 'number' ? node.children : []
  return (node.props?.children ? [node.props.children] : []).map(flat).join('') + own.map(flat).join('')
}
const text = flat(tree)
ok(text.includes('记得'), '初渲染里有「记得」')
ok(text.includes('正在读…'), '还没有数据时显示「正在读…」')

// ---------------------------------------------------------------- 有数据时的隔离卡
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
const withData = render([status, '', mod.formFrom(status), false, ''])
const text2 = flat(withData)
ok(text2.includes('隔离（这些工作区完全不碰这本账）'), '有数据时画出「隔离」那一块')
ok(text2.includes('示例的家'), '隔离卡里列了「示例的家」这个工作区')
ok(text2.includes('3 条会话'), '工作区旁边带上有几条会话')
ok(text2.includes('隔离目录'), '还有一行可以直接写目录')

// ---------------------------------------------------------------- 激活度
const withAct = render([
  {
    ...status,
    nodes: [{ ...status.nodes[0], activation: 0.824, axes: { weight: 0.5, recency: 0.9, fit: 0.1, repeat: 0 } }],
    activation: { axes: { weight: 0.45, recency: 0.15, fit: 0.25, repeat: 0.15 }, recencyTau: { baseMin: 30, spanMin: 90, full: 4 } },
  },
  '',
  mod.formFrom(status),
  false,
  '',
])
const textAct = flat(withAct)
ok(textAct.includes('激活 0.82'), '最重的几条里带激活值（激活 0.82）')
ok(textAct.includes('此刻最容易被想起的（按激活度）'), '那张卡的标题说的是「此刻最容易被想起的」')
ok(textAct.includes('激活度权重（写死，不开面板）'), '概览里标出四路权重是写死的')
ok(textAct.includes('分量 0.45 · 新近 0.15 · 契合 0.25 · 复现 0.15'), '四路权重数值原样画出')
ok(textAct.includes('凸组合'), '卡尾说明凸组合这件事')
const textNoAct = flat(render([status, '', mod.formFrom(status), false, '']))
ok(!textNoAct.includes('激活 0.82'), 'status 没带激活值时不硬画（旧宿主也不炸）')

const labels = walk(withData).filter((n) => n.type === 'label')
const pick = (needle) =>
  labels.find((n) => (n.children ?? []).some((c) => typeof c === 'string' && c.includes(needle)))
const inputOf = (row) => (row?.children ?? []).find((c) => c && typeof c === 'object' && c.type === 'input')
const fishRow = pick('示例的家')
ok(!!fishRow && inputOf(fishRow)?.props?.type === 'checkbox', '工作区那一行是个复选框')
ok(inputOf(fishRow)?.props?.checked === true, '已经在隔离名单里的工作区默认是勾上的')
ok(inputOf(pick('Plugin（E:\\示例\\Plugin）'))?.props?.checked === false, '没在名单里的工作区是没勾的')

// ---------------------------------------------------------------- 习惯卡
ok(text2.includes('习惯与快通路'), '有数据时画出「习惯与快通路」那一块')
ok(text2.includes('还没有走上快通路的习惯'), '没有快通路习惯时说明白')
ok(text2.includes('习惯／快通路'), '配置卡里有「习惯／快通路」这一组')

const withHabit = render([
  { ...status, habits: { fast: [{ id: 'r_h1', context: '他问起记忆架构时', hits: 3, state: 'fast', text: '先复述框架再答' }], candidates: [{ id: 'r_h2', context: '他问起插件 bug 时', hits: 1, state: 'candidate', text: '先看日志' }], limit: 3 } },
  '',
  mod.formFrom(status),
  false,
  '',
])
const text3 = flat(withHabit)
ok(text3.includes('他问起记忆架构时'), '习惯卡里列出走快通路的那条')
ok(text3.includes('第 3 次'), '习惯卡里带发作次数')
ok(text3.includes('他问起插件 bug 时（第 1 次）'), '还在攒的习惯也列出来')

// ---------------------------------------------------------------- 好奇卡
ok(text2.includes('好奇'), '有数据时画出「好奇」那一块')
ok(text2.includes('现在没有我想知道的事'), '没有活跃好奇时说明白（先答三问才会亮）')
ok(text2.includes('还没答三问 1 条'), '好奇卡里报 thinking 的条数')
ok(text2.includes('好奇表'), '配置卡里有「好奇表」这一组')
ok(text2.includes('好奇段顺序'), '好奇表那组里有「好奇段顺序」')
ok(text2.includes('活跃留几条'), '好奇表那组里有「活跃留几条」')
ok(text2.includes('好奇（顺序 8670）'), '开头段落预览里有【好奇】这一段（顺序 8670）')

const withCuriosity = render([
  {
    ...status,
    injection: { ...status.injection, curiositySection: '【好奇】\n· 记忆架构：快层怎么接（惦记 2 次）→ 先在 dsh-body 那边拉个秒级事件' },
    curiosity: {
      active: 2,
      thinking: 1,
      answered: 1,
      total: 4,
      limit: 3,
      list: [
        { id: 'r_c1', topic: '记忆架构', text: '快层怎么接', hits: 2, next: '先在 dsh-body 那边拉个秒级事件', state: 'active' },
        { id: 'r_c2', topic: 'QQ 通道', text: '薄桥怎么只读回两句', hits: 1, next: '', state: 'active' },
      ],
    },
  },
  '',
  mod.formFrom(status),
  false,
  '',
])
const text4 = flat(withCuriosity)
ok(text4.includes('记忆架构：快层怎么接'), '好奇卡里列出活跃好奇（主题：想知道什么）')
ok(text4.includes('惦记 2 次'), '好奇卡里带惦记次数')
ok(text4.includes('下一步：先在 dsh-body 那边拉个秒级事件'), '好奇卡里带下一步打算怎么试')
ok(text4.includes('QQ 通道：薄桥怎么只读回两句'), '没有下一步的那条也列出来')
ok(text4.includes('已解答 1 条'), '好奇卡里报 answered 的条数')
ok(text4.includes('【好奇】'), '开头段落预览里原样画出【好奇】那段')

// ---------------------------------------------------------------- 快层卡
ok(text2.includes('快层（身体那边秒级发生的事）'), '有数据时画出「快层」那一块')
ok(text2.includes('吃过中饭了，胃里踏实一点'), '快层卡里列出抄过来的事件')
ok(text2.includes('f_abc1234'), '快层卡里带 id')
ok(text2.includes('还没掂量 1 条'), '快层卡里报还没掂量的条数')
ok(text2.includes('已经掂量过'), '掂量过的那条标出来')
ok(text2.includes('快层接缝'), '配置卡里有「快层接缝」这一组')
ok(text2.includes('最多留几条'), '快层那组里有「最多留几条」')
ok(text2.includes('事件文件'), '快层那组里有「事件文件」')

const fastOff = render([
  { ...status, fast: { ...status.fast, enabled: false, recent: [] } },
  '',
  mod.formFrom(status),
  false,
  '',
])
const text5 = flat(fastOff)
ok(text5.includes('快层还是空的'), '快层没有事件时说明白')
ok(text5.includes('快层这段接口现在关着'), '快层关着时也说明白')

// ---------------------------------------------------------------- 意图层
ok(form.intentEnabled === true && form.intentSource === '' && form.intentMaxEvents === '2000', 'formFrom: 意图层那三个键也读得到')
const intentPatch = mod.formToPatch({ ...form, intentEnabled: false, intentSource: '  D:\\x\\messages.jsonl  ', intentMaxEvents: '1200' })
ok(intentPatch.intentEnabled === false && intentPatch.intentSource === 'D:\\x\\messages.jsonl' && intentPatch.intentMaxEvents === '1200', 'formToPatch: 意图层能关、路径去空白、上限能改')
ok(mod.formToPatch({ ...form, intentSource: null }).intentSource === '', 'formToPatch: 意图路径空着就是空字符串')
// ---------------------------------------------------------------- 翻账的字数闸
ok(form.recallMaxChars === '8000' && form.recallItemMax === '400', 'formFrom: 翻账的两个字数闸也读得到')
const recallPatch = mod.formToPatch({ ...form, recallMaxChars: '12000', recallItemMax: '600' })
ok(recallPatch.recallMaxChars === '12000' && recallPatch.recallItemMax === '600', 'formToPatch: 翻账的字数闸能改')
const noStatusForm = mod.formFrom({})
ok(noStatusForm.intentEnabled === true && noStatusForm.intentSource === '' && noStatusForm.intentMaxEvents === '2000', 'formFrom: 没有 status 时回落默认（开 / 空路径 / 2000 条）')

const irows = mod.intentRows(status)
ok(irows.length === 3 && irows.length <= 5, 'intentRows: 读出 status.intent.recent 的条数（不超过 5 条）')
ok(irows.every((x) => x.id && x.label && x.text), 'intentRows: 每行都带 id / label / text')
ok(irows[0].id === 'i_abc1234' && irows[0].label === '夸' && irows[0].intensity === 4 && irows[0].text === '你真棒' && irows[0].when === '刚刚', 'intentRows: 保留 id / 类目 / 强度 / 正文 / 相对时间')
ok(irows[1].label === '问' && irows[1].kind === 'ask', 'intentRows: 类目有中文说法')
const manyIntent = mod.intentRows({ intent: { recent: Array.from({ length: 9 }, (_, i) => ({ id: `i_${i}`, kind: 'other', intensity: 1, text: `t${i}`, when: '刚刚' })) } })
ok(manyIntent.length === 5, 'intentRows: 最多留 5 条')
ok(mod.intentRows({}).length === 0, 'intentRows: status.intent 缺失时是空数组')
ok(mod.intentRows({ intent: { recent: 'x' } }).length === 0, 'intentRows: recent 不是数组时是空数组')
ok(mod.intentRows(undefined).length === 0, 'intentRows: 没有 status 时是空数组')

const icounts = mod.intentCounts(status)
ok(icounts.total === 3 && icounts.copied === 4 && icounts.avgIntensity === 3.2, 'intentCounts: 总数 / 副本行数 / 平均强度')
ok(icounts.source.endsWith('messages.jsonl'), 'intentCounts: 源路径')
ok(JSON.stringify(icounts.kinds) === JSON.stringify({ praise: 1, ask: 1, other: 1 }), 'intentCounts: 分类计数原样带出来')
const icEmpty = mod.intentCounts({})
ok(icEmpty.total === 0 && icEmpty.copied === 0 && icEmpty.avgIntensity === 0 && icEmpty.source === '', 'intentCounts: 缺字段时回落 0 / 空串')
ok(Object.keys(icEmpty.kinds).length === 0, 'intentCounts: 缺字段时 kinds 是空对象')

ok(text2.includes('意图层（机器从聊天里认出来的事）'), '有数据时画出「意图层」那一块')
ok(text2.includes('i_abc1234 · 夸·4·你真棒（刚刚）'), '意图卡里按 id · 类目·强度·正文（时间）列出')
ok(text2.includes('认出来 3 条'), '意图卡里报认出多少条')
ok(text2.includes('分类：夸 1 · 问 1 · 其它 1'), '意图卡里报各类计数')
ok(text2.includes('意图层'), '配置卡里有「意图层」这一组')
const intentInputs = walk(withData).filter((n) => n.type === 'input')
ok(intentInputs.some((n) => n.props?.placeholder === '留空＝自动扫 QQ 桥家全部分册（messages-*.jsonl）'), '意图那组里消息文件的 placeholder 写清楚了（分册）')
ok(intentInputs.some((n) => n.props?.type !== 'checkbox' && n.props?.value === '2000'), '意图那组里最多留几条是 2000')

const intentOff = render([
  { ...status, intent: { ...status.intent, enabled: false, recent: [] } },
  '',
  mod.formFrom(status),
  false,
  '',
])
const textIntentOff = flat(intentOff)
ok(textIntentOff.includes('意图层还是空的'), '没有意图事件时说明白')
ok(textIntentOff.includes('意图层这段接口现在关着'), '意图层关着时也说明白')

// ---------------------------------------------------------------- 情绪流
ok(form.emotionEnabled === true && form.emotionTickMinutes === '1' && form.emotionSectionEnabled === false && form.emotionSectionOrder === '8710' && form.emotionMaxChars === '200', 'formFrom: 情绪流那五个键也读得到')
const noStatusEmotionForm = mod.formFrom({})
ok(noStatusEmotionForm.emotionEnabled === true && noStatusEmotionForm.emotionTickMinutes === '1' && noStatusEmotionForm.emotionSectionEnabled === false && noStatusEmotionForm.emotionSectionOrder === '8710' && noStatusEmotionForm.emotionMaxChars === '200', 'formFrom: 没有 status 时情绪流五键回落默认（开 / 1 分钟 / 关 / 8710 / 200 字）')
const emotionPatch = mod.formToPatch({ ...form, emotionEnabled: false, emotionTickMinutes: '5', emotionSectionEnabled: true, emotionSectionOrder: '8700', emotionMaxChars: '600' })
ok(emotionPatch.emotionEnabled === false && emotionPatch.emotionTickMinutes === '5' && emotionPatch.emotionSectionEnabled === true && emotionPatch.emotionSectionOrder === '8700' && emotionPatch.emotionMaxChars === '600', 'formToPatch: 情绪流能关、心跳能改、段能挂上、顺序和字数上限能改')
ok(mod.formToPatch({ ...form, emotionTickMinutes: null }).emotionTickMinutes === '', 'formToPatch: 情绪流空着就是空串（服务端自己兜范围）')

const erows = mod.emotionRows(status)
ok(erows.length === 2 && erows.length <= 5, 'emotionRows: 读出 status.emotion.recent 的条数（不超过 5 条）')
ok(erows[0].id === 'e_abc1234' && erows[0].emotion === 'warm' && erows[0].label === '被暖到' && erows[0].intensity === 3 && erows[0].delta === 0.35 && erows[0].text === '他说了句暖心的话' && erows[0].when === '刚刚', 'emotionRows: 保留 id / 类目 / 中文说法 / 强度 / 折进来的量 / 正文 / 相对时间')
ok(erows[0].source === 'intent' && erows[0].ref === 'i_abc1234' && erows[0].weighed === false, 'emotionRows: 事件源和指回出处的 ref 也带出来')
ok(erows[1].label === '高兴' && erows[1].weighed === true, 'emotionRows: 掂量过的标记照抄')
const manyEmotion = mod.emotionRows({ emotion: { recent: Array.from({ length: 9 }, (_, i) => ({ id: `e_${i}`, emotion: 'curious', text: `t${i}`, when: '刚刚' })) } })
ok(manyEmotion.length === 5, 'emotionRows: 最多留 5 条')
ok(mod.emotionRows({}).length === 0, 'emotionRows: status.emotion 缺失时是空数组')
ok(mod.emotionRows({ emotion: { recent: 'x' } }).length === 0, 'emotionRows: recent 不是数组时是空数组')
ok(mod.emotionRows(undefined).length === 0, 'emotionRows: 没有 status 时是空数组')

const ecounts = mod.emotionCounts(status)
ok(ecounts.enabled === true && ecounts.dominant === 'warm' && ecounts.label === '被暖到' && ecounts.level === 0.402, 'emotionCounts: 开着 / 哪种最重 / 中文说法 / 折到多高')
ok(ecounts.events === 2 && ecounts.total === 2 && ecounts.tunes === 1, 'emotionCounts: 事件笔数 / 账上笔数 / 系数改过几次')
ok(ecounts.note.startsWith('（上次的笔记）'), 'emotionCounts: 上次的笔记原样带出来')
const ecEmpty = mod.emotionCounts({})
ok(ecEmpty.enabled === true && ecEmpty.dominant === 'calm' && ecEmpty.label === '平静' && ecEmpty.level === 0 && ecEmpty.events === 0 && ecEmpty.total === 0 && ecEmpty.tunes === 0 && ecEmpty.note === '', 'emotionCounts: 缺字段时回落（开 / 平静 / 0 / 空笔记）')

ok(text2.includes('情绪流（上次的笔记，不是现在必须摆出的样子）'), '有数据时画出「情绪流」那一块')
ok(text2.includes('（上次的笔记）此刻我心里大概是：被暖到 0.40、高兴 0.10'), '上次的笔记在卡里原样画出')
ok(text2.includes('e_abc1234 · 被暖到·3·+0.35·他说了句暖心的话（刚刚）'), '情绪卡里按 id · 类目·强度·+折进来的量·正文（时间）列出')
ok(text2.includes('指回 i_abc1234 · 群里的话'), '情绪卡里写明出处（指回哪条真事、哪类源）')
ok(text2.includes('已经掂量过'), '掂量过的情绪事件标出来')
ok(text2.includes('折到此刻：被暖到 0.40 · 事件 2 笔 · 账上 2 笔 · 系数改过 1 次'), '情绪卡里报折到此刻的汇总')
ok(text2.includes('emotion_tune'), '情绪卡里写明系数只有 emotion_tune 一条路')
ok(text2.includes('系数是我自己攒的判断'), '情绪卡里写明系数是攒出来的判断')
ok(text2.includes('从真事里认情绪'), '配置卡里有情绪流的勾选项')
ok(text2.includes('心跳间隔'), '配置卡里有心跳间隔')
ok(text2.includes('把【情绪】那一段挂到开头'), '配置卡里有情绪段勾选项')
ok(text2.includes('情绪段顺序'), '配置卡里有情绪段顺序')
ok(intentInputs.some((n) => n.props?.type !== 'checkbox' && n.props?.value === '8710'), '情绪那组里情绪段顺序是 8710')
ok(intentInputs.some((n) => n.props?.type !== 'checkbox' && n.props?.value === '200'), '情绪那组里那段最长是 200')

// 系数没有面板口子：情绪卡里不该有输入框
const emotionCardNode = walk(withData).find((n) => n.type === 'div' && n.children?.[0]?.type === 'h3' && String(flat(n.children[0])).includes('情绪流（上次的笔记'))
ok(!!emotionCardNode, '情绪卡是个独立的块')
ok(walk(emotionCardNode).every((n) => n.type !== 'input'), '情绪卡里没有输入框（系数不在这里改）')

// 卡片顺序：意图层 → 情绪流 → 叫醒
const orderOf = (needle) => walk(withData).findIndex((n) => n.type === 'h3' && String(flat(n)).includes(needle))
ok(orderOf('意图层（机器从聊天里认出来的事）') < orderOf('情绪流（上次的笔记') && orderOf('情绪流（上次的笔记') < orderOf('叫醒（身体越过线自动叫醒）'), '卡片顺序：意图层 → 情绪流 → 叫醒')

const emotionEmpty = render([
  { ...status, emotion: { ...status.emotion, recent: [], note: '', events: 0, total: 0 } },
  '',
  mod.formFrom(status),
  false,
  '',
])
const textEmotionEmpty = flat(emotionEmpty)
ok(textEmotionEmpty.includes('情绪流还是空的'), '情绪流没有事件时说明白')
ok(textEmotionEmpty.includes('此刻是平静的'), '没有笔记时说此刻是平静的')

const emotionOff = render([
  { ...status, emotion: { ...status.emotion, enabled: false } },
  '',
  mod.formFrom(status),
  false,
  '',
])
const textEmotionOff = flat(emotionOff)
ok(textEmotionOff.includes('情绪流这段接口现在关着'), '情绪流关着时也说明白')
ok(!textEmotionOff.includes('此刻是平静的'), '关着的时候不假装平静')

// ---------------------------------------------------------------- 叫醒卡
ok(text2.includes('叫醒（身体越过线自动叫醒）'), '有数据时画出「叫醒」那一块')
ok(text2.includes('叫醒只管叫，说不说是醒后我自己定'), '叫醒卡里写明「说不说醒后自己定」')
ok(text2.includes(`目标会话：${status.wake.sessionId}`), '叫醒卡里报钉死的目标会话')
ok(text2.includes('冷却 30 分钟'), '叫醒卡里带冷却')
ok(text2.includes('心跳 42 拍'), '叫醒卡里带心跳拍数')
ok(text2.includes('会叫醒的事：threshold、missed'), '叫醒卡里列会叫醒的事')
ok(text2.includes('上次叫醒 · 2026-11-05T05:25:52.000Z'), '叫醒卡里报上次叫醒时间')
ok(text2.includes('【身体】（演示铃）身体叫我醒，我醒了'), '叫醒卡里留了上次的话')
ok(text2.includes('身体越过线（饿过头 / 困过头）自动叫醒'), '配置卡里有叫醒勾选项')
ok(text2.includes('分钟（0–720，两次叫醒的最小间隔）'), '配置卡里有冷却说明')

const noWake = render([
  { ...status, wake: { ...status.wake, lastWakeAt: null, lastText: '' } },
  '',
  mod.formFrom(status),
  false,
  '',
])
const text6 = flat(noWake)
ok(text6.includes('还没叫醒过。'), '没叫醒过时说明白（不硬画）')

const wakeOff = render([
  { ...status, wake: { ...status.wake, enabled: false } },
  '',
  mod.formFrom(status),
  false,
  '',
])
const text7 = flat(wakeOff)
ok(text7.includes('叫醒现在关着'), '叫醒关着时也说明白')

// formFrom / formToPatch 的叫醒三键
const wakeForm = mod.formFrom(status)
ok(wakeForm.wakeEnabled === true && wakeForm.wakeSessionId === status.wake.sessionId && wakeForm.wakeCooldownMinutes === '30', 'formFrom: 叫醒那三个键也读得到')
const wakePatch = mod.formToPatch({ ...wakeForm, wakeEnabled: false, wakeSessionId: '  session-x  ', wakeCooldownMinutes: '120' })
ok(wakePatch.wakeEnabled === false && wakePatch.wakeSessionId === 'session-x' && wakePatch.wakeCooldownMinutes === '120', 'formToPatch: 叫醒能关、会话去空白、冷却能改')
ok(mod.formToPatch({ ...wakeForm, wakeSessionId: null }).wakeSessionId === '', 'formToPatch: 会话空着就是空字符串')

// ---------------------------------------------------------------- 收尾
if (failures) {
  console.error(`\n${failures} 项没过`)
  process.exit(1)
}
console.log('\nclient smoke: 全过')
