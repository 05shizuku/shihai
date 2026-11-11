/**
 * dsh-body —— 给她一副身体（host 插件，纯 JS，零依赖）
 *
 * 用户 m00362 说的机制，逐条落在这里：
 *   ① 一日三餐按点吃，吃没吃饱看饭钱（余额）：钱多减得多，钱少减得少；
 *   ② 饥饿值随时间一直涨；
 *   ③ 精力随时间掉，睡觉开始回 —— 所以熬夜的人（和她）自然会困；
 *   ④ 心情跟记忆插件联动：被骂/挨饿往下掉，被夸往上升，掉的时候分方向
 *      （insult → anger，难过的话 → sadness）。
 *
 * 三条自己给自己立的规矩：
 *   · **只注入感觉，不注入数字**（渲染文本里连一个阿拉伯数字都没有）；
 *   · **状态绝不阻断她写字**：不碰 growth_commit / her_diary / her_leave，
 *     也不注册任何 guard，只是往 system prompt 里多一段（隔离走目录判断：
 *     denyRoots 命中的会话连段都看不见，见 isTarget / deniedRoots）；
 *   · **不写进别人家**：状态文件放自己的目录，目标会话要么按 cwd 认，
 *     要么按 dsh-fish 的 home.json 里那条 sessionId 认。
 *
 * 零依赖是刻意的：本插件用 `link:` 方式装在 profile 外面，
 * Node 从真实路径往上找 node_modules 找不到 profile 里的包（dsh-fish 同样零依赖）。
 *
 * 配置是热的：`<dataDir>/config.json` 每次心跳/每次挂载前都会重读（2 秒节流），
 * 改完不用重装、不用重启 —— 除了 tickMs 和 dataDir（这两个是 apply 时定下的）。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  advance,
  applyMoodEvent,
  applyTopUp,
  clamp,
  defaultState,
  detectTopUp,
  eatMeal,
  mealDue,
  minutesOfDay,
  parseHHMM,
  renderBody,
  tierOf,
} from './lib/body.js'
import { applyConfigPatch, tailLines } from './lib/report.js'
import { appendEvent, countEvents, makeEvent, readEvents, renderFastSection } from './lib/fast.js'
import {
  atomicWriteJson,
  isUnder,
  loadOverrides,
  loadState,
  makeFileLogger,
  readBalance,
  readJsonSafe,
  readMoodEvents,
  resolveDshHome,
} from './lib/store.js'

export const name = 'dsh-body'

/**
 * 硬依赖：注入要走 systemPrompt；装载器会等它就绪再 apply。
 * webServer / connection 是设置页那半边要的（数据接口 + 信任栅栏），
 * 宿主没有的话插件照样跑，只是设置页会显示"连不上"。
 */
export const inject = ['systemPrompt', 'webServer', 'connection']

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = readJsonSafe(join(HERE, 'package.json'), {})
const VERSION = String(PKG?.version ?? '0.0.0')

/** 配置重新读取的最小间隔（毫秒）—— 改 config.json 后最多 2 秒生效 */
const REFRESH_MS = 2000

