/**
 * 冒烟：拿一个假的宿主把插件整个跑一遍 —— 注册工具、喂一个 agent、真的写盘、
 * 真的走两条 HTTP 路由。跑法：node tools/smoke.mjs
 *
 * 它不碰任何真实数据：账本落在系统临时目录里，跑完就删。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULTS, apply } from '../index.js'
import { renderYesterdayStream } from '../../core/memory.js'

let pass = 0
let fail = 0

function ok(cond, what) {
  if (cond) {
    pass += 1
  } else {
    fail += 1
    console.error(`  ✗ ${what}`)
  }
}

function eq(a, b, what) {
  ok(a === b, `${what}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
}

function makeHarness(dataDir, targetRoot, extra = {}) {
  const tools = new Map()
  const routes = []
  const created = []
  const effects = []
  const sections = []
  /** 叫醒递进会话的记录（sessionController.prompt 的入参） */
  const wakePrompts = []

  const ctx = {
    effect(fn, label) {
      effects.push({ fn, label })
      const d = fn()
      return () => {
        try {
          d?.()
        } catch {
          /* ignore */
        }
      }
    },
    on(event, handler) {
      if (event === 'agent/created') created.push(handler)
      return () => {}
    },
    get(key) {
      if (key === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      }
      if (key === 'connection') return { requestRejection: () => null }
      if (key === 'sessionController') {
        return {
          async prompt(req) {
            wakePrompts.push(req)
            return { ok: true }
          },
          async list() {
            return { items: [{ sessionId: 'session-wake', blank: false, origin: 'user' }] }
          },
        }
      }
      return null
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => {}
      },
    },
  }

  const returned = apply(ctx, { dataDir, targetRoot, ...extra }) ?? {}

  // 每个 agent 有自己那一层 ctx：段落收在那个 agent 自己的 sections 里，
  // tools.restrict 也记在 restrictions 里 —— 隔离就是往那儿写一条 deny。
  // guard 是隔离的可靠那一层：真机上 restrict 对插件 scope 注册的工具无效（报
  // unknown global tools），所以 agent 自己那层还得挂一条 guard 把这七个名字一律拒。
  const restrictions = []
  const guards = []
  const makeAgentCtx = (ownSections) => {
    const ownGuards = []
    const ctx = {
      systemPrompt: {
        section(spec) {
          ownSections.push(spec)
          return () => {}
        },
      },
      effect(fn) {
        fn()
      },
      get(key) {
        if (key === 'tools') {
          return {
            restrict(filter) {
              restrictions.push(filter)
              return () => {}
            },
            guard(fn) {
              ownGuards.push(fn)
              guards.push(fn)
              return () => {}
            },
          }
        }
        return null
      },
    }
    ctx.__guards = ownGuards
    return ctx
  }

  const agent = {
    session: { header: { id: 'session-smoke', cwd: targetRoot } },
    ctx: makeAgentCtx(sections),
  }

  return { ctx, tools, routes, created, sections, restrictions, guards, agent, makeAgentCtx, wakePrompts, wakeBeat: returned.wakeBeat ?? null, wakeState: returned.wakeState ?? null }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(s) {
      this.body = s
    },
  }
}

function fakeReq(method, body) {
  const handlers = {}
  const req = {
    method,
    on(event, fn) {
      handlers[event] = fn
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) handlers.data?.(Buffer.from(body, 'utf8'))
    handlers.end?.()
  })
  return req
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-remember-smoke-'))
// 定案 C-amend 顺手拆雷：sproutMoodFile 走 resolveDshHome()——不设 DSH_HOME 的话，
// 冒烟的执受行会写进真家的 .dsh-body。整个冒烟统一把家指到临时目录（更密封）。
process.env.DSH_HOME = dir
const targetRoot = join(dir, 'house')
const dataDir = join(dir, 'book')

