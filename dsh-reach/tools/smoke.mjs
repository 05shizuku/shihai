/**
 * dsh-reach 冒烟：不打真宿主，打一个假 ctx，把整条链跑一遍。
 *
 *   写下一条 → 心跳到点 → 投递（假的 sessionController.prompt）
 *            → 会话"出生" → 段落挂进 system prompt → 状态记成 sent
 *   外加：设置页三条接口、撤掉一条、空手回合、送不出去的容错。
 *
 * 跑法：node tools/smoke.mjs        （不用真 B 站、不用真会话、不花钱）
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, DEFAULTS } from '../index.js'
import { STATUS } from '../lib/reach.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const failures = []

function ok(cond, label, extra) {
  if (cond) {
    passed += 1
    return
  }
  failures.push(`${label}${extra ? ` —— ${extra}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-reach-smoke-'))
const stateFile = join(dir, 'state.json')
const configFile = join(dir, 'config.json')

// ---------------------------------------------------------------- 假宿主

function makeReq({ method = 'GET', body = '' } = {}) {
  const handlers = {}
  const req = {
    method,
    on(ev, fn) {
      ;(handlers[ev] ||= []).push(fn)
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    if (body) for (const fn of handlers.data ?? []) fn(Buffer.from(body))
    for (const fn of handlers.end ?? []) fn()
  })
  return req
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(code, headers) {
      res.statusCode = code
      Object.assign(res.headers, headers ?? {})
      return res
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) res.chunks.push(Buffer.from(chunk))
      res.writableEnded = true
    },
  }
  return res
}

function readJson(res) {
  const text = Buffer.concat(res.chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text }
  }
}

const SID = 'session-smoke-1'
const WORKSPACE = 'E:\\大肥鱼\\Plugin'

const prompts = []
const sections = []
const routes = new Map()
const tools = new Map()
const handlers = new Map()

const fakeAgent = {
  session: { header: { id: SID, cwd: WORKSPACE } },
  ctx: {
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    effect() {
      return () => {}
    },
  },
}

const services = {
  sessionController: {
    async list() {
      return {
        items: [
          { sessionId: SID, updatedAt: Date.now(), running: false, blank: false, cwd: WORKSPACE },
          { sessionId: 'session-sub', updatedAt: Date.now(), running: false, blank: false, cwd: WORKSPACE, origin: 'subagent' },
        ],
      }
    },
    async prompt(request) {
      prompts.push(request)
      // 模拟"会话是冷的、agent 在投递之后才出生"
      for (const fn of handlers.get('agent/created') ?? []) fn({ agent: fakeAgent })
      return { accepted: true }
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  connection: {
    requestRejection() {
      return null
    },
  },
}

const ctx = {
  get(key) {
    return services[key] ?? null
  },
  effect(fn) {
    const d = fn()
    return () => {
      try {
        d?.()
      } catch {
        /* ignore */
      }
    }
  },
  on(event, fn) {
    ;(handlers.get(event) || handlers.set(event, []).get(event)).push(fn)
    return () => {}
  },
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
}

// ---------------------------------------------------------------- 跑起来

apply(ctx, { dataDir: dir, tickMs: 200, checkInEnabled: false })
await sleep(30)

ok(tools.has('reach_out') && tools.has('reach_list') && tools.has('reach_cancel'), '三个工具都挂上了', [...tools.keys()].join(','))
ok(routes.has('/dsh-reach/status'), '设置页 status 接口挂上了', [...routes.keys()].join(','))
ok(routes.has('/dsh-reach/checkin') && routes.has('/dsh-reach/config'), '另外两条接口也挂上了')

const reachOut = tools.get('reach_out')
const exec = { agent: fakeAgent, callId: 'c1', name: 'reach_out', arguments: '{}', signal: new AbortController().signal }

// ① 留一句"现在就说"
const saved = await reachOut.execute({ text: '等他忙完，问一句今天的火锅。', note: '他今晚加班', when: 'now' }, exec)
ok(saved.ok === true, 'reach_out 留下了', JSON.stringify(saved))
ok(String(saved.id).startsWith('r_'), 'id 有前缀', saved.id)
ok(saved.when === '现在', '回执里说得清什么时候', saved.when)

// ② 心跳把它送出去
await sleep(600)
const delivered = prompts.find((p) => String(p.requestId).includes(String(saved.id)))
ok(Boolean(delivered), '到点了会投一次', JSON.stringify(prompts.map((p) => p.requestId)))
ok(delivered && delivered.sessionId === SID, '投给写它的那条会话', delivered?.sessionId)
ok(delivered && delivered.content?.[0]?.text === '（到点了）', '触发只有一句系统信号，不替我说话', JSON.stringify(delivered?.content))
ok(delivered && delivered.mode === 'queue', '会话没在跑就用 queue', delivered?.mode)
ok(delivered && typeof delivered.clientTimeZone === 'string' && delivered.clientTimeZone.length > 0, '带了时区', delivered?.clientTimeZone)

