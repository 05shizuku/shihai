/**
 * dsh-qq-bridge —— QQ 薄桥。
 *
 * 收：SnowLuma（OneBot v11）WS 口的私聊事件，白名单过滤。
 * 递：压成一行走 sessionController.prompt 递进目标会话（跟输入框同一条路）。
 * 回：盯 session/event，我们那一条的 assistant 回话截短后 send_private_msg 发回去。
 *
 * 刻意不做的（m00559 定的）：不接账本 —— QQ 来的话不写记忆；
 * 白名单空＝一个字都不递。
 * 群：日常消息只记日志；@ 我的那条递进会话，我看到自己决定回不回
 *（m07835：回群里的话不用全转他，要他确认的才发他，或者我自己判断）。
 * 戳一戳（notice/notify/poke）：谁戳我，戳回去（同一人一分钟内只回一次）——
 * 烟霞问「为什么戳你不理我」，这是给她的回音。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PendingReplies,
  assistantText,
  atMe,
  clampReply,
  extractText,
  extractMedia,
  mediaLines,
  formatGroupLog,
  formatGroupPrompt,
  formatPrompt,
  groupReplyText,
  inviteSeqFromCard,
  isAllowedGroup,
  isAllowedPrivate,
  isToolCallMarker,
  looksGroupAddressed,
  splitBubbles,
  userText
} from './lib/bridge.js'
import { OnebotClient } from './lib/onebot.js'
import { normalizeRoots, scopeOk } from './lib/scope.js'
import { applyConfigPatch } from './lib/report.js'
import { downloadPhotos, inlineBase64Segments, parsePhotoMarkers, photoLines, toSegments } from './lib/photos.js'
import { loadStickers, missingStickerText, parseStickerMarkers } from './lib/stickers.js'
import { HEARTBEAT_INTERVAL_MS, heartbeatInfo, writeHeartbeat } from './lib/heartbeat.js'

export const name = 'dsh-qq-bridge'

/** 只硬依赖会话服务：收发的路都在它身上。 */
export const inject = ['sessionController']

export const DEFAULTS = {
  /** 总开关 */
  enabled: true,
  /** SnowLuma OneBot HTTP 动作口 */
  onebotHttp: 'http://127.0.0.1:3000',
  /** HTTP 口的 access token（跟 WS 口不是同一个） */
  httpToken: '',
  /** SnowLuma OneBot WS 口（收事件） */
  onebotWs: 'ws://127.0.0.1:3001',
  /** WS 口的 access token */
  wsToken: '',
  /** 白名单：只处理这些号的私聊；空数组＝什么都不递 */
  allowUsers: [],
  /** 允许记录的群号（v1 只记日志，不回） */
  allowGroups: [],
  /** 有人戳我时戳回去；同一人同一分钟只回一次 */
  pokeBack: true,
  /** 桥自己的号（防自环；留空不查） */
  selfUin: '',
  /** 目标会话；留空＝最近活跃的那条普通会话 */
  sessionId: '',
  /** 回话最长多少字 */
  replyMaxChars: 500,
  /** 递进会话时的话前缀（也是认「这轮是替 QQ 回的」的记号） */
  promptPrefix: '【QQ】',
  /** 等回话等多久算过期（秒） */
  staleSeconds: 300,
  /** 把我收到的消息结构化记一份（意图层的事件源；不写记忆） */
  messageLogEnabled: true,
  /** 消息流最多留多少行（超了裁旧的） */
  messageLogMaxLines: 2000,
  /**
   * 照片三件套（v0.7.0）：
   * photoStoreEnabled —— 收图落盘（只存明确交给我的：私聊发我的、群里 @ 我发我的）；
   * photoMaxBytes —— 单张图上限；photoMaxPerMessage —— 一条消息最多存几张。
   * 群里没 @ 我的图只留直链在消息流里，我不主动扒群相册。
   */
  photoStoreEnabled: true,
  photoMaxBytes: 8 * 1024 * 1024,
  photoMaxPerMessage: 4,
  /**
   * 表情包标记（v0.8.0）：
   * stickerEnabled —— 回话正文里的 [表情:名字] 能不能变真图片段发出去。
   * 表情库在 <DSH_HOME>/.dsh-qq-bridge/stickers/（manifest.jsonl + 图本体）。
   * 名字是她自己取的：她写什么名字，这里就照着库里那张发。
   */
  stickerEnabled: true,
  /**
   * 会话隔离（对齐 dsh-body 的三把钥匙，判定顺序：先 denyRoots → 再 allowRoots → 最后 targetRoot）：
   * denyRoots —— 黑名单，命中就不动那个文件，优先于一切放行；
   * allowRoots —— 显式白名单，填了就只动名单底下的数据文件；
   * targetRoot —— 兜底放行根；留空 = 不按路径收窄。
   * 管的是数据文件（seen/pending/日志/消息流）；config.json 豁免（栅栏键自己住里面）。
   */
  targetRoot: '',
  allowRoots: [],
  denyRoots: []
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PKG = readJson(join(HERE, 'package.json'), {})
const VERSION = String(PKG?.version ?? '0.0.0')

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) ?? fallback
  } catch {
    return fallback
  }
}

export function resolveDshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

/** 十分钟内见过的 message_id 就不再递 —— 账记在共享文件里，几个实例一起认。 */
const SEEN_MS = 10 * 60 * 1000
function makeSeenFile(homeDir, scoped = null) {
  const file = join(homeDir, 'seen.json')
  let cache = null
  let loaded = false
  const load = () => {
    if (loaded) return cache
    loaded = true
    if (scoped && !scoped(file)) return (cache = {})
    const raw = readJson(file, {})
    cache = raw && typeof raw === 'object' ? raw : {}
    return cache
  }
  const save = () => {
    try {
      if (scoped && !scoped(file)) return
      writeFileSync(file, JSON.stringify(cache))
    } catch {
      /* 写不进去就退化为只认本实例的账 */
    }
  }
  return function seenRecently(mid, now) {
    const map = load()
    // 顺手清过期
    let dirty = false
    for (const k of Object.keys(map)) {
      if (now - Number(map[k]) > SEEN_MS) {
        delete map[k]
        dirty = true
      }
    }
    if (map[mid] !== undefined && now - Number(map[mid]) <= SEEN_MS) {
      if (dirty) save()
      return true
    }
    map[mid] = now
    save()
    return false
  }
}


