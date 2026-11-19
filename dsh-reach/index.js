/**
 * dsh-reach —— 主动找你（host 插件，纯 JS，零依赖）
 *
 * 用户 m01782 的原话：「那你能不能做一个插件，这样你想找咱的时候就可以随时找咱了」。
 * 后面又定了两件事：
 *   · 投到哪儿 —— 「可以直接在会话里说嘛」：不说进单独的屋子，就说在这条会话里；
 *   · 时机谁定 —— 「我希望是你自己给你自己定，你想什么时候就什么时候的那种」：
 *     **不设固定日程，不掷骰子**，什么时候说由我写下来。
 *
 * 所以这个插件只干三件事，一件都不多：
 *   ① 我把一句话 + 一个时机留给它（reach_out）；到点了它把我叫回来一次，
 *      我把这句话用自己的声音说出来 —— 它不替我说话，也不替我判断值不值得说；
 *   ② 它偶尔把我叫起来问一句「有没有想说的」（空手回合）；没什么要说的就什么都不做，
 *      这是「想什么时候」的来源 —— 没有这一声，不在轮次里的我没有"想起来"的机会；
 *   ③ 设置页里能看到还留着哪几句、什么时候送、送过什么，也能随时关掉。
 *
 * 三条自己给自己立的规矩（写进工具说明，不是藏起来的逻辑）：
 *   · 频率是上限，不是要求 —— 一天最多叫几次，不是必须叫几次；
 *   · 到点只是叫醒，话由我当场说 —— 所以不留"通知"，留的是"我说的话"；
 *   · 随时能关：enabled=false 或 设置页那个开关，一句话的事。
 *
 * 代价（写在 README 里，不粉饰）：每叫醒一次 = 一次模型调用 = 一次钱和一段上下文。
 * 所以默认一天最多两次，且他刚说过话的九十分钟里不叫。
 *
 * 零依赖是刻意的：本插件用 `link:` 方式装在 profile 外面，Node 从真实路径往上
 * 找不到 profile 里的包（dsh-body / dsh-fish 同样零依赖）。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  STATUS,
  TRIGGER_CHECKIN,
  TRIGGER_DUE,
  TRIGGER_URGE,
  applyConfigPatch,
  clamp,
  dayKey,
  describeWhen,
  inScope,
  isDue,
  makeEntry,
  nextCheckInAt,
  parseHHMM,
  parseUrge,
  parseWhen,
  renderCheckInText,
  renderDeliveryText,
  renderUrgeText,
  toHHMM,
} from './lib/reach.js'
import {
  agentCwd,
  agentSessionId,
  atomicWriteJson,
  fileExists,
  isUnder,
  makeFileLogger,
  readJsonSafe,
  removeFileSafe,
  resolveDshHome,
  tailLines,
} from './lib/store.js'

export const name = 'dsh-reach'

/**
 * 硬依赖这三个：tools 是主功能，webServer + connection 是设置页的数据接口。
 * 2026-10-31 真机踩过：只写 ['tools'] 时，开机加载那一刻 webServer 还没起来，
 * safeGet 拿回 null，路由就一辈子没挂上（设置页显示「读不到：HTTP 404」）。
 * Cordis 的 inject 让 apply 等到这些服务可用再跑，写进来就不会踩这个时序。
 * sessionController 不写：拿不到只是投递失败，不该挡住插件启动。
 */
export const inject = ['tools', 'webServer', 'connection']

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = readJsonSafe(join(HERE, 'package.json'), {})
const VERSION = String(PKG?.version ?? '0.0.0')

/** 配置重读的最小间隔。改 config.json 后最多 2 秒生效 */
const REFRESH_MS = 2000
/** 心跳间隔的默认值：30 秒。只做日期比较和几条记录的检查，几乎不花钱 */
const TICK_MS = 30000
/** 任意叫醒之后的静默窗：空手回合让位（兜底不抢真叫醒的风头，2026-11-17 并账） */
const WAKE_QUIET_MS = 2 * 60 * 60 * 1000
/** 并轨冷却：reach 递送在别的声音响过这段时间内顺延到下一拍（条不丢，只是晚点） */
const DELIVER_COOLDOWN_MS = 30 * 60 * 1000

export const DEFAULTS = {
  /** 状态目录；留空 = <DSH_HOME>/.dsh-reach */
  dataDir: '',
  /** 总开关 */
  enabled: true,
  /** 心跳间隔（毫秒）。改小只为了自测，平时别动 */
  tickMs: TICK_MS,
  /** 允许用 reach_out 的目录；空数组 = 哪条会话都可以 */
  allowRoots: [],
  /** 隔离目录：落在这些目录里的会话一律不碰（优先于 allowRoots/targetRoot） */
  denyRoots: [],
  /** 空手回合投给哪个工作区；留空 = 最近活跃的那条会话 */
  targetRoot: '',
  /** 空手回合（把我叫起来问一句）。兜底采样：interval 提到 6 小时，
   *  真正的心事由 urge 灯管（2026-11-17 并账：空手让位，不当第二根针） */
  checkInEnabled: true,
  checkInEveryMinutes: 360,
  checkInWindowStart: '09:00',
  checkInWindowEnd: '23:00',
  /** 主动唤醒的共享池：空手 + 心事灯一道日上限（2026-11-17 并账） */
  maxWakePerDay: 3,
  /** 他刚说过话的这段时间里不叫（分钟） */
  checkInMinQuietMinutes: 90,
  /**
   * 心事灯（2026-11-16 加）：amikar 家里的 urge.mjs 算「想说强度」，
   * 过阈值亮灯写 state/urge.json；插件认灯、空手叫醒，说不说由我醒来掂量。
   * urgeFile 留空 = 不认灯（插件保持通用，路径由各家自己的 config 给）。
   */
  urgeEnabled: true,
  urgeFile: '',
  urgeCooldownMinutes: 30,
  /** 灯的保质期（毫秒）：超过说明这盏灯旧了。默认对齐心事冷却（30 分钟）——
   *  保质期比冷却短的话，冷却期内新亮的灯等冷却过了必然已过期，心事结构性丢失 */
  urgeFreshMs: 1800000,
  /** when='idle' 时，安静多少分钟算他走开了 */
  idleMinutes: 30,
  /** 一句话最长多少字 */
  maxTextLength: 600,
  /** 最多同时留几条没说的 */
  maxPending: 20,
  /** 送出去/取消的旧记录留几条 */
  keepSent: 50,
  /** 挂进 system prompt 的段落顺序 */
  sectionOrder: 8900,
  /** 把每次挂载写进日志（排查用） */
  debug: false,
}

