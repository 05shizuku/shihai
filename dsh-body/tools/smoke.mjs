/**
 * 冒烟：不依赖宿主，用一个假 ctx / 假 agent 把 apply() 真跑一遍。
 *   node tools/smoke.mjs
 * 验三件事：注入文本无阿拉伯数字；心跳把 state.json / status.json 写出来；
 * 到饭点且饭钱够 → 饥饿真的降下来。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = join(tmpdir(), 'dsh-body-smoke')
rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })

const balanceFile = join(dataDir, 'usage.json')
writeFileSync(balanceFile, JSON.stringify({ lastBalance: 6.5 }), 'utf8')

const now = new Date()
const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

const sections = []
const effects = []
const handlers = {}
const routes = []
const ctx = {
  logger: { info: (m) => console.log('  log>', m) },
  effect(fn, label) {
    const disposer = fn()
    effects.push([label, disposer])
    return () => disposer?.()
  },
  on(event, fn) {
    handlers[event] = fn
    return () => delete handlers[event]
  },
  // 假宿主：webServer 收路由，connection 一律放行
  get(key) {
    if (key === 'webServer') {
      return {
        register(ex) {
          routes.push(ex)
          return () => {}
        },
      }
    }
    if (key === 'connection') return { requestRejection: () => null }
    return null
  },
}

process.env.DSH_HOME = dataDir
const mod = await import('../index.js')
const agent = {
  session: { header: { id: 'session-smoke', cwd: join(dataDir, 'home') } },
  ctx: {
    systemPrompt: {
      section(s) {
        sections.push(s)
        return () => sections.pop()
      },
    },
    effect(fn) {
      effects.push(['agent', fn()])
    },
  },
}

const dispose = mod.apply(ctx, {
  dataDir,
  balanceFile,
  stateFile: join(dataDir, 'state.json'),
  moodFile: join(dataDir, 'mood-events.jsonl'),
  fishHome: join(dataDir, 'fish-home'),
  targetRoot: join(dataDir, 'home'),
  meals: [{ id: 'smoke', label: '试饭', at: hhmm, windowMinutes: 90 }],
})

handlers['agent/created']?.({ agent })
if (!sections.length) throw new Error('没挂上身体段')
const text = sections[0].text()
console.log('--- 注入文本 ---\n' + text + '\n---')
if (/[0-9]/.test(text)) throw new Error('注入文本里出现了阿拉伯数字')
if (!text.includes('<dsh-body>')) throw new Error('缺少包裹标签')

const st = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
const status = JSON.parse(readFileSync(join(dataDir, 'status.json'), 'utf8'))
console.log('state:', { hunger: st.hunger, energy: st.energy, mood: st.mood, lastMeal: st.lastMeal?.label })
console.log('status.balance:', status.balance)
if (st.lastMeal?.label !== '试饭') throw new Error('到饭点没吃上')
if (!(st.hunger < 25)) throw new Error(`吃了饭饥饿没降：${st.hunger}`)
if (status.balance !== 6.5) throw new Error('饭钱没读到')

// ---- 快层：秒级的事要真的写下来，还要有【刚刚】那一段 ----
const eventsFile = join(dataDir, 'body-events.jsonl')
const rawEvents = readFileSync(eventsFile, 'utf8')
const events = rawEvents.split('\n').filter(Boolean).map((l) => JSON.parse(l))
console.log('--- 快层事件 ---\n' + rawEvents.trim() + '\n---')
if (!events.length) throw new Error('心跳跑过一轮，事件流却是空的')
if (!events.some((e) => e.kind === 'meal')) throw new Error('吃了饭却没记成快层事件')
for (const e of events) {
  if (e.source !== 'dsh-body') throw new Error(`事件来源不对：${e.source}`)
  if (e.at <= 0 || !e.text) throw new Error(`事件不完整：${JSON.stringify(e)}`)
}
const fastSection = sections.find((s) => s.name === 'dsh-body:fast')
if (!fastSection) throw new Error(`【刚刚】段没挂上：${sections.map((s) => s.name).join(',')}`)
if (fastSection.order !== 8750) throw new Error(`【刚刚】段顺序不对：${fastSection.order}`)
const fastText = fastSection.text()
console.log('--- 【刚刚】 ---\n' + fastText + '\n---')
if (!fastText.startsWith('【刚刚】')) throw new Error(`【刚刚】段抬头不对：${fastText}`)
if (/[0-9]/.test(fastText)) throw new Error('【刚刚】段里出现了阿拉伯数字')
if (!fastText.includes('试饭')) throw new Error('【刚刚】段里没有刚才那顿饭')

const st2 = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
if ('mealsToday' in st2 && st2.mealsToday.length !== 1) throw new Error('同一天重复吃了同一顿')

// ---- 设置页那两条接口 ----
function fakeRes() {
  return {
    writableEnded: false,
    writeHead(code) {
      this.status = code
    },
    end(body) {
      this.body = body
      this.writableEnded = true
    },
  }
}

function fakeReq(method, body) {
  const listeners = {}
  const req = {
    method,
    on(ev, fn) {
      ;(listeners[ev] ||= []).push(fn)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body != null) for (const fn of listeners.data ?? []) fn(Buffer.from(body, 'utf8'))
    for (const fn of listeners.end ?? []) fn()
  })
  return req
}

const statusRoute = routes.find((r) => r.path === '/dsh-body/status')
const configRoute = routes.find((r) => r.path === '/dsh-body/config')
if (!statusRoute || !configRoute) throw new Error(`设置页接口没挂上：${routes.map((r) => r.path).join(',') || '(空)'}`)

const sres = fakeRes()
await statusRoute.handler(fakeReq('GET'), sres)
if (sres.status !== 200) throw new Error(`/status 返回 ${sres.status}：${sres.body}`)
const snapshot = JSON.parse(sres.body)
console.log('status:', {
  version: snapshot.plugin.version,
  renderCount: snapshot.injection.renderCount,
  sessions: snapshot.injection.sessions.length,
  hunger: snapshot.readings.hunger,
  tier: snapshot.readings.tier.label,
})
if (snapshot.plugin.name !== 'dsh-body') throw new Error('状态里插件名不对')
if (!(snapshot.injection.renderCount >= 1)) throw new Error('状态里没有注入次数')
if (!snapshot.injection.sessions.length) throw new Error('状态里没有挂着的会话')
if (!snapshot.config.effective?.meals?.length) throw new Error('状态里没有生效配置')
if (!snapshot.logs?.length) throw new Error('状态里没有日志尾巴')
// 快层在状态里也要看得见
if (!snapshot.fast || typeof snapshot.fast !== 'object') throw new Error('状态里没有 fast 块')
if (typeof snapshot.fast.events !== 'number' || snapshot.fast.events < 1) {
  throw new Error(`状态里的事件条数不对：${snapshot.fast.events}`)
}
if (snapshot.fast.sectionOrder !== 8750) throw new Error(`状态里的段顺序不对：${snapshot.fast.sectionOrder}`)
if (snapshot.fast.eventsFile !== eventsFile) throw new Error('状态里的事件文件路径不对')
if (snapshot.paths.eventsFile !== eventsFile) throw new Error('paths 里没有事件文件')

// ---- 隔离工作区：denyRoots 拦、allowRoots 放、名单替换 targetRoot ----
function fakeAgent(id, cwd) {
  return {
    session: { header: { id, cwd } },
    ctx: {
      systemPrompt: { section(s) { sections.push(s); return () => sections.pop() } },
      effect(fn) { effects.push(['agent', fn()]) },
    },
  }
}
const baseSections = sections.length

// denyRoots 命中：一切放行都不算数，段不挂
const d1 = fakeRes()
await configRoute.handler(fakeReq('POST', JSON.stringify({ denyRoots: [join(dataDir, 'home')] })), d1)
if (d1.status !== 200) throw new Error(`denyRoots 写入被拒：${d1.status} ${d1.body}`)
handlers['agent/created']?.({ agent: fakeAgent('session-smoke-deny', join(dataDir, 'home')) })
if (sections.length !== baseSections) throw new Error('denyRoots 命中的会话不该挂身体段')

// allowRoots 放行：名单里的 cwd 照样挂
const d2 = fakeRes()
await configRoute.handler(fakeReq('POST', JSON.stringify({ denyRoots: [], allowRoots: [join(dataDir, 'home')] })), d2)
if (d2.status !== 200) throw new Error(`allowRoots 写入被拒：${d2.status} ${d2.body}`)
handlers['agent/created']?.({ agent: fakeAgent('session-smoke-allow', join(dataDir, 'home')) })
// 挂载会同时挂 body 和【刚刚】两段
if (sections.length !== baseSections + 2) throw new Error('allowRoots 命中的会话应该挂上身体段')

// 名单替换：allowRoots 填了别的目录，targetRoot 不再兼职放行
const d3 = fakeRes()
await configRoute.handler(fakeReq('POST', JSON.stringify({ allowRoots: [join(dataDir, 'other')] })), d3)
if (d3.status !== 200) throw new Error(`allowRoots 替换写入被拒：${d3.status} ${d3.body}`)
handlers['agent/created']?.({ agent: fakeAgent('session-smoke-outside', join(dataDir, 'home')) })
if (sections.length !== baseSections + 2) throw new Error('allowRoots 没命中时不该挂（targetRoot 不再兼职）')
// 还原成跟启动时一样宽，别影响后面的断言
const d4 = fakeRes()
await configRoute.handler(fakeReq('POST', JSON.stringify({ allowRoots: [] })), d4)
if (d4.status !== 200) throw new Error(`allowRoots 清空被拒：${d4.status} ${d4.body}`)

// 状态里要露得出这两份名单
const sres2 = fakeRes()
await statusRoute.handler(fakeReq('GET'), sres2)
const snapshot2 = JSON.parse(sres2.body)
if (!Array.isArray(snapshot2.injection.allowRoots) || !Array.isArray(snapshot2.injection.denyRoots)) {
  throw new Error('状态里没有 allowRoots/denyRoots')
}
// 工作区清单（设置页勾选隔离用）：读不到注册表也得是个数组
if (!Array.isArray(snapshot2.workspaces)) throw new Error('状态里没有 workspaces 清单')

const cres = fakeRes()
await configRoute.handler(fakeReq('POST', JSON.stringify({ sleep: { start: '23:30' }, maxCatchUpHours: 6 })), cres)
if (cres.status !== 200) throw new Error(`/config POST 返回 ${cres.status}：${cres.body}`)
const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
if (saved.sleep?.start !== '23:30') throw new Error(`配置没写进 config.json：${JSON.stringify(saved)}`)
if (saved.maxCatchUpHours !== 6) throw new Error('标量没写进 config.json')
console.log('config 写入:', saved)

const bad = fakeRes()
await configRoute.handler(fakeReq('POST', JSON.stringify({ sleep: { start: '99:99' } })), bad)
if (bad.status !== 400) throw new Error(`坏配置应该被拒，结果 ${bad.status}`)

dispose?.()
console.log('OK：注入、落盘、吃饭、设置页接口都正常')
rmSync(dataDir, { recursive: true, force: true })