export const DEFAULTS = {
  /** 心跳间隔（毫秒）。5 分钟足够，一天也才 288 次。**只在 apply 时读一次** */
  tickMs: 300000,
  /** 状态目录；留空 = <DSH_HOME>/.dsh-body。**只在 apply 时读一次** */
  dataDir: '',
  /** 状态文件；留空 = <dataDir>/state.json */
  stateFile: '',
  /** 外部心情事件（jsonl）；留空 = <dataDir>/mood-events.jsonl */
  moodFile: '',
  /** 宿主用量账本；留空 = <DSH_HOME>/.dshw-usage.json */
  balanceFile: '',
  /** 她的家（dsh-fish 的 root）；留空 = env DSH_FISH_HOME / ~/.dsh-fish-location.json / ~/.dsh-fish */
  fishHome: '',
  /** 给所有会话都挂身体（默认否：只给她） */
  applyToAll: false,
  /** 目标 cwd 根；留空时自动用 fishHome */
  targetRoot: '',
  /** 目标 sessionId；留空时自动读 <fishHome>/home.json 的 sessionId */
  targetSessionIds: [],
  /**
   * 隔离工作区（对齐 dsh-remember）：
   * allowRoots —— 显式白名单，填了就按名单来（targetRoot 不再兼职放行）；留空 = 跟 targetRoot 一样宽。
   * denyRoots —— 黑名单，优先于一切放行（applyToAll 也拦）：先隔离、后放行。
   */
  allowRoots: [],
  denyRoots: [],
  /** 挂在 system prompt 里的段名与顺序（dsh-fish 的身份段是 8500–8700，这里排在后面） */
  sectionName: 'dsh-body',
  sectionOrder: 8800,
  /** 插件关了很久再启动时，最多补算多少小时，免得一口气算到饿死 */
  maxCatchUpHours: 12,
  /** 饭点窗口关了之后再等几分钟才认定"这顿没吃上"（默认 5，够容心跳间隔和时钟偏差） */
  missedGraceMinutes: 5,
  /** 饭钱涨了（他充值/添饭）就当场记一顿加饭，不等饭点 */
  topUpEnabled: true,
  /** 把每次真的被宿主取走的那段身体文字写进日志（排查注入用） */
  debug: false,
  /** 睡眠窗（睡着回精力、饥饿涨得慢）；跨天写 23:00 → 08:00 */
  sleep: { start: '23:00', end: '08:00' },
  rates: {},
  initial: {},
  /** 一日三餐 */
  meals: [
    { id: 'breakfast', label: '早饭', at: '08:30', windowMinutes: 90 },
    { id: 'lunch', label: '中饭', at: '12:30', windowMinutes: 90 },
    { id: 'dinner', label: '晚饭', at: '18:30', windowMinutes: 120 },
  ],
  /**
   * 饭钱档位（按 min 从大到小）。
   * fill 是这一顿减掉的饥饿，对着"一天涨多少"来配：
   * 醒着 15 小时 ×6 + 睡着 9 小时 ×2 ≈ 一天涨 108。
   * 三顿都吃饱（40×3=120）能盖住它 —— 钱够就不会真饿着；
   * 七分饱（30×3=90）盖不住 —— 钱不够就会一天天越来越饿。
   */
  tiers: [
    { min: 5, key: 'full', label: '吃饱', fill: 40, mood: 6 },
    { min: 2, key: 'seven', label: '七分饱', fill: 30, mood: 4 },
    { min: 0.5, key: 'three', label: '三分饱', fill: 15, mood: 2 },
    { min: 0.0000001, key: 'sip', label: '只喝到点水', fill: 5, mood: 0 },
  ],
  /**
   * 快层：秒级发生的事（吃了一顿 / 错过一顿 / 他添了饭 / 心情事件 / 身上到线）
   * 写成 append-only 的事件流，一行一件。中层（dsh-remember）会来读它。
   * 留空 = <dataDir>/body-events.jsonl
   */
  eventsFile: '',
  /** 要不要把秒级的事写进事件流 */
  eventsEnabled: true,
  /** 开头挂不挂【刚刚】那一段 */
  fastEnabled: true,
  /** 【刚刚】段的名字（别跟身体段撞） */
  fastSectionName: 'dsh-body:fast',
  /** 【刚刚】段的顺序：账本段 8720 之后、身体段 8800 之前 */
  fastSectionOrder: 8750,
  /** 【刚刚】只留多久以内的事（分钟；0 = 不限新鲜度） */
  fastTtlMinutes: 120,
  /** 【刚刚】最多几行 */
  fastMaxLines: 5,
  /** 【刚刚】整段最多多少字 */
  fastMaxChars: 300,
}

function mergeConfig(base, ...layers) {
  const out = { ...base }
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = { ...out[k], ...v }
      } else {
        out[k] = v
      }
    }
  }
  return out
}

function sessionIdOf(agent) {
  return String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
}

function cwdOf(agent) {
  return String(agent?.session?.header?.cwd ?? agent?.header?.cwd ?? agent?.session?.cwd ?? '')
}