// ③ 会话出生时把"我留给自己的话"挂进 system prompt
const mine = sections.find((s) => String(s.name).startsWith('dsh-reach-r_'))
ok(Boolean(mine), '到点那段挂上了', JSON.stringify(sections.map((s) => s.name)))
const mineText = typeof mine?.text === 'function' ? mine.text() : String(mine?.text ?? '')
ok(mineText.includes('【自己留给自己的话 · 到点了】'), '段落标题对')
ok(mineText.includes('等他忙完，问一句今天的火锅。'), '原话在里面', mineText.slice(0, 120))
ok(mineText.includes('他今晚加班'), '当时写的原因也在')
ok(mineText.includes('这句我不说了'), '允许当场反悔')
ok(mine?.interpolate === false, '这段不插值（不然 {{ }} 会被吃掉）')

// ④ 状态记成 sent
const state1 = JSON.parse(readFileSync(stateFile, 'utf8'))
const row = state1.entries.find((e) => e.id === saved.id)
ok(row?.status === STATUS.sent, '状态记成 sent', row?.status)
ok(Number(row?.sentAt) > 0, '记了发送时间')

// ⑤ 设置页 /status
const statusRoute = routes.get('/dsh-reach/status')
const res1 = makeRes()
await statusRoute.handler(makeReq({ method: 'GET' }), res1)
const status = readJson(res1)
ok(res1.statusCode === 200 && status.ok === true, '/status 通了', String(res1.statusCode))
ok(status.counts?.sentTotal === 1, '数显对了', JSON.stringify(status.counts))
ok(typeof status.engine?.tickMs === 'number' && status.engine.tickMs === 200, 'tickMs 生效（自测才调这么小）', String(status.engine?.tickMs))
let stringified = true
try {
  JSON.stringify(status)
} catch {
  stringified = false
}
ok(stringified, '/status 能被 JSON.stringify（定时器别混进去）')

// ⑥ 再留一条、撤掉它
const second = await reachOut.execute({ text: '明早提醒他早点睡。', inMinutes: 30 }, exec)
ok(second.ok === true, '第二条留下了')
const cancelled = await tools.get('reach_cancel').execute({ id: second.id }, exec)
ok(cancelled.ok === true, '撤得掉', JSON.stringify(cancelled))
const listRes = await tools.get('reach_list').execute({}, exec)
ok(listRes.ok === true && listRes.items.length === 0, '撤掉之后列表里没有了', JSON.stringify(listRes.items))

// ⑥b 范围还没收窄时，别的目录里也能留（默认开放）；这条留着给后面验证"范围外的看不见"
const foreignAgent = {
  session: { header: { id: 'session-smoke-2', cwd: 'E:\\别人的工作区' } },
  ctx: fakeAgent.ctx,
}
const foreignExec = { ...exec, agent: foreignAgent, callId: 'c2' }
const foreignSaved = await reachOut.execute({ text: '这是别的目录里留的。', inMinutes: 30 }, foreignExec)
ok(foreignSaved.ok === true, '默认开放时别处也能留', JSON.stringify(foreignSaved))

// ⑦ 设置页 /config：坏值 400，好值写进 config.json
const configRoute = routes.get('/dsh-reach/config')
const badRes = makeRes()
await configRoute.handler(makeReq({ method: 'POST', body: JSON.stringify({ checkInMaxPerDay: 999 }) }), badRes)
const badJson = readJson(badRes)
ok(badRes.statusCode === 400 && badJson.rejected?.length > 0, '越界的值被拒且说理由', JSON.stringify(badJson.rejected))

const goodRes = makeRes()
await configRoute.handler(
  makeReq({
    method: 'POST',
    // 关掉"他刚说过话就不叫"，否则假列表的 updatedAt=现在 会让空手回合正确地拒绝叫
    body: JSON.stringify({
      checkInEnabled: true,
      checkInWindowStart: '7:5',
      checkInMinQuietMinutes: 0,
      // 把范围收窄到我这个工作区，并按住"别人的工作区"那个目录
      targetRoot: WORKSPACE,
      denyRoots: 'E:\\别人的工作区',
    }),
  }),
  goodRes,
)
const goodJson = readJson(goodRes)
ok(goodRes.statusCode === 200 && goodJson.ok === true, '好值收下了', String(goodRes.statusCode))
const cfgOnDisk = JSON.parse(readFileSync(configFile, 'utf8'))
ok(cfgOnDisk.checkInWindowStart === '07:05', '时间归一化后落盘', cfgOnDisk.checkInWindowStart)
ok(cfgOnDisk.targetRoot === WORKSPACE, 'targetRoot 落盘', cfgOnDisk.targetRoot)
ok(Array.isArray(cfgOnDisk.denyRoots) && cfgOnDisk.denyRoots[0] === 'E:\\别人的工作区', 'denyRoots 落盘', JSON.stringify(cfgOnDisk.denyRoots))