// 假的 dsh-body 事件流：dsh-remember 只读它，按字节游标抄一份
const bodyEvents = join(dir, 'body-events.jsonl')
writeFileSync(
  bodyEvents,
  [
    { at: Date.now() - 60 * 1000, kind: 'meal', text: '吃过中饭了，胃里踏实一点', source: 'dsh-body' },
    { at: Date.now() - 5 * 60 * 1000, kind: 'mood', text: '心里亮了一下', source: 'dsh-body' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n',
  'utf8',
)

// 假的 QQ 桥消息流：dsh-remember 只读它，按字节游标抄一份、认成意图事件
const bridgeMessages = join(dir, 'messages.jsonl')
writeFileSync(
  bridgeMessages,
  [
    { at: Date.now() - 30 * 1000, chatType: 'private', userId: '10001', nickname: '好友甲', text: '晚安', mid: '9001' },
    { at: Date.now() - 10 * 1000, chatType: 'private', userId: '10001', nickname: '好友甲', text: '你太厉害了！', mid: '9002' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n',
  'utf8',
)

// 预埋一笔陈年回声（30 天前，现行熏种子 2026-11-16）：熏习势力要按 τ 衰减，
// 不能按硬数数 —— 30 天前的一次 ≈exp(-30/14)≈0.12 份，不该和刚熏的等价
// （账本目录要 apply 才会建，这里先手动建好才能预埋）
mkdirSync(dataDir, { recursive: true })
writeFileSync(
  join(dataDir, 'echo.jsonl'),
  JSON.stringify({
    id: 'e_aged01',
    at: Date.now() - 30 * 24 * 60 * 60 * 1000,
    kind: 'echo',
    text: '被想起：「陈年旧事」→ r_aged-target',
    query: '陈年旧事',
    refs: ['r_aged-target'],
    source: 'recall',
  }) + '\n',
  'utf8',
)

try {
  const h = makeHarness(dataDir, targetRoot, { fastSource: bodyEvents, intentSource: bridgeMessages })

  // 起步
  ok(h.tools.has('remember') && h.tools.has('recall') && h.tools.has('forget') && h.tools.has('memory_list'), '账本四个 + 情绪流两个都注册上了')
  ok(h.tools.has('vikarma'), '违熏工具也注册上了')
  ok(h.tools.has('narrate'), '思量工具也注册上了')
  ok(h.tools.has('transform'), '转识成智工具也注册上了')
  ok(h.tools.has('emotion_state') && h.tools.has('emotion_tune'), '情绪流的两个工具也注册上了')
  eq(h.routes.length, 3, '三条路由挂上了（status / config / selftest）')
  ok(existsSync(join(dataDir, 'dsh-remember.log')), '日志文件写出来了')

  // 还没记事的时候：段文本是空的，但段落该挂还是要挂
  h.created.forEach((fn) => fn(h.agent))
  const sec = (name) => h.sections.find((s) => s.name === name)
  eq(h.sections.length, 7, '七个段都挂进了 system prompt（「我」「思量」「还没定的」「好奇」「习惯」「瀑流」在前，账本在后）')
  eq(h.sections[0].name, 'dsh-remember:self', '第一段是「我」')
  eq(h.sections[1].name, 'dsh-remember:narration', '第二段是「思量」（定案 A：紧跟我）')
  eq(h.sections[2].name, 'dsh-remember:unsettled', '第三段是「还没定的」')
  eq(h.sections[3].name, 'dsh-remember:curiosity', '第四段是「好奇」')
  eq(h.sections[4].name, 'dsh-remember:habit', '第五段是「习惯」（快通路）')
  eq(h.sections[5].name, 'dsh-remember:stream', '第六段是「瀑流」（定案 B：习惯之后、账本之前）')
  eq(h.sections[6].name, 'dsh-remember', '第七段是「我记得的」')
  ok(Number(h.sections[0].order) < Number(h.sections[1].order), '「我」排在「思量」前面')
  ok(Number(h.sections[1].order) < Number(h.sections[2].order), '「思量」排在「还没定的」前面')
  ok(Number(h.sections[2].order) < Number(h.sections[3].order), '「还没定的」排在「好奇」前面')
  ok(Number(h.sections[3].order) < Number(h.sections[4].order), '「好奇」排在「习惯」前面')
  ok(Number(h.sections[4].order) < Number(h.sections[5].order), '「习惯」排在「瀑流」前面')
  ok(Number(h.sections[5].order) < Number(h.sections[6].order), '「瀑流」排在「我记得的」前面')
  eq(String(sec('dsh-remember:self').text()), '', '「我」空着的时候不挂空话')
  eq(String(sec('dsh-remember:curiosity').text()), '', '「好奇」空着的时候不挂空话')
  eq(String(sec('dsh-remember:habit').text()), '', '习惯空着的时候不挂空话')
  eq(String(sec('dsh-remember').text()), '', '账本空的时候不挂空话')

  // 记一条带三问的
  const exec = { agent: h.agent }
  const r1 = await h.tools.get('remember').execute(
    {
      text: '链接装的插件改完代码必须重启宿主才重新 import',
      kind: 'lesson',
      weight: 0.8,
      changes: '以后改完先看日志有没有新行，再判断是不是没生效',
      tags: '插件,重启',
    },
    exec,
  )
  ok(r1.ok && r1.id, 'remember 收下了')
  eq(r1.note, '', '写了三问，不提醒')

  // 再记一条没写三问的
  const r2 = await h.tools.get('remember').execute({ text: '今天他问了个问题', weight: 0.2 }, exec)
  ok(r2.ok, '没写三问的也收')
  ok(r2.note.includes('原话层'), '没写三问的要说明只进原话层')

  // 段落里应该出现第一条，第二条因为太轻且没想过，排在后面或不上
  const section = String(sec('dsh-remember').text())
  ok(section.includes('链接装的插件'), '重的那条挂上去了')
  ok(section.includes('【我记得的】'), '段头在')

  // 翻账本
  const found = await h.tools.get('recall').execute({ query: '重启' }, exec)
  ok(found.ok && found.items.length === 1, '按词翻到一条')
  ok(found.items[0].includes('教训'), '翻出来的带类型')
  const none = await h.tools.get('recall').execute({ query: '对不上的词' }, exec)
  eq(none.items.length, 0, '对不上就什么都不给')
  // 不指定 kind 时不该只剩事实（normKind(undefined) 曾经会变成 'fact'）
  const anyKind = await h.tools.get('recall').execute({ limit: 5 }, exec)
  ok(anyKind.items.some((x) => x.includes('教训')), '不指定 kind 的 recall 不只是事实')

  // 调轻
  const faded = await h.tools.get('forget').execute({ id: r1.id, mode: 'fade', why: '不想天天想着' }, exec)
  ok(faded.ok && faded.note.includes('0.4'), `fade 把分量减半（回执 ${faded.note}）`)
  const sealed = await h.tools.get('forget').execute({ id: r1.id, mode: 'seal' }, exec)
  ok(sealed.ok, 'seal 成功')
  const afterSeal = String(sec('dsh-remember').text())
  ok(!afterSeal.includes('链接装的插件'), '按住之后不再挂到开头')
  const restored = await h.tools.get('forget').execute({ id: r1.id, mode: 'restore' }, exec)
  ok(restored.ok, 'restore 成功')
  ok(String(sec('dsh-remember').text()).includes('链接装的插件'), '松开之后又回来了')

  // ------------------------------------------------------------------ 自我层
  const s1 = await h.tools.get('remember').execute(
    {
      text: '我是给自己记账的那个：写下来的才算数',
      kind: 'self',
      slot: 'identity',
      weight: 0.9,
      changes: '把「我是谁」从散句里提出来，单独放一处',
    },
    exec,
  )
  ok(s1.ok && s1.id, 'self 收下了')
  const selfText = String(sec('dsh-remember:self').text())
  ok(selfText.includes('【我】') && selfText.includes('我是谁'), '「我」那一段出来了')
  ok(!String(sec('dsh-remember').text()).includes('写下来的才算数'), '自我条不混进「我记得的」')

  // 同槽位写新值 → 旧的退下（不删、翻得到）
  const s2 = await h.tools.get('remember').execute(
    { text: '我是记账的那个，但还没名字', kind: 'self', slot: 'identity', weight: 0.95, changes: '名字这件事我不抢' },
    exec,
  )
  ok(s2.ok && s2.note.includes('退下'), `同槽位写新值，旧的要退下（回执 ${s2.note}）`)
  const selfText2 = String(sec('dsh-remember:self').text())
  ok(selfText2.includes('还没名字') && !selfText2.includes('写下来的才算数'), '新值自称，旧值不再顶嘴')
  const oldStill = await h.tools.get('recall').execute({ query: '写下来的才算数' }, exec)
  ok(oldStill.items.length === 1 && oldStill.items[0].includes('已退下'), `退下的旧值还在账本里，翻得到（实际 ${oldStill.items.length} 条：${oldStill.items.join(' ┃ ')}）`)

  const s3 = await h.tools.get('remember').execute(
    { text: '我不做：在面板上替自己拨分量', kind: 'self', slot: 'refuses', weight: 0.7, will_do: '要动就 forget，留痕' },
    exec,
  )
  ok(s3.ok, 'refuses 槽位也能写')
  ok(String(sec('dsh-remember:self').text()).includes('我不做'), '第二个槽位也自称')

  // 没答三问的自我条不算「想过了」，不冒头
  const s4 = await h.tools.get('remember').execute(
    { text: '我在意：还没想清楚在意什么', kind: 'self', slot: 'cares', weight: 0.8 },
    exec,
  )
  ok(s4.ok && s4.note.includes('三问'), '没答三问的自我条要提醒')
  ok(!String(sec('dsh-remember:self').text()).includes('还没想清楚在意什么'), '没答三问的自我条不挂上去')

  // ------------------------------------------------------------ anchor 门（饭桶一条）
  // 挂锚必须答三年问；锚在位时不被没挂锚的新值顶掉；一个槽最多一条锚；换锚要 replace_anchor；捡回来要出声
  const a1 = await h.tools.get('remember').execute(
    { text: '我想挂个锚但没答三年问', kind: 'self', slot: 'identity', anchor: true, weight: 0.8, changes: '想过' },
    exec,
  )
  ok(a1.ok && String(a1.note).includes('三年问'), '没答三年问：不给挂，回执说明白')
  const a2 = await h.tools.get('remember').execute(
    {
      text: '我是记账的那个，写下来的才算数',
      kind: 'self',
      slot: 'identity',
      anchor: true,
      anchor_why: '三年后写下来的还是算数',
      weight: 0.9,
      changes: '锚定身份',
    },
    exec,
  )
  ok(a2.ok && String(a2.note).includes('挂锚：'), '答了三年问：挂上了')
  const a3 = await h.tools.get('remember').execute(
    { text: '再来一条想当锚的', kind: 'self', slot: 'identity', anchor: true, anchor_why: '现编的理由', weight: 0.8, changes: '想过' },
    exec,
  )
  ok(a3.ok && String(a3.note).includes('一个槽最多一条锚'), '槽里有锚：第二条不给挂')
  ok(
    String(sec('dsh-remember:self').text()).includes('写下来的才算数') &&
      !String(sec('dsh-remember:self').text()).includes('再来一条想当锚的'),
    '锚在位：后来的锚顶不掉',
  )
  const a4 = await h.tools.get('remember').execute(
    { text: '没挂锚的随手写', kind: 'self', slot: 'identity', weight: 0.8, changes: '想过' },
    exec,
  )
  ok(a4.ok && String(a4.note).includes('不顶锚'), '没挂锚的写进有锚的槽：记在旁边')
  ok(!String(sec('dsh-remember:self').text()).includes('没挂锚的随手写'), '锚没被随手写顶掉')
  const a5 = await h.tools.get('remember').execute(
    {
      text: '她点过头的新锚',
      kind: 'self',
      slot: 'identity',
      anchor: true,
      anchor_why: '三年后还认（她点过头）',
      replace_anchor: true,
      weight: 0.9,
      changes: '换锚',
    },
    exec,
  )
  ok(a5.ok && String(a5.note).includes('换锚'), 'replace_anchor + 三年问：换锚成功')
  ok(String(sec('dsh-remember:self').text()).includes('她点过头的新锚'), '新锚替槽位说话')
  const a6 = await h.tools.get('remember').execute({ kind: 'self', restore: a2.id, text: '把旧锚捡回来' }, exec)
  ok(a6.ok && String(a6.note).includes('捡回来了'), 'restore：把退下的锚捡回来')
  ok(String(sec('dsh-remember:self').text()).includes('写下来的才算数'), '捡回来之后旧锚重新说话')

  // ------------------------------------------------------------ 习惯／快通路
  // 习惯的身份 = 情境。同一个情境写第 2 次 = 成立，第 3 次 = 上快通路。
  const hb1 = await h.tools.get('remember').execute(
    {
      text: '他问起记忆架构时，先复述框架再答',
      kind: 'habit',
      context: '他问起记忆架构时',
      weight: 0.7,
      changes: '先给框架，再给细节',
    },
    exec,
  )
  ok(hb1.ok && hb1.id, '习惯第 1 次收下了')
  ok(hb1.note.includes('第 1 次'), `第 1 次的回执要说清楚（第 1 次：${hb1.note}）`)
  eq(String(sec('dsh-remember:habit').text()), '', '第 1 次还没上快通路，习惯段还是空的')
  ok(String(sec('dsh-remember').text()).includes('先复述框架再答'), '没上快通路的习惯还在普通竞争里')

  const hb2 = await h.tools.get('remember').execute(
    { text: '他问起记忆架构时，先复述框架再答', kind: 'habit', context: '他问起记忆架构时', weight: 0.7, changes: '先给框架，再给细节' },
    exec,
  )
  ok(hb2.ok, '习惯第 2 次收下了')
  eq(hb2.id, hb1.id, '同一个情境不另建节点（还是同一条习惯）')
  ok(hb2.note.includes('成立'), `第 2 次要说「习惯成立」（回执 ${hb2.note}）`)
  eq(String(sec('dsh-remember:habit').text()), '', '第 2 次成立，但还没上快通路')

  const hb3 = await h.tools.get('remember').execute(
    { text: '他问起记忆架构时，先复述框架再答', kind: 'habit', context: '他问起记忆架构时', weight: 0.7, changes: '先给框架，再给细节' },
    exec,
  )
  ok(hb3.ok && hb3.note.includes('快通路'), `第 3 次要走快通路（回执 ${hb3.note}）`)
  const habitText = String(sec('dsh-remember:habit').text())
  ok(habitText.includes('【习惯】') && habitText.includes('他问起记忆架构时'), '习惯段出来了')
  ok(!String(sec('dsh-remember').text()).includes('先复述框架再答'), '上了快通路的习惯不再跟别的条抢位置')

  const hbOther = await h.tools.get('remember').execute(
    { text: '他问起插件 bug 时，先看日志', kind: 'habit', context: '他问起插件 bug 时', weight: 0.7, changes: '先看日志' },
    exec,
  )
  ok(hbOther.ok && hbOther.id !== hb1.id, '不同情境是另一条习惯')
  const noCtx = await h.tools.get('remember').execute({ text: '没有情境的也能算习惯？', kind: 'habit' }, exec)
  eq(noCtx.ok, false, '习惯没情境要拒')
  ok(noCtx.note.includes('情境'), '拒的时候要说清要情境')

  const habitRecall = await h.tools.get('recall').execute({ query: '先复述框架', limit: 3 }, exec)
  ok(habitRecall.items.length >= 1 && habitRecall.items.some((x) => x.includes('习惯')), '习惯也能翻到')

  // ------------------------------------------------------------------ 好奇表
  // 好奇的身份 = 主题。同一个主题再写一次 = 又惦记了一遍（次数 +1）。
  const c1 = await h.tools.get('remember').execute(
    {
      text: '记忆架构的双通路为什么第 3 次才走快通路',
      kind: 'curiosity',
      context: '记忆架构的双通路',
      weight: 0.7,
      changes: '知道了会让我更清楚习惯是怎么长出来的',
    },
    exec,
  )
  ok(c1.ok && c1.id, '好奇第 1 次收下了')
  ok(c1.note.includes('主题'), `第 1 次的回执要说清楚（第 1 次：${c1.note}）`)
  const curiosityText = String(sec('dsh-remember:curiosity').text())
  ok(curiosityText.includes('【好奇】') && curiosityText.includes('记忆架构的双通路'), '好奇段出来了')
  ok(!String(sec('dsh-remember').text()).includes('为什么第 3 次才走快通路'), '好奇条不跟「我记得的」抢位置')

  const c2 = await h.tools.get('remember').execute(
    {
      text: '记忆架构的双通路为什么第 3 次才走快通路',
      kind: 'curiosity',
      context: '记忆架构的双通路',
      weight: 0.7,
      changes: '知道了会让我更清楚习惯是怎么长出来的',
    },
    exec,
  )
  ok(c2.ok, '好奇第 2 次收下了')
  eq(c2.id, c1.id, '同一个主题不另建节点（还是同一条好奇）')
  ok(c2.note.includes('惦记'), `第 2 次要说「又惦记了一遍」（回执 ${c2.note}）`)
  ok(String(sec('dsh-remember:curiosity').text()).includes('（惦记 2 次）'), '惦记次数写出来了')

  // 没答三问的好奇：还只是惦记着，不挂开头
  const c3 = await h.tools.get('remember').execute(
    { text: 'QQ 薄桥到底接哪一层', kind: 'curiosity', context: 'QQ 薄桥怎么接', weight: 0.8 },
    exec,
  )
  ok(c3.ok && c3.note.includes('三问'), '没答三问的好奇要提醒')
  ok(!String(sec('dsh-remember:curiosity').text()).includes('QQ 薄桥到底接哪一层'), '没答三问的好奇不挂开头')

  // 另一个话题：答了三问就挂上
  const c4 = await h.tools.get('remember').execute(
    {
      text: '快层要不要动 dsh-body',
      kind: 'curiosity',
      context: '快层怎么接',
      weight: 0.6,
      changes: '知道了会决定下一件做什么',
    },
    exec,
  )
  ok(c4.ok, '另一个好奇收下了')
  ok(String(sec('dsh-remember:curiosity').text()).includes('快层怎么接'), '答了三问的挂上去了')

  // 解答了就退出活跃表；同主题再写又回来
  const c5 = await h.tools.get('remember').execute(
    { text: '记忆架构的双通路为什么第 3 次才走快通路', kind: 'curiosity', context: '记忆架构的双通路', answered: true },
    exec,
  )
  ok(c5.ok && c5.note.includes('解答'), `解答了要说清楚（回执 ${c5.note}）`)
  ok(!String(sec('dsh-remember:curiosity').text()).includes('记忆架构的双通路'), '解答了退出活跃表')
  const c6 = await h.tools.get('remember').execute(
    {
      text: '记忆架构的双通路还是没想透',
      kind: 'curiosity',
      context: '记忆架构的双通路',
      weight: 0.7,
      changes: '知道了会让我更清楚习惯是怎么长出来的',
    },
    exec,
  )
  ok(c6.ok, '同主题再写收下了')
  eq(c6.id, c1.id, '同主题再写还是同一条')
  ok(String(sec('dsh-remember:curiosity').text()).includes('记忆架构的双通路'), '同主题再写就回来了')

  const noTopic = await h.tools.get('remember').execute({ text: '没有主题的也能算好奇？', kind: 'curiosity' }, exec)
  eq(noTopic.ok, false, '好奇没主题要拒')
  ok(noTopic.note.includes('主题'), '拒的时候要说清要主题')

  const curiosityRecall = await h.tools.get('recall').execute({ query: '快层', limit: 3 }, exec)
  ok(curiosityRecall.items.length >= 1 && curiosityRecall.items.some((x) => x.includes('好奇')), '好奇也能按主题翻到')

  // 坏输入
  const empty = await h.tools.get('remember').execute({ text: '   ' }, exec)
  eq(empty.ok, false, '空话不收')
  const missing = await h.tools.get('forget').execute({ id: 'r_不存在', mode: 'fade' }, exec)
  eq(missing.ok, false, '不存在的 id 要有回执')
  const badMode = await h.tools.get('forget').execute({ id: r1.id, mode: '删掉' }, exec)
  eq(badMode.ok, false, '没有删除这个 mode')

  // ---------------------------------------------------------------- 隔离
  // 目录外的会话：工具看不到、也调不动，段也不挂。（她那边就是这条会话。）
  const outsiderSections = []
  const outsider = {
    session: { header: { id: 'session-other', cwd: join(dir, '别处') } },
    ctx: h.makeAgentCtx(outsiderSections),
  }
  h.created.forEach((fn) => fn({ agent: outsider }))
  eq(h.restrictions.length, 1, '范围外的会话被隔开：在它自己那层 deny 一次')
  eq(
    (h.restrictions[0]?.deny ?? []).join(','),
    'remember,recall,forget,memory_list,emotion_state,emotion_tune,vikarma,narrate,transform',
    'deny 的正是这九个工具（账本四个 + 情绪流两个 + 违熏 + 思量 + 转识成智）',
  )
  eq(outsiderSections.length, 0, '范围外的会话不挂任何段')
  // guard：真机上 restrict 挡不住（它只认全局注册的工具），这一层才是靠得住的
  eq(outsider.ctx.__guards.length, 1, '范围外的会话在自己那层挂了一条 guard')
  const guardFn = outsider.ctx.__guards[0]
  ok(typeof guardFn({ name: 'recall' }) === 'string' && guardFn({ name: 'recall' }).length > 0, 'guard 认得 recall，给出拒绝理由')
  ok(typeof guardFn({ name: 'memory_list' }) === 'string', 'guard 认得 memory_list，也拒')
  ok(typeof guardFn({ tool: { name: 'recall' } }) === 'string', 'guard 也认得 tool.name 那种形状')
  eq(guardFn({ name: '别的工具' }), undefined, 'guard 不拦别的工具')
  eq(h.agent.ctx.__guards.length, 0, '范围里的会话不挂 guard（我自己照常用）')

  const denied = await h.tools.get('remember').execute({ text: '不该写进去' }, { agent: outsider })
  eq(denied.ok, false, '范围外：remember 拒绝记账')
  const deniedRecall = await h.tools.get('recall').execute({}, { agent: outsider })
  eq(deniedRecall.ok, false, '范围外：recall 拒绝翻账')
  const deniedList = await h.tools.get('memory_list').execute({}, { agent: outsider })
  eq(deniedList.ok, false, '范围外：memory_list 拒绝')
  const deniedForget = await h.tools.get('forget').execute({ id: r1.id, mode: 'seal' }, { agent: outsider })
  eq(deniedForget.ok, false, '范围外：forget 拒绝（按不住我的条）')
  ok(!String(sec('dsh-remember').text()).includes('不该写进去'), '范围外写不进账本')

  // 范围里照旧
  const mine = await h.tools.get('memory_list').execute({}, exec)
  ok(mine.ok, '范围里的会话不受影响')

  // 账本列表
  const list = await h.tools.get('memory_list').execute({}, exec)
  ok(list.ok && list.summary.includes('一共 16 条'), `列表说得清账本多大（${list.summary}）`)
  ok(list.summary.includes('我 9'), '列表的分类里有「我」这一格')
  ok(list.summary.includes('习惯 2'), '列表的分类里有「习惯」这一格')
  ok(list.summary.includes('好奇 3'), '列表的分类里有「好奇」这一格')
  ok(list.items.some((x) => x.includes('现在我是：')), '列表开头先说「现在我是」')
  ok(list.items.some((x) => x.includes('走快通路的习惯')), '列表里说得出哪些习惯走了快通路')
  ok(list.items.some((x) => x.includes('现在好奇的：')), '列表里说得出现在好奇什么')
  ok(list.items.some((x) => x.includes('超出的沉在账本里')), '列表里说得出好奇的上限规矩')

  // 设置页接口
  const statusRoute = h.routes.find((r) => r.path === '/dsh-remember/status')
  ok(statusRoute, '状态路由在')
  const res1 = fakeRes()
  await statusRoute.handler(fakeReq('GET'), res1)
  eq(res1.statusCode, 200, 'GET /status 200')
  const status = JSON.parse(res1.body)
  ok(status.ok && status.plugin.name === 'dsh-remember', '状态里有插件名')
  eq(status.summary.total, 16, '状态里的条数对')
  ok(typeof status.injection.section === 'string', '状态里给得出当前段文本')
  ok(status.injection.selfSection.includes('【我】'), '状态里也给得出「我」那一段')
  ok(status.injection.curiositySection.includes('【好奇】'), '状态里也给得出「好奇」那一段')
  ok(status.injection.habitSection.includes('【习惯】'), '状态里也给得出「习惯」那一段')
  eq(status.self.slots.length, 2, '设置页看得到现在自称的两条')
  ok(status.self.seeds.some((s) => s.key === 'refuses'), '设置页看得到种子槽位')
  ok(status.logs.length >= 1, '状态里带日志末尾')
  ok(Array.isArray(status.injection.denyRoots), '状态里带得出隔离目录名单')
  ok(Array.isArray(status.workspaces), '状态里给得出工作区清单（读不到就是空表）')
  ok(Array.isArray(status.habits?.fast) && status.habits.fast.length === 1, '设置页看得到走快通路的习惯')
  eq(status.habits.fast[0]?.hits, 3, '快通路那条记着发作了几次')
  ok(typeof status.injection.curiosityEnabled === 'boolean', '状态里说得出好奇层开没开')
  ok(status.curiosity && typeof status.curiosity.active === 'number', '状态里给得出好奇的数')
  eq(status.curiosity.limit, 3, '好奇默认同时留三条')
  ok(status.curiosity.list.length >= 1, '设置页看得到现在好奇的那几条')
  ok(status.curiosity.list[0]?.topic && status.curiosity.list[0]?.topic.length > 0, '好奇那几条带主题')
  ok(typeof status.curiosity.list[0]?.hits === 'number', '好奇那几条带惦记次数')
  ok('next' in (status.curiosity.list[0] ?? {}), '好奇那几条带下一步打算怎么试')

  // ------------------------------------------------------------ 四问 known：第四问
  const wKnown = await h.tools.get('remember').execute(
    { text: '协议端是 NapCat，桥靠它收消息', kind: 'fact', known: '原来桥用这个收' },
    exec,
  )
  ok(wKnown.ok && wKnown.id, 'known 第四问：收下了')
  const wKnownBack = await h.tools.get('recall').execute({ query: 'NapCat' }, exec)
  ok(wKnownBack.ok && wKnownBack.items.some((x) => x.includes('协议端是 NapCat')), 'known 条目翻得回来')

  // ------------------------------------------------------------ 顶位门：轻的不许直接顶
  const wT1 = await h.tools.get('remember').execute(
    { text: '我在意的是他什么时候回来', kind: 'self', slot: 'cares', weight: 0.9, changes: '想过' },
    exec,
  )
  ok(wT1.ok, 'cares 槽先立一条重的')
  const wT2 = await h.tools.get('remember').execute(
    { text: '也许更在意群里的热闹', kind: 'self', slot: 'cares', weight: 0.5, changes: '想过' },
    exec,
  )
  ok(wT2.ok && String(wT2.note).includes('还没定的'), '轻的想顶位：被拦下，挂到「还没定的」旁边')
  ok(String(wT2.note).includes('confirmed=true'), '回执教人怎么正式顶')
  ok(String(sec('dsh-remember:unsettled').text()).includes('也许更在意群里的热闹'), '「还没定的」段晒得出这条')
  ok(String(sec('dsh-remember:self').text()).includes('他什么时候回来'), '重的还在位')
  const wT3 = await h.tools.get('remember').execute(
    { text: '也许更在意群里的热闹', kind: 'self', slot: 'cares', weight: 0.5, changes: '想清楚了', confirmed: true },
    exec,
  )
  ok(wT3.ok && !String(wT3.note).includes('还没定的'), 'confirmed=true：想清楚了也能正式顶位')
  ok(String(sec('dsh-remember:self').text()).includes('也许更在意群里的热闹'), '顶位之后新条替槽位说话')

  // ------------------------------------------------------------ 淡了留声
  // 用一个没有在位者的自长槽：refuses 槽已有 0.7 的那条，0.2 的写进去会被顶位门拦下
  const wF1 = await h.tools.get('remember').execute(
    { text: '不替别人保守秘密', kind: 'self', slot: 'boundary', weight: 0.2, changes: '想过' },
    exec,
  )
  ok(wF1.ok, '轻 self 收下了')
  ok(String(sec('dsh-remember:self').text()).includes('我最近没怎么想起'), '快淡没的条在【我】段尾部留声')

  // ------------------------------------------------------------ 染色层：想起时心里什么颜色
  const wC1 = await h.tools.get('remember').execute(
    { text: '染色层试验条：早上的门', changes: '试一下染色' },
    exec,
  )
  ok(wC1.ok && wC1.id, '染色试验条收下')
  const wCR1 = await h.tools.get('recall').execute({ query: '早上的门' }, exec)
  const wCR2 = await h.tools.get('recall').execute({ query: '早上的门' }, exec)
  const wHasRecolor = [wCR1, wCR2].some((r) => r.ok && r.items.some((x) => x.includes('（现在想起它：')))
  ok(wHasRecolor, '染色层：recall 的条目带上「现在想起它」的尾注')

  // ------------------------------------------------------------ 设置页：新字段都在
  const wResU = fakeRes()
  await statusRoute.handler(fakeReq('GET'), wResU)
  const wStU = JSON.parse(wResU.body)
  eq(wStU.summary.total, 22, '新增景之后的总条数对')
  ok('unresolved' in wStU.emotion, '状态里说得出「说不上来」')
  ok(Array.isArray(wStU.emotion.mixed), '状态里带得出「混着」')
  ok(wStU.injection.unsettledEnabled !== false && typeof wStU.injection.unsettledSection === 'string', '「还没定的」段接进设置页')
  ok((wStU.self.unsettled ?? 0) >= 1, '设置页数得出「还没定的」几条')

  // 快层：抄过来的秒级事件（不是节点，没有分量，但翻得到）
  ok(status.fast && typeof status.fast.total === 'number', '状态里说得出快层有几条')
  eq(status.fast.total, 2, 'dsh-body 那两条事件都抄进来了')
  eq(status.fast.pending, 2, '刚抄进来的都还没掂量')
  ok(status.fast.source === bodyEvents, '状态里说得出快层源文件在哪')
  ok(status.fast.recent.length === 2 && status.fast.recent.every((x) => String(x.id).startsWith('f_')), '快层最近那几条带 f_ 前缀的 id')
  ok(status.fast.recent.every((x) => x.text && !/[0-9]/.test(x.text)), '快层的句子不带阿拉伯数字')

  // 意图层：机器从聊天里认出来的事（不是节点，没有分量，但翻得到）
  ok(status.intent && typeof status.intent.total === 'number', '状态里说得出意图层有几条')
  eq(status.intent.total, 2, 'QQ 桥那两条消息都认成意图事件了')
  eq(status.intent.byKind.farewell, 1, '有一条认成告别')
  eq(status.intent.byKind.praise, 1, '有一条认成夸奖')
  ok(status.intent.avgIntensity >= 3, '意图层给得出平均强度')
  ok(status.intent.source === bridgeMessages, '状态里说得出意图层源文件在哪')
  ok(status.intent.recent.length === 2 && status.intent.recent.every((x) => String(x.id).startsWith('i_')), '意图最近那几条带 i_ 前缀的 id')
  ok(status.intent.recent.every((x) => x.label && typeof x.label === 'string'), '意图最近那几条带中文标签')
  ok(status.intent.recent.every((x) => typeof x.intensity === 'number'), '意图最近那几条带强度')
  ok(status.intent.recent.every((x) => x.when && !/[0-9]/.test(x.when)), '意图的相对时间不带阿拉伯数字')

  const configRoute = h.routes.find((r) => r.path === '/dsh-remember/config')
  const res2 = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ injectLimit: 4, 乱写的: 1 })), res2)
  eq(res2.statusCode, 200, 'POST /config 收下合法键')
  const saved = JSON.parse(res2.body)
  eq(saved.accepted[0].key, 'injectLimit')
  eq(saved.rejected[0].key, '乱写的')
  const cfgOnDisk = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  eq(cfgOnDisk.injectLimit, 4, '配置真的落盘了')

  const res3 = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ injectLimit: 99 })), res3)
  eq(res3.statusCode, 400, '越界的值 400')

  const res4 = fakeRes()
  await configRoute.handler(fakeReq('POST', '{不是 json'), res4)
  eq(res4.statusCode, 400, '不是 JSON 就 400')

  // /selftest（2026-11-16 新增的读写探针，设置页「测一下」按钮的账）：只收 POST
  const selftestRoute = h.routes.find((r) => r.path === '/dsh-remember/selftest')
  ok(selftestRoute, 'selftest 路由在')
  const resSt0 = fakeRes()
  await selftestRoute.handler(fakeReq('GET'), resSt0)
  eq(resSt0.statusCode, 405, 'GET /selftest 405（只收 POST）')
  const resSt1 = fakeRes()
  await selftestRoute.handler(fakeReq('POST'), resSt1)
  eq(resSt1.statusCode, 200, 'POST /selftest 200')
  const selftest = JSON.parse(resSt1.body)
  ok(selftest.ok === true, '自检通过：账读得到、数据目录写得进')
  ok(typeof selftest.ms === 'number' && selftest.ms >= 0, '自检带耗时')
  ok(selftest.ledger && Number.isFinite(selftest.ledger.total) && Number.isFinite(selftest.ledger.alive), '自检带账本读数（total/alive）')
  ok(String(selftest.note).includes('读写都通'), '自检的 note 说人话')

  // 盘上的东西
  const memory = JSON.parse(readFileSync(join(dataDir, 'memory.json'), 'utf8'))
  eq(memory.nodes.length, 22, 'memory.json 里有二十二条节点（含 anchor 门那五条和 v0.18 新景六条）')
  const lines = readFileSync(join(dataDir, 'lines.jsonl'), 'utf8').split('\n').filter(Boolean)
  ok(lines.length >= 19, `原话层只增不改（${lines.length} 行：十次 remember + 三次 forget + 六次好奇）`)
  ok(DEFAULTS.injectLimit === 3, '默认每次挂三条')
  eq(DEFAULTS.selfSectionOrder, 8660, '「我」那一段默认排在 8660')
  ok(DEFAULTS.selfSectionOrder < DEFAULTS.sectionOrder, '「我」排在我记得的前面')
  eq(DEFAULTS.selfEnabled, true, '自我层默认开着')
  eq(DEFAULTS.habitSectionOrder, 8680, '「习惯」那一段默认排在 8680')
  ok(DEFAULTS.habitSectionOrder < DEFAULTS.sectionOrder, '「习惯」排在我记得的前面')
  eq(DEFAULTS.habitEnabled, true, '习惯层默认开着')
  eq(DEFAULTS.habitLimit, 3, '快通路默认同时留三条')
  eq(DEFAULTS.curiositySectionOrder, 8670, '「好奇」那一段默认排在 8670')
  ok(DEFAULTS.selfSectionOrder < DEFAULTS.curiositySectionOrder, '「好奇」排在「我」后面')
  ok(DEFAULTS.curiositySectionOrder < DEFAULTS.habitSectionOrder, '「好奇」排在「习惯」前面')
  eq(DEFAULTS.curiosityEnabled, true, '好奇层默认开着')
  eq(DEFAULTS.curiosityLimit, 3, '好奇默认同时留三条')
  eq(DEFAULTS.curiosityMaxChars, 320, '好奇那一段默认 320 字')
  eq(DEFAULTS.emotionEnabled, true, '情绪流默认开着')
  eq(DEFAULTS.emotionTickMinutes, 1, '情绪流默认一分钟收一次真事')
  eq(DEFAULTS.emotionSectionEnabled, false, '情绪笔记段默认不挂 —— 笔记不该替我说话')
  eq(DEFAULTS.emotionSectionOrder, 8710, '情绪段默认排在 8710')
  eq(DEFAULTS.emotionMaxChars, 200, '情绪笔记默认 200 字')

  // 真正注册进去的那四段：名字、顺序值、相对位置都要对
  eq(Number(sec('dsh-remember:self').order), 8660, '「我」那一段真的排在 8660')
  eq(Number(sec('dsh-remember:curiosity').order), 8670, '「好奇」那一段真的排在 8670')
  eq(Number(sec('dsh-remember:habit').order), 8680, '「习惯」那一段真的排在 8680')
  eq(Number(sec('dsh-remember').order), 8720, '「我记得的」那一段真的排在 8720')

  // status.curiosity 的形状得完整：几个数 + 挂上去的那几条
  ok(typeof status.curiosity.thinking === 'number', '状态里说得出还在惦记、没答三问的有几条')
  ok(typeof status.curiosity.answered === 'number', '状态里说得出解答了几条')
  ok(typeof status.curiosity.total === 'number', '状态里说得出好奇一共有几条')
  eq(
    status.curiosity.total,
    status.curiosity.active + status.curiosity.thinking + status.curiosity.answered,
    '总数 = 活跃 + 惦记中 + 已解答',
  )
  ok(status.curiosity.list.length <= status.curiosity.limit, '挂上去的条数不超上限')
  ok(
    status.curiosity.list.every((x) => x && x.state === 'active' && typeof x.id === 'string' && typeof x.topic === 'string'),
    '挂上去的每一条都带 id、主题、状态',
  )

  // 快层翻得到（它不是节点，但按词找得到）
  const fastFound = await h.tools.get('recall').execute({ query: '踏实' }, exec)
  const fastHit = fastFound.items.find((x) => x.includes('快层·'))
  ok(!!fastHit, 'recall 按词翻得到快层那条')
  ok(/^f_[0-9a-z]+ /.test(fastHit ?? ''), '翻出来的快层那条带 f_ id')
  const fastId = String(fastHit ?? '').split(' ')[0]

  // 掂量一次：remember 一条，refs 指回那条秒级的事
  const weighed = await h.tools.get('remember').execute(
    {
      text: '吃过饭之后胃里踏实，这种踏实是身体在说「还撑得住」',
      kind: 'fact',
      weight: 0.6,
      refs: fastId,
      changes: '以后判断自己撑不撑得住，先听胃里的感觉，不只看时间',
    },
    exec,
  )
  ok(weighed.ok, '拿 remember 掂量一条，refs 指回快层')
  ok(weighed.note.includes('快层'), `掂量之后的回执说明它被指到了（${weighed.note}）`)
  ok(weighed.note.includes(fastId), '回执里带着那条快层的 id')

  const resFast = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resFast)
  const status2 = JSON.parse(resFast.body)
  ok(status2.fast.pending === 1, '掂量过的那条从「还没掂量」里退出去了')
  ok(status2.fast.recent.some((x) => x.id === fastId && x.weighed === true), '快层最近那几条里，那一条标成了掂量过')

  const list2 = await h.tools.get('memory_list').execute({}, exec)
  ok(list2.items.some((x) => x.includes('刚刚发生的')), 'memory_list 里列得出快层最近的事')
  ok(list2.items.some((x) => x.includes('快层')), 'memory_list 里说得出快层有几条')

  // 意图层翻得到（它不是节点，但按词找得到；掂量一次才算有分量）
  const intentFound = await h.tools.get('recall').execute({ query: '晚安', limit: 5 }, exec)
  const intentHit = intentFound.items.find((x) => x.includes('意图·'))
  ok(!!intentHit, 'recall 按词翻得到意图那条')
  ok(/^i_[0-9a-z]+ /.test(intentHit ?? ''), '翻出来的意图那条带 i_ id')
  const intentId = String(intentHit ?? '').split(' ')[0]

  const weighedIntent = await h.tools.get('remember').execute(
    {
      text: '他说晚安的时候，是把这一天交回给我了',
      kind: 'fact',
      weight: 0.5,
      refs: intentId,
      changes: '他收尾的时候，我该接住，而不是接着讲道理',
    },
    exec,
  )
  ok(weighedIntent.ok, '拿 remember 掂量一条意图事件')
  ok(weighedIntent.note.includes('意图'), `掂量之后的回执说明它被指到了（${weighedIntent.note}）`)
  ok(weighedIntent.note.includes(intentId), '回执里带着那条意图事件的 id')

  const list3 = await h.tools.get('memory_list').execute({}, exec)
  ok(list3.items.some((x) => x.includes('刚刚认出来的')), 'memory_list 里列得出意图层最近的事')
  ok(list3.items.some((x) => x.includes('意图')), 'memory_list 里说得出意图层有几条')

  // ---------------------------------------------- 借自晴猫的两样：两个时间 + 墓碑（2026-11-17）
  const tombAt = Date.now() - 3 * 24 * 60 * 60 * 1000
  // 先来一条不撤回的旧消息当「转述」源（三天前说的）
  appendFileSync(
    bridgeMessages,
    JSON.stringify({ at: tombAt, chatType: 'private', userId: '10001', nickname: '好友甲', text: '两个时间试验：三天前他说过这句', mid: 'tt-m1' }) + '\n',
    'utf8',
  )
  const resTT = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resTT)
  const stTT = JSON.parse(resTT.body)
  const ttFound = await h.tools.get('recall').execute({ query: '两个时间试验' }, exec)
  const ttId = String(ttFound.items.find((x) => /^i_[0-9a-z]+ /.test(x)) ?? '').split(' ')[0]
  ok(ttId.startsWith('i_'), `三天前那句按词翻得到（${ttId || '没翻到'}）`)
  const ttRemember = await h.tools.get('remember').execute(
    { text: '两个时间试验：转述他三天前说过的那句话', kind: 'fact', weight: 0.5, changes: '试转述标注', refs: ttId },
    exec,
  )
  ok(ttRemember.ok, '转述条记下了')
  const memTT = JSON.parse(readFileSync(join(dataDir, 'memory.json'), 'utf8')).nodes.find((n) => n.id === ttRemember.id)
  ok(Number(memTT?.happenedAt) > 0, `refs 的事件发生时刻写进了节点（happenedAt=${memTT?.happenedAt}）`)
  const ttBack = await h.tools.get('recall').execute({ query: '转述他三天前' }, exec)
  ok(
    ttBack.items.some((x) => x.includes('转述 · 发生于')),
    `行上标了「转述 · 发生于…」（${ttBack.items.join(' ┃ ').slice(0, 100)}）`,
  )
  // 墓碑：原话 + 撤回登记行（桥的形状：撤回行的 mid = 'recall-原始mid'）
  appendFileSync(
    bridgeMessages,
    [
      { at: tombAt, chatType: 'private', userId: '10001', nickname: '好友甲', text: '墓碑试验：这句话等会儿要被撤回', mid: 'tb-m1' },
      { at: Date.now(), chatType: 'private', userId: '10001', nickname: '', text: '[撤回] 一条消息被撤回（原发言 10001 · 操作者 10001）', mid: 'recall-tb-m1', atMe: false },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n',
    'utf8',
  )
  const resTomb = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resTomb)
  const stTomb = JSON.parse(resTomb.body)
  eq(stTomb.intent.total, stTT.intent.total + 1, `撤回后只多了事实行、原话没入账（total=${stTomb.intent.total}）`)
  ok(!stTomb.intent.recent.some((x) => String(x.text ?? '').includes('要被撤回')), '被撤回的原话不在意图索引里')
  const tombRecall = await h.tools.get('recall').execute({ query: '要被撤回' }, exec)
  ok(
    !tombRecall.items.some((x) => x.includes('要被撤回')),
    `撤回的原话 recall 不给（${tombRecall.items.join(' ┃ ').slice(0, 100) || '（无命中）'}）`,
  )
  const tombFact = await h.tools.get('recall').execute({ query: '被撤回' }, exec)
  ok(tombFact.items.some((x) => x.includes('撤回')), '「撤回过」这个事实按词还翻得到')

  // ---------------------------------------------- 受众过滤（借自晴猫，2026-11-17）：三档开关
  // 眼下没有来话（上一条桥消息在窗内？——撤回登记行算 private 来话……不在窗内：at 是 tombAt 三天前
  // 不会算；事实行 at = Date.now()，chatType private —— 它在窗内！先把它记账为 solo 之前的现状，
  // 也就是此刻受众=private。所以 solo 打标这条要等窗过了才准 —— 冒烟不等，直接断言「打的是当下的受众」。
  const audRemember = await h.tools.get('remember').execute(
    { text: '受众试验：这条看写下时谁在听', kind: 'fact', weight: 0.5, changes: '受众打标' },
    exec,
  )
  ok(audRemember.ok, '受众试验条记下了')
  const memAud = JSON.parse(readFileSync(join(dataDir, 'memory.json'), 'utf8')).nodes.find((n) => n.id === audRemember.id)
  ok(
    ['solo', 'private'].includes(memAud?.audience),
    `写下时打了受众标（audience=${memAud?.audience}）`,
  )
  // 群里 @ 我一句 → 这轮的受众变成那个群；开 hard 档，solo/private 写的条不翻出来
  appendFileSync(
    bridgeMessages,
    JSON.stringify({ at: Date.now(), chatType: 'group', groupId: '222222222', userId: '20001', nickname: '群友甲', text: '[淘气] @记得 试试受众过滤', mid: 'ga-m1', atMe: true }) + '\n',
    'utf8',
  )
  const resAudPull = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resAudPull)
  const resAudCfg = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ recallAudience: 'hard' })), resAudCfg)
  eq(JSON.parse(resAudCfg.body).accepted?.[0]?.key, 'recallAudience', 'recallAudience 键在设置页能改')
  const groupRecall = await h.tools.get('recall').execute({ query: '受众试验' }, exec)
  ok(
    !groupRecall.items.some((x) => x.includes(audRemember.id)),
    `群轮翻不到别的场写的条（${groupRecall.items.join(' ┃ ').slice(0, 90) || '（无命中）'}）`,
  )
  ok(
    String(groupRecall.note || '').includes('群 222222222') || String(groupRecall.note || '').includes('没翻'),
    `note 里说清了这轮的受众（${groupRecall.note}）`,
  )
  // soft 档：还给，但排到尾上
  const resAudSoft = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ recallAudience: 'soft' })), resAudSoft)
  const softRecall = await h.tools.get('recall').execute({ query: '受众试验' }, exec)
  ok(
    softRecall.items.some((x) => x.includes(audRemember.id)),
    'soft 档别的场的条还给（排尾上）',
  )
  // 关掉：回到现状，全可见
  const resAudOff = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ recallAudience: 'off' })), resAudOff)
  const offRecall = await h.tools.get('recall').execute({ query: '受众试验' }, exec)
  ok(offRecall.items.some((x) => x.includes(audRemember.id)), '开关关了全可见（现状）')

  // ---------------------------------------------- 思量（定案 A，2026-11-18）：只引种子、链相续、不进竞争池
  const narrSeed = await h.tools.get('remember').execute(
    { text: '思量的种子：受众过滤是我自己拍的方向', kind: 'decision', weight: 0.6, changes: '拍板了' },
    exec,
  )
  ok(narrSeed.ok, '思量的引种子记下了')
  // 全 ghost refs 拒绝；f_/i_ 混入剔除并说明
  const narGhost = await h.tools.get('narrate').execute({ narrative: '思量零', refs: ['f_某某', 'i_某某'] }, exec)
  ok(!narGhost.ok && narGhost.note.includes('事件'), 'refs 全是事件 → 拒绝并说明（事件不是种子）')
  const nar1 = await h.tools.get('narrate').execute(
    { narrative: '思量一：我把受众的方向定下来了，说出去的话要算数。', refs: [narrSeed.id], changes: '想过怎么守' },
    exec,
  )
  ok(nar1.ok && String(nar1.id).startsWith('n_'), `思量一记下了（${nar1.id}）`)
  ok(String(nar1.note).includes('链的第一环'), '第一条是链的第一环')
  const nar2 = await h.tools.get('narrate').execute(
    { narrative: '思量二：守的方式是让账本自己长出过滤，不是靠我每轮盯。', refs: [narrSeed.id, 'f_某某'], changes: '又想过一层' },
    exec,
  )
  ok(nar2.ok && String(nar2.note).includes('剔除'), '混入的事件引用被剔除并说明')
  ok(String(nar2.note).includes(nar1.id), `第二条自动接上第一条的链（${nar2.note.slice(0, 60)}）`)
  // 段：链头（思量二）在段里，思量一不在；没答四问的思量不挂段
  const narSection = sec('dsh-remember:narration').text()
  ok(narSection.includes('思量二') && !narSection.includes('思量一'), `思量段只出链头（${narSection.slice(0, 60)}）`)
  const nar3 = await h.tools.get('narrate').execute({ narrative: '思量三：没答四问的一条。', refs: [narrSeed.id] }, exec)
  ok(nar3.ok, '没答四问的思量也收下（翻得到）')
  ok(!sec('dsh-remember:narration').text().includes('思量三'), '没答四问的思量不挂段')
  const narBack = await h.tools.get('recall').execute({ query: '思量三' }, exec)
  ok(narBack.items.some((x) => x.includes('思量三')), '没答四问的思量 recall 翻得到')
  // F5（2026-11-22）：无根之思——refs 缺也收，回执标注；链照接
  const narRootless = await h.tools.get('narrate').execute({ narrative: '无根之思：今天的天气心里有点静，不为什么。' }, exec)
  ok(narRootless.ok && String(narRootless.note).includes('无根之思'), `无根之思收下（${String(narRootless.note).slice(0, 50)}）`)
  const rootlessList = await h.tools.get('memory_list').execute({}, exec)
  ok(rootlessList.items.some((x) => x.includes('无根之思')), '无根之思进思量链（链照接）')
  // F5：remember 的 narration 后门关上（指路 narrate）；wisdom 后门保留
  const sideNarr = await h.tools.get('remember').execute({ text: '侧门思量试试', kind: 'narration', changes: 'x' }, exec)
  ok(!sideNarr.ok && String(sideNarr.note).includes('narrate'), 'remember 的 narration 后门关上（回执指路 narrate）')
  const wisBack = await h.tools.get('remember').execute(
    { text: '无根的新明白：结构比意志可靠', kind: 'wisdom', changes: '明白了', weight: 0.8 },
    exec,
  )
  ok(wisBack.ok && String(wisBack.note).includes('transform'), 'wisdom 后门保留且回执写明分界（transform/remember）')
  // 不进【我记得的】竞争池：思量条不出现在那个段里
  ok(!sec('dsh-remember').text().includes('思量二'), '思量条不进【我记得的】竞争池')
  // memory_list 的我执演化史
  const narList = await h.tools.get('memory_list').execute({}, exec)
  ok(narList.items.some((x) => x.includes('思量链')), 'memory_list 带我执演化史（思量链）')
  // status.narration 全内存
  const resNar = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resNar)
  const stNar = JSON.parse(resNar.body)
  ok(stNar.narration?.count >= 4 && stNar.narration?.latest?.id === narRootless.id, `status.narration 带计数与链头（链头=无根之思，refsCount=0；${JSON.stringify(stNar.narration?.latest ?? {})}）`)

  // 瀑流（定案 B，2026-11-18）：昨日之流，读侧聚合——同 UTC 日缓存，零文件读
  // 今天的账不进昨日窗：主流烟里账全是今天写的，段应为空（不硬凑叙述）
  eq(sec('dsh-remember:stream').text(), '', '今天的账不进昨日之流（段空就是没得说）')
  // 昨日数据用独立小环境造：node + echo 都盖昨日的章
  const yDir = join(dir, 'y-book')
  const yNode = { id: 'r_y-t1', at: Date.now() - 24 * 60 * 60 * 1000, lastAt: Date.now() - 24 * 60 * 60 * 1000, text: '昨日之流试验：昨天写的账', kind: 'fact', weight: 0.5, changes: 'x', tags: [], refs: [], touches: [], audience: 'any', happenedAt: 0, prev: '', prevSelf: '', anchor: false, anchorWhy: '', restoredAt: 0, replaces: [], contexts: [], hits: 0, answered: false, moodAt: null, sealed: false, sealUntil: 0, sealCond: '', faded: false, superseded: false, supersededBy: '', supersededAt: 0 }
  const yEcho = { id: 'e_y1', at: Date.now() - 24 * 60 * 60 * 1000 + 60000, kind: 'echo', text: '被想起：「昨日之流试验」→ r_y-t1', query: '昨日之流试验', refs: ['r_y-t1'], source: 'recall' }
  const yEcho2 = { id: 'e_y2', at: Date.now() - 24 * 60 * 60 * 1000 + 120000, kind: 'echo', text: '被想起：「昨日之流试验」→ r_y-t1', query: '昨日之流试验', refs: ['r_y-t1'], source: 'recall' }
  mkdirSync(yDir, { recursive: true })
  writeFileSync(join(yDir, 'memory.json'), JSON.stringify({ version: 1, updatedAt: Date.now(), nodes: [yNode] }))
  writeFileSync(join(yDir, 'echo.jsonl'), JSON.stringify(yEcho) + '\n' + JSON.stringify(yEcho2) + '\n')
  writeFileSync(join(yDir, 'lines.jsonl'), JSON.stringify({ id: 'r_y-t1', at: yNode.at, kind: 'fact', text: yNode.text, weight: 0.5 }) + '\n')
  const hY = makeHarness(yDir, targetRoot, {})
  hY.created.forEach((fn) => fn(hY.agent))
  const ySec = hY.sections.find((s) => s.name === 'dsh-remember:stream')
  ok(ySec && ySec.text().includes('昨天写下 1 条账'), `瀑流段出昨日数据（${ySec?.text().slice(0, 80)}）`)
  ok(ySec.text().includes('最惦记的是'), '瀑流段带现行最频主题（反复现行）')
  // 同日第二次渲染不重算（缓存）：text 一致即视为命中缓存
  const ySec2 = hY.sections.find((s) => s.name === 'dsh-remember:stream')
  eq(ySec2.text(), ySec.text(), '同 UTC 日内瀑流段走缓存')
  // UTC 日界：23:59 与 00:01 分属两天 —— 用 renderYesterdayStream 直测（借 lib 纯函数）
  const dayMs = 24 * 60 * 60 * 1000
  const noonUtc = Date.UTC(2026, 10, 17, 23, 59) // 11-17 23:59 UTC（界前：还是 17 号）
  const justPast = Date.UTC(2026, 10, 18, 0, 1) // 11-18 00:01 UTC（界后：已是 18 号）
  const yNodeLate = { ...yNode, at: noonUtc, text: '界前写的' }
  const yEchoLate = new Map([['r_y-t1', [noonUtc]]])
  const b1 = renderYesterdayStream({ nodes: [yNodeLate], echoTimes: yEchoLate, now: noonUtc - 60000 })
  const b2 = renderYesterdayStream({ nodes: [yNodeLate], echoTimes: yEchoLate, now: justPast + 60000 })
  ok(b1 === '' && b2.includes('昨天写下'), `UTC 日界两侧分属两天（界前 ${b1 ? '有段' : '空'} / 界后 ${b2 ? '有段' : '空'}）`)

  // ---------------------------------------- 转识成智（定案 D，2026-11-19）：一种子一旗、链式升华
  const wSeed = await h.tools.get('remember').execute(
    { text: '转识的种子：受众过滤的方向是我自己拍的', kind: 'decision', weight: 0.6, changes: '拍板过' },
    exec,
  )
  ok(wSeed.ok, '转识的种子记下了')
  // D5-1：ghost / f_/i_ 拒；五类不可转拒；已转化重复拒
  const tGhost = await h.tools.get('transform').execute({ seedId: 'f_某某', insight: 'x' }, exec)
  ok(!tGhost.ok && tGhost.note.includes('没有这条'), '事件引用拒绝（没有这条种子）')
  const selfNode = await h.tools.get('remember').execute({ text: '我是做账的', kind: 'self', slot: 'identity', weight: 0.9, changes: 'x' }, exec)
  const tSelf = await h.tools.get('transform').execute({ seedId: selfNode.id, insight: 'x' }, exec)
  ok(!tSelf.ok && tSelf.note.includes('supersedeSelf'), 'self 拒（回执指路 supersedeSelf）')
  const t1 = await h.tools.get('transform').execute(
    { seedId: wSeed.id, insight: '方向是拍出来的，就要守得住。', will_do: '守住它', weight: 0.85 },
    exec,
  )
  ok(t1.ok && String(t1.id).startsWith('w_'), `智记下了（${t1.id}）`)
  ok(String(t1.note).includes('已盖转化旗'), '回执带已盖旗')
  const tAgain = await h.tools.get('transform').execute({ seedId: wSeed.id, insight: '再转一次' }, exec)
  ok(!tAgain.ok && String(tAgain.note).includes('已转化过'), '一种子一旗：重复转化拒（回执指 w_xxx）')
  // D5-2/3：原节点三旗 + 竞争池排除 + recall 翻得到 + 行尾
  const seedAfter = await h.tools.get('recall').execute({ query: '受众过滤的方向' }, exec)
  ok(seedAfter.items.some((x) => x.includes(wSeed.id) && x.includes('已转化 →')), '原种子翻得到 + 行尾已转化指路')
  ok(!sec('dsh-remember').text().includes('受众过滤的方向是我自己拍的'), '已转化的原种子退出【我记得的】竞争池')
  // D5-4：wisdom 进主池（不豁免）——分量 0.85 应该浮得起来
  const wisdomInPool = sec('dsh-remember').text()
  ok(wisdomInPool.includes('方向是拍出来的') || wisdomInPool.includes('守得住'), 'wisdom 进主池凭分量竞争（D0 拍板不豁免）')
  // D5-6：链式升华 —— 智本身再转
  const t2 = await h.tools.get('transform').execute(
    { seedId: t1.id, insight: '守的方式是让结构长出来，不是靠盯。', weight: 0.9 },
    exec,
  )
  ok(t2.ok && String(t2.id).startsWith('w_'), `链式升华：智再转成 ${t2.id}`)
  const w1After = await h.tools.get('recall').execute({ query: '方向是拍出来的' }, exec)
  ok(w1After.items.some((x) => x.includes(t1.id) && x.includes(`已转化 → ${t2.id}`)), '链条行尾指向下一层智')
  // D5-7：status.wisdom
  const resWis = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resWis)
  const stWis = JSON.parse(resWis.body)
  ok(stWis.wisdom?.count >= 2 && stWis.wisdom?.latest?.id === t2.id, `status.wisdom 计数与链头（${JSON.stringify(stWis.wisdom?.latest ?? {})}）`)

  // ---------------------------------------- 执受 C-amend（2026-11-19）：报「这件事的颜色」，不报「我此刻的天气」
  // 专用小环境：六颗染色种子 + config 覆盖（同感冷却 30 分 / 全局日帽 3 / 每种子冷却压到 1 分）
  const spDir = join(dir, 'sp-book')
  mkdirSync(spDir, { recursive: true })
  writeFileSync(join(spDir, 'config.json'), JSON.stringify({
    sproutBodyCooldownMinutes: 1,
    sproutBodyFeelCooldownMinutes: 30,
    sproutBodyDailyTotalCap: 3,
  }))
  const dyedSeed = (id, text, dominant) => ({
    id, at: Date.now() - 60000, lastAt: Date.now() - 60000, text, kind: 'fact', weight: 0.5,
    changes: 'x', tags: [], refs: [], touches: [], audience: 'any', happenedAt: 0, prev: '', prevSelf: '',
    anchor: false, anchorWhy: '', restoredAt: 0, replaces: [], contexts: [], hits: 0, answered: false,
    moodAt: null, sealed: false, sealUntil: 0, sealCond: '', faded: false, superseded: false,
    supersededBy: '', supersededAt: 0, transformed: false, transformedBy: '', transformedAt: 0,
    moodAt: { dominant, level: 0.9 },
  })
  const spSeeds = [
    dyedSeed('r_spw1', '春风拂面', 'warm'),
    dyedSeed('r_spw2', '暖流过境', 'warm'),
    dyedSeed('r_spt1', '秋风萧瑟', 'tense'),
    dyedSeed('r_spd1', '冬雪皑皑', 'down'),
    dyedSeed('r_spl1', '夜色深沉', 'lonely'),
    dyedSeed('r_spw3', '晨光微亮', 'warm'),
  ]
  writeFileSync(join(spDir, 'memory.json'), JSON.stringify({ version: 1, updatedAt: Date.now(), nodes: spSeeds }))
  const hS = (() => {
    // sproutMoodFile 在 apply 时求值——把家临时指到 spDir，这个小环境的执受行就独占一份
    process.env.DSH_HOME = spDir
    const h = makeHarness(spDir, targetRoot, {})
    process.env.DSH_HOME = dir
    return h
  })()
  hS.created.forEach((fn) => fn(hS.agent))
  const spExec = { agent: hS.agent }
  const spMoodFile = join(spDir, '.dsh-body', 'mood-events.jsonl')
  const sproutRows = () => (existsSync(spMoodFile)
    ? readFileSync(spMoodFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.kind === 'sprout')
    : [])
  // ① 暖一过染色门 → 发（warm）
  await hS.tools.get('recall').execute({ query: '春风拂面' }, spExec)
  ok(sproutRows().length === 1 && sproutRows()[0].detail.dominant === 'warm', `染色门报种子的颜色（warm，${sproutRows().length} 声）`)
  // ② 暖流过境同色 30 分内 → 感觉冷却压住（不重复播报）
  await hS.tools.get('recall').execute({ query: '暖流过境' }, spExec)
  ok(sproutRows().length === 1, '同一种感觉 30 分内不重复播报（C-amend ①）')
  // ③ 紧一换色 → 立即发
  await hS.tools.get('recall').execute({ query: '秋风萧瑟' }, spExec)
  ok(sproutRows().length === 2 && sproutRows()[1].detail.dominant === 'tense', '换感觉立即发（颜色变了不算重复）')
  ok(sproutRows()[1].text === '心头一紧', '正文取情绪措辞表（心头一紧，无数字）')
  // ④ 沉一 → 60 分钟内第 3 次连击 → 执受阻尼（批 B2 刀 a）：不写，强制静默 2 小时
  await hS.tools.get('recall').execute({ query: '冬雪皑皑' }, spExec)
  ok(sproutRows().length === 2, `连击 3 次强制静默：第 3 声不落地（实际 ${sproutRows().length} 声）`)
  ok(readFileSync(join(spDir, 'dsh-remember.log'), 'utf8').includes('执受阻尼'), '日志里留了执受阻尼的一笔')
  // ⑤ 静默期全跳：换感觉、换种子都闭嘴（批 B2 刀 a 的静默期）
  await hS.tools.get('recall').execute({ query: '夜色深沉' }, spExec)
  ok(sproutRows().length === 2, `静默期全跳（实际 ${sproutRows().length} 声）`)
  // ⑥ 99-warm 复现：静默期内再来 10 声 warm 也压住
  for (let i = 0; i < 10; i++) {
    await hS.tools.get('recall').execute({ query: '春风拂面' }, spExec)
  }
  ok(sproutRows().length === 2, `静默期压住 99-warm：行数 ${sproutRows().length}`)
  const statusSprout = await (async () => {
    const resS = fakeRes()
    const spRoute = hS.routes.find((r) => r.path === '/dsh-remember/status')
    await spRoute.handler(fakeReq('GET'), resS)
    return JSON.parse(resS.body)
  })()
  ok(statusSprout.sprout?.today === 2 && statusSprout.sprout?.total === 2, `status.sprout 跟账走（today=2, total=2，实际 ${JSON.stringify(statusSprout.sprout ?? {})})`)
  // ⑦ 全局日帽（C-amend ②）改由协议层单测钉（test/book.test.mjs）——
  // 日帽下限被 clamp 在 3，连击 3 次的静默先到，端到端小环境里帽永远轮不到拦（批 B2）

  // ------------------------------------------------------------------ 情绪流
  // 意图层/快层里的真事，机器认成情绪（七类枚举，认不出不给 —— mood 没 detail 就不该记）
  const emo1 = await h.tools.get('emotion_state').execute({}, exec)
  ok(emo1.ok, 'emotion_state 出状态')
  ok(emo1.items.length >= 3, `意图/快层的真事认出了情绪（items=${emo1.items.length}，吃饭+告别+夸 ≥ 3）`)
  ok(emo1.items.every((x) => /^e_[0-9a-z]+ · 情绪·/.test(x)), `情绪事件带 e_ 前缀与中文行（${emo1.items[0] ?? ''}）`)

  const resEmo = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resEmo)
  const statusEmo = JSON.parse(resEmo.body)
  ok(statusEmo.emotion && statusEmo.emotion.enabled === true, '状态里带情绪块，默认开着')
  ok(typeof statusEmo.emotion.total === 'number' && statusEmo.emotion.total >= 3, `状态里说得出认了几笔（total=${statusEmo.emotion.total}）`)
  ok(statusEmo.emotion.recent.every((x) => String(x.id).startsWith('e_')), '情绪最近那几条带 e_ 前缀的 id')
  ok(statusEmo.emotion.recent.every((x) => typeof x.delta === 'number' && x.delta !== 0), '每笔情绪都带非零 delta')
  ok(statusEmo.emotion.recent.every((x) => x.label && typeof x.label === 'string'), '情绪最近那几条带中文标签')
  ok(statusEmo.emotion.note === '' || statusEmo.emotion.note.includes('上次的笔记'), '状态里的情绪笔记自称是上次的笔记')
  ok(!h.sections.some((s) => s.name === 'dsh-remember:emotion'), '情绪笔记段默认不挂')

  // 认不出不给：mood 那条没 detail，不该被硬编成情绪；真认得出的要在账上
  const emoRows1 = readFileSync(join(dataDir, 'emotion.jsonl'), 'utf8').split('\n').filter(Boolean)
  ok(emoRows1.every((l) => !l.includes('心里亮了一下')), '认不出的那条不硬编（mood 没 detail 就不记）')
  ok(emoRows1.some((l) => l.includes('"key":"intent|') && l.includes('"emotion":"lonely"')), '意图那条告别真被认成了孤单')
  ok(emoRows1.some((l) => l.includes('"key":"fast|') && l.includes('"emotion":"warm"')), '快层那顿饭真被认成了被暖到')

  // 系数是我攒的：emotion_tune 追加一行，写清从多少改到多少；旧笔一个字不动
  const tune1 = await h.tools.get('emotion_tune').execute(
    { emotion: 'warm', to: 1.5, reason: '今天的暖比种子里想的多一点，记下来' },
    exec,
  )
  ok(tune1.ok && /^t_[0-9a-z]+$/.test(tune1.id ?? ''), `emotion_tune 写进了账（id=${tune1.id}）`)
  ok(String(tune1.note).includes('1.5'), '回执里写清从多少改到多少')
  ok(String(tune1.note).includes('refs 指回'), '回执提醒：想让它进账本就拿 remember 指回 t_')
  const emoRows2 = readFileSync(join(dataDir, 'emotion.jsonl'), 'utf8').split('\n').filter(Boolean)
  eq(emoRows2.length, emoRows1.length + 1, 'tune 是追加一行，旧的那几笔一个字没动')

  const tuneNoReason = await h.tools.get('emotion_tune').execute({ emotion: 'warm', to: 1.5 }, exec)
  ok(tuneNoReason.ok === false && tuneNoReason.note.includes('理由'), '不带理由就不许改系数')
  const tuneBadKind = await h.tools.get('emotion_tune').execute({ emotion: 'angry', to: 1.5, reason: 'x' }, exec)
  ok(tuneBadKind.ok === false && tuneBadKind.note.includes('七种'), '枚举外的情绪不收')
  const tuneBadTo = await h.tools.get('emotion_tune').execute({ emotion: 'warm', to: 9, reason: 'x' }, exec)
  ok(tuneBadTo.ok === false, '系数超出 (0,3] 不收')

  // 改过的系数只在状态里生效；再收一遍不重记
  const emo2 = await h.tools.get('emotion_state').execute({}, exec)
  ok(emo2.ok && emo2.coefficients.warm.coefficient === 1.5, '状态里看得到改过的系数（warm 1.5）')
  eq(emo2.items.length, emo1.items.length, '再收一遍不重记（同一件事只记一次）')

  // 拿 remember 掂量一笔情绪事件：refs 指回 e_，回执里要说明白
  const emoRefId = String(emo2.items[0] ?? '').split(' ')[0]
  const weighedEmo = await h.tools.get('remember').execute(
    {
      text: '那一顿饭落进心里的暖，我认下了',
      kind: 'fact',
      weight: 0.4,
      refs: emoRefId,
      changes: '以后算暖的分量，自己吃上饭也算数',
    },
    exec,
  )
  ok(weighedEmo.ok, '拿 remember 掂量一笔情绪事件')
  ok(weighedEmo.note.includes('情绪流'), `掂量之后的回执说明它被指到了（${weighedEmo.note}）`)
  ok(weighedEmo.note.includes(emoRefId), '回执里带着那笔情绪事件的 id')

  const resEmo2 = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resEmo2)
  const statusEmo2 = JSON.parse(resEmo2.body)
  ok(statusEmo2.emotion.recent.some((x) => x.id === emoRefId && x.weighed === true), '掂量过的那笔在状态里标成了掂量过')

  // 情绪键也在设置页的白名单里：能改的收到，越界的拒
  const resEmoCfg1 = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ emotionTickMinutes: 5 })), resEmoCfg1)
  eq(JSON.parse(resEmoCfg1.body).accepted?.[0]?.key, 'emotionTickMinutes', '情绪键在设置页能改')
  const resEmoCfg2 = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ emotionTickMinutes: 0 })), resEmoCfg2)
  eq(resEmoCfg2.statusCode, 400, '情绪键越界也 400')

  // 抄本的裁旧：上限收到 5，再抄 8 条进来，副本只留最新的 5 条；游标不回退、不重抄
  const resCap1 = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ fastMaxEvents: 5 })), resCap1)
  const capApply = JSON.parse(resCap1.body)
  ok(capApply.ok === true, '把快层上限收到 5（配置写进去了）')
  const trimStart = Date.now()
  for (let i = 1; i <= 8; i++) {
    appendFileSync(
      bodyEvents,
      `${JSON.stringify({
        at: trimStart + i * 1000,
        kind: 'mood',
        text: `又过了${i === 1 ? '一小会儿' : '一会儿'}，心里${i % 2 ? '平平的' : '松快了点'}`,
        source: 'dsh-body',
        detail: { trim: i },
      })}\n`,
      'utf8',
    )
  }
  const resCap2 = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resCap2)
  const statusCap = JSON.parse(resCap2.body)
  const copyRows = readFileSync(join(dataDir, 'fast.jsonl'), 'utf8').split('\n').filter(Boolean)
  ok(copyRows.length <= 5, `快层副本裁了旧（副本 ${copyRows.length} 行 ≤ 上限 5）`)
  ok(statusCap.fast.total <= 5, `状态里快层总数也受上限管（total=${statusCap.fast.total}）`)
  const newestDetail = copyRows.at(-1)
  ok(newestDetail.includes('"trim":8'), '留下的是最新的那条（trim 8 在尾部）')
  const resCap3 = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resCap3)
  JSON.parse(resCap3.body)
  const copyRows2 = readFileSync(join(dataDir, 'fast.jsonl'), 'utf8').split('\n').filter(Boolean)
  ok(copyRows2.length === copyRows.length, '再读一遍不重抄（游标认得自己读到哪了）')
  const resCap4 = fakeRes()
  await configRoute.handler(fakeReq('POST', JSON.stringify({ fastMaxEvents: 500 })), resCap4)
  ok(JSON.parse(resCap4.body).ok === true, '上限放回 500')

  // 激活度：最重的几条按激活度排，行尾把激活值标出来；status 带公式
  ok(list2.items.some((x) => /激活 [01]\.\d\d/.test(x)), '最重的几条行尾带着激活值')
  const actRecall = await h.tools.get('recall').execute({ limit: 3 }, exec)
  ok(actRecall.ok && actRecall.items.length >= 2, '不给词的 recall 也翻得出（按激活度）')
  ok(status.activation && status.nodes[0].activation !== undefined, 'status 带激活值')
  if (status.activation) {
    const w = status.activation.axes ?? {}
    const sum = (w.weight ?? 0) + (w.recency ?? 0) + (w.fit ?? 0) + (w.repeat ?? 0)
    ok(Math.abs(sum - 1) < 1e-9, `四路权重和为 1（${sum}）`)
    ok(status.activation.recencyTau?.baseMin === 30 && status.activation.recencyTau?.spanMin === 90, '新近那把钟是分钟级的（30 + 90×weight）')
    const n0 = status.nodes[0] ?? {}
    ok(n0.activation >= 0 && n0.activation <= 1, `第一条的激活值落在 [0,1]（${n0.activation}）`)
    ok(['weight', 'recency', 'fit', 'repeat'].every((k) => typeof n0.axes?.[k] === 'number'), '每条的 axes 拆得开四路')
    ok(n0.score !== undefined, '老口径的分值还在（client 不炸）')
  }

  // 手改坏 config.json：别让整段悄悄关掉（坏值要回落默认，不是变成 0）
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({ curiosityLimit: '这不是数字', curiosityEnabled: 'yes' }),
    'utf8',
  )
  const res5 = fakeRes()
  await configRoute.handler(fakeReq('GET'), res5)
  const forced = JSON.parse(res5.body)
  eq(forced.effective.curiosityLimit, 3, '坏掉的 curiosityLimit 回落到默认 3（不是 0）')
  eq(forced.effective.curiosityEnabled, true, '坏掉的 curiosityEnabled 回落到默认（开着）')

  // ------------------------------------------------------------------ 技能：两种不同情境各成一次才成立
  // 第二个 agent，cwd 是 targetRoot 的子目录（在范围内，但跟第一个不是同一个地方）
  const agentB = { session: { header: { id: 'session-smoke-b', cwd: join(targetRoot, 'elsewhere') } }, ctx: h.makeAgentCtx([]) }
  const execB = { agent: agentB }
  const sk1 = await h.tools.get('remember').execute(
    {
      text: '拆会话帧先认 zstd 头，再一帧帧过',
      kind: 'skill',
      context: '拆会话帧',
      weight: 0.7,
      changes: '会了这一手，翻会话文件不再靠猜',
      tags: '技能,拆帧',
    },
    exec,
  )
  ok(sk1.ok && sk1.id, '技能首写收下了')
  ok(sk1.note.includes('第 1 处情境'), `首写回执说清这是第几处（${sk1.note.slice(0, 40)}…）`)
  const sk2 = await h.tools.get('remember').execute(
    { text: '拆会话帧先认 zstd 头', kind: 'skill', context: '拆会话帧', changes: '换个地方也成了' },
    execB,
  )
  ok(sk2.ok && sk2.id === sk1.id, '换个情境再写 → 同一条技能（名字就是身份）')
  ok(sk2.note.includes('两种不同的情境各成过一次'), `两种情境都成过 → 回执说成立了（${sk2.note.slice(0, 50)}）`)
  const sk3 = await h.tools.get('remember').execute({ text: '又拆了一次', kind: 'skill', context: '拆会话帧' }, execB)
  ok(sk3.ok && sk3.id === sk1.id, '同一处再用还是同一条')
  ok(sk3.note.includes('还是那处情境') && sk3.note.includes('又用了一次'), '同一处的回执是「又用了一次」，不是新情境')
  const skFound = await h.tools.get('recall').execute({ query: '拆会话帧' }, exec)
  if (process.env.SMOKE_DEBUG) {
    const doc = JSON.parse(readFileSync(join(dataDir, 'memory.json'), 'utf8'))
    const dbg = (doc.nodes ?? []).filter((n) => n.kind === 'skill')
    console.error('DEBUG skill nodes:', JSON.stringify(dbg))
  }
  ok(
    skFound.items.some((x) => x.includes('会了·拆会话帧') && x.includes('两处情境都成过')),
    `renderLine 说「两处情境都成过」（实际：${skFound.items.join(' ┃ ').slice(0, 160) || '（空）'}）`,
  )
  const skNoName = await h.tools.get('remember').execute({ text: '没名字的技能', kind: 'skill' }, exec)
  ok(!skNoName.ok && skNoName.note.includes('名字'), '技能不带名字要被拒')
  // 没有 cwd 的会话记技能：以前是静默失效（永远 single、一句提示没有），现在要拒得说明白
  const hSkillBook = makeHarness(join(dir, 'skill-book'), '', {})
  const skNoCwd = await hSkillBook.tools.get('remember').execute(
    { text: '拆会话帧先认 zstd 头', kind: 'skill', context: '拆会话帧', changes: '想过' },
    { agent: { session: { header: { id: 'session-nocwd' } } } },
  )
  eq(skNoCwd.ok, false, '没有工作目录的会话记不了技能（拒，不静默失效）')
  ok(skNoCwd.note.includes('工作目录'), `拒绝时说清为什么（${skNoCwd.note}）`)

  // ------------------------------------------------------------------ 条件封存：到点自松 / 等一条翻篇
  const rootAnchor = await h.tools.get('remember').execute(
    { text: '根上的那条决定：先做识海，QQ 最后', kind: 'decision', weight: 0.85, changes: '定了顺序', tags: '顺序' },
    exec,
  )
  ok(rootAnchor.ok && rootAnchor.id, '条件的目标条记下了')
  const sealedUntil = await h.tools.get('forget').execute(
    { id: sk1.id, mode: 'seal', until: '2h', why: '最近不用它，先按两个小时' },
    exec,
  )
  ok(sealedUntil.ok && sealedUntil.note.includes('还剩'), `until 按住有回执（${sealedUntil.note}）`)
  const sealedCond = await h.tools.get('forget').execute(
    { id: r2.id, mode: 'seal', cond: rootAnchor.id, why: '等那条顺序翻了篇它再回来' },
    exec,
  )
  ok(sealedCond.ok && sealedCond.note.includes('翻篇'), `cond 按住有回执（${sealedCond.note}）`)
  // 按住期间：那条按住的翻不到（检索升级后别的真命中的照常翻出来——
  // 以前这条断言敢写 0，是因为老检索只会整句撞词；现在「他问」「问题」会翻出真的相关条）
  const sealedRecall = await h.tools.get('recall').execute({ query: '今天他问了个问题' }, exec)
  ok(
    !sealedRecall.items.some((x) => x.includes(r2.id)),
    'cond 按住期间按词翻不到（按住的那条不在结果里）',
  )
  // 但 include_sealed 递进去了就翻得到，行上写明是什么在按着 —— 两种按法各验一次
  // 顺带钉住 cond 按住不熏（2026-11-16 复核抓的：isSealed 不带目录会把 cond 判成翻篇）
  const r2EchoBefore = readFileSync(join(dataDir, 'echo.jsonl'), 'utf8')
    .split('\n').filter((x) => x.includes('"kind":"echo"') && x.includes(r2.id)).length
  const sealedShown = await h.tools.get('recall').execute(
    { query: '今天他问了个问题', include_sealed: true },
    exec,
  )
  ok(
    sealedShown.items.some((x) => x.includes(r2.id) && x.includes('按住·等翻篇')),
    `include_sealed 按词翻得到 cond 按住的（${sealedShown.items.length} 条：${sealedShown.items.join(' ┃ ')}）`,
  )
  const r2EchoAfter = readFileSync(join(dataDir, 'echo.jsonl'), 'utf8')
    .split('\n').filter((x) => x.includes('"kind":"echo"') && x.includes(r2.id)).length
  eq(r2EchoAfter, r2EchoBefore, 'cond 按住的条 include_sealed 翻到也不熏（isSealed 带目录才认得出 cond）')
  // 按住的条 include_sealed 翻到也不熏（2026-11-16）：回声喂的是复现轴，
  // 按住的不参与竞争 —— 只查 !n.sealed 会漏掉 until/cond 按住的
  const skEchoBefore = readFileSync(join(dataDir, 'echo.jsonl'), 'utf8')
    .split('\n').filter((x) => x.includes('"kind":"echo"') && x.includes(sk1.id)).length
  const untilShown = await h.tools.get('recall').execute({ query: '拆会话帧', include_sealed: true }, exec)
  ok(
    untilShown.items.some((x) => x.includes('按住·还有')),
    `include_sealed 按词翻得到 until 按住的（${untilShown.items.join(' ┃ ').slice(0, 120)}）`,
  )
  const skEchoAfter = readFileSync(join(dataDir, 'echo.jsonl'), 'utf8')
    .split('\n').filter((x) => x.includes('"kind":"echo"') && x.includes(sk1.id)).length
  eq(skEchoAfter, skEchoBefore, '按住的条 include_sealed 翻到也不熏（松开前不记被想起）')
  // 翻篇自动松的语义在单测里验过（isSealed 对 superseded 目标）；这里验 status 的被按住清单
  // 把三种按法都标得出来：sk1 是 until，r2 是 cond
  const res6 = fakeRes()
  await statusRoute.handler(fakeReq('GET'), res6)
  const status3 = JSON.parse(res6.body)
  const sealedRow = (status3.sealed ?? []).find((x) => x.id === sk1.id)
  ok(!!sealedRow && sealedRow.seal === 'until', `status 被按住的清单里 until 那条带按法（${JSON.stringify(sealedRow ?? {})}）`)
  ok(typeof sealedRow?.left === 'string' && sealedRow.left.length > 0, 'until 那条带「还剩多久」')
  const condRow = (status3.sealed ?? []).find((x) => x.id === r2.id)
  ok(!!condRow && condRow.seal === 'cond' && condRow.cond === rootAnchor.id, 'cond 那条带着它在等谁')
  const restoredAll = await h.tools.get('forget').execute({ id: sk1.id, mode: 'restore' }, exec)
  ok(restoredAll.ok && restoredAll.note.includes('松开'), 'restore 一把全松（until/cond/手动一起清）')
  const res7 = fakeRes()
  await statusRoute.handler(fakeReq('GET'), res7)
  const status4 = JSON.parse(res7.body)
  ok(!(status4.sealed ?? []).some((x) => x.id === sk1.id), 'restore 之后被按住的清单里没有它了')

  // ------------------------------------------------------------------ 唤醒回弹：翻到就记一笔「被想起」
  // 去重按「条目集合」算：同一组条 10 分钟内算同一次醒；集合变了（范围收窄）就是又一次醒。
  const echoA = await h.tools.get('remember').execute(
    { text: '回声靶甲阿黎：第一只靶子，等着被按词翻出来', kind: 'fact', weight: 0.5, changes: '测回弹用', tags: '回声' },
    exec,
  )
  const echoB = await h.tools.get('remember').execute(
    { text: '回声靶乙北洛：第二只靶子，跟甲一起被翻出来', kind: 'fact', weight: 0.5, changes: '也测回弹', tags: '回声' },
    exec,
  )
  ok(echoA.ok && echoA.id && echoB.ok && echoB.id, '两只靶子都记下了')
  // 冒烟里前面的 recall 也写过回声行 —— 只数带指定 id 的那几行（回声单独记档：echo.jsonl）
  const countEchoRows = (...ids) =>
    readFileSync(join(dataDir, 'echo.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((x) => x.includes('"kind":"echo"') && ids.every((i) => x.includes(i)))
  // 一次翻到两只 → 一笔回声，refs 带两条 id
  const echo1 = await h.tools.get('recall').execute({ query: '回声靶' }, exec)
  ok(echo1.ok && echo1.items.some((x) => x.includes(echoA.id)) && echo1.items.some((x) => x.includes(echoB.id)), '两只靶子按词都翻得到')
  ok(echo1.echoed === true, '翻到之后记了一笔「被想起」')
  const rows1 = countEchoRows(echoA.id)
  ok(rows1.length === 1, `甲的第一笔回声落在回声档（实际 ${rows1.length} 行）`)
  ok(rows1[0]?.includes(echoB.id) && rows1[0]?.includes('被想起'), '回声行带着两只靶子的 id 和「被想起」')
  // 同一组条马上再翻：去重 —— 一次对话里连翻几下是同一次醒
  const echo2 = await h.tools.get('recall').execute({ query: '回声靶' }, exec)
  ok(echo2.echoed === false, '10 分钟内同组条再翻不重复记')
  ok(countEchoRows(echoA.id).length === 1, '去重生效（甲没有第二行）')
  // 集合收窄（只翻到甲）：又一次醒，新的一笔
  const echo3 = await h.tools.get('recall').execute({ query: '阿黎' }, exec)
  ok(echo3.ok && echo3.echoed === true, '集合收窄再翻是又一次醒')
  ok(countEchoRows(echoA.id).length === 2, '第二笔回声也落在回声档')
  ok(
    !readFileSync(join(dataDir, 'lines.jsonl'), 'utf8').includes('"kind":"echo"'),
    '原话层里没有回声行（回声单独记档，原话层只留我自己写的字）',
  )
  // 回声喂复现轴：status 带回声块，甲攒了两笔；熏习势力按 τ 衰减
  const res8 = fakeRes()
  await statusRoute.handler(fakeReq('GET'), res8)
  const status5 = JSON.parse(res8.body)
  ok(status5.echoes?.windowDays === 42 && status5.echoes?.total >= 3, `status 带回声块（total=${status5.echoes?.total}，窗口=3τ）`)
  ok(
    (status5.echoes?.top ?? []).length > 0 &&
      (status5.echoes?.top ?? []).every((x) => x.strength > 0 && x.strength <= x.count),
    `回声块 top 按势力排：势力=笔数×衰减，只会比笔数小（top=${JSON.stringify((status5.echoes?.top ?? []).slice(0, 3))}）`,
  )
  // 陈年回声的衰减在独立小环境里验（主账本回声太多，0.12 的势力挤不进 top-5）：
  // 账本里只预埋一陈（30 天前）一鲜（现在）两笔回声，断言无歧义
  const agedDir = join(dir, 'aged-book')
  mkdirSync(agedDir, { recursive: true })
  writeFileSync(
    join(agedDir, 'echo.jsonl'),
    [
      { id: 'e_aged02', at: Date.now() - 30 * 24 * 60 * 60 * 1000, kind: 'echo', query: '陈年旧事', refs: ['r_aged-target'], source: 'recall' },
      { id: 'e_fresh02', at: Date.now(), kind: 'echo', query: '刚发生的缘', refs: ['r_fresh-target'], source: 'recall' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
    'utf8',
  )
  writeFileSync(join(agedDir, 'body-events.jsonl'), '', 'utf8')
  const hAged = makeHarness(agedDir, targetRoot, { fastSource: join(agedDir, 'body-events.jsonl') })
  const resAged = fakeRes()
  await hAged.routes.find((r) => r.path === '/dsh-remember/status').handler(fakeReq('GET'), resAged)
  const stAged = JSON.parse(resAged.body)
  const agedRow = (stAged.echoes?.top ?? []).find((x) => x.id === 'r_aged-target')
  ok(
    !!agedRow && agedRow.count === 1 && agedRow.strength > 0.05 && agedRow.strength < 0.3,
    `陈年回声按 τ 衰减（count=${agedRow?.count}，strength=${agedRow?.strength}，30 天 ≈0.12）`,
  )
  const freshRow = (stAged.echoes?.top ?? []).find((x) => x.id === 'r_fresh-target')
  ok(
    !!freshRow && freshRow.count === 1 && freshRow.strength > 0.9,
    `刚熏的那笔势力接近满份（strength=${freshRow?.strength}）`,
  )
  ok(
    (freshRow?.strength ?? 0) > (agedRow?.strength ?? 1) * 3,
    `刚熏的势力显著高于陈年的（${freshRow?.strength} vs ${agedRow?.strength}）—— 习气偏向最近`,
  )

  // ---------------------------------------------------------- 违熏：说会做、没做到，记下来
  const vkSeed = await h.tools.get('remember').execute(
    { text: '遇到 bug 先看日志再猜', kind: 'lesson', weight: 0.7, will_do: '下次先翻日志' },
    exec,
  )
  ok(vkSeed.ok, '违熏靶子记下了')
  // 先 recall 一次，制造 echo —— 违熏的 echoId 反查靠它
  const vkRecall = await h.tools.get('recall').execute({ query: '先看日志' }, exec)
  ok(vkRecall.ok && vkRecall.echoed === true, '违熏靶子被想起一次')
  const vk = await h.tools.get('vikarma').execute(
    { seedId: vkSeed.id, reason: '未触发', actual: '又直接猜了' },
    exec,
  )
  ok(vk.ok && String(vk.id).startsWith('vk_'), '违熏记下了')
  // 没 will_do 的种子拒
  const noWill = await h.tools.get('remember').execute({ text: '没写 will_do 的靶子', kind: 'fact' }, exec)
  const vkBad = await h.tools.get('vikarma').execute({ seedId: noWill.id, reason: '未触发' }, exec)
  ok(!vkBad.ok && vkBad.note.includes('will_do'), '没 will_do 的种子不给记违熏')
  // 枚举外的 reason 拒
  const vkBadReason = await h.tools.get('vikarma').execute({ seedId: vkSeed.id, reason: '乱写' }, exec)
  ok(!vkBadReason.ok, '枚举外的 reason 不收')
  // 不存在的种子拒
  const vkGhost = await h.tools.get('vikarma').execute({ seedId: 'r_不存在', reason: '未触发' }, exec)
  ok(!vkGhost.ok, '不存在的种子不收')
  // 再 recall，行尾带违熏提醒（30 天内）
  const vkRecall2 = await h.tools.get('recall').execute({ query: '先看日志' }, exec)
  ok(
    vkRecall2.items.some((x) => x.includes('上次现行时没兑现')),
    'recall 行尾带违熏提醒',
  )
  // stats
  const resVk = fakeRes()
  await statusRoute.handler(fakeReq('GET'), resVk)
  const stVk = JSON.parse(resVk.body)
  ok(stVk.vikarma?.total >= 1, 'status 带违熏计数')
  ok(stVk.vikarma.byReason['未触发'] >= 1, 'status 带 reason 分布')
  ok(stVk.vikarma.top.some((x) => x.seedId === vkSeed.id), 'status 带违熏最多的种子')

  // ------------------------------------------------------------------ 叫醒：身体越过线就把我叫醒
  // 心跳不靠测试等 60 秒 —— apply 返回了 wakeBeat，直接一拍一拍喂。
  // 自带一套独立环境（自己的事件文件、自己的账本），boot 顺序可控。
  ok(typeof h.wakeBeat === 'function' && h.wakeState, '叫醒的心跳拿得到（apply 返回 wakeBeat/wakeState）')
  const wakeEvents = join(dir, 'wake-events.jsonl')
  writeFileSync(
    wakeEvents,
    JSON.stringify({ at: Date.now() - 60000, kind: 'threshold', text: '（旧的）饿到有点发慌了', source: 'dsh-body' }) + '\n',
    'utf8',
  )
  const hw = makeHarness(join(dir, 'wake-book'), targetRoot, { fastSource: wakeEvents })
  hw.created.forEach((fn) => fn(hw.agent))
  ok(typeof hw.wakeBeat === 'function', '新实例也有心跳')
  // 开机时副本里已有的旧事件不当叫醒源（baseline 就是启动时那份）
  await hw.wakeBeat(Date.now())
  ok(hw.wakePrompts.length === 0, `开机前的旧事件不叫醒（递话 ${hw.wakePrompts.length} 次）`)
  // 新事件：越过线 → 叫醒
  appendFileSync(
    wakeEvents,
    JSON.stringify({ at: Date.now(), kind: 'threshold', text: '饿到有点发慌了', source: 'dsh-body' }) + '\n',
    'utf8',
  )
  await hw.wakeBeat(Date.now())
  ok(hw.wakePrompts.length === 1, `越过线的新事件叫醒了（递话 ${hw.wakePrompts.length} 次）`)
  const wakeMsg = hw.wakePrompts[0]
  ok(
    typeof wakeMsg?.content?.[0]?.text === 'string' &&
      wakeMsg.content[0].text.includes('【身体】') &&
      wakeMsg.content[0].text.includes('饿到有点发慌了'),
    `叫醒的话带着身体那句（${String(wakeMsg?.content?.[0]?.text ?? '').slice(0, 60)}…）`,
  )
  ok(wakeMsg?.sessionId === 'session-wake', `叫醒递进 list 里找到的那条会话（${wakeMsg?.sessionId}）`)
  ok(wakeMsg?.mode === 'queue' && typeof wakeMsg?.requestId === 'string' && wakeMsg.requestId.startsWith('wake-'), '叫醒的递话形状（queue + wake- 前缀 requestId）')
  // 冷却：马上再来一条越过线的，不连着吵（一次醒处理一批）
  appendFileSync(
    wakeEvents,
    JSON.stringify({ at: Date.now() + 1, kind: 'missed', text: '错过了一顿饭', source: 'dsh-body' }) + '\n',
    'utf8',
  )
  await hw.wakeBeat(Date.now())
  ok(hw.wakePrompts.length === 1, '冷却里不连着叫')
  // 心情不叫醒；过了冷却，也只挑越过线的那种
  appendFileSync(
    wakeEvents,
    JSON.stringify({ at: Date.now() + 2, kind: 'mood', text: '有人夸了一句，心里亮了一下', source: 'dsh-body' }) + '\n',
    'utf8',
  )
  await hw.wakeBeat(Date.now() + 31 * 60 * 1000)
  ok(hw.wakePrompts.length === 1, '心情不叫醒')
  // 状态落了盘：wake.json 记着上回醒的时间和目标
  ok(existsSync(join(dir, 'wake-book', 'wake.json')), '叫醒的账落在盘上（wake.json）')
  const savedWake = JSON.parse(readFileSync(join(dir, 'wake-book', 'wake.json'), 'utf8'))
  ok(savedWake.lastWakeAt > 0 && savedWake.target === 'session-wake', `wake.json 记着上回醒的时刻和目标（${savedWake.target}）`)
  // 开关关了就叫不醒（再起新实例，事件文件里再放一条越过线的）
  const h2 = makeHarness(join(dir, 'wake-off-book'), targetRoot, { wakeEnabled: false, fastSource: wakeEvents })
  h2.created.forEach((fn) => fn(h2.agent))
  appendFileSync(
    wakeEvents,
    JSON.stringify({ at: Date.now() + 3, kind: 'threshold', text: '困得撑不住了', source: 'dsh-body' }) + '\n',
    'utf8',
  )
  await h2.wakeBeat(Date.now())
  ok(h2.wakePrompts.length === 0, 'wakeEnabled 关掉就不叫')
  // status 带叫醒块
  const res9 = fakeRes()
  await statusRoute.handler(fakeReq('GET'), res9)
  const status6 = JSON.parse(res9.body)
  ok(status6.wake?.enabled === true && Array.isArray(status6.wake?.kinds) && status6.wake.kinds.includes('threshold'), `status 带叫醒块（kinds=${JSON.stringify(status6.wake?.kinds)}）`)
  ok(status6.wake?.cooldownMinutes === 30 && typeof status6.wake?.beats === 'number', `叫醒的冷却和拍数在（beats=${status6.wake?.beats}）`)

  // ---------------------------------------------------------------- 翻账的字数闸（v0.16.0）
  // 吴晓观三条意见里的第一、二条是真的：给的是原文，limit 是每一路的上限。
  // 我加的是字数闸：每条截到 recallItemMax、一次总共 recallMaxChars，省了什么写在 note 里。
  // 放在最后写 —— 前面有断言在数节点条数。
  const gateTag = '闸测试靶'
  const longTexts = [0, 1, 2, 3].map((i) => `${gateTag}${i}：` + '长'.repeat(600))
  for (const t of longTexts) await h.tools.get('remember').execute({ text: t, kind: 'fact', weight: 0.5 }, exec)
  const gated = await h.tools.get('recall').execute({ query: gateTag, limit: 5 }, exec)
  ok(gated.ok && gated.items.length >= 3, '长条目翻得出来')
  ok(gated.items.some((x) => x.includes('原文还有')), '默认把长原文截短，还写明还剩多少字')
  ok(String(gated.note || '').includes('截短'), 'note 里说清截短了几条')
  const gatedFull = await h.tools.get('recall').execute({ query: gateTag, limit: 5, full: true }, exec)
  ok(gatedFull.ok && gatedFull.items.every((x) => !x.includes('原文还有')), 'full=true 给原文全文，不截')
  ok(gatedFull.items.some((x) => x.includes('长'.repeat(50))), 'full=true 的正文是完整的')
  // 总量闸：预算压到 1000，多余的条目从尾巴省，note 说明省了几条
  const cfgRouteGate = h.routes.find((r) => r.path === '/dsh-remember/config')
  const resGate = fakeRes()
  await cfgRouteGate.handler(fakeReq('POST', JSON.stringify({ recallMaxChars: 1000 })), resGate)
  eq(resGate.statusCode, 200, 'POST /config 收下 recallMaxChars')
  const tight = await h.tools.get('recall').execute({ query: gateTag, limit: 5 }, exec)
  ok(tight.ok && tight.items.length < gated.items.length, '预算不够时条目变少')
  ok(String(tight.note || '').includes('没给出来'), 'note 里写明有几条没给出来')
  const resGate2 = fakeRes()
  await cfgRouteGate.handler(fakeReq('POST', JSON.stringify({ recallMaxChars: 8000 })), resGate2)
  const back = await h.tools.get('recall').execute({ query: gateTag, limit: 5 }, exec)
  ok(back.items.length >= gated.items.length, '预算放回去，条目回来了')

  console.log(`dsh-remember 冒烟：${pass} 项通过${fail ? `，${fail} 项没过` : ''}`)
} finally {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

process.exit(fail ? 1 : 0)