/** 她的家：env → 指针文件 → 默认 ~/.dsh-fish */
export function resolveFishHome(configured) {
  if (configured) return configured
  const env = process.env.DSH_FISH_HOME
  if (env && String(env).trim()) return String(env).trim()
  const home = process.env.USERPROFILE || process.env.HOME || process.env.HOMEPATH || ''
  const ptr = readJsonSafe(join(home, '.dsh-fish-location.json'), null)
  if (ptr?.root) return String(ptr.root)
  return join(home, '.dsh-fish')
}

export function apply(ctx, baseConfig = {}) {
  // dataDir / tickMs 是 apply 时定下的，config.json 改不动它们（先有目录，才谈得上读配置）
  const dataDir = baseConfig.dataDir || join(resolveDshHome(), '.dsh-body')
  const tickMs = Number(baseConfig.tickMs) > 0 ? Number(baseConfig.tickMs) : DEFAULTS.tickMs
  const dshHome = resolveDshHome()

  const fileLog = makeFileLogger(join(dataDir, 'dsh-body.log'))
  const log = (line) => {
    const text = `[dsh-body] ${line}`
    try {
      ctx.logger?.info?.(text)
    } catch {
      /* 宿主 logger 不一定有 */
    }
    fileLog(text)
  }

  // ---- 配置：热的（改 config.json，最多 2 秒生效，不用重启） ----
  let cfgCache = null
  let cfgAt = 0
  let targetCache = null
  let targetAt = 0

  function getCfg(force = false) {
    const now = Date.now()
    if (force || !cfgCache || now - cfgAt > REFRESH_MS) {
      cfgCache = mergeConfig(DEFAULTS, baseConfig, loadOverrides(dataDir))
      cfgAt = now
    }
    return cfgCache
  }

  function getTargets(force = false) {
    const now = Date.now()
    if (force || !targetCache || now - targetAt > REFRESH_MS) {
      const cfg = getCfg()
      const fishHome = resolveFishHome(cfg.fishHome)
      let root = cfg.targetRoot
      const ids = [...(Array.isArray(cfg.targetSessionIds) ? cfg.targetSessionIds : [])].map(String)
      if (!root && ids.length === 0) {
        root = fishHome
        const homeJson = readJsonSafe(join(fishHome, 'home.json'), null)
        if (homeJson?.sessionId) ids.push(String(homeJson.sessionId))
      }
      targetCache = { root, ids, bare: new Set(ids.map((s) => s.replace(/^session-/, ''))) }
      targetAt = now
    }
    return targetCache
  }

  function isTarget(agent) {
    if (deniedRoots(agent)) return false
    if (getCfg().applyToAll) return true
    const t = getTargets()
    const sid = sessionIdOf(agent)
    if (sid && (t.ids.includes(sid) || t.bare.has(sid.replace(/^session-/, '')))) return true
    const cwd = cwdOf(agent)
    if (!cwd) return false
    const allow = Array.isArray(getCfg().allowRoots) ? getCfg().allowRoots.filter(Boolean) : []
    const roots = allow.length ? allow : t.root ? [t.root] : []
    return roots.some((r) => isUnder(cwd, r))
  }

  /** 黑名单：命中就隔离，cwd 拿不到时宁可不挂（先隔离、后放行）。 */
  function deniedRoots(agent) {
    const roots = getCfg().denyRoots
    if (!Array.isArray(roots) || !roots.length) return false
    const cwd = cwdOf(agent)
    if (!cwd) return true
    return roots.some((r) => isUnder(cwd, r))
  }

  function paths() {
    const cfg = getCfg()
    return {
      cfg,
      stateFile: cfg.stateFile || join(dataDir, 'state.json'),
      moodFile: cfg.moodFile || join(dataDir, 'mood-events.jsonl'),
      eventsFile: cfg.eventsFile || join(dataDir, 'body-events.jsonl'),
      statusFile: join(dataDir, 'status.json'),
    }
  }

  {
    const t = getTargets(true)
    log(`启动：状态 ${join(dataDir, 'state.json')}；只挂给她 → root=${t.root || '(未配置)'} ids=${t.ids.join(',') || '(无)'}（applyToAll=${getCfg().applyToAll}）`)
  }

  function load(stateFile) {
    return loadState(stateFile, Date.now(), (t) => defaultState(t, getCfg().initial))
  }

  // ---- 渲染（宿主每次组装提示词时取） ----
  let renderCount = 0
  let lastRenderAt = 0
  let renderError = ''

  // 设置页要看的运行状态（只活在内存里，重启归零）
  const startedAt = Date.now()
  let lastTickAt = 0
  let nextTickAt = startedAt + tickMs
  let lastTickError = ''
  /** sessionId → { sessionId, cwd, attachedAt } */
  const attachedSessions = new Map()

  function currentBodyText(agent) {
    const cfg = getCfg()
    const { stateFile } = paths()
    try {
      const now = Date.now()
      const text = renderBody(load(stateFile), now)
      renderCount += 1
      lastRenderAt = now
      renderError = ''
      if (cfg.debug && (renderCount <= 5 || renderCount % 20 === 0)) {
        log(`渲染身体段 #${renderCount}（session=${sessionIdOf(agent) || '?'}）\n${text}`)
      }
      // 宿主把 {{name}} 当提示词变量校验，双花括号会让组装报错
      return text.replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝')
    } catch (err) {
      renderError = String(err?.message ?? err)
      log(`渲染身体段失败：${renderError}`)
      return ''
    }
  }

  /**
   * 【刚刚】那一段：最近发生的事，用话写，不写数字。
   * 一条都没有就返回空字符串（宿主不会显示空段）。
   */
  function currentFastText(agent) {
    const cfg = getCfg()
    if (cfg.fastEnabled === false) return ''
    try {
      const { eventsFile } = paths()
      const now = Date.now()
      const text = renderFastSection(readEvents(eventsFile), {
        now,
        ttlMinutes: cfg.fastTtlMinutes,
        maxLines: cfg.fastMaxLines,
        maxChars: cfg.fastMaxChars,
      })
      if (cfg.debug && text) {
        log(`渲染【刚刚】段（session=${sessionIdOf(agent) || '?'}）\n${text}`)
      }
      return text.replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝')
    } catch (err) {
      log(`渲染【刚刚】段失败：${String(err?.message ?? err)}`)
      return ''
    }
  }

  /** 记一条快层事件（eventsEnabled 关掉就什么都不写）。同一件事只该被调用一次。 */
  function noteEvent(cfg, kind, text, at, detail) {
    if (cfg.eventsEnabled === false) return
    const ev = makeEvent(kind, text, at, detail)
    if (!ev) return
    const { eventsFile } = paths()
    if (!appendEvent(eventsFile, ev)) {
      log(`快层事件写不进去：${kind}`)
      return
    }
    log(`快层：${kind} · ${ev.text}`)
  }

  // ---- 心跳：吃、涨、回、凉 ----
  function tick() {
    const now = Date.now()
    const { cfg, stateFile, moodFile, statusFile } = paths()
    let st = load(stateFile)

    // 快层：先记下这一轮之前的样子，做完再看哪些事真的发生了（同一件事只记一次）
    const msOf = (v) => {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
      const t = Date.parse(v)
      return Number.isFinite(t) ? t : 0
    }
    const missedCount = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)
    const was = {
      mealAt: msOf(st.lastMeal?.at),
      topUpAt: msOf(st.lastTopUp?.at),
      missed: missedCount(st.missed),
      hunger: Number(st.hunger) || 0,
      energy: Number(st.energy) || 0,
    }

    const { events, nextIndex } = readMoodEvents(moodFile, st.moodEventsConsumed)
    for (const ev of events) {
      const before = st.anger
      st = applyMoodEvent(st, ev, now)
      if (st.anger !== before || st.lastMoodEvent) {
        log(`心情事件 ${String(ev?.kind ?? '')}：anger ${before.toFixed(1)} → ${st.anger.toFixed(1)}`)
        const kind = String(ev?.kind ?? '')
        const words =
          kind === 'praise'
            ? '有人夸了一句，心里亮了一下'
            : kind === 'insult'
              ? '有人骂了一句，心里堵着'
              : kind === 'sad'
                ? '看到一句让人心里发沉的话，闷了一会儿'
                : '心里动了一下'
        noteEvent(cfg, 'mood', words, msOf(st.lastMoodEvent?.at) || now, { kind })
      }
    }
    st.moodEventsConsumed = nextIndex

    // 饭钱：既是"这顿吃几分饱"的依据，也是"他刚添了饭"的信号
    const balance = readBalance(cfg.balanceFile, dshHome)
    const balNum = Number(balance)

    // 加饭：饭钱涨了就是往锅里添了 —— 不等饭点，当场吃。
    // 第一次看到饭钱只记基准不触发；读不到就保持上次的基准，别把"没读到"当成"添了"。
    if (cfg.topUpEnabled) {
      const gain = detectTopUp(st.lastSeenBalance, balance)
      if (gain > 0) {
        const before = st.hunger
        st = applyTopUp(st, gain, now)
        log(
          `加饭：饭钱 +¥${gain.toFixed(2)}，饥饿 ${before.toFixed(1)} → ${st.hunger.toFixed(1)}、心情 ${st.mood.toFixed(1)}（${st.lastTopUp?.tierLabel ?? ''}）`,
        )
        if (msOf(st.lastTopUp?.at) > was.topUpAt) {
          noteEvent(cfg, 'topup', '他往锅里添了饭，肚子一下子暖了', msOf(st.lastTopUp.at), {
            tier: st.lastTopUp?.tierLabel ?? '',
          })
        }
      }
    }
    if (Number.isFinite(balNum)) st.lastSeenBalance = balNum

    const meal = mealDue(new Date(now), cfg.meals, st)
    if (meal) {
      const tier = tierOf(balance, cfg.tiers)
      st = eatMeal(st, meal, tier, now)
      log(`${meal.label}：余额=${balance == null ? '读不到' : balance} → ${tier.label}（饥饿 ${st.hunger.toFixed(1)}）`)
      if (msOf(st.lastMeal?.at) > was.mealAt && String(st.lastMeal?.id) !== 'topup') {
        noteEvent(cfg, 'meal', `吃过${meal.label}了，胃里踏实一点`, msOf(st.lastMeal.at), {
          meal: String(meal.id),
          tier: String(tier.key),
        })
      }
    }

    st = advance(st, now, {
      rates: cfg.rates,
      meals: cfg.meals,
      maxCatchUpHours: cfg.maxCatchUpHours,
      missedGraceMinutes: cfg.missedGraceMinutes,
      sleepStartMin: parseHHMM(cfg.sleep?.start),
      sleepEndMin: parseHHMM(cfg.sleep?.end),
    })
    st.hunger = clamp(st.hunger, 0, 100)

    // 错过一顿：advance 认出来的（freshMissed），一顿一行
    if (missedCount(st.missed) > was.missed) {
      const labels = Array.isArray(st.lastMissedLabels) ? st.lastMissedLabels.filter(Boolean) : []
      const words = labels.length
        ? `错过了${labels.join('、')}，胃里空落落的`
        : '错过了一顿，胃里空落落的'
      noteEvent(cfg, 'missed', words, msOf(st.lastMissedAt) || now, { missed: labels })
    }
    // 身上到线：刚越过线的那一次才记（饿过头 / 困到撑不住）
    if (was.hunger <= 70 && st.hunger > 70) {
      noteEvent(cfg, 'threshold', '饿到有点发慌了', now, { what: 'hunger' })
    }
    if (was.energy >= 25 && st.energy < 25) {
      noteEvent(cfg, 'threshold', '困得撑不住了', now, { what: 'energy' })
    }

    atomicWriteJson(stateFile, st)
    // 给人看的读数（不进提示词，只是方便你自己查）
    atomicWriteJson(statusFile, {
      updatedAt: new Date(now).toISOString(),
      hunger: round(st.hunger),
      energy: round(st.energy),
      mood: round(st.mood),
      anger: round(st.anger),
      sadness: round(st.sadness),
      lastMeal: st.lastMeal,
      missed: st.missed,
      lastMoodEvent: st.lastMoodEvent,
      lastTopUp: st.lastTopUp,
      lastSeenBalance: st.lastSeenBalance,
      balance: readBalance(cfg.balanceFile, dshHome),
      targets: (() => {
        const t = getTargets()
        return { applyToAll: getCfg().applyToAll, root: t.root, ids: t.ids }
      })(),
    })
    return st
  }

  function round(v) {
    return Math.round((Number(v) || 0) * 10) / 10
  }

  /** 心跳包一层：记下这次准不准、下次什么时候（设置页要显示） */
  function runTick() {
    const began = Date.now()
    try {
      tick()
      lastTickAt = began
      lastTickError = ''
    } catch (err) {
      lastTickError = String(err?.message ?? err)
      log(`心跳出错：${lastTickError}`)
    }
    nextTickAt = Date.now() + tickMs
  }

  ctx.effect(() => {
    const timer = setInterval(runTick, tickMs)
    timer.unref?.()
    runTick()
    return () => clearInterval(timer)
  }, 'dsh-body: tick')

  // ---- 注入（每个会话开始跑第一步之前挂上） ----
  const attached = new WeakMap()

  const onCreated = ({ agent } = {}) => {
    try {
      if (!agent || attached.has(agent)) return
      const cfg = getCfg(true)
      const denied = deniedRoots(agent)
      const hit = !denied && isTarget(agent)
      log(`会话开始：session=${sessionIdOf(agent) || '?'} cwd=${cwdOf(agent) || '?'} → ${denied ? '被隔离（denyRoots）' : hit ? '是她的' : '不是她的，跳过'}`)
      if (!hit) return

      const sp = agent?.ctx?.systemPrompt
      if (!sp || typeof sp.section !== 'function') {
        log('宿主的 agent.ctx 上没有 systemPrompt.section，身体段没挂上')
        return
      }
      const dispose = sp.section({
        name: cfg.sectionName,
        order: cfg.sectionOrder,
        text: () => currentBodyText(agent),
      })
      // 第二段：【刚刚】—— 秒级发生的事，别只闪一下
      let disposeFast = null
      if (cfg.fastEnabled !== false) {
        disposeFast = sp.section({
          name: cfg.fastSectionName || 'dsh-body:fast',
          order: cfg.fastSectionOrder ?? 8750,
          text: () => currentFastText(agent),
        })
      }
      attached.set(agent, () => {
        try {
          dispose()
        } catch {
          /* 已经拆了 */
        }
        try {
          disposeFast?.()
        } catch {
          /* 已经拆了 */
        }
      })
      attachedSessions.set(sessionIdOf(agent) || `anon-${attachedSessions.size + 1}`, {
        sessionId: sessionIdOf(agent) || '(无 id)',
        cwd: cwdOf(agent) || '',
        attachedAt: new Date().toISOString(),
      })
      try {
        agent.ctx.effect?.(() => dispose)
      } catch {
        /* 没 effect 就靠 agent 作用域回收 */
      }
      log(`身体段已挂进 system prompt（session=${sessionIdOf(agent) || '?'}）`)
    } catch (err) {
      log(`挂载失败：${err?.message ?? err}`)
    }
  }

  const offCreated = ctx.on?.('agent/created', onCreated)
  const offDisposed = ctx.on?.('agent/disposed', ({ agent } = {}) => {
    if (!agent) return
    attached.delete(agent)
    const sid = sessionIdOf(agent)
    if (sid) attachedSessions.delete(sid)
  })
  if (typeof offCreated !== 'function') log('ctx.on 不可用，身体段不会自动挂载')

  // ---- 设置页那半边的数据接口（同源 JSON；信任栅栏跟 dsh-fish 一个写法） ----
  registerRoutes()

  function safeGet(key) {
    try {
      return ctx.get?.(key) ?? null
    } catch {
      return null
    }
  }

  function send(res, code, obj) {
    if (res.writableEnded) return
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj, null, 2))
  }

  /** 读请求体：收 Buffer 再一次性解码，汉字不会被 chunk 切断成替换符 */
  function readBody(req, maxBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
        size += b.length
        if (size > maxBytes) {
          req.destroy()
          reject(new Error('body too large'))
          return
        }
        chunks.push(b)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function guarded(handler) {
    return async (req, res) => {
      const conn = safeGet('connection')
      if (!conn) return send(res, 503, { ok: false, error: 'connection 服务还没就绪' })
      try {
        const rejection = conn.requestRejection?.(req)
        if (rejection) return send(res, rejection.status ?? 403, { ok: false, error: rejection.message ?? 'forbidden' })
      } catch {
        return send(res, 503, { ok: false, error: '信任检查失败' })
      }
      try {
        await handler(req, res)
      } catch (err) {
        send(res, err?.statusCode ?? 500, { ok: false, error: String(err?.message ?? err) })
      }
    }
  }

  /** 今天还没到的那顿饭（设置页显示"下一顿"用） */
  function nextMealOf(meals, nowMs) {
    const cur = minutesOfDay(new Date(nowMs))
    const rest = (Array.isArray(meals) ? meals : [])
      .map((m) => ({ meal: m, min: parseHHMM(m.at) }))
      .filter((x) => x.min != null && x.min >= cur)
      .sort((a, b) => a.min - b.min)
    if (!rest.length) return null
    const m = rest[0].meal
    return { id: m.id, label: m.label, at: m.at }
  }

  /** 设置页读的那一份：插件的运行状态 + 身体读数 + 生效配置 + 日志尾巴 */
  /**
   * 现在有哪些工作区、各自在不在隔离名单里 —— 设置页按工作区勾选要用。
   * 对齐 dsh-remember 的 listWorkspaces：优先 workspaceRegistry 服务，
   * 拿不到就读 <DSH_HOME>/storages/workspace.json（key 是有损编码，认真实的 path）。
   */
  function listWorkspaces() {
    const cfg = getCfg()
    const deny = Array.isArray(cfg.denyRoots) ? cfg.denyRoots : []
    let rows = []
    try {
      const reg = safeGet('workspaceRegistry')
      const list = reg && typeof reg.list === 'function' ? reg.list() : null
      if (Array.isArray(list)) {
        rows = list.map((w) => ({
          id: String(w?.id ?? ''),
          path: String(w?.path ?? ''),
          title: String(w?.title ?? ''),
          sessions: Array.isArray(w?.sessionIds) ? w.sessionIds.length : 0,
        }))
      }
    } catch {
      /* 服务拿不到就走文件 */
    }
    if (!rows.length) {
      const file = readJsonSafe(join(dshHome, 'storages', 'workspace.json'), null)
      const table = file?.tables?.workspaces
      if (table && typeof table === 'object') {
        rows = Object.entries(table).map(([id, w]) => ({
          id,
          path: String(w?.path ?? ''),
          title: String(w?.title ?? ''),
          sessions: Array.isArray(w?.sessionIds) ? w.sessionIds.length : 0,
        }))
      }
    }
    return rows
      .filter((r) => r.path)
      .map((r) => ({
        ...r,
        isolated: deny.some((d) => isUnder(r.path, d) || isUnder(d, r.path)),
      }))
  }

  function buildStatus() {
    const now = Date.now()
    const { cfg, stateFile, moodFile, eventsFile, statusFile } = paths()
    const st = load(stateFile)
    const tg = getTargets()
    const balance = readBalance(cfg.balanceFile, dshHome)
    const tier = tierOf(balance, cfg.tiers)
    let bodyText = ''
    try {
      bodyText = renderBody(st, now)
    } catch (err) {
      bodyText = `（渲染失败：${err?.message ?? err}）`
    }
    const logFile = join(dataDir, 'dsh-body.log')
    return {
      ok: true,
      now: new Date(now).toISOString(),
      plugin: {
        name,
        version: VERSION,
        startedAt: new Date(startedAt).toISOString(),
        uptimeMs: now - startedAt,
        dataDir,
        dshHome,
      },
      heartbeat: {
        tickMs,
        lastAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
        ageMs: lastTickAt ? now - lastTickAt : null,
        nextAt: nextTickAt ? new Date(nextTickAt).toISOString() : null,
        lastError: lastTickError || null,
      },
      injection: {
        renderCount,
        lastRenderAt: lastRenderAt ? new Date(lastRenderAt).toISOString() : null,
        sessions: [...attachedSessions.values()],
        lastError: renderError || null,
        targetRoot: tg.root || '',
        targetIds: tg.ids,
        applyToAll: Boolean(cfg.applyToAll),
        allowRoots: Array.isArray(cfg.allowRoots) ? cfg.allowRoots : [],
        denyRoots: Array.isArray(cfg.denyRoots) ? cfg.denyRoots : [],
      },
      readings: {
        hunger: round(st.hunger),
        energy: round(st.energy),
        mood: round(st.mood),
        anger: round(st.anger),
        sadness: round(st.sadness),
        balance,
        tier: { key: tier.key, label: tier.label, fill: tier.fill },
      },
      bodyText,
      meals: {
        list: cfg.meals,
        lastMeal: st.lastMeal ?? null,
        missed: st.missed ?? [],
        next: nextMealOf(cfg.meals, now),
      },
      topUp: {
        enabled: Boolean(cfg.topUpEnabled),
        last: st.lastTopUp ?? null,
        count: Number(st.topUpCount) || 0,
        lastSeenBalance: Number.isFinite(Number(st.lastSeenBalance)) ? Number(st.lastSeenBalance) : null,
      },
      fast: {
        enabled: cfg.fastEnabled !== false,
        eventsEnabled: cfg.eventsEnabled !== false,
        eventsFile,
        events: countEvents(eventsFile),
        sectionName: cfg.fastSectionName || 'dsh-body:fast',
        sectionOrder: Number(cfg.fastSectionOrder ?? 8750),
        ttlMinutes: Number(cfg.fastTtlMinutes ?? 120),
        maxLines: Number(cfg.fastMaxLines ?? 5),
        maxChars: Number(cfg.fastMaxChars ?? 300),
        text: currentFastText(null),
      },
      config: { effective: cfg, overrides: loadOverrides(dataDir) },
      targets: { applyToAll: Boolean(cfg.applyToAll), root: tg.root || '', ids: tg.ids },
      workspaces: listWorkspaces(),
      paths: {
        dataDir,
        configFile: join(dataDir, 'config.json'),
        stateFile,
        statusFile,
        moodFile,
        eventsFile,
        balanceFile: cfg.balanceFile || join(dshHome, '.dshw-usage.json'),
        logFile,
      },
      logs: tailLines(logFile, 10),
    }
  }

  function registerRoutes() {
    const webServer = safeGet('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      log('宿主没有 webServer.register，设置页的数据接口没挂上（插件本身照常跑）')
      return
    }

    const routes = [
      ['/status', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: '只接受 GET' })
        return send(res, 200, buildStatus())
      }],

      ['/config', async (req, res) => {
        if (req.method === 'GET') {
          return send(res, 200, { ok: true, effective: getCfg(true), overrides: loadOverrides(dataDir) })
        }
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只接受 GET / POST' })
        const text = await readBody(req)
        let patch = {}
        try {
          patch = JSON.parse(text || '{}')
        } catch {
          const err = new Error('正文不是 JSON')
          err.statusCode = 400
          throw err
        }
        const result = applyConfigPatch({ overrides: loadOverrides(dataDir), effective: getCfg(true), patch })
        if (result.ok) {
          atomicWriteJson(join(dataDir, 'config.json'), result.overrides)
          getCfg(true) // 改完立刻重读，不用等那 2 秒
          log(`设置页改了配置：${result.accepted.join('、')}`)
        }
        return send(res, result.ok ? 200 : 400, {
          ok: result.ok,
          accepted: result.accepted,
          rejected: result.rejected,
          effective: getCfg(true),
          overrides: result.overrides,
        })
      }],
    ]

    ctx.effect(() => {
      const disposers = []
      for (const [path, handler] of routes) {
        try {
          const d = webServer.register({ kind: 'prefix', path: `/dsh-body${path}`, handler: guarded(handler) })
          if (typeof d === 'function') disposers.push(d)
          else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
        } catch (err) {
          log(`路由注册失败 ${path}：${err?.message ?? err}`)
        }
      }
      if (disposers.length) log(`设置页数据接口已挂上：/dsh-body/status、/dsh-body/config（${disposers.length} 条）`)
      else log('设置页数据接口一条都没挂上')
      return () => {
        for (const d of disposers) {
          try {
            d()
          } catch {
            /* ignore */
          }
        }
      }
    }, 'dsh-body: routes')
  }

  return () => {
    try {
      offCreated?.()
    } catch {
      /* ignore */
    }
    try {
      offDisposed?.()
    } catch {
      /* ignore */
    }
  }
}