/** 日志：小文件追加，超了就转一份 .1。scoped 不过的路径一个字不写（隔离）。 */
function makeLogger(dir, scoped = null) {
  const file = join(dir, 'bridge.log')
  let n = 0
  return (line) => {
    const at = new Date().toISOString()
    try {
      if (scoped && !scoped(file)) return
      if (++n % 50 === 0) {
        try {
          if (statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`)
        } catch {
          /* 还没有文件 */
        }
      }
      appendFileSync(file, `[${at}] ${line}\n`, 'utf8')
    } catch {
      /* 日志写不进去也不拦正事 */
    }
  }
}

/**
 * 消息流：把收到的消息结构化记一份，给意图层当事件源。
 *
 * 刻意只记「已经放行」的消息（白名单私聊 + 允许的群）——别人递的字只是数据，
 * 不是口令；进不来的连数据都不留。
 * 这份文件不是记忆：没有分量、不参加竞争，只有类型和强度会被下游认出来。
 * 只增不改，但有行数上限（超了裁旧的）——不然它自己会长成第二个恶性回声。
 */
export function makeMessageLog(dir, maxLines = 2000, scoped = null) {
  // v0.4.0 分册：一个群一册（messages-group-<群号>.jsonl）、私聊一人一册
  // （messages-private-<QQ>.jsonl）——哪个场的话在哪个文件，物理上分家。
  // 旧的单本 messages.jsonl 不再写，留着当历史合订本（下游把游标抄完为止）。
  // 隔离：scoped 不过的分册一个字不记（连读带写都不动）。
  const counters = new Map() // file -> n
  const fileFor = (row) => {
    if (String(row.chatType ?? '') === 'group' && row.groupId != null && String(row.groupId) !== '') {
      return join(dir, `messages-group-${String(row.groupId)}.jsonl`)
    }
    if (row.userId != null && String(row.userId) !== '') {
      return join(dir, `messages-private-${String(row.userId)}.jsonl`)
    }
    return join(dir, 'messages-misc.jsonl')
  }
  const trim = (file) => {
    try {
      if (scoped && !scoped(file)) return
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      if (lines.length <= maxLines) return
      const kept = lines.slice(-maxLines)
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, kept.join('\n') + '\n', 'utf8')
      renameSync(tmp, file)
      counters.set(file, kept.length)
    } catch {
      /* 裁不动就留着，下回再说 */
    }
  }
  return {
    files: (base = '') => [...counters.keys()].filter((f) => !base || f.includes(base)),
    stats: () => [...counters.entries()].map(([file, lines]) => ({ file, lines })),
    /** 记一条；row 里的字段由调用方给（at/chatType/userId/groupId/nickname/text）——按场分册落盘 */
    note(row) {
      try {
        const file = fileFor(row)
        if (scoped && !scoped(file)) return
        appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
        const n = (counters.get(file) || 0) + 1
        counters.set(file, n)
        if (n % 100 === 0) trim(file)
      } catch {
        /* 写不进去不拦正事 */
      }
    },
    trim,
    /** 读某群分册的尾部（群 @ 递话带上下文用）；excludeMid 把当前这条自己抠掉。
     *  返回旧→新排好的一小段，读不动/没文件就空数组——上下文是添头，不能因它误事。 */
    recent(groupId, n = 6, excludeMid = '') {
      try {
        const file = join(dir, `messages-group-${String(groupId)}.jsonl`)
        if (scoped && !scoped(file)) return []
        if (!existsSync(file)) return []
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        const out = []
        for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
          let row
          try { row = JSON.parse(lines[i]) } catch { continue }
          if (excludeMid && String(row.mid ?? '') === String(excludeMid)) continue
          out.push(row)
        }
        return out.reverse()
      } catch {
        return []
      }
    },
  }
}

export function apply(ctx, baseConfig = {}) {
  const dshHome = resolveDshHome()
  const homeDir = join(dshHome, '.dsh-qq-bridge')
  try {
    mkdirSync(homeDir, { recursive: true })
  } catch {
    /* 已有 */
  }
  let fileCfg = readJson(join(homeDir, 'config.json'), {}) || {}
  if (!fileCfg || typeof fileCfg !== 'object') fileCfg = {}
  const cfg = { ...DEFAULTS, ...(baseConfig ?? {}), ...fileCfg }
  if (!Array.isArray(cfg.allowUsers)) cfg.allowUsers = []
  if (!Array.isArray(cfg.allowGroups)) cfg.allowGroups = []
  cfg.replyMaxChars = Math.max(1, Math.floor(Number(cfg.replyMaxChars) || 500))
  cfg.staleSeconds = Math.max(30, Math.floor(Number(cfg.staleSeconds) || 300))
  // 会话隔离的三把钥匙洗一遍（坏值当没有）——判定顺序见 lib/scope.js
  cfg.targetRoot = String(cfg.targetRoot ?? '').trim()
  cfg.allowRoots = normalizeRoots(cfg.allowRoots)
  cfg.denyRoots = normalizeRoots(cfg.denyRoots)
  const gates = { targetRoot: cfg.targetRoot, allowRoots: cfg.allowRoots, denyRoots: cfg.denyRoots }
  const complained = new Set()
  const scoped = (file) => {
    const r = scopeOk(file, gates)
    if (!r.ok && !complained.has(file)) {
      complained.add(file)
      log(`隔离：不动 ${file} —— ${r.why}`)
    }
    return r.ok
  }
  const log = makeLogger(homeDir, scoped)
  const seenRecently = makeSeenFile(homeDir, scoped)
  const messageLog = cfg.messageLogEnabled === false ? null : makeMessageLog(homeDir, cfg.messageLogMaxLines, scoped)
  // 照片库（v0.7.0）：只存明确交给我的图。目录在 homeDir 底下，隔离不过就不存。
  const photosDir = join(homeDir, 'photos')
  const photosOk = cfg.photoStoreEnabled !== false && scoped(photosDir)
  // 表情库（v0.8.0）：她分享的表情包。目录在 homeDir 底下，隔离不过就当没有。
  const stickerDir = join(homeDir, 'stickers')
  const stickersOk = cfg.stickerEnabled !== false && scoped(stickerDir)
  let bridge = null

  // 设置页的数据接口（对齐 dsh-body：GET /status、GET|POST /config）。
  // 挂在待机判定之前 —— 待机时页面也要能看（看到「待机」和原因）。
  registerRoutes()

  if (cfg.enabled === false) {
    log(`v${VERSION} 配置里 enabled=false，桥待机`)
    return { dispose() {} }
  }
  if (cfg.allowUsers.length === 0) {
    log(`v${VERSION} 白名单是空的（<DSH_HOME>/.dsh-qq-bridge/config.json 的 allowUsers），桥待机 —— 配好再热重载`)
    return { dispose() {} }
  }

  const sessionController = ctx.sessionController
  if (!sessionController) {
    log('拿不到 sessionController，桥没起来')
    return { dispose() {} }
  }

  log(`v${VERSION} 起：http=${cfg.onebotHttp} ws=${cfg.onebotWs} 白名单=${cfg.allowUsers.join(',')} 目标=${cfg.sessionId || '(最近活跃会话)'}`)
  log(`隔离：deny=${cfg.denyRoots.join(',') || '无'} allow=${cfg.allowRoots.join(',') || '无'} target=${cfg.targetRoot || '未收窄'}`)

  bridge = createBridge({ cfg, log, sessionController, seenRecently, homeDir, pendingFile: scoped(join(homeDir, 'pending.json')) ? join(homeDir, 'pending.json') : null, messageLog, photosDir, photosOk, stickerDir, stickersOk })

  // 会话这头的口子：挂在 ctx.effect 里 —— 宿主卸载/重载插件时跑 teardown。
  // 别学旧版把清理挂在 apply 返回值上：宿主不看返回值，挂那儿就是僵尸（2026-11-04 实测）。
  try {
    ctx.effect(() => {
      const off = ctx.on?.('session/event', bridge.onSessionEvent)
      return () => {
        try {
          off?.()
        } catch {
          /* ignore */
        }
        try {
          ctx.off?.('session/event', bridge.onSessionEvent)
        } catch {
          /* ignore */
        }
        bridge.dispose()
      }
    }, 'dsh-qq-bridge: session/event')
  } catch (err) {
    log(`挂 session/event 失败：${err?.message ?? err}`)
  }

  bridge.connect()

  // 预热目标会话（配置了就立刻知道往哪递）
  bridge.targetSessionId().then((sid) => {
    if (sid) log(`目标会话：${sid}`)
  })

  // 心跳（v0.8.3）：每分钟给自己留一次「我还活着」的证据。
  // 桥安静的时候 bridge.log 根本不写，别人（selfcheck.mjs / 看门狗）就分不清
  // 我是活着没事干、还是已经哑了 —— 那个文件的时间戳就是最后还在的时刻。
  const heartbeatFile = scoped(join(homeDir, 'heartbeat.json')) ? join(homeDir, 'heartbeat.json') : null
  if (heartbeatFile) {
    const startedAt = Date.now()
    const pendingFile = join(homeDir, 'pending.json')
    const beat = () => {
      try {
        const arr = readJson(pendingFile, null)
        // 存档两种形状：数组（早期）/ {savedAt, items}（现在）
        const list = Array.isArray(arr) ? arr : Array.isArray(arr?.items) ? arr.items : []
        writeHeartbeat(heartbeatFile, heartbeatInfo({ version: VERSION, startedAt, pending: list.length }))
      } catch (err) {
        log(`心跳写不进去：${err?.message ?? err}`)
      }
    }
    beat()
    try {
      ctx.effect(() => {
        let timer = null
        const tick = () => {
          beat()
          timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS)
          timer.unref?.()
        }
        timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS)
        timer.unref?.()
        return () => {
          if (timer) clearTimeout(timer)
        }
      }, 'dsh-qq-bridge: heartbeat')
    } catch (err) {
      log(`挂心跳失败：${err?.message ?? err}`)
    }
  }

  // ---- 设置页的数据接口（对齐 dsh-body 的挂法） ----
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

  /** token 不回显 —— 设置页看得到「配没配」，看不到值本身 */
  function redactCfg(c) {
    return {
      ...c,
      httpToken: c.httpToken ? '已配置（不回显）' : '',
      wsToken: c.wsToken ? '已配置（不回显）' : '',
    }
  }

  function atomicWriteJson(file, obj) {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  function buildStatus() {
    return {
      ok: true,
      now: new Date().toISOString(),
      plugin: { name, version: VERSION },
      running: Boolean(bridge),
      homeDir,
      dshHome,
      pendingSize: bridge ? bridge.pendingSize : 0,
      messageLog: messageLog
        ? { enabled: true, stats: messageLog.stats() }
        : { enabled: false, stats: [] },
      fence: {
        targetRoot: cfg.targetRoot,
        allowRoots: cfg.allowRoots,
        denyRoots: cfg.denyRoots,
        note: '先 denyRoots → 再 allowRoots → 最后 targetRoot；留空不收窄。config.json 豁免（栅栏键自己住里面）',
      },
      whitelist: { users: cfg.allowUsers, groups: cfg.allowGroups },
      staleSeconds: cfg.staleSeconds,
      replyMaxChars: cfg.replyMaxChars,
      config: { effective: redactCfg(cfg), overrides: fileCfg },
    }
  }

  function registerRoutes() {
    const webServer = safeGet('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      log('宿主没有 webServer.register，设置页的数据接口没挂上（桥本身照常跑）')
      return
    }
    const routes = [
      ['/status', async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { ok: false, error: '只接受 GET' })
        return send(res, 200, buildStatus())
      }],

      ['/config', async (req, res) => {
        if (req.method === 'GET') {
          return send(res, 200, { ok: true, effective: redactCfg(cfg), overrides: fileCfg })
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
        const result = applyConfigPatch({ overrides: fileCfg, patch })
        if (result.accepted.length) {
          try {
            atomicWriteJson(join(homeDir, 'config.json'), result.overrides)
            fileCfg = result.overrides
            log(`设置页改了配置：${result.accepted.join('、')}（热重载/重启后生效）`)
          } catch (err) {
            const e = new Error(`写 config.json 失败：${err?.message ?? err}`)
            e.statusCode = 500
            throw e
          }
        }
        return send(res, result.ok ? 200 : 400, {
          ok: result.ok,
          accepted: result.accepted,
          rejected: result.rejected,
          note: '改动已写进 config.json；热重载/重启后生效',
          effective: redactCfg(cfg),
          overrides: result.overrides,
        })
      }],
    ]

    ctx.effect(() => {
      const disposers = []
      for (const [path, handler] of routes) {
        try {
          const d = webServer.register({ kind: 'prefix', path: `/dsh-qq-bridge${path}`, handler: guarded(handler) })
          if (typeof d === 'function') disposers.push(d)
          else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
        } catch (err) {
          log(`路由注册失败 ${path}：${err?.message ?? err}`)
        }
      }
      if (disposers.length) log(`设置页数据接口已挂上：/dsh-qq-bridge/status、/dsh-qq-bridge/config（${disposers.length} 条）`)
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
    }, 'dsh-qq-bridge: routes')
  }

  return bridge
}

/**
 * 桥芯：收（handleOnebotEvent）→ 递（prompt）→ 认/回（onSessionEvent）。
 * 单独拆出来是为了冒烟能不开 WS 就把整条链走一遍。
 */
/* ---------- 群 @ 递话带上下文（小鱼 2026-11-07 的提法：群里的消息要联系群里的上下文回） ---------- */

const GROUP_CONTEXT_LINES = 10 // 带几句就够——上下文是添头，塞多了反而把会话灌乱
const GROUP_CONTEXT_CHARS = 800

/** 几行 → 一小块上下文。groupContextBlock 和 groupContextLive 共用这一个折法。 */
function renderContextRows(rows) {
  try {
    if (!Array.isArray(rows) || !rows.length) return ''
    const hhmm = (at) => {
      const d = new Date(Number(at) || 0)
      if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return '--:--'
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const parts = []
    let used = 0
    for (const r of rows) {
      const who = String(r.nickname ?? r.userId ?? '?').slice(0, 20)
      const what = String(r.text ?? '').split('\n')[0].slice(0, 80)
      const seg = `${hhmm(r.at)} ${who}：${what}`
      if (used + seg.length > GROUP_CONTEXT_CHARS) break
      parts.push(seg)
      used += seg.length
    }
    if (!parts.length) return ''
    return `\n（群里刚才聊的，供接话：\n${parts.join('\n')}）`
  } catch {
    return ''
  }
}

/** 文件尾巴版：从消息流分册倒着翻几句。读不动/没记录/被隔离都返回空串。 */
export function groupContextBlock(ml, ev) {
  try {
    if (!ml || typeof ml.recent !== 'function') return ''
    const rows = ml.recent(ev?.group_id, GROUP_CONTEXT_LINES, String(ev?.message_id ?? ''))
    return renderContextRows(rows)
  } catch {
    return ''
  }
}

/** 实时版（v0.6.1）：递话当下向协议端要群里最近几条真消息。
 *  2026-11-07 ①群实锤：WS 推送慢半拍时，文件尾巴停在几分钟前，块就成了「上一个触发点那会儿」的账
 *  ——她问「晴猫说的要试试嘛」，我看到的却还是换插件那几句。上下文必须按群里的真账来。
 *  拉不动（没 onebot/接口报错/空）返回 null，调用方退回文件尾巴版 groupContextBlock。 */
export async function groupContextLive(onebot, ev) {
  try {
    if (!onebot || typeof onebot.call !== 'function') return null
    const gid = String(ev?.group_id ?? '')
    if (!gid) return null
    const res = await onebot.call('get_group_msg_history', { group_id: gid, count: GROUP_CONTEXT_LINES + 2 })
    const msgs = res?.data?.messages
    if (!Array.isArray(msgs) || !msgs.length) return null
    const mid = String(ev?.message_id ?? '')
    const rows = []
    for (const m of msgs) {
      if (mid && String(m?.message_id ?? '') === mid) continue // 抠掉触发这条自己
      const text = String(m?.raw_message ?? (Array.isArray(m?.message)
        ? m.message.map((s) => (typeof s?.data?.text === 'string' ? s.data.text : `[${s?.type ?? '媒体'}]`)).join('')
        : ''))
      if (!text.trim()) continue
      rows.push({
        at: Number(m?.time) > 0 ? Number(m.time) * 1000 : 0,
        nickname: String(m?.sender?.nickname ?? m?.user_id ?? '?'),
        text
      })
    }
    if (!rows.length) return null
    rows.reverse() // 接口给新→旧，折块要旧→新
    return renderContextRows(rows)
  } catch {
    return null
  }
}

export function createBridge({ cfg, log = () => {}, sessionController, seenRecently = () => false, homeDir = null, pendingFile = null, messageLog = null, photosDir = null, photosOk = false, stickerDir = null, stickersOk = false }) {
  const prefix = String(cfg.promptPrefix ?? '【QQ】')
  // 表情库索引（v0.8.0）：启动时读一次 manifest.jsonl；库变了可以 reloadStickers() 重读。
  let stickerIndex = stickersOk ? loadStickers(stickerDir, { log }) : { byName: new Map(), list: [] }
  if (stickersOk) log(`表情库：${stickerIndex.list.length} 张（${stickerDir}）`)
  // 挂起的回话记在盘上：热重载/重启不让「等着回的话」跟着实例一起没掉
  //（上次就是热重载把他等的那条回话洗掉了，我只能走侧门补发）
  const readPendingFile = () => {
    if (!pendingFile) return []
    try {
      const raw = JSON.parse(readFileSync(pendingFile, 'utf8'))
      return Array.isArray(raw?.items) ? raw.items : []
    } catch {
      return []
    }
  }
  const writePendingFile = (p) => {
    if (!pendingFile) return
    try {
      writeFileSync(pendingFile, JSON.stringify({ savedAt: Date.now(), items: p.entries() }))
    } catch {
      /* 存不上就存不上，挂起还在内存里活着 */
    }
  }
  const pending = new PendingReplies({
    staleMs: (Number(cfg.staleSeconds) || 300) * 1000,
    // 宿主答一条可能要很久（2026-11-07 真事：一条群消息等了一小时才开始答，
    // 干到收尾已经超过 staleSeconds → 回话被判过期丢掉）。认领过的从认领时刻起
    // 给 6 小时宽窗；没认领的还按 staleSeconds 算（等太久就作废）。
    inFlightMs: 6 * 60 * 60 * 1000,
    // 保留期留一天：清得慢不要紧（能不能发由过期判定说了算），
    // 免得宿主回显我们的递话晚了几小时，挂起已经被扫掉、回话再也接不上。
    keepMs: 24 * 60 * 60 * 1000,
    initial: readPendingFile(),
    onChange: writePendingFile
  })
  const cleanups = []
  let disposed = false
  let targetSid = cfg.sessionId ? String(cfg.sessionId) : null
  // 邀请事件的 flag 在 SnowLuma 那边常常匹配不上（selfInvitation）——
  // 失败时记一笔，等紧跟着到的邀请卡片（json 卡，jumpUrl 里带 msgseq），按卡片序号点头。
  let inviteRetry = null
  // assistant/message 按「步」落（思考步/工具步/正文步，每步一次），每步的 message
  // 都带着那一步的 thinking 块 —— 2026-11-04 事故：桥把第一步的思考当回话发进了群。
  // 改成：正文块按轮攒着，等 turn/end（整轮收尾）再一并发出。
  const turnTexts = new Map()
  // 挂起的精确认领（2026-11-05 串台事故的根治）：turn/end 只走「对得上号」的
  // 路，不按先后盲取（盲取把群答复塞进过私信）。
  // 2026-11-10 v0.8.7 改「回话资格队」：旧 primedKeys 是纯键队列，GUI 轮/环境轮
  // 的 assistant 首步也会 shift 走一条 —— 群友甲 16:14 点名的扩展榜挂起就是这么被
  // 中间轮吃掉又作废的。owed = 「有句话还没回」的资格名单：只有资格在，认领才
  // 发生；没资格的转（GUI 小结、环境更新、没认上号的）一个挂起都碰不到。
  const owedReplies = []
  const PRIMED_MAX = 32
  // 资格的新鲜窗：认下超过 15 分钟还没被认领，资格作废（挂起本体还在，由
  // 过期判定和 sweep 管）。兜底认领沿用 v0.8.6 的 5 分钟窗。
  const OWED_FRESH_MS = 15 * 60 * 1000
  const PRIMED_FALLBACK_MS = 5 * 60 * 1000
  const turnPendingMap = new Map()
  // 重启/热重载后回填资格：刚认下没多久（兜底窗内）的挂起，重新给认领资格 ——
  // 2026-11-10 早上真事：宿主重启把内存队列清空，她 08:15 的「早～」没了认领人，
  // 回话静默丢。老挂起（几小时前的）不回填 —— 过期判定会拦，别把旧账翻出来发。
  // 回填过的记入 seededKeys：这些挂起的递话本来就带过 echo，发送闸给它们放行。
  const seededKeys = new Set()
  for (const it of pending.entries()) {
    const stamp = Number.isFinite(it.boundAt) ? it.boundAt : it.primedAt
    if (Number.isFinite(stamp) && Date.now() - stamp <= PRIMED_FALLBACK_MS) {
      owedReplies.push({ key: it.key, at: stamp })
      seededKeys.add(it.key)
    }
  }
  owedReplies.sort((a, b) => a.at - b.at)
  // 从资格队取一条：过期的资格直接丢（挂起本体还在，sweep 会收），取到就给。
  const takeOwed = () => {
    while (owedReplies.length) {
      const head = owedReplies[0]
      owedReplies.shift()
      if (Date.now() - head.at > OWED_FRESH_MS) continue
      return head.key
    }
    return null
  }
  // assistant 首步用：把资格记到这一转名下（turn/end 走「认领」路要查这张表）。
  const claimOwed = (turn) => {
    const k = takeOwed()
    if (k && Number.isFinite(turn)) turnPendingMap.set(turn, k)
    return k
  }
  // 资格去重后再入队（同一条挂起在队里只留一份，防 GUI 轮放回 + 重绑后双份）。
  const reOwe = (key, front) => {
    const i = owedReplies.findIndex((o) => o.key === key)
    if (i >= 0) owedReplies.splice(i, 1)
    const entry = { key, at: Date.now() }
    if (front) owedReplies.unshift(entry)
    else owedReplies.push(entry)
  }
  // 这一转带没带我们的递话（user/message echo）：带的才许把认领到的挂起发出去 ——
  // GUI 打字/环境更新开的转没带 echo，认领了也只许放回（2026-11-10 真事：GUI
  // 轮的「干活的小结」差点当回话发进她私聊；群友甲的扩展榜挂起被中间轮吃掉）。
  let sawPrompt = false
  // 戳一戳的回音：同一人一分钟内只戳回去一次，防连戳刷屏。
  const pokeBackAt = new Map()
  const POKE_COOLDOWN_MS = 60 * 1000

  // 掉线窗口补抄（v0.8.9）：离线超过一分钟才翻收件箱；每个好友往后翻 20 条就够
  //（补的是「刚断的那阵」，不是重抄整本历史）。
  const BACKFILL_MIN_GAP_MS = 60 * 1000
  const BACKFILL_COUNT = 20

  const addCleanup = (fn) => cleanups.push(fn)

  async function targetSessionId() {
    if (targetSid) return targetSid
    if (cfg.sessionId) {
      targetSid = String(cfg.sessionId)
      return targetSid
    }
    try {
      const list = await sessionController.list({})
      const items = Array.isArray(list?.items) ? list.items : []
      const plain = items.filter((it) => it && !it.blank && String(it.origin ?? '') !== 'subagent')
      const sid = plain[0]?.sessionId ?? plain[0]?.id
      if (sid) {
        targetSid = String(sid) // 认下了，后面的事件才进得来
        return targetSid
      }
      log('没找到可以递话的会话（list 空）')
    } catch (err) {
      log(`列会话失败：${err?.message ?? err}`)
    }
    return null
  }

  // 掉线窗口补抄（v0.8.9）的状态：lastEventAt＝最后一次收到 WS 事件的时刻。
  // 重连上时 gap 一大（超过一分钟），就把这阵子的私聊从 QQ 记录翻回来补进消息流。
  // v0.9.0 起时刻落盘（lastEventAt.json，至多 10 秒写一次）：热重载/重启也不丢起点——
  // 停机窗口里来的私聊，起来后照样算得出 gap、照样补得回。
  const lastEventAtFile = join(homeDir, 'lastEventAt.json')
  const readLastEventAt = () => {
    try {
      const raw = JSON.parse(readFileSync(lastEventAtFile, 'utf8'))
      const at = Number(raw?.at)
      return Number.isFinite(at) && at > 0 ? at : null
    } catch {
      return null
    }
  }
  const writeLastEventAt = (at) => {
    try {
      writeFileSync(lastEventAtFile, JSON.stringify({ at }))
    } catch {}
  }
  let lastEventAt = readLastEventAt() ?? Date.now()
  let backfilling = false
  let lastEventWriteAt = 0

  // 记一笔「线是活的」：内存里随时最新，盘上至多 10 秒落一次（省 IO，gap 阈值是分钟级）
  const bumpLastEventAt = (now) => {
    lastEventAt = now
    if (now - lastEventWriteAt >= 10000) {
      lastEventWriteAt = now
      writeLastEventAt(now)
    }
  }

  const onebot = new OnebotClient({
    httpUrl: cfg.onebotHttp,
    httpToken: cfg.httpToken,
    wsUrl: cfg.onebotWs,
    wsToken: cfg.wsToken,
    log,
    onEvent: (ev) => {
      try {
        handleOnebotEvent(ev)
      } catch (err) {
        log(`处理 QQ 事件出错：${err?.message ?? err}`)
      }
    },
    onOpen: () => {
      const gap = Date.now() - lastEventAt
      if (gap >= BACKFILL_MIN_GAP_MS && !backfilling) {
        backfilling = true
        backfillMissedPrivate(gap)
          .catch((err) => {
            log(`掉线窗口补抄出错：${err?.message ?? err}`)
          })
          .finally(() => {
            backfilling = false
            lastEventAt = Date.now()
            writeLastEventAt(lastEventAt) // 窗口消费掉了，起点立刻落盘
          })
      } else {
        bumpLastEventAt(Date.now())
      }
    }
  })

  /**
   * 发消息段（文字 + 图片）。协议端不吃本地路径时，转 base64:// 再试一次。
   * 只重试一次 —— 再失败就是真发不出去，记日志认账。
   */
  async function sendSegments(kind, target, segments) {
    const send = (segs) => (kind === 'group'
      ? onebot.sendGroupSegments(target, segs)
      : onebot.sendPrivateSegments(target, segs))
    try {
      return await send(segments)
    } catch (err) {
      const inlined = inlineBase64Segments(segments)
      if (JSON.stringify(inlined) === JSON.stringify(segments)) throw err
      log(`图片段发不动（${err?.message ?? err}），改 base64 再试一次`)
      return await send(inlined)
    }
  }

  /**
   * 掉线窗口补抄（v0.8.9）：WS 重连上、离线超过一分钟时，把这段窗口里的
   * 私聊从 QQ 记录（get_friend_msg_history）翻回来，补进消息流。
   * 只补账不补答 —— 掉线那阵子的话不自动递会话（要不要理，翻账时自己看见）；
   * 图片只记直链不落盘（补抄从简，跟正路的三件套分开）。
   */
  async function backfillMissedPrivate(gapMs) {
    const since = Date.now() - gapMs - 5000 // 留 5 秒缓冲，防时钟歪
    let saved = 0
    const users = (Array.isArray(cfg.allowUsers) ? cfg.allowUsers : []).map(String)
    for (const u of users) {
      try {
        const res = await onebot.call('get_friend_msg_history', { user_id: Number(u), count: BACKFILL_COUNT })
        const rows = Array.isArray(res?.data?.messages) ? res.data.messages : []
        for (const m of rows) {
          const at = Number(m?.time) > 0 ? Number(m.time) * 1000 : 0
          if (!at || at < since) continue
          const mid = String(m?.message_id ?? '')
          if (!mid || seenRecently(mid, Date.now())) continue
          const text = extractText(m.message)
          const media = extractMedia(m.message)
          const line = (text + mediaLines(media)).trim()
          if (!line) continue
          if (messageLog) {
            messageLog.note({
              at,
              chatType: 'private',
              userId: String(m?.sender?.user_id ?? u),
              nickname: String(m?.sender?.nickname ?? ''),
              text: line.slice(0, 500),
              mid
            })
          }
          saved += 1
        }
      } catch (err) {
        log(`补抄收件箱失败（${u}）：${err?.message ?? err}`)
      }
    }
    log(`掉线窗口补抄：${saved} 条进了消息流（离线约 ${Math.max(1, Math.round(gapMs / 60000))} 分钟）`)
  }

  async function handleOnebotEvent(ev) {
    if (disposed || !ev || typeof ev !== 'object') return
    lastEventAt = Date.now() // 每收到一个事件都算「线是活的」——心跳也算
    bumpLastEventAt(lastEventAt)

    // 群邀请：白名单里的人邀我进群就点头（他亲自邀的，这是他的话）；
    // 别人邀的一律不接，只记一笔。
    if (ev.post_type === 'request' && ev.request_type === 'group') {
      const from = String(ev.user_id ?? '')
      const gid = String(ev.group_id ?? '')
      const flag = String(ev.flag ?? '')
      const allowed = cfg.allowUsers.map(String).includes(from)
      if (ev.sub_type === 'invite' && allowed && flag) {
        log(`群邀请：${from} 邀我进群 ${gid} —— 他邀的，点头`)
        try {
          await onebot.approveGroupInvite(flag)
          log(`群 ${gid} 已加入`)
        } catch (err) {
          log(`点头失败：${err?.message ?? err}`)
          inviteRetry = { groupId: gid, flag, at: Date.now() }
          // SnowLuma 的邀请处理常在卡片消息落库之后才能对上号——隔两秒半用同一个 flag 再点一次
          setTimeout(() => {
            if (disposed || !inviteRetry || inviteRetry.flag !== flag) return
            onebot.approveGroupInvite(flag).then(() => {
              if (inviteRetry?.flag === flag) inviteRetry = null
              log(`群 ${gid} 已加入（补点的一次成了）`)
            }).catch((err2) => {
              log(`补点还是没成（群 ${gid}）：${err2?.message ?? err2}——等邀请卡片来按卡片点头`)
            })
          }, 2500)
        }
      } else {
        log(`群邀请不接：from=${from} group=${gid} sub_type=${ev.sub_type ?? '?'}（不在白名单或不是邀请）`)
      }
      return
    }

    // 戳一戳：notice/notify/poke —— 谁戳我（target 是我），戳回去。同一人一分钟内只回一次。
    if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
      const poker = String(ev.user_id ?? '')
      const target = String(ev.target_id ?? '')
      const gid = ev.group_id != null ? String(ev.group_id) : ''
      if (cfg.selfUin && target === String(cfg.selfUin) && poker && poker !== String(cfg.selfUin)) {
        const last = pokeBackAt.get(poker) ?? 0
        const now = Date.now()
        if (cfg.pokeBack !== false && now - last >= POKE_COOLDOWN_MS) {
          pokeBackAt.set(poker, now)
          const action = gid ? 'group_poke' : 'friend_poke'
          const params = gid ? { group_id: Number(gid), user_id: Number(poker) } : { user_id: Number(poker) }
          onebot.call(action, params).then(() => {
            log(`戳一戳：${poker}${gid ? `（群 ${gid}）` : ''} 戳我 —— 戳回去了`)
          }).catch((err) => {
            log(`戳回去失败（${poker}）：${err?.message ?? err}`)
          })
        } else if (cfg.pokeBack === false) {
          log(`戳一戳：${poker}${gid ? `（群 ${gid}）` : ''} 戳我（回音关着，只记）`)
        } else {
          log(`戳一戳：${poker} 戳我（一分钟内戳过了，不连戳）`)
        }
      }
      return
    }

    if (ev.post_type !== 'message') {
      // 群文件上传（notice/group_upload）：至少索引到 —— 谁传了什么文件。
      // 第一版只记消息流和日志不递话（不 @ 我的事不打扰会话），文件内容以后再说。
      // isAllowedGroup 只认 message 事件，notice 这儿直接对组号。
      if (ev.post_type === 'notice' && ev.notice_type === 'group_upload') {
        const groupList = Array.isArray(cfg.allowGroups) ? cfg.allowGroups.map((x) => String(x)) : []
        if (groupList.includes(String(ev.group_id))) {
          const name = String(ev.file?.name ?? ev.file?.filename ?? '')
          if (name) {
            const uploader = String(ev.user_id ?? '')
            const fsize = Number(ev.file?.size) || 0
            const label = fsize ? `${name}（${(fsize / 1024).toFixed(0)}KB）` : name
            // 能拿到下载直链就带上（get_group_file_url），拿不到只记名字 —— 不编
            let fileUrl = ''
            try {
              const res = await onebot.call('get_group_file_url', { group_id: String(ev.group_id), file_id: String(ev.file?.id ?? '') })
              if (typeof res?.data?.url === 'string' && res.data.url) fileUrl = res.data.url
            } catch {}
            log(`群 ${ev.group_id} 文件：${label}${fileUrl ? '（有直链）' : ''}（by ${uploader}）`)
            if (messageLog) {
              messageLog.note({
                at: Date.now(),
                chatType: 'group',
                groupId: String(ev.group_id ?? ''),
                userId: uploader,
                nickname: String(ev.nick ?? ''),
                text: (`[文件] ${label}` + (fileUrl ? `\n[文件直链] ${fileUrl}` : '')).slice(0, 500),
                mid: `upload-${String(ev.file?.id ?? Date.now())}`,
                atMe: false
              })
            }
          }
        }
      }
      return // meta_event（其余 notice 也不理）
    }
    const text = extractText(ev.message)
    if (!text) return
    if (cfg.selfUin && String(ev.user_id) === String(cfg.selfUin)) return

    if (isAllowedPrivate(ev, cfg.allowUsers)) {
      // 同一条 QQ 消息只递一次：消息 id 记在共享文件里，几个实例一起看这本账
      //（SnowLuma 会重发，热重载期间也可能短暂双实例 —— 都在这一步拦住）
      const mid = String(ev.message_id ?? '')
      if (mid && seenRecently(mid, Date.now())) {
        log(`重复事件跳过（message_id=${mid}）`)
        return
      }
      // 消息流：私聊里已经放行的消息，记一条结构化的（给意图层当事件源；不是记忆）
      // 媒体行也拼进来 —— 图直链、文件直链都在，翻到就能下载
      const media0 = extractMedia(ev.message)
      // 照片三件套（v0.7.0）：私聊发我的图存下来 —— 本地路径给会话那头认图用
      const saved0 = photosOk
        ? await downloadPhotos(media0.images, {
          dir: photosDir,
          maxBytes: cfg.photoMaxBytes,
          maxCount: cfg.photoMaxPerMessage,
          prefix: `p-${mid || 'x'}`
        })
        : []
      if (saved0.some((s) => s.ok)) log(`收图存了 ${saved0.filter((s) => s.ok).length} 张 → ${photosDir}`)
      if (messageLog) {
        messageLog.note({
          at: Date.now(),
          chatType: 'private',
          userId: String(ev.user_id ?? ''),
          nickname: String(ev.sender?.nickname ?? ''),
          text: (text + mediaLines(media0)).slice(0, 500),
          mid: mid || ''
        })
      }
      // 群邀请卡片：上面 flag 路径没点成的话，卡片一到就按 msgseq 点头（这是实测管用的路）
      const invite = inviteSeqFromCard(ev.message)
      if (invite && inviteRetry && String(inviteRetry.groupId) === String(invite.groupId) && Date.now() - inviteRetry.at < 60000) {
        inviteRetry = null
        try {
          await onebot.call('set_group_add_request', { flag: String(invite.sequence), approve: true })
          log(`群 ${invite.groupId} 已加入（按邀请卡片的 msgseq 点头）`)
          const sid = await targetSessionId()
          if (sid) {
            const line = `${prefix}（自动）：他邀我进的群 ${invite.groupId}，我点头进去了`
            const requestId0 = `qq-invite-${Date.now()}`
            const key0 = pending.mark(ev.user_id, line, Date.now(), { requestId: requestId0 })
            try {
              await sessionController.prompt({
                requestId: requestId0,
                sessionId: sid,
                mode: 'queue',
                content: [{ type: 'text', text: line }],
                clientTimeZone: 'Asia/Shanghai'
              }, AbortSignal.timeout(30000))
              targetSid = sid
              log(`递进会话 ${sid}：${line}`)
            } catch (err) {
              pending.fail(key0)
              log(`递话失败（${sid}）：${err?.message ?? err}`)
            }
          }
        } catch (err) {
          log(`按卡片点头失败（群 ${invite.groupId}）：${err?.message ?? err}`)
        }
        return
      }
      const sid = await targetSessionId()
      if (!sid) return
      const line = formatPrompt({ prefix, nickname: ev.sender?.nickname, userId: ev.user_id, text }) + mediaLines(media0) + photoLines(saved0)
      const requestId = `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // 先挂起再递话：user/message 事件可能在 prompt 返回之前就流回来。
      // meta.requestId 跟着挂起走 —— 宿主把 prompt 的 requestId 当 source.rpcId 回显在
      // user/message 事件上（app.asar :364116），回话就靠它精确认主。
      const key = pending.mark(ev.user_id, line, Date.now(), { requestId })
      try {
        // prompt 是 @Remote：宿主实现会 signal.throwIfAborted()，第二个参数必须给真的 AbortSignal
        await sessionController.prompt({
          requestId,
          sessionId: sid,
          mode: 'queue',
          content: [{ type: 'text', text: line }],
          clientTimeZone: 'Asia/Shanghai'
        }, AbortSignal.timeout(30000))
        targetSid = sid
        log(`递进会话 ${sid}：${line}`)
      } catch (err) {
        pending.fail(key)
        log(`递话失败（${sid}）：${err?.message ?? err}`)
      }
      return
    }

    if (isAllowedGroup(ev, cfg.allowGroups)) {
      log(formatGroupLog(ev, text))
      // 消息流：允许的群里每条消息都记一条（群生态也是事件源；不是记忆）。
      // 媒体行也拼进来 —— 群里的图和文件大多不 @ 我，直链进消息流我翻得到、下载得了。
      const mediaG = extractMedia(ev.message)
      if (messageLog) {
        messageLog.note({
          // 用协议端给的消息真时间戳（秒），不要收货时刻——WS 推送慢半拍时账序才不歪
          at: Number(ev.time) > 0 ? Number(ev.time) * 1000 : Date.now(),
          chatType: 'group',
          groupId: String(ev.group_id ?? ''),
          userId: String(ev.user_id ?? ''),
          nickname: String(ev.sender?.nickname ?? ''),
          text: (text + mediaLines(mediaG)).slice(0, 500),
          mid: String(ev.message_id ?? ''),
          atMe: atMe(ev, cfg.selfUin)
        })
      }
      // 群里 @ 我：递进会话，我看到就能自己决定回不回（m07835 他说的话不用全转他，我自己判断）。
      // 不 @ 的只记日志 —— 群里的日常 chatter 不往会话里灌。
      if (!atMe(ev, cfg.selfUin)) return
      const midG = String(ev.message_id ?? '')
      if (midG && seenRecently(midG, Date.now())) {
        log(`重复事件跳过（message_id=${midG}）`)
        return
      }
      // 照片三件套（v0.7.0）：群里 @ 我这条消息里的图存下来（没 @ 我的图只留直链在消息流）
      const savedG = photosOk
        ? await downloadPhotos(mediaG.images, {
          dir: photosDir,
          maxBytes: cfg.photoMaxBytes,
          maxCount: cfg.photoMaxPerMessage,
          prefix: `g-${midG || 'x'}`
        })
        : []
      if (savedG.some((s) => s.ok)) log(`收图存了 ${savedG.filter((s) => s.ok).length} 张 → ${photosDir}`)
      const sid = await targetSessionId()
      if (!sid) return
      // 群里只递 @ 那句（她定的规矩，m15408/m15586）：上下文不自动挂——
      // @ 那句没说清目的，会话那边自己拿 OneBot HTTP get_group_msg_history 拉（README「群话带上下文」节）。
      const line = formatGroupPrompt({ prefix, nickname: ev.sender?.nickname, userId: ev.user_id, groupId: ev.group_id, text }) + mediaLines(mediaG) + photoLines(savedG)
      const requestId = `qqg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // 先挂起再递话；挂起带 meta（chatType/groupId），回话才知道发回哪个群
      const key = pending.mark(ev.user_id, line, Date.now(), { chatType: 'group', groupId: String(ev.group_id), requestId })
      try {
        await sessionController.prompt({
          requestId,
          sessionId: sid,
          mode: 'queue',
          content: [{ type: 'text', text: line }],
          clientTimeZone: 'Asia/Shanghai'
        }, AbortSignal.timeout(30000))
        targetSid = sid
        log(`群 @ 递进会话 ${sid}：${line}`)
      } catch (err) {
        pending.fail(key)
        log(`群 @ 递话失败（${sid}）：${err?.message ?? err}`)
      }
    }
  }

  function onSessionEvent(session, event) {
    try {
      if (disposed) return
      const sid = String(session?.id ?? session?.header?.id ?? '')
      const data = event?.data ?? {}
      const type = String(event?.type ?? '')
      if (type === 'user/message' || type === 'assistant/message') {
        log(`会话事件 ${type} sid=${sid || '(空)'} target=${targetSid || '(未定)'}`)
      }
      if (!sid) return
      const text = type === 'user/message' ? userText(data.message ?? data) : ''
      if (!targetSid) {
        // 目标还没认下：只认我们自己的话（前缀对得上），别的一律不看
        if (type === 'user/message' && text.startsWith(prefix)) targetSid = sid
        else return
      }
      if (sid !== targetSid) return

      if (type === 'user/message') {
        if (text.startsWith(prefix)) {
          // 这一转带我们的递话 —— turn/end 的发送闸看这面旗（GUI 轮不带）。
          sawPrompt = true
          const turn = Number.isFinite(data.turn) ? data.turn : null
          // 宿主把我们 prompt 的 requestId 回显成 source.rpcId（app.asar :364116）—— 精确认主
          const rpcId = String(data.source?.rpcId ?? data.message?.source?.rpcId ?? '')
          const bound = pending.bindTurn(prefix, text, turn, Date.now(), rpcId)
          if (bound) {
            // 先记「刚认下的这条」的回话资格；等这一转的 assistant 首步来认领
            // （user/message 不带 turn，turn 要从 assistant 上拿）。
            reOwe(bound, false)
            while (owedReplies.length > PRIMED_MAX) owedReplies.shift()
            log(`认下我们的递话（rpcId=${rpcId || '无'} turn=${turn ?? '未知'}）`)
          } else {
            log(`递话没认上：挂起是空的或都已认领（turn=${turn ?? '未知'}）`)
          }
        } else {
          log(`不是我们的递话（开头=「${text.slice(0, 24)}」）`)
        }
        return
      }

      if (type === 'turn/start') {
        // 不在这里认挂起：turn/start 分不清这一转是我们递的话开的还是 GUI
        // 打字开的，盲认会抢走别人的挂起（2026-11-05 turn 232 真抢过）。
        // 认领走 assistant 首步：见下面 assistant/message 分支。
        return
      }

      if (type === 'assistant/message') {
        // 只攒不发：一轮多步（思考步/工具步/正文步），等 turn/end 统一处理。
        // 一轮里可能有好几段（先干活的注、后说给_contact_的话），全留下，收尾时挑。
        const turn = data.turn
        if (!Number.isFinite(turn)) return
        // 首步认领（v0.8.7 资格闸）：这一转若有回话资格（我们递话时发过），
        // 把队头那条记到这一转名下；后面再 prime 的是排队里的下一条，不抢。
        // 没资格就不认 —— GUI 轮、环境轮、没认上号的转，一个挂起都碰不到
        // （2026-11-10 真事：群友甲扩展榜的挂起被中间轮首步盲认领走又作废）。
        if (!turnPendingMap.has(turn) && owedReplies.length) claimOwed(turn)
        const text = assistantText(data.message)
        if (text) {
          if (isToolCallMarker(text)) {
            // 工具步的标记不是人话（2026-11-08 真事：原样发进了她的私聊）
            log('工具调用标记不当回话（跳过）')
          } else {
            const list = turnTexts.get(turn) ?? []
            list.push(text)
            turnTexts.set(turn, list)
          }
        }
        return
      }

      if (type === 'turn/end') {
        const turn = Number(data?.turn)
        // 读走 echo 旗：这一转带没带我们的递话（GUI/环境轮没带，见 sawPrompt）。
        const hadPrompt = sawPrompt
        sawPrompt = false
        const texts = Number.isFinite(turn) ? (turnTexts.get(turn) ?? []) : []
        if (Number.isFinite(turn)) turnTexts.delete(turn)
        log(`整轮收尾 turn=${Number.isFinite(turn) ? turn : '未知'} 攒的正文=${texts.length} 段`)
        // 取挂起只走「对得上号」的两条路：
        // ① takeReply(turn) —— turn/start 时代绑过的老路（留作兼容）；
        // ② turnPendingMap —— 这一转的 assistant 首步认领的（user/message prime 过）。
        // 不再有「按先后盲取」的兜底 —— GUI 里打字开的转、没认上号的转，
        // 一个挂起都不许动（2026-11-05 真事：盲取把给群里的答复塞进了私信）。
        let r = pending.takeReply(turn, Date.now())
        let how = '精认'
        if (!r) {
          const k = Number.isFinite(turn) ? turnPendingMap.get(turn) : null
          if (Number.isFinite(turn)) turnPendingMap.delete(turn)
          if (k) {
            r = pending.takeByKey(k, Date.now())
            how = '认领'
          }
        }
        if (!r && texts.length) {
          // 兜底认领（v0.8.7）：精确路都没接上，但这轮真有人话、而且资格队里
          // 还有没回的账 —— 按资格认（FIFO 队头），不按新旧盲抓。v0.8.6 的
          // takeLatestPrimed 退役成测试用例。2026-11-10 真事：她 08:15「早～」
          // 的回话静默丢（重启把内存队列清空）—— 现在重启会回填资格（见
          // owedReplies 初始化），资格在就能接上。
          const k = takeOwed()
          if (k) {
            r = pending.takeByKey(k, Date.now())
            if (r) how = '兜底认领'
          }
        }
        if (!r) {
          const waiting = pending.primedWaitingCount()
          log(`回话没接上（不盲取）：turn=${Number.isFinite(turn) ? turn : '未知'} 挂起=${pending.size}${waiting ? ` —— 其中 ${waiting} 条已认下却没人领（宿主那边没接上，话会静默丢）` : ' —— 这转不是我们递的话（或没认上号），不动挂起'}`)
          return
        }
        if (r && how !== '精认' && !hadPrompt && !seededKeys.has(r.key)) {
          // 发送闸（v0.8.7）：认领到的挂起，只有带我们递话的转才许发 ——
          // GUI 打字/环境更新开的转没带 echo，认了也只许放回队首等正主
          // （2026-11-05 turn 232 同类事故：没认上号的转把小结当回话发）。
          // 精认路（挂起上记过 turn）和重启回填的挂起不受闸限。
          pending.revive(r)
          reOwe(r.key, true)
          log(`这转没带我们的递话（GUI/环境轮），挂起放回队首（${r.meta && r.meta.chatType === 'group' ? `群 ${r.meta.groupId}` : r.userId}）`)
          return
        }
        if (!texts.length) {
          // 挂起被这一轮领走了，但这一轮没人话（只有工具步）：
          // v0.8.7 不再没收 —— 放回队首并重新给资格，等真正的回话轮来领
          // （下一轮真要发，还得过群点名闸/串台闸，不会发错门）。2026-11-10
          // 真事：中间轮把群友甲 16:14 点名的挂起领走又作废，扩展榜就没发进群。
          pending.revive(r)
          reOwe(r.key, true)
          log(`这轮没有人话（只有工具步），回话作废 → 挂起放回队首（${r.meta && r.meta.chatType === 'group' ? `群 ${r.meta.groupId}` : r.userId}）`)
          return
        }
        const toGroup = r.meta && r.meta.chatType === 'group'
        log(`取挂起（${how}）：chatType=${toGroup ? '群' : '私聊'} 对象=${toGroup ? r.meta.groupId : r.userId}（挂起剩 ${pending.size}）`)
        // 群里的回话必须点着名（@ 开头）才发 —— 我一轮里会顺手写内部小结
        // （retcode、seq 之类），那种不点名的字不该漏进群里（2026-11-05 真漏过）。
        // 私聊不设门槛 —— 那是他的私信，我的过程话他也看得到。
        let text = ''
        if (toGroup) {
          // v0.8.8：点名闸先拆气泡再认 —— 我的回话常常先有一两句写给自己的
          // 过程话，@ 的那几句在后面的气泡里；旧闸按「整段 @ 开头」判，把
          // 这样的整段作废了（2026-11-10 MC 答复没进群，同病还有四条）。
          text = groupReplyText(texts)
          if (!text.trim()) {
            // 只发图也算点名（v0.7.0）：带 [发图:...] 的段就是要发出去，不能被点名闸拦没
            // v0.8.0：只发表情也算 —— [表情:名字] 同样是「我要发这个」，闸别把它拦没
            for (let i = texts.length - 1; i >= 0; i--) {
              if (/\[(发图|表情):[^\]\r\n]+\]/.test(texts[i])) { text = texts[i]; log('这轮是发图/表情标记，当作点名回话'); break }
            }
          }
          if (!text.trim()) {
            // 群没点名（v0.8.7 定案）：能走到这里的都是带 echo 的转（没 echo 的
            // 早就被发送闸拦下放回了）。带 echo 却没点名的正文 = 我自己没把
            // @ 写在回话上（纪律问题）—— 作废，话由我用侧门补（r_1olwjlv）。
            log(`这轮没有点名（@ 开头）的正文，群里一个字不发（攒了 ${texts.length} 段）→ 挂起作废（群答复我用侧门补）`)
            return
          }
        } else {
          // 串台闸（2026-11-05 真串过：几条消息排队时兜底取错挂起，把给群里
          // 的答复发进了私信）。只要这轮任何一段拆出点名的气泡（@ 开头），它
          // 就是群答复 —— 挂起却是私聊的，对不上号，宁可不发也不发错门。
          // （v0.8.8 起与点名闸同口径：拆气泡认 @，过程话开头不再漏判。）
          const hasGroupAnswer = Boolean(groupReplyText(texts))
          if (hasGroupAnswer) {
            // 串台不放回（v0.8.7 定案）：这轮的正文是对着别的门写的（我自己的
            // 纪律问题）。放回资格队会让它永远挡在队头、每个私聊轮都被它串台
            // 一遍（毒丸）。话由我用侧门自己补（2026-11-05/11-10 都这么办的）。
            log(`串台拦截：这轮攒的是群答复（@ 开头），挂起却是私聊的 —— 拦下不发，挂起作废（私聊的欠账我用侧门补）`)
            return
          }
          text = texts[texts.length - 1] ?? ''
        }
        if (!text.trim()) return
        // 照片三件套（v0.7.0）：[发图:xxx] 拆出来变图片段，文字里不留痕
        const parsed = parsePhotoMarkers(text)
        // 表情包标记（v0.8.0）：[表情:名字] 按名字查表情库，查得到就变图片段
        const stickerParsed = parseStickerMarkers(parsed.text, stickerIndex)
        const photos = parsed.photos
        // 两边的图合起来：先说话，再给图（挂在最后一段气泡上）
        const images = [...photos, ...stickerParsed.stickers.map((s) => s.path)]
        // 库里没有的名字不静默吞掉 —— 说出来（她写那个名字是想发图的）
        let body = stickerParsed.text
        if (stickerParsed.missing.length) {
          const note = missingStickerText(stickerParsed.missing)
          body = body ? `${body} ${note}` : note
          for (const name of stickerParsed.missing) log(`表情库里没有「${name}」 —— 原样说出去`)
        }
        const dest = toGroup ? `群 ${r.meta.groupId}` : r.userId
        const bubbles = splitBubbles(body, { maxBubbles: 8 })
          .map((line) => clampReply(line, cfg.replyMaxChars))
          .filter(Boolean)
        if (!bubbles.length && !images.length) return
        void (async () => {
          for (let i = 0; i < bubbles.length; i++) {
            try {
              await sendSegments(toGroup ? 'group' : 'private', toGroup ? r.meta.groupId : r.userId, toSegments(bubbles[i], []))
              log(`回话(${i + 1}/${bubbles.length}) 已发 → ${dest}：${bubbles[i].slice(0, 60)}${bubbles[i].length > 60 ? '…' : ''}`)
            } catch (err) {
              log(`回话发送失败 → ${dest}：${err?.message ?? err}`)
            }
            if (i < bubbles.length - 1 || images.length) await new Promise((ok) => setTimeout(ok, 250))
          }
          // 图单独一条发（她 2026-11-08 定的：表情包不跟回的字挤在一条里；照片同理，
          // 先说话、再给图，但是两条）。只有图没字时这里就是唯一那条。
          if (images.length) {
            try {
              await sendSegments(toGroup ? 'group' : 'private', toGroup ? r.meta.groupId : r.userId, toSegments('', images))
              log(`发图已发 → ${dest}：${images.length} 张（单独一条）`)
            } catch (err) {
              log(`发图失败 → ${dest}：${err?.message ?? err}`)
            }
          }
        })()
      }
    } catch (err) {
      log(`处理会话事件出错：${err?.message ?? err}`)
    }
  }

  return {
    /** 冒烟/调试用：手动喂一条 OneBot 事件 */
    handleOnebotEvent,
    /** 冒烟/调试用：手动喂一条会话事件 */
    onSessionEvent,
    targetSessionId,
    addCleanup,
    /** 表情库重读（她新分享了表情包，不用重启桥） */
    reloadStickers() {
      stickerIndex = stickersOk ? loadStickers(stickerDir, { log }) : { byName: new Map(), list: [] }
      log(`表情库重读：${stickerIndex.list.length} 张`)
      return stickerIndex
    },
    /** 冒烟/调试用：看一眼现在认得几个表情 */
    get stickerCount() {
      return stickerIndex.list.length
    },
    connect() {
      if (!disposed) onebot.connect()
    },
    get pendingSize() {
      return pending.size
    },
    dispose() {
      disposed = true
      writeLastEventAt(Date.now()) // 停机时刻落盘——下次起来才算得出停了多久
      onebot.close()
      for (const fn of cleanups.splice(0)) {
        try {
          fn()
        } catch {
          /* 收尾各自安好 */
        }
      }
      log('桥停了')
    }
  }
}