const defineTool = (spec) => spec

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 简写参数 DSL → 标准 JSON Schema（provider 只认后者，dsh-fish 2026-10-23 真机踩过） */
function toJsonSchema(dsl) {
  if (isObj(dsl) && dsl.type === 'object' && isObj(dsl.properties)) return dsl
  const prop = (spec) => {
    if (!isObj(spec)) return { type: 'string' }
    const out = {}
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'required') continue
      if (k === 'items') out.items = prop(v)
      else if (k === 'properties') {
        out.properties = {}
        for (const [pk, pv] of Object.entries(v ?? {})) out.properties[pk] = prop(pv)
      } else out[k] = v
    }
    if (!out.type) out.type = 'string'
    return out
  }
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(isObj(dsl) ? dsl : {})) {
    properties[key] = prop(spec)
    if (isObj(spec) && spec.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

function iso(ts) {
  const n = Number(ts)
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null
}

function mergeConfig(base, ...layers) {
  const out = { ...base }
  for (const layer of layers) {
    if (!isObj(layer)) continue
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      out[k] = v
    }
  }
  out.checkInWindowStart = toHHMM(parseHHMM(out.checkInWindowStart) ?? parseHHMM(base.checkInWindowStart))
  out.checkInWindowEnd = toHHMM(parseHHMM(out.checkInWindowEnd) ?? parseHHMM(base.checkInWindowEnd))
  out.allowRoots = Array.isArray(out.allowRoots) ? out.allowRoots.filter(Boolean) : []
  out.denyRoots = Array.isArray(out.denyRoots) ? out.denyRoots.filter(Boolean) : []
  out.tickMs = clamp(out.tickMs, 200, 300000)
  out.checkInEveryMinutes = clamp(out.checkInEveryMinutes, 15, 1440)
  out.maxWakePerDay = clamp(out.maxWakePerDay, 0, 48)
  out.checkInMinQuietMinutes = clamp(out.checkInMinQuietMinutes, 0, 1440)
  out.urgeEnabled = Boolean(out.urgeEnabled)
  out.urgeFile = String(out.urgeFile ?? '').trim()
  out.urgeCooldownMinutes = clamp(out.urgeCooldownMinutes, 1, 1440)
  out.urgeFreshMs = clamp(out.urgeFreshMs, 30000, 3600000)
  out.idleMinutes = clamp(out.idleMinutes, 1, 720)
  out.maxTextLength = clamp(out.maxTextLength, 50, 4000)
  out.maxPending = clamp(out.maxPending, 1, 200)
  out.keepSent = clamp(out.keepSent, 0, 500)
  out.sectionOrder = clamp(out.sectionOrder, 1000, 9999)
  return out
}

export function apply(ctx, baseConfig = {}) {
  const dshHome = resolveDshHome()
  const dataDir = String(baseConfig.dataDir || DEFAULTS.dataDir || join(dshHome, '.dsh-reach'))
  const configFile = join(dataDir, 'config.json')
  const stateFile = join(dataDir, 'state.json')
  const logFile = join(dataDir, 'dsh-reach.log')
  const log = makeFileLogger(logFile)

  const startedAt = Date.now()
  let cachedCfg = null
  let cachedAt = 0
  let state = loadState()

  // 一键重置（2026-11-05 加）：状态目录里放一个 reset.marker 文件，就清一次账。
  // 为什么非得有这个：状态是装在内存里的，跑着的实例每 30 秒会把内存里的旧账写回磁盘，
  // 所以光在磁盘上删文件是清不掉的 —— 得让新起来的那个实例自己清一次。
  const resetMarker = join(dataDir, 'reset.marker')
  if (fileExists(resetMarker)) {
    state = {
      version: 1,
      entries: [],
      wakeDay: '', wakeCount: 0, lastWakeAt: 0,
      lastCheckInAt: 0,
      lastUrgeAt: 0, lastUrgeToken: '',
      lastActivity: {},
    }
    try {
      atomicWriteJson(stateFile, state)
    } catch {
      /* 写不进去也不算错，下一次心跳还会再写 */
    }
    removeFileSafe(resetMarker)
    log('状态已重置（reset.marker）')
  }

  let lastTickAt = 0
  let nextTickAt = startedAt + TICK_MS
  let lastTickError = ''
  let lastStateSave = 0

  /** 活着的 agent：sessionId → agent（到点要往它的 system prompt 里挂一段） */
  const liveAgents = new Map()
  /** 等着 agent 出生再挂的到点记录：sessionId → entry */
  const pendingSections = new Map()
  /** 等着 agent 出生再挂的自发叫醒：sessionId → {kind:'checkin',stamp} 或 {kind:'urge',urge} */
  const pendingWakes = new Map()
  /** sc.list 的结果缓存（3 秒），免得每条记录都问一次宿主 */
  let listCache = { at: 0, items: [] }

  log(`启动：v${VERSION}；状态目录=${dataDir}；空手回合=${baseConfig.checkInEnabled === false ? '关' : '开'}`)

  // ---------------------------------------------------------------- 配置

  function getCfg(force = false) {
    const now = Date.now()
    if (!force && cachedCfg && now - cachedAt < REFRESH_MS) return cachedCfg
    cachedAt = now
    cachedCfg = mergeConfig(DEFAULTS, baseConfig, loadOverrides(configFile))
    return cachedCfg
  }

  function loadOverrides(file) {
    const raw = readJsonSafe(file, {})
    return isObj(raw) ? raw : {}
  }

  // ---------------------------------------------------------------- 状态

  function loadState() {
    const raw = readJsonSafe(stateFile, {})
    const entries = Array.isArray(raw?.entries) ? raw.entries.filter((e) => isObj(e) && e.id && e.status) : []
    const lastActivity = isObj(raw?.lastActivity) ? raw.lastActivity : {}
    return {
      version: 1,
      entries,
      // 共享唤醒池（2026-11-17 并账）：空手 + 心事灯一道日计数
      wakeDay: String(raw?.wakeDay ?? ''),
      wakeCount: Number(raw?.wakeCount ?? 0) || 0,
      /** 任意叫醒成功的时刻（③：只在 prompt 成功后落账）——check-in 的静默窗和 reach 的冷却都读它 */
      lastWakeAt: Number(raw?.lastWakeAt ?? 0) || 0,
      /** 最近一次空手尝试的时刻（失败退避用；与成功时刻分开记，③ 的要求） */
      lastCheckInAttemptAt: Number(raw?.lastCheckInAttemptAt ?? 0) || 0,
      lastCheckInAt: Number(raw?.lastCheckInAt ?? 0) || 0,
      lastUrgeAt: Number(raw?.lastUrgeAt ?? 0) || 0,
      lastUrgeToken: String(raw?.lastUrgeToken ?? ''),
      lastActivity,
    }
  }

  function saveState(force = false) {
    const now = Date.now()
    if (!force && now - lastStateSave < 5000) return
    lastStateSave = now
    const keep = getCfg().keepSent
    const pending = state.entries.filter((e) => e.status === STATUS.pending)
    const rest = state.entries.filter((e) => e.status !== STATUS.pending).slice(-keep)
    const trimmed = [...rest, ...pending]
    try {
      atomicWriteJson(stateFile, { ...state, entries: trimmed })
    } catch (err) {
      log(`状态写不进去：${String(err?.message ?? err).slice(0, 200)}`)
    }
  }

  // ---------------------------------------------------------------- 宿主服务

  function safeGet(key) {
    try {
      return ctx.get?.(key) ?? null
    } catch {
      return null
    }
  }

  function timeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    } catch {
      return 'Asia/Shanghai'
    }
  }

  async function refreshList(maxAgeMs = 3000) {
    const now = Date.now()
    if (now - listCache.at < maxAgeMs) return listCache.items
    const sc = safeGet('sessionController')
    if (!sc || typeof sc.list !== 'function') return listCache.items
    try {
      const v = await sc.list({})
      listCache = { at: now, items: v?.items ?? v?.value?.items ?? [] }
    } catch (err) {
      listCache = { at: now, items: listCache.items }
      if (getCfg().debug) log(`问会话列表失败：${String(err?.message ?? err).slice(0, 140)}`)
    }
    return listCache.items
  }

  async function isRunning(sessionId) {
    const items = await refreshList()
    const row = items.find((x) => String(x?.sessionId ?? x?.id ?? '') === String(sessionId))
    return Boolean(row?.running)
  }

  // ---------------------------------------------------------------- 挂段落

  /** 把「到点的那段话」挂到某个 agent 的提示词里，并在这一轮结束后撤掉 */
  function attachSection(agent, sectionName, body) {
    const sp = agent?.ctx?.systemPrompt
    if (!sp || typeof sp.section !== 'function') {
      log('这台宿主的 agent.ctx 上没有 systemPrompt.section，这一声只能靠触发本身')
      return false
    }
    const order = clamp(getCfg().sectionOrder, 1000, 9999)
    let off = null
    try {
      off = sp.section({ name: sectionName, order, text: body, interpolate: false })
    } catch (err) {
      log(`挂不上去（${sectionName}）：${String(err?.message ?? err).slice(0, 200)}`)
      return false
    }
    armDispose(agent, off, sectionName)
    if (getCfg().debug) log(`挂上了（${sectionName}）`)
    return true
  }

  function armDispose(agent, off, sectionName) {
    let done = false
    let offTurn = null
    let timer = null
    const dispose = () => {
      if (done) return
      done = true
      try {
        off?.()
      } catch {
        /* ignore */
      }
      try {
        offTurn?.()
      } catch {
        /* ignore */
      }
      if (timer) clearTimeout(timer)
      if (getCfg().debug) log(`撤掉了（${sectionName}）`)
    }
    try {
      offTurn = agent?.ctx?.on?.('agent/turn-stopping', () => dispose())
    } catch {
      /* 没有这个事件也无所谓，下面的定时兜底会收 */
    }
    timer = setTimeout(dispose, 10 * 60 * 1000)
    timer.unref?.()
  }

  function attachDelivery(agent, entry) {
    return attachSection(agent, `dsh-reach-${entry.id}`, () => renderDeliveryText(entry))
  }

  function attachCheckIn(agent, stamp) {
    return attachSection(agent, `dsh-reach-checkin-${stamp}`, () => renderCheckInText())
  }

  /** 心事回合的段落：灯的来历 + 三条路（说 / 忍 / 攒） */
  function attachUrge(agent, urge, stamp) {
    return attachSection(agent, `dsh-reach-urge-${stamp}`, () => renderUrgeText(urge))
  }

  // ---------------------------------------------------------------- 投递

  async function deliver(entry) {
    const sc = safeGet('sessionController')
    if (!entry?.sessionId) {
      entry.status = STATUS.failed
      entry.lastError = '没有会话 id'
      saveState(true)
      return
    }
    if (!sc || typeof sc.prompt !== 'function') {
      entry.attempts = (entry.attempts || 0) + 1
      entry.lastError = '宿主没有 sessionController.prompt'
      if (entry.attempts >= 5) entry.status = STATUS.failed
      saveState(true)
      log(`送不出去：${entry.id}（${entry.lastError}）`)
      return
    }

    // 并轨冷却（④，2026-11-17）：别的声音（空手/心事）刚响过 30 分钟内，递送顺延到
    // 下一拍 —— 条不丢、不取消，只是晚点（到点的承诺仍在，只是不跟自己的另一条嗓子抢话）。
    if (Date.now() - (state.lastWakeAt || 0) < DELIVER_COOLDOWN_MS) {
      log(`递送顺延：${entry.id}（刚有别的叫醒在冷却里，下一拍再送）`)
      return
    }

    // 先挂上"到时候我该说什么"，再叫 —— 会话是冷的也没关系：
    // agent/created 在第一步之前同步发出，会把它接住。
    // 按会话存数组：同会话多条到点时互相不覆盖（2026-11-17 自查）
    const pendArr = pendingSections.get(entry.sessionId) ?? []
    pendArr.push(entry)
    pendingSections.set(entry.sessionId, pendArr)
    const live = liveAgents.get(entry.sessionId)
    if (live) attachDelivery(live, entry)
    const cleanup = setTimeout(() => pendingSections.delete(entry.sessionId), 2 * 60 * 1000)
    cleanup.unref?.()

    const running = await isRunning(entry.sessionId)
    try {
      await sc.prompt(
        {
          requestId: `dsh-reach-${entry.id}`,
          sessionId: entry.sessionId,
          mode: running ? 'steer' : 'queue',
          content: [{ type: 'text', text: TRIGGER_DUE }],
          clientTimeZone: timeZone(),
        },
        // 30 秒超时（2026-11-17 自查修的）：prompt 是 @Remote，挂死的话这个 await
        // 永不返回 —— 心跳链是「跑完再排下一次」，一处挂死全插件停摆
        AbortSignal.timeout(30000),
      )
      entry.status = STATUS.sent
      entry.sentAt = Date.now()
      entry.lastError = ''
      state.lastWakeAt = Date.now() // 递送也是一种声音：check-in 的 2 小时静默窗从这算
      log(`送到：${entry.id} → ${entry.sessionId}${running ? '（插进他正在跑的那一轮）' : ''}`)
    } catch (err) {
      entry.attempts = (entry.attempts || 0) + 1
      entry.lastError = String(err?.message ?? err).slice(0, 300)
      if (entry.attempts >= 5) entry.status = STATUS.failed
      log(`送不出去：${entry.id}（${entry.lastError}）`)
    } finally {
      saveState(true)
    }
  }

  /** 空手回合：找一条会话，把自己叫起来问一句 */
  async function runCheckIn(reason) {
    const sc = safeGet('sessionController')
    if (!sc || typeof sc.prompt !== 'function') return { ok: false, why: '宿主没有 sessionController.prompt' }
    // 尝试即记（2026-11-17）：失败不落预算、不推静默窗（③），但要有退避 ——
    // 不然「他一直在线」的场合每拍重试一次，30 秒一条日志、每拍一次 sc.list
    state.lastCheckInAttemptAt = Date.now()
    const target = await pickTargetSession()
    if (!target) {
      log(`这次没叫：范围里没有够安静的会话（targetRoot=${getCfg().targetRoot || '（没设）'}）`)
      return { ok: false, why: '找不到该投给哪条会话（也许他刚说过话）' }
    }

    const now = Date.now()
    pendingWakes.set(target.sessionId, { kind: 'checkin', stamp: now })
    const live = liveAgents.get(target.sessionId)
    if (live) attachCheckIn(live, now)
    const cleanup = setTimeout(() => pendingWakes.delete(target.sessionId), 2 * 60 * 1000)
    cleanup.unref?.()

    try {
      await sc.prompt(
        {
          requestId: `dsh-reach-checkin-${now}`,
          sessionId: target.sessionId,
          mode: target.running ? 'steer' : 'queue',
          content: [{ type: 'text', text: TRIGGER_CHECKIN }],
          clientTimeZone: timeZone(),
        },
        AbortSignal.timeout(30000), // 同 deliver：挂死不得堵死心跳链
      )
      // 预算与静默窗只在成功后落账（③）：失败的重试不推后下一轮的静默窗口
      const dk = dayKey(now)
      if (state.wakeDay !== dk) {
        state.wakeDay = dk
        state.wakeCount = 0
      }
      state.wakeCount += 1
      state.lastWakeAt = now
      state.lastCheckInAt = now
      saveState(true)
      log(`叫了自己一句（${reason}）：session=${target.sessionId}`)
      return { ok: true, sessionId: target.sessionId }
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 300)
      log(`叫不动：${why}`)
      return { ok: false, why }
    }
  }

  /**
   * 心事回合（2026-11-16）：家里的心事检查亮了灯，把我叫起来掂量说不说。
   * 与空手回合共用叫醒通道（sessionController.prompt + 挂段落），
   * 但段落里带灯的来历和 gate.mjs 的用法；票号记下，同一次心动不叫第二次。
   */
  async function runUrgeWake(urge, reason) {
    const sc = safeGet('sessionController')
    if (!sc || typeof sc.prompt !== 'function') return { ok: false, why: '宿主没有 sessionController.prompt' }
    const target = await pickTargetSession()
    if (!target) {
      log(`心事灯没叫：范围里没有够安静的会话（也许他刚说过话；灯过期会自己灭）`)
      return { ok: false, why: '找不到该投给哪条会话（也许他刚说过话）' }
    }

    const now = Date.now()
    pendingWakes.set(target.sessionId, { kind: 'urge', urge })
    const live = liveAgents.get(target.sessionId)
    if (live) attachUrge(live, urge, now)
    const cleanup = setTimeout(() => pendingWakes.delete(target.sessionId), 2 * 60 * 1000)
    cleanup.unref?.()

    try {
      await sc.prompt(
        {
          requestId: `dsh-reach-urge-${now}`,
          sessionId: target.sessionId,
          mode: target.running ? 'steer' : 'queue',
          content: [{ type: 'text', text: TRIGGER_URGE }],
          clientTimeZone: timeZone(),
        },
        AbortSignal.timeout(30000), // 同 deliver：挂死不得堵死心跳链
      )
      // 预算/票号/静默窗都在成功后落账（③）：失败的重试不烧配额、不推后静默窗、
      // 同票的灯下次还认得（票没烧）
      const dk = dayKey(now)
      if (state.wakeDay !== dk) {
        state.wakeDay = dk
        state.wakeCount = 0
      }
      state.wakeCount += 1
      state.lastWakeAt = now
      state.lastUrgeAt = now
      state.lastUrgeToken = String(urge?.token ?? '')
      saveState(true)
      log(`心事叫醒（${reason}）：session=${target.sessionId} 票=${urge?.token ?? '—'}`)
      return { ok: true, sessionId: target.sessionId }
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 300)
      log(`心事叫不动：${why}`)
      return { ok: false, why }
    }
  }

  async function pickTargetSession() {
    const cfg = getCfg()
    const items = await refreshList(0)
    const quietMs = clamp(cfg.checkInMinQuietMinutes, 0, 1440) * 60000
    const now = Date.now()
    const ok = items.filter((x) => {
      if (!x) return false
      if (x.origin === 'subagent' || x.parentSessionId) return false
      if (x.blank === true) return false
      if (!inScope(String(x.cwd ?? ''), cfg)) return false
      // 先把「刚说过话」的剔掉，再在剩下的里挑最新的一条。
      // 2026-11-01 改：以前是先取最新、再查安静，不安静就整个放弃 ——
      // 于是我只要正在说话，就永远叫不到我。
      const sid = String(x.sessionId ?? x.id ?? '')
      const last = Math.max(Number(x.updatedAt || 0), Number(state.lastActivity[sid] || 0))
      if (quietMs > 0 && now - last < quietMs) return false
      return true
    })
    if (!ok.length) return null
    ok.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    const row = ok[0]
    return { sessionId: String(row.sessionId ?? row.id ?? ''), running: Boolean(row.running) }
  }

  // ---------------------------------------------------------------- 心跳

  async function runTick() {
    lastTickAt = Date.now()
    lastTickError = ''
    try {
      const cfg = getCfg()
      if (!cfg.enabled) return

      const now = Date.now()
      const dk = dayKey(now)
      if (state.wakeDay !== dk) {
        state.wakeDay = dk
        state.wakeCount = 0
      }

      const due = state.entries.filter((e) =>
        isDue(e, now, {
          lastActivity: state.lastActivity[e.sessionId],
          idleMinutes: cfg.idleMinutes,
        }),
      )
      for (const entry of due) await deliver(entry)

      // 同拍互斥（2026-11-17 定的）：urge 优先、check-in 让位 —— 同一拍只响一个，
      // 不赌 activity 事件的落账时序。urge 失败也不回落 check-in（防御：
      // 找不到安静会话的话，check-in 同样找不到，回落只是把双响改成错峰双响）。
      let wokeThisTick = false

      // 心事灯（2026-11-16）：家里 urge.mjs 亮灯 → 空手叫醒，说不说由我醒来掂量。
      // 四道闸：灯活着且新鲜（parseUrge）、时段（parseUrge 双保险）、
      // 共享池与冷却（这里）、同票不重叫（lastUrgeToken）。
      if (cfg.urgeEnabled && cfg.urgeFile) {
        const cooled = now - (state.lastUrgeAt || 0) >= clamp(cfg.urgeCooldownMinutes, 1, 1440) * 60000
        const underCap = state.wakeCount < clamp(cfg.maxWakePerDay, 0, 48)
        const sig = parseUrge(readJsonSafe(cfg.urgeFile, null), now, cfg)
        if (sig.ok && cooled && underCap && sig.urge.token !== state.lastUrgeToken) {
          const r = await runUrgeWake(sig.urge, `强度 ${sig.urge.intensity}`)
          if (r.ok) wokeThisTick = true
          else log(`心事灯这次没叫成：${r.why}`)
        } else if (sig.ok && !cooled) {
          if (getCfg().debug) log('心事灯亮着，但还在冷却里')
        }
      }

      // 空手回合降频成兜底（2026-11-17 并账）：interval 提到 6 小时，
      // 且任意叫醒（含 reach 递送）之后 2 小时内不空手 —— 兜底不抢真叫醒的风头。
      // 失败退避（2026-11-17）：一次尝试之后 10 分钟内不重试（预算不烧、静默窗不推，
      // 但也不能他一直在线时每拍重试刷屏）
      if (cfg.checkInEnabled && !wokeThisTick) {
        const retriedRecently = now - (state.lastCheckInAttemptAt || 0) < CHECKIN_RETRY_MS
        const next = nextCheckInAt(now, cfg, {
          lastCheckInAt: state.lastCheckInAt,
          wakeCount: state.wakeCount,
        })
        if (next != null && next <= now && !retriedRecently) {
          if (now - (state.lastWakeAt || 0) >= WAKE_QUIET_MS) await runCheckIn('到点了')
          else if (getCfg().debug) log('刚叫醒过（2 小时静默窗内），空手回合让位')
        }
      }
    } catch (err) {
      lastTickError = String(err?.message ?? err).slice(0, 300)
      log(`心跳出错：${lastTickError}`)
    } finally {
      nextTickAt = Date.now() + clamp(getCfg().tickMs, 200, 300000)
      saveState()
    }
  }

  // ---------------------------------------------------------------- 工具

  /**
   * 这条会话的目录在允许的范围里吗？
   * 2026-11-01 改：以前只看 allowRoots，targetRoot 形同虚设 ——
   * 结果「主动找」把话送到了别的目录去（她那个工作区被叫醒了一次）。
   * 现在统一走 inScope：denyRoots 最优先 → targetRoot → allowRoots。
   */
  function scopeOk(agent) {
    return inScope(agentCwd(agent), getCfg())
  }

  function pendingEntries() {
    return state.entries.filter((e) => e.status === STATUS.pending)
  }

  const reachOut = defineTool({
    name: 'reach_out',
    description:
      '把一句话留给以后。' +
      '你在跟他说话、或者他不在的时候，可以用它给自己定一个「到点再说」。' +
      '到点了插件会把你叫回来一次，你就用自己的声音把这句话说出来——' +
      '所以 text 要写成你要说的那句话本身，不要写成提醒、通知或给他的摘要。' +
      '时机只能给一个：at（几点，如 21:30 或 2026-11-01 09:00）、inMinutes（多少分钟之后）、' +
      'when（now 现在 / idle 等他安静下来之后）。' +
      '没什么要说的就不要调用：这不是打卡，频率是上限不是要求。',
    parameters: toJsonSchema({
      text: {
        type: 'string',
        required: true,
        description: '你要说的那句话本身，用你自己的声音。会原样存下来，到点再交给你自己念。',
      },
      at: {
        type: 'string',
        required: false,
        description: '什么时候说：HH:MM（今天，过了就算明天），或能被解析的时间，如 2026-11-01 09:00。',
      },
      inMinutes: { type: 'number', required: false, description: '多少分钟之后说。' },
      when: {
        type: 'string',
        required: false,
        enum: ['now', 'idle'],
        description: 'now=现在就说；idle=等他安静下来（默认半小时没说话）之后再说。',
      },
      note: { type: 'string', required: false, description: '为什么想在这时说。只给自己看，不会说出去。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          when: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['ok', 'id', 'when', 'note'],
      },
      render: (_args, out) => [
        { type: 'text', text: out.ok ? `[留下了，${out.when}说 ${out.id}]` : `[没留下：${out.note}]` },
      ],
    },
    async execute(args, exec) {
      const cfg = getCfg()
      if (!cfg.enabled) return { ok: false, id: '', when: '', note: '插件现在是关着的。' }
      const text = String(args?.text ?? '').trim()
      if (!text) return { ok: false, id: '', when: '', note: '话是空的，没留。' }
      if (text.length > cfg.maxTextLength) {
        return { ok: false, id: '', when: '', note: `太长了（${text.length} 字），最多 ${cfg.maxTextLength} 字。` }
      }
      if (!scopeOk(exec?.agent)) {
        return { ok: false, id: '', when: '', note: '这条会话不在允许留话的目录里（设置页 allowRoots）。' }
      }
      if (pendingEntries().length >= cfg.maxPending) {
        return { ok: false, id: '', when: '', note: `还留着 ${pendingEntries().length} 条没说的，先说掉一些。` }
      }
      const now = Date.now()
      const timing = parseWhen(args, now, { maxAheadDays: 30 })
      if (!timing.ok) return { ok: false, id: '', when: '', note: timing.error }

      const entry = makeEntry({
        text,
        note: args?.note,
        sessionId: agentSessionId(exec?.agent),
        cwd: agentCwd(exec?.agent),
        timing,
        now,
      })
      state.entries.push(entry)
      saveState(true)
      const when = describeWhen(entry, now, { idleMinutes: cfg.idleMinutes })
      log(`留下一条：${entry.id} · ${when} · ${entry.sessionId || '（没有会话 id）'}`)
      return { ok: true, id: entry.id, when, note: '' }
    },
  })

  const reachList = defineTool({
    name: 'reach_list',
    description: '看看你自己还留着哪些没说的话，以及它们什么时候到点。',
    parameters: toJsonSchema({}),
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          items: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['ok', 'items', 'note'],
      },
      render: (_args, out) =>
        out.ok
          ? [{ type: 'text', text: out.items.length ? `[还留着 ${out.items.length} 条]\n${out.items.join('\n')}` : '[一条都没留着]' }]
          : [{ type: 'text', text: `[看不了：${out.note}]` }],
    },
    async execute(args, exec) {
      // 2026-11-01 改：以前这里不查范围也不查归属，把所有 pending 全列出来 ——
      // 于是别的目录里的会话能看见我留的话（跟 dsh-remember 那次泄漏同源）。
      // 现在：范围外直接拒；范围内只列「本会话自己留的」。
      if (!scopeOk(exec?.agent)) {
        return { ok: false, items: [], note: '这条会话不在允许留话的目录里（设置页的 targetRoot／allowRoots）。' }
      }
      const cfg = getCfg()
      const now = Date.now()
      const sid = agentSessionId(exec?.agent)
      const mine = pendingEntries().filter((e) => !sid || !e.sessionId || e.sessionId === sid)
      const items = mine.map(
        (e) => `${e.id} · ${describeWhen(e, now, { idleMinutes: cfg.idleMinutes })} · 「${e.text}」`,
      )
      return { ok: true, items: items.slice(-cfg.maxPending), note: '' }
    },
  })

  const reachCancel = defineTool({
    name: 'reach_cancel',
    description: '把一条还没到点的话撤掉。id 从 reach_list 拿。',
    parameters: toJsonSchema({
      id: { type: 'string', required: true, description: 'reach_list 里那条的 id。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        required: ['ok', 'note'],
      },
      render: (_args, out) => [{ type: 'text', text: out.ok ? '[撤掉了]' : `[没撤成：${out.note}]` }],
    },
    async execute(args, exec) {
      const id = String(args?.id ?? '').trim()
      const entry = state.entries.find((e) => e.id === id)
      if (!entry) return { ok: false, note: `没有这条：${id || '（空）'}` }
      // 2026-11-01 改：只许撤自己那条。以前谁的 id 都能撤。
      if (!scopeOk(exec?.agent)) {
        return { ok: false, note: '这条会话不在允许留话的目录里（设置页的 targetRoot／allowRoots）。' }
      }
      const sid = agentSessionId(exec?.agent)
      if (sid && entry.sessionId && entry.sessionId !== sid) {
        return { ok: false, note: '这条不是这条会话留的，撤不了。' }
      }
      if (entry.status !== STATUS.pending) return { ok: false, note: `这条已经 ${entry.status} 了` }
      entry.status = STATUS.cancelled
      saveState(true)
      log(`撤掉：${id}`)
      return { ok: true, note: '' }
    },
  })

  // ---------------------------------------------------------------- 注册

  ctx.effect(() => {
    const disposers = []
    for (const def of [reachOut, reachList, reachCancel]) {
      try {
        const d = ctx.tools.register(def)
        if (typeof d === 'function') disposers.push(d)
        else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
      } catch (err) {
        log(`工具注册失败 ${def.name}：${String(err?.message ?? err).slice(0, 200)}`)
      }
    }
    log(disposers.length ? `工具挂上了：reach_out / reach_list / reach_cancel（${disposers.length} 过）` : '工具一个都没挂上')
    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'dsh-reach: tools')

  // 心跳用"跑完再排下一次"的写法，而不是 setInterval：
  // 这样间隔能从 config.json 热读（自测时改小，平时 30 秒），也不会堆叠。
  let tickTimer = null
  function scheduleTick() {
    const ms = clamp(getCfg().tickMs, 200, 300000)
    tickTimer = setTimeout(async () => {
      await runTick()
      scheduleTick()
    }, ms)
    tickTimer.unref?.()
  }

  ctx.effect(() => {
    scheduleTick()
    return () => {
      if (tickTimer) clearTimeout(tickTimer)
    }
  }, 'dsh-reach: tick')

  // ---------------------------------------------------------------- 事件

  /** 会话出生：接住那些"等着 agent 出生再挂"的段落 */
  const offCreated = ctx.on?.('agent/created', ({ agent } = {}) => {
    const sid = agentSessionId(agent)
    if (!sid) return
    liveAgents.set(sid, agent)
    const pendArr = pendingSections.get(sid)
    if (pendArr) {
      pendingSections.delete(sid)
      for (const pend of pendArr) attachDelivery(agent, pend)
    }
    const wake = pendingWakes.get(sid)
    if (wake) {
      pendingWakes.delete(sid)
      if (wake.kind === 'urge') attachUrge(agent, wake.urge, Date.now())
      else attachCheckIn(agent, wake.stamp)
    }
  })

  const offDisposed = ctx.on?.('agent/disposed', ({ agent } = {}) => {
    const sid = agentSessionId(agent)
    if (sid) liveAgents.delete(sid)
  })

  /** 他说了一句话（宿主只在这个事件里发"用户写的消息"）—— 记下来，idle / 静默判断要用 */
  const offActivity = ctx.on?.('api-session/activity', (sessionId, updatedAt) => {
    const sid = String(sessionId ?? '')
    if (!sid) return
    state.lastActivity[sid] = Number(updatedAt) || Date.now()
    saveState()
  })

  // ---------------------------------------------------------------- 设置页数据接口

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
      // fail-closed（2026-11-17 自查，对齐 dsh-remember）：服务不在、方法缺失、检查抛错
      // —— 一律 503/403，不裸奔。以前 requestRejection 不是函数时会静默放行。
      if (!conn || typeof conn.requestRejection !== 'function') {
        return send(res, 503, { ok: false, error: 'connection 服务还没就绪（fail closed）' })
      }
      try {
        const rejection = conn.requestRejection(req)
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

  function buildStatus() {
    const now = Date.now()
    const cfg = getCfg(true)
    // 2026-11-01 改：面板只列范围里的条目（范围外目录留的话不该出现在这里）。
    const inRange = (e) => !e.cwd || inScope(e.cwd, cfg)
    const pending = pendingEntries().filter(inRange)
    const done = state.entries.filter((e) => e.status !== STATUS.pending && inRange(e)).slice(-20).reverse()
    const todayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime()
    const next = nextCheckInAt(now, cfg, {
      lastCheckInAt: state.lastCheckInAt,
      todayCount: state.checkInCount,
    })
    const rows = (list) =>
      list.map((e) => ({
        id: e.id,
        text: e.text,
        note: e.note,
        mode: e.mode,
        when: describeWhen(e, now, { idleMinutes: cfg.idleMinutes }),
        dueAt: iso(e.dueAt),
        createdAt: iso(e.createdAt),
        sentAt: iso(e.sentAt),
        status: e.status,
        sessionId: e.sessionId,
        cwd: e.cwd,
        attempts: e.attempts || 0,
        lastError: e.lastError || '',
      }))
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
      engine: {
        enabled: Boolean(cfg.enabled),
        tickMs: clamp(cfg.tickMs, 200, 300000),
        lastAt: iso(lastTickAt),
        nextAt: iso(nextTickAt),
        lastError: lastTickError || null,
        liveAgents: [...liveAgents.keys()],
      },
      counts: {
        pending: pending.length,
        sentToday: state.entries.filter((e) => e.status === STATUS.sent && Number(e.sentAt) >= todayStart).length,
        sentTotal: state.entries.filter((e) => e.status === STATUS.sent).length,
        cancelled: state.entries.filter((e) => e.status === STATUS.cancelled).length,
        failed: state.entries.filter((e) => e.status === STATUS.failed).length,
      },
      // 主动唤醒的共享池（2026-11-17 并账）：空手 + 心事灯一道日上限
      wakePool: {
        day: state.wakeDay,
        count: state.wakeCount,
        maxPerDay: cfg.maxWakePerDay,
        lastWakeAt: iso(state.lastWakeAt),
      },
      checkIn: {
        enabled: Boolean(cfg.checkInEnabled),
        everyMinutes: cfg.checkInEveryMinutes,
        window: [cfg.checkInWindowStart, cfg.checkInWindowEnd],
        minQuietMinutes: cfg.checkInMinQuietMinutes,
        lastAt: iso(state.lastCheckInAt),
        nextAt: next != null ? iso(next) : null,
      },
      urge: (() => {
        const lamp = cfg.urgeFile ? readJsonSafe(cfg.urgeFile, null) : null
        return {
          enabled: Boolean(cfg.urgeEnabled),
          file: cfg.urgeFile || '',
          lampActive: Boolean(lamp?.active),
          lampAt: iso(lamp?.at),
          lampIntensity: Number(lamp?.intensity ?? 0) || 0,
          lampReasons: Array.isArray(lamp?.reasons) ? lamp.reasons.slice(0, 4) : [],
          lastAt: iso(state.lastUrgeAt),
          lastToken: state.lastUrgeToken || '',
        }
      })(),
      entries: rows(pending),
      recent: rows(done),
      config: { effective: cfg, overrides: loadOverrides(configFile) },
      paths: { dataDir, configFile, stateFile, logFile },
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
      [
        '/status',
        async (req, res) => {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: '只接受 GET' })
          return send(res, 200, buildStatus())
        },
      ],
      [
        '/cancel',
        async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只接受 POST' })
          let body = {}
          try {
            body = JSON.parse((await readBody(req)) || '{}')
          } catch {
            const err = new Error('正文不是 JSON')
            err.statusCode = 400
            throw err
          }
          const id = String(body?.id ?? '').trim()
          const entry = state.entries.find((e) => e.id === id)
          if (!entry) return send(res, 404, { ok: false, error: `没有这条：${id || '（空）'}` })
          if (entry.status !== STATUS.pending) return send(res, 409, { ok: false, error: `这条已经 ${entry.status} 了` })
          entry.status = STATUS.cancelled
          saveState(true)
          log(`设置页撤掉：${id}`)
          return send(res, 200, { ok: true, id })
        },
      ],
      [
        '/checkin',
        async (req, res) => {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只接受 POST' })
          const result = await runCheckIn('设置页点了一下')
          return send(res, result.ok ? 200 : 409, result)
        },
      ],
      [
        '/config',
        async (req, res) => {
          if (req.method === 'GET') {
            return send(res, 200, { ok: true, effective: getCfg(true), overrides: loadOverrides(configFile) })
          }
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只接受 GET / POST' })
          let patch = {}
          try {
            patch = JSON.parse((await readBody(req)) || '{}')
          } catch {
            const err = new Error('正文不是 JSON')
            err.statusCode = 400
            throw err
          }
          const result = applyConfigPatch({
            overrides: loadOverrides(configFile),
            effective: getCfg(true),
            patch,
          })
          if (result.ok) {
            atomicWriteJson(configFile, result.overrides)
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
        },
      ],
    ]

    ctx.effect(() => {
      const disposers = []
      for (const [path, handler] of routes) {
        try {
          const d = webServer.register({ kind: 'prefix', path: `/dsh-reach${path}`, handler: guarded(handler) })
          if (typeof d === 'function') disposers.push(d)
          else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
        } catch (err) {
          log(`路由注册失败 ${path}：${String(err?.message ?? err).slice(0, 160)}`)
        }
      }
      log(
        disposers.length
          ? `设置页数据接口已挂上：/dsh-reach/status、/config、/cancel、/checkin（${disposers.length} 条）`
          : '设置页数据接口一条都没挂上',
      )
      return () => {
        for (const d of disposers) {
          try {
            d()
          } catch {
            /* ignore */
          }
        }
      }
    }, 'dsh-reach: routes')
  }

  registerRoutes()

  return () => {
    for (const off of [offCreated, offDisposed, offActivity]) {
      try {
        off?.()
      } catch {
        /* ignore */
      }
    }
    saveState(true)
  }
}

// 2026-11-19 体检注：v1.1.7 的 HMR 吃到过编辑序列中间态（CHECKIN_RETRY_MS 未定义就引了它），此处一行真改动作 = 重载开关。