// ⑦b 范围收窄之后：别的目录里留的话看不见、撤不掉、也留不进新的
const listMine = await tools.get('reach_list').execute({}, exec)
ok(listMine.ok === true && !listMine.items.some((s) => s.includes('这是别的目录里留的')), '自己的列表里看不到别处留的', JSON.stringify(listMine.items))

const listForeign = await tools.get('reach_list').execute({}, foreignExec)
ok(listForeign.ok === false, '范围外的会话看不了列表', JSON.stringify(listForeign))

const cancelForeign = await tools.get('reach_cancel').execute({ id: foreignSaved.id }, exec)
ok(cancelForeign.ok === false, '撤不掉别处留的话', JSON.stringify(cancelForeign))

const outForeign = await reachOut.execute({ text: '再留一句。', when: 'now' }, foreignExec)
ok(outForeign.ok === false, '范围外的会话留不进新的', JSON.stringify(outForeign))

const statusRoute2 = routes.get('/dsh-reach/status')
const res2 = makeRes()
await statusRoute2.handler(makeReq({ method: 'GET' }), res2)
const status2 = readJson(res2)
ok(
  !(status2.entries ?? []).some((e) => e.id === foreignSaved.id),
  '面板上不列范围外的条目',
  JSON.stringify((status2.entries ?? []).map((e) => e.id)),
)
ok(status2.counts?.pending === (status2.entries ?? []).length, '待发条数和列出来的对得上', JSON.stringify(status2.counts))

// ⑧ 空手回合：点一下，它把我叫起来问一句
const checkinRes = makeRes()
await routes.get('/dsh-reach/checkin').handler(makeReq({ method: 'POST' }), checkinRes)
const ciJson = readJson(checkinRes)
ok(checkinRes.statusCode === 200 && ciJson.ok === true, '空手回合投出去了', JSON.stringify(ciJson))
const checkinPrompt = prompts.find((p) => p.content?.[0]?.text === '（想问一句）')
ok(Boolean(checkinPrompt), '触发是"（想问一句）"')
ok(checkinPrompt?.sessionId === SID, '没投给 subagent 那条', checkinPrompt?.sessionId)
const checkinSection = sections.find((s) => String(s.name).startsWith('dsh-reach-checkin-'))
const checkinText = typeof checkinSection?.text === 'function' ? checkinSection.text() : ''
ok(checkinText.includes('没有就什么都不做'), '段落里写明可以什么都不做')

// ⑨ 送不出去：prompt 抛错时不许把这条弄丢，也不许无限重试
const brokenCtx = { ...ctx }
let attemptsSeen = 0
const brokenServices = {
  ...services,
  sessionController: {
    async list() {
      return { items: [{ sessionId: SID, updatedAt: Date.now(), running: false, blank: false, cwd: WORKSPACE }] }
    },
    async prompt() {
      attemptsSeen += 1
      throw new Error('假装的网络断了')
    },
  },
}
const broken = brokenCtx
const dir2 = mkdtempSync(join(tmpdir(), 'dsh-reach-smoke-fail-'))
writeFileSync(
  join(dir2, 'state.json'),
  JSON.stringify({
    version: 1,
    entries: [
      {
        id: 'r_fail0000',
        text: '这条送不出去',
        note: '',
        sessionId: SID,
        cwd: WORKSPACE,
        mode: 'at',
        dueAt: Date.now() - 5000,
        createdAt: Date.now() - 60000,
        status: STATUS.pending,
        attempts: 0,
        lastError: '',
        sentAt: null,
      },
    ],
    checkInDay: '',
    checkInCount: 0,
    lastCheckInAt: 0,
    lastActivity: {},
  }),
)
const brokenCtx2 = {
  ...broken,
  get(key) {
    return brokenServices[key] ?? null
  },
}
apply(brokenCtx2, { dataDir: dir2, tickMs: 200, checkInEnabled: false })
await sleep(600)
const failState = JSON.parse(readFileSync(join(dir2, 'state.json'), 'utf8'))
const failRow = failState.entries.find((e) => e.id === 'r_fail0000')
ok(attemptsSeen >= 1, '确实试着送了', String(attemptsSeen))
ok(failRow?.status === STATUS.pending, '送不出去还留在待发里，不丢', failRow?.status)
ok(Number(failRow?.attempts) >= 1, '记了失败次数', String(failRow?.attempts))
ok(String(failRow?.lastError ?? '').includes('网络断了'), '记了失败原因', failRow?.lastError)

// ---------------------------------------------------------------- 收尾

rmSync(dir, { recursive: true, force: true })
rmSync(dir2, { recursive: true, force: true })

if (failures.length) {
  console.error(`✖ 冒烟没过（${failures.length} 处）`)
  for (const f of failures) console.error(`  · ${f}`)
  process.exit(1)
}
console.log(`✔ 冒烟通过：${passed} 项`)
console.log(`  （默认配置里 tickMs=${DEFAULTS.tickMs}，自测才调成 200）`)
