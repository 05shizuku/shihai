// Book——账本协议的显式状态容器（G-1 批③，2026-11-22）。
//
// 为什么有这个文件：批③要把 index.js 里的账本协议（loadBook/pullFast/pullIntent/
// loadEchoIndex/loadVikarmaIndex/saveNodes/keepTail/展示与三写入点）从闭包里抽出来。
// 抽法（大肥鱼批③绿灯时定的）：闭包状态不逐函数传参——全部装进一个 Book，
// 协议函数统一收 book 首参。三个好处：闭包变显式状态（抽错编译期就报）；
// 九工具侧只传一个东西；G-2 服务化时服务持有的就是同一个 Book。
//
// 批③起本文件承载协议本体：createBook 造出全部显式状态，协议函数从 index.js
// 逐行搬来（闭包引用按 docs/g1-batch3-book-skeleton.md §3 的映射表改成 book.*，
// 现逻辑逐行不变）。行为零变化：characterization 四钉、冒烟 409、考卷逐题一致
// 是判官。index.js 里 pullFast/pullIntent 留同名薄壳做宿主侧绑定（cfg 闸门 +
// 源路径解析），cfg 不进 Book（§1.4 的拍板）。
//
// 独立性纪律：本目录（core/protocol/）不 import core/ 的纯函数件之外的东西，
// 也不 import index.js —— 账本协议是被抽出来的地基，不许反向依赖宿主胶水。
// 文件 I/O 助手用 ./io.js（与 dsh-remember/lib/store.js 逐字同源的副本）。

import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isSealed, normNodes } from '../memory.js'
import { normEmotionLine } from '../emotion.js'
import { normFastEvent, pushFastIndex } from '../fast.js'
import {
  intentEventFromMessage,
  intentIdFromMessage,
  normIntentEvent,
  pushIntentIndex,
} from '../intent.js'
import {
  appendJsonLine,
  atomicWriteJson,
  keepTailLines,
  readJsonLines,
  readJsonLinesFrom,
  readJsonSafe,
  readJsonSafeSticky,
  readTextSafe,
} from './io.js'

/**
 * 组装 Book：账本协议的全部显式状态。
 *
 * @param {{ dataDir: string, log: Function, dshHome: string }} init
 *   dataDir——账本数据目录（index.js 已按 baseConfig/resolveDshHome 归一）；
 *   log——makeFileLogger 造好的日志函数（协议内部写日志走它）；
 *   dshHome——DSH 家目录（resolveDshHome() 的结果，sproutMoodFile 等家目录推导用）。
 * @returns Book 对象（字段清单见 docs/g1-batch3-book-skeleton.md §1，逐项对应 index.js 现声明）
 */
export function createBook({ dataDir, log, dshHome, bodyHome = '', rememberTag = '', bodySourceTag = '' }) {
  const files = {
    dir: dataDir,
    memory: join(dataDir, 'memory.json'),
    lines: join(dataDir, 'lines.jsonl'),
    config: join(dataDir, 'config.json'),
    log: join(dataDir, 'dsh-remember.log'),
    /** 快层：秒级事件的副本（可再生的抄本——超过上限会裁旧，源头在 dsh-body 家里） */
    fast: join(dataDir, 'fast.jsonl'),
    /** 快层游标：源文件读到哪个字节了（自己的事写自己家） */
    fastCursor: join(dataDir, 'fast.cursor.json'),
    /** 意图层：机器认出来的事的副本（可再生的抄本——超过上限会裁旧，源头在 QQ 桥家里） */
    intent: join(dataDir, 'intent.jsonl'),
    /** 意图层游标：源文件读到哪个字节了 */
    intentCursor: join(dataDir, 'intent.cursor.json'),
    /** 情绪流自己的账：只增不改 */
    emotion: join(dataDir, 'emotion.jsonl'),
    /** 回声档：「被想起」单独记这本（原话层只留我自己写的字） */
    echo: join(dataDir, 'echo.jsonl'),
    /** 违熏档：种子说会做得不一样、实际没做到的账（只增不改；不进复现轴） */
    vikarma: join(dataDir, 'vikarma.jsonl'),
    /** 叫醒的账：上回什么时候醒的（重启后冷却从这儿接着算） */
    wake: join(dataDir, 'wake.json'),
    /** 执受阻尼的账：feelTracker 落盘（批 C6-N7）——silentUntil 不许被重启绕过 */
    feel: join(dataDir, 'feel.json'),
  }

  return {
    // 环境
    dataDir,
    dshHome,
    // 宿主注入（批 D11）：身体家目录与两个 wire 身份——core 不再拼宿主插件名
    bodyHome,
    rememberTag,
    bodySourceTag,
    sproutMoodFile: bodyHome ? join(bodyHome, 'mood-events.jsonl') : '',
    files,
    log,

    // 协议核心态（index.js L393-395/L443 的现声明）
    nodes: [],
    meta: { startedAt: Date.now(), renderCount: 0, lastRenderAt: null, lastRenderError: null, savedAt: null, saveError: null },
    broken: false,   // ← memoryBroken
    backupOk: false, // ← memoryBackupOk

    // 熏习 / 回声 / 染色 / 展示（L498-551）
    echoAt: new Map(),        // id → 被想起的时间戳数组
    echoDedupe: new Map(),    // 同键 10 分钟内只记一次
    recolorAt: new Map(),     // 染色冷却
    latestEchoRow: new Map(), // id → {at, rowId, query, with}（缘起链/违熏反查）
    displayDays: new Map(),   // 展示天集（展示不算现行）
    displayDedupe: new Map(), // 展示记账去重（日期|排序 id 集）

    // 违熏 / 执受（L508-3491）
    vikarmaAt: new Map(),                    // seedId → {at, reason, count}
    vikarmaAgg: { total: 0, byReason: {}, byDay: {} },
    sproutTracker: new Map(),                // seedId → {lastAt, day, count}
    sproutAgg: { day: '', today: 0, total: 0 },
    feelTracker: { dominant: '', at: 0, streak: 0, silentUntil: 0 }, // 同感冷却（全局单槽）+ 连击静默（批 B2）

    // 快层 / 意图层（L456-482）
    fastIndex: [],            // 快层副本索引（裁旧受 fastMaxEvents）
    fastAllIds: new Set(),
    intentIndex: [],          // 意图层副本索引
    intentAllIds: new Set(),
    intentTombstoned: new Set(),
    // 墓碑键（index.js 现声明 L482 的逐字实现）：撤回登记行的 mid 形状是
    // 'recall-原始mid' —— 反解出要盖住的原始 mid；其余 mid 不产生墓碑键。
    // （批②占位写的 `tomb:${mid}` 不是一致实现，2026-11-22 批③子步 1 修正。）
    intentTombKey: (mid) => {
      const s = String(mid ?? '')
      return s.startsWith('recall-') ? s.slice(7) : ''
    },

    // 缓存（读路径 5 秒纪律的产物）
    emotionLinesCache: { at: 0, lines: [] }, // 已退役（批 D7）：由 emotionRows + 字节游标取代，字段保留防外部引用
    echoStatsCache: { at: 0, stats: new Map() },
    // 情绪流常驻索引（批 D7）：启动整读一次，此后增量拉取——不再每 5 秒整本 parse
    emotionRows: [],
    emotionCursor: 0,
    emotionRowIds: new Set(), // 内存去重（批 D7）：写入点顺手 push 的行与 refresh 重读的行只算一份

    // 游标（内存态；落盘 files.fastCursor / files.intentCursor，语义零变化）
    cursor: { fast: {}, intent: {} },

    // 段渲染缓存（批③尾进 Book，与 echoStatsCache 同类的观测缓存）
    streamCache: { day: '', text: '' },
  }
}

// ---------------------------------------------------------------- 协议本体
//
// 以下函数自 index.js 逐行搬来（2026-11-22 批③），闭包引用按映射表改成 book.*：
// nodes→book.nodes、files→book.files、memoryBroken→book.broken、
// memoryBackupOk→book.backupOk、meta→book.meta、echoAt→book.echoAt……
// 现逻辑逐行不变；cfg 由调用方传入（cfg 不进 Book，§1.4）。

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

/** 展示观测的天窗：「常挂」要说的是最近 —— 14 天外的天自动丢弃（不然 cold 会误报陈年条） */
const DISPLAY_DAY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
/** 导出给 index.js 的展示记账过渡用（批③子步 2 后 noteDisplay 内部自用，此外无人引用）。 */
export function pruneDisplayDays(days, now) {
  for (const d of [...days]) {
    const t = Date.parse(`${d}T00:00:00.000Z`)
    if (Number.isFinite(t) && now - t > DISPLAY_DAY_WINDOW_MS) days.delete(d)
  }
}

/** 游标文件名（fileKey）：只存名字不存全路径 —— 搬家/正反斜杠都不认错 */
function cursorKey(source) {
  return String(source ?? '').split(/[\\/]/).pop() ?? ''
}

/** 意图层游标归一：v2 形状原样收；v1 单条游标归到它的文件名下 —— 老游标不浪费。 */
function normIntentCursorState(raw) {
  const state = {}
  if (raw && raw.version === 2 && raw.files && typeof raw.files === 'object') {
    for (const [k, v] of Object.entries(raw.files)) {
      if (v && typeof v === 'object') state[k] = { offset: Number(v.offset) || 0, copied: Number(v.copied) || 0, at: Number(v.at) || 0 }
    }
  } else if (raw && (raw.source || raw.offset != null)) {
    const k = cursorKey(raw.source)
    if (k) state[k] = { offset: Number(raw.offset) || 0, copied: Number(raw.copied) || 0, at: Number(raw.at) || 0 }
  }
  return state
}

/**
 * 账本启动读（自 index.js 逐行搬来，闭包引用改 book.*）。
 * 三道护栏：①重试六次每次隔一拍 ②进程内粘住上一份好的 ③盘上快照。
 * 三层全空之后严格再读一遍——还认不出账就是真损坏：先滚 .corrupt 备份、
 * 亮 book.broken；备份没成，saveNodes 拒绝覆盖写（保原文）。
 * 读出来的 nodes 过 normNodes 后赋 book.nodes。
 */
export function loadBook(book) {
  const snapFile = join(book.dataDir, 'memory.snapshot.json')
  let loaded = null
  let corruptWhy = null
  for (let i = 0; i < 6; i += 1) {
    loaded = readJsonSafeSticky(book.files.memory, null)
    if (isObj(loaded)) {
      try { atomicWriteJson(snapFile, loaded) } catch { /* 快照写不动就算了 */ }
      book.nodes = normNodes(loaded?.nodes ?? [], Date.now())
      return book.nodes
    }
    const until = Date.now() + 100
    while (Date.now() < until) { /* 瞬时读冲突：等一拍再试 */ }
  }
  try {
    const raw = readTextSafe(book.files.memory, '')
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw)
        if (isObj(parsed) && Array.isArray(parsed.nodes)) {
          loaded = parsed // 六连败后严格读反而成了——瞬时冲突结束，拿它当好账本
        } else {
          corruptWhy = 'JSON 认得但形状不对（要 {…, nodes:[…]}）'
        }
      } catch (err) {
        corruptWhy = `解析失败：${String(err?.message ?? err).slice(0, 120)}`
      }
      if (corruptWhy) {
        book.broken = true
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const bak = `${book.files.memory}.corrupt-${stamp}.bak`
          copyFileSync(book.files.memory, bak)
          book.backupOk = true
          book.log(`账本 memory.json 读不出能认的账（${corruptWhy}）。原文已备份到 ${bak} —— 恢复靠它，别删；这次启动按空账本算。`)
        } catch (bakErr) {
          book.log(`账本 memory.json 损坏且备份失败（${String(bakErr?.message ?? bakErr).slice(0, 120)}）—— 本次运行拒绝覆盖写节点表，请先手动备份 ${book.files.memory}。`)
        }
        book.nodes = normNodes([], Date.now())
        return book.nodes
      }
      if (loaded) {
        try { atomicWriteJson(snapFile, loaded) } catch { /* 快照写不动就算了 */ }
        book.nodes = normNodes(loaded?.nodes ?? [], Date.now())
        return book.nodes
      }
    }
  } catch { /* 读文件本身出问题——按三道护栏的兜底走 */ }
  // 快照兜底（批 D1，2026-11-25 外部审查 P0-1）：走到这里 = memory.json 空文件/持续不可读，
  // 且六连重试＋严格重读都没成。兜底不许静默——红灯、留证、日志，三道护栏在这一支也要生效：
  // 没有这三样，任意一次成功保存就把整本账「合法」格掉。
  if (!existsSync(book.files.memory)) {
    // 账本文件不存在 = 首次启动（或整本被挪走）：空账是合法起点，不亮红灯；有快照就先恢复现场。
    const snap = readJsonSafeSticky(snapFile, null)
    if (isObj(snap)) book.log(`账本 memory.json 不在，按快照恢复现场（快照 updatedAt ${new Date(Number(snap.updatedAt) || 0).toISOString()}）。`)
    loaded = isObj(snap) ? snap : null
    book.nodes = normNodes(loaded?.nodes ?? [], Date.now())
    return book.nodes
  }
  book.broken = true
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const bak = `${book.files.memory}.empty-${stamp}.bak`
    copyFileSync(book.files.memory, bak) // 空文件/半截文件也留证：它何时变空，本身就是线索
    book.backupOk = true
    book.log(`账本 memory.json 读不出能认的账（空文件或持续不可读）。现状已备份到 ${bak}；本次按快照兜底——快照之后若还有只落在 memory.json 里的改动，要人工对一遍。`)
  } catch (bakErr) {
    book.log(`账本 memory.json 读不出且备份失败（${String(bakErr?.message ?? bakErr).slice(0, 120)}）——本次运行拒绝覆盖写节点表，请先手动备份 ${book.files.memory}。`)
  }
  const snap = readJsonSafeSticky(snapFile, null)
  loaded = isObj(snap) ? snap : null
  book.nodes = normNodes(loaded?.nodes ?? [], Date.now())
  return book.nodes
}

/**
 * 节点表落盘（自 index.js 逐行搬来，闭包引用改 book.*）。
 * 坏账本没备份成功就拒绝覆盖写（自 shihai 合并，2026-11-15 审查）——
 * 宁可这条记不上，不能把原文冲掉。写成一次 = 红灯解除（characterization 钉）。
 * 返回布尔（批 A2，2026-11-25 外部审查 P1-2）：写成了 true；拒写/写失败 false——
 * 调用方拿它把「假成功」挡在回执外面（不再 log 完就当没发生）。
 */
export function saveNodes(book) {
  if (book.broken && !book.backupOk) {
    book.meta.saveError = 'memory.json 上次解析失败且备份没成 —— 拒绝覆盖写（保原文）'
    book.log(`账本不写入：${book.meta.saveError}`)
    return false
  }
  try {
    atomicWriteJson(book.files.memory, { version: 1, updatedAt: Date.now(), nodes: book.nodes })
    book.broken = false // 写成一次 = 盘上的坏文件已经被好的换掉，红灯解除
    book.meta.savedAt = Date.now()
    book.meta.saveError = null
    return true
  } catch (err) {
    book.meta.saveError = String(err?.message ?? err).slice(0, 200)
    book.log(`账本写不进去：${book.meta.saveError}`)
    return false
  }
}

/**
 * 副本的裁旧（自 pullFast/pullIntent 的两段同形代码收拢，2026-11-22 批③）：
 * 上限内不动；超了只留最新的 cap 条。cap=0 是「不设上限」，不裁。
 * 原话层和回声档不走这条 —— 只增不改的永远只增。
 */
export function keepTail(book, file, cap, label) {
  if (cap > 0) {
    const kept = keepTailLines(file, cap)
    if (kept >= 0) book.log(`${label}裁旧：留最新 ${kept} 条（上限 ${cap}）`)
  }
}

/**
 * 从源文件增量抄新事件。返回抄了几条。（自 index.js 逐行搬来，闭包引用改 book.*）
 * 抄不动就抄不动 —— 源文件坏了不该让账本这边出事。
 * 宿主侧薄壳（index.js）先过 cfg 闸门再解析源路径；这里对 cfg/source 再各自设防。
 */
export function pullFast(book, now, cfg, source) {
  if (!cfg || !cfg.enabled || cfg.fastEnabled === false) return 0
  if (!source) return 0
  const state = readJsonSafeSticky(book.files.fastCursor, {})
  book.cursor.fast = state // 游标内存态挂进 Book（每拍刷新；落盘仍是 files.fastCursor）
  const sameSource = String(state.source ?? '') === source
  const offset = sameSource ? Number(state.offset) || 0 : 0
  let got = null
  try {
    got = readJsonLinesFrom(source, offset)
  } catch (err) {
    book.log(`快层源读不动：${String(err?.message ?? err).slice(0, 160)}`)
    return 0
  }
  if (!got || !got.exists) return 0
  const cap = clamp(cfg.fastMaxEvents, 0, 5000)
  let added = 0
  for (const raw of got.rows) {
    const ev = normFastEvent(raw, { now, defaultSource: book.bodySourceTag })
    if (!ev) continue
    if (book.fastAllIds.has(ev.id)) continue
    try {
      appendJsonLine(book.files.fast, {
        id: ev.id,
        at: ev.at,
        kind: ev.kind,
        text: ev.text,
        source: ev.source,
        detail: ev.detail ?? null,
        copiedAt: now,
      })
    } catch (err) {
      book.log(`快层副本写不进去：${String(err?.message ?? err).slice(0, 160)}`)
      continue
    }
    book.fastAllIds.add(ev.id) // 写成功后再记（批 D12）：append 失败不留僵尸 id，下一拍重抄
    book.fastIndex = pushFastIndex(book.fastIndex, ev, cap)
    added += 1
  }
  if (added) {
    const nextCursor = {
      source,
      offset: got.next,
      at: now,
      copied: (Number(state.copied) || 0) + added,
    }
    try {
      atomicWriteJson(book.files.fastCursor, nextCursor)
    } catch (err) {
      book.log(`快层游标写不进去：${String(err?.message ?? err).slice(0, 160)}`)
    }
    book.cursor.fast = nextCursor
    keepTail(book, book.files.fast, cap, '快层副本') // 裁旧（见 keepTail）
    book.log(`快层抄了 ${added} 条（源 ${source}）`)
  }
  return added
}

/**
 * 从源文件们增量抄新消息，认成意图事件。返回抄了几条。（自 index.js 逐行搬来）
 * 每册一个游标（v2 映射，key=文件名）；旧的单条游标形状读进来归到它的文件名下。
 * 抄不动就抄不动 —— 源文件坏了不该让账本这边出事。
 * labelOf：源文件 → 身份域（'qq-bridge'/'chat'），宿主侧给（intentSourceLabel）。
 */
export function pullIntent(book, now, cfg, sources, labelOf) {
  if (!cfg || !cfg.enabled || cfg.intentEnabled === false) return 0
  if (!Array.isArray(sources) || !sources.length) return 0
  const cap = clamp(cfg.intentMaxEvents, 0, 5000)
  const rawState = readJsonSafeSticky(book.files.intentCursor, {})
  // v2 形状 { version:2, files:{ [文件名]:{offset,copied,at} } }；
  // v1 形状 { source, offset, copied } 归到它文件名下 —— 老游标不浪费。
  book.cursor.intent = normIntentCursorState(rawState) // 游标内存态挂进 Book（每拍刷新）
  const state = book.cursor.intent
  const newFiles = {}
  let total = 0
  const perSource = []
  for (const source of sources) {
    const k = cursorKey(source)
    const same = state[k] && state[k].offset > 0 // offset>0 才是抄过的（offset 0 的空游标不可信——源被裁过旧就重头来）
    const offset = same ? state[k].offset : 0
    let got = null
    try {
      got = readJsonLinesFrom(source, offset)
    } catch (err) {
      book.log(`意图层源读不动：${String(err?.message ?? err).slice(0, 160)}`)
      continue
    }
    if (!got || !got.exists) continue
    const label = labelOf(source)
    let added = 0
    for (const rawRow of got.rows) {
      // 先认身份再分类：同一条消息只算一次（源被裁旧重写时，靠它认出「这条抄过了」）
      const id = intentIdFromMessage(rawRow, { source: label })
      if (id && book.intentAllIds.has(id)) continue
      const ev = intentEventFromMessage(rawRow, { source: label })
      if (!ev) continue
      // 撤回行先进墓碑集（同批里它的原话可能已经抄进索引了，要当场盖住）
      const tk = book.intentTombKey(ev.mid)
      if (tk) {
        book.intentTombstoned.add(tk)
        book.intentIndex = book.intentIndex.filter((x) => !(x && x.mid && book.intentTombstoned.has(x.mid)))
      }
      // 被撤回的原话只入档不进索引 —— 「撤回过」的事实行照常走
      if (ev.mid && book.intentTombstoned.has(ev.mid)) continue
      try {
        appendJsonLine(book.files.intent, {
          id: ev.id,
          at: ev.at,
          kind: ev.kind,
          intensity: ev.intensity,
          text: ev.text,
          source: ev.source,
          from: ev.from ?? '',
          // 消息平台 id：墓碑（撤回登记）靠它认领要盖住的原话（2026-11-17 补的——
          // 以前抄本不带 mid，撤回行落了也认不出盖谁）
          mid: ev.mid ?? '',
          // 是否 @ 我：群轮的受众识别靠它（2026-11-17 复核抓的硬伤——以前不落盘，
          // 重启后 loadIntentIndex 重建的索引里 atMe 恒空，群轮全部判成 solo）
          atMe: ev.atMe === true,
          chatType: ev.chatType ?? '',
          nickname: ev.nickname ?? '',
          groupId: ev.groupId ?? '',
          matched: ev.matched ?? [],
          copiedAt: now,
        })
      } catch (err) {
        book.log(`意图层副本写不进去：${String(err?.message ?? err).slice(0, 160)}`)
        continue
      }
      book.intentAllIds.add(ev.id) // 写成功后再记（批 D12）：append 失败不留僵尸 id，下一拍重抄
      book.intentIndex = pushIntentIndex(book.intentIndex, ev, cap)
      added += 1
    }
    newFiles[k] = { offset: got.next, copied: (state[k]?.copied || 0) + added, at: now }
    if (added) perSource.push(`${k.split('messages-').pop() ?? k} ${added}`)
    total += added
  }
  if (total) {
    const nextCursor = { version: 2, at: now, files: { ...state, ...newFiles } }
    try {
      atomicWriteJson(book.files.intentCursor, nextCursor)
    } catch (err) {
      book.log(`意图层游标写不进去：${String(err?.message ?? err).slice(0, 160)}`)
    }
    book.cursor.intent = nextCursor
    // 副本的裁旧：源那边自己也在裁（旧消息会从桥的文件里消失），所以副本留得比索引宽一点，
    // 至少两千行 —— 源裁了之后，靠这份还能按词翻到旧事。0 = 不裁。
    const copyCap = cap > 0 ? Math.max(cap, 2000) : 0
    keepTail(book, book.files.intent, copyCap, '意图层副本')
    book.log(`意图层抄了 ${total} 条（${perSource.join('，') || sources.length + ' 个源'}）`)
  }
  return total
}

/** 启动时把回声读进索引（自 index.js 逐行搬来，闭包引用改 book.*）：旧档在原话层里，新档单独记 echo.jsonl；之后随写随更。 */
export function loadEchoIndex(book, now = Date.now()) {
  try {
    for (const file of [book.files.lines, book.files.echo]) {
      for (const row of readJsonLines(file, 0)) {
        if (!row) continue
        const at = Number(row.at) || 0
        if (!at) continue
        if (row.kind === 'recolor' && row.ref) {
          // 染色限流索引：一条最近一次「现在想起它」是什么时候、什么颜色
          const key = String(row.ref)
          const prev = book.recolorAt.get(key)
          if (!prev || at > prev.at) book.recolorAt.set(key, { at, dominant: String(row.dominant ?? ''), level: Number(row.level) || 0 })
          continue
        }
        if (row.kind === 'display' && Array.isArray(row.refs)) {
          // 展示观测（不算现行，不进 echoAt）：id -> 被挂到开头过哪些天（14 天窗）
          const day = new Date(at).toISOString().slice(0, 10)
          for (const rid of row.refs) {
            const key = String(rid ?? '').trim()
            if (!key) continue
            const days = book.displayDays.get(key) ?? new Set()
            days.add(day)
            pruneDisplayDays(days, now)
            if (days.size) book.displayDays.set(key, days)
            else book.displayDays.delete(key)
          }
          continue
        }
        if (row.kind !== 'echo' || !Array.isArray(row.refs)) continue
        const rowId = String(row.id ?? '')
        for (const rid of row.refs) {
          const key = String(rid ?? '').trim()
          if (!key) continue
          const list = book.echoAt.get(key) ?? []
          list.push(at)
          // 上限给足余量：窗口 42 天（3τ），热条一个月被熏上百次也不该把最老的挤掉
          book.echoAt.set(key, list.slice(-200))
          const prevLatest = book.latestEchoRow.get(key)
          if (!prevLatest || at > prevLatest.at) {
            // 瀑流/缘起链（定案 B）：顺手多存 query 与同现的种子——echo 行自带，零成本
            book.latestEchoRow.set(key, {
              at,
              rowId,
              query: String(row.query ?? ''),
              with: (row.refs ?? []).map(String).filter((x) => x !== key),
            })
          }
        }
      }
    }
  } catch {
    /* 回声读不出来就当没有 —— 回弹不该把账本弄坏 */
  }
}

/** 违熏索引（自 index.js 逐行搬来，闭包引用改 book.*）：seedId -> {at, reason, count}（最近一次 + 累计次数；status 聚合也从这走） */
export function loadVikarmaIndex(book) {
  try {
    for (const row of readJsonLines(book.files.vikarma, 0)) {
      if (!row || row.kind !== 'vikarma') continue
      const sid = String(row.seedId ?? '').trim()
      if (!sid) continue
      const at = Number(row.at) || 0
      if (!at) continue
      const reason = String(row.reason ?? '')
      const prev = book.vikarmaAt.get(sid) ?? { at: 0, reason: '', count: 0 }
      book.vikarmaAt.set(sid, {
        at: Math.max(prev.at, at),
        reason: at >= prev.at ? reason : prev.reason,
        count: prev.count + 1,
      })
      book.vikarmaAgg.total += 1
      book.vikarmaAgg.byReason[reason] = (book.vikarmaAgg.byReason[reason] ?? 0) + 1
      const day = new Date(at).toISOString().slice(0, 10)
      book.vikarmaAgg.byDay[day] = (book.vikarmaAgg.byDay[day] ?? 0) + 1
    }
  } catch {
    /* 读不出就当没有 */
  }
}

// ---------------------------------------------------------------- 写入点（批③子步 2）
//
// 回声 / 违熏 / 执受三个写入点与展示记账，自 index.js 逐行搬来（闭包引用改 book.*）。
// 写入点只有这些；其余一切（原话层 lines.jsonl、情绪流 emotion.jsonl、配置 config.json、
// 叫醒 wake.json）不在这里写。

/** 同一组条多久内不重复记「被想起」。 */
const ECHO_DEDUPE_MS = 10 * 60 * 1000
/** 一笔回声/一次染色最多带几条（跟 recall 的默认 limit 对齐；index.js 的 recolorRecall 另持一份同值） */
const RECALL_ECHO_MAX = 5

/**
 * 翻到就记一笔「被想起」（自 index.js 的 recallEcho 逐行搬来，收 book）。
 * 同一组条 10 分钟内不重复记 —— 一次对话里连翻几下是同一次醒，不是几次。
 */
export function noteEcho(book, list, query, now = Date.now(), dir = null) {
  try {
    // 按住的不熏（三种按法都算）—— 回声喂的是复现轴，按住的条不参与竞争；
    // 只查 !n.sealed 会漏掉 until/cond 按住的（include_sealed 路径翻到它们）。
    // isSealed 必须带目录：cond 按住要查「另一条还在不在」，不传目录会
    // 把 cond 按住误判成翻篇（2026-11-16 复核抓到的实证）。
    // 松开之后重新被翻到，才重新开始熏。
    const ids = (Array.isArray(list) ? list : [])
      .filter((n) => n && n.id && !isSealed(n, now, dir))
      .map((n) => n.id)
      .slice(0, RECALL_ECHO_MAX)
    if (!ids.length) return false
    // 去重键按集合算（排序后拼）—— 翻两遍顺序差一点也算同一组，不重复记
    const key = [...ids].sort().join(',')
    const last = book.echoDedupe.get(key) || 0
    if (now - last < ECHO_DEDUPE_MS) return false
    // 去重表顺手清理：只留两倍窗内的键，别让内存攒一辈子（2026-11-16 复核建议）
    for (const [k, at] of book.echoDedupe) {
      if (now - at > ECHO_DEDUPE_MS * 2) book.echoDedupe.delete(k)
    }
    book.echoDedupe.set(key, now)
    const row = {
      id: `e_${now.toString(36)}`,
      at: now,
      kind: 'echo',
      text: `被想起：「${String(query ?? '').slice(0, 80)}」→ ${ids.join('、')}`,
      // 缘起链的原始数据：哪条种子、在什么缘（query）下现行。机器可读，别让下游去解析 text
      query: String(query ?? '').slice(0, 80),
      refs: ids,
      source: 'recall',
    }
    appendJsonLine(book.files.echo, row)
    for (const rid of ids) {
      const arr = book.echoAt.get(rid) ?? []
      arr.push(now)
      book.echoAt.set(rid, arr.slice(-200))
      book.latestEchoRow.set(rid, {
        at: now,
        rowId: row.id,
        query: String(row.query ?? ''),
        with: ids.filter((x) => x !== rid),
      })
    }
    book.echoStatsCache = { at: 0, stats: new Map() } // 回声变了，熏习统计作废
    return true
  } catch {
    return false
  }
}

/**
 * 违熏写入点（自 vikarma 工具的落账段收拢，2026-11-22 批③子步 2，收 book）：
 * 追加一行进 vikarma.jsonl + 内存索引（book.vikarmaAt / book.vikarmaAgg）同步更新。
 * 写失败向上抛 —— 回执文案由调用方按原文给（「违熏写不进去：…」）。
 */
export function noteVikarma(book, row) {
  appendJsonLine(book.files.vikarma, row)
  const seedId = String(row.seedId ?? '')
  const reason = String(row.reason ?? '')
  const now = Number(row.at) || 0
  book.vikarmaAt.set(seedId, {
    at: now,
    reason,
    count: (book.vikarmaAt.get(seedId)?.count ?? 0) + 1,
  })
  book.vikarmaAgg.total += 1
  book.vikarmaAgg.byReason[reason] = (book.vikarmaAgg.byReason[reason] ?? 0) + 1
  const vkDay = new Date(now).toISOString().slice(0, 10)
  book.vikarmaAgg.byDay[vkDay] = (book.vikarmaAgg.byDay[vkDay] ?? 0) + 1
}

/**
 * 展示记账（自 index.js 的 recordDisplay 逐行搬来，收 book）。
 * 展示观测（2026-11-16 拍板：展示不算现行，只记账不喂复现轴）。
 * 每天每组条最多记一行（dedupe 键 = 日期|排序后的 id 集）——
 * 用途：找出「常挂但从不被想起」的条（死重或 recall 词表覆盖不到），只观测不改排名。
 */
export function noteDisplay(book, list, now) {
  try {
    const ids = list.map((n) => n.id).filter(Boolean).sort()
    if (!ids.length) return
    // 「天」按 UTC 日（与 loadEchoIndex 的去重口径一致；东八区日界在早八点，见 philosophy.md）
    const day = new Date(now).toISOString().slice(0, 10)
    const key = `${day}|${ids.join(',')}`
    if (book.displayDedupe.has(key)) return
    book.displayDedupe.set(key, now)
    // 前几天的键清掉，防无限增长（盘上的行还在，只是内存去重表不用留）
    for (const k of book.displayDedupe.keys()) {
      if (!k.startsWith(day)) book.displayDedupe.delete(k)
    }
    appendJsonLine(book.files.echo, {
      id: `d_${now.toString(36)}`,
      at: now,
      kind: 'display',
      refs: ids,
      source: 'inject',
    })
    for (const rid of ids) {
      const days = book.displayDays.get(rid) ?? new Set()
      days.add(day)
      pruneDisplayDays(days, now)
      if (days.size) book.displayDays.set(rid, days)
      else book.displayDays.delete(rid)
    }
  } catch {
    /* 观测失败不挡注入 */
  }
}

/** sprout 的身体感觉措辞（从情绪枚举来，无阿拉伯数字） */
const SPROUT_TEXT = {
  warm: '心头一暖',
  pleased: '心头一亮',
  curious: '心头一动',
  tense: '心头一紧',
  down: '心头一沉',
  restless: '心头一躁',
  lonely: '心头一空',
}

/**
 * recall 现行的种子过了一道双门 → 往身体家 mood-events.jsonl 追加一行 sprout
 * （自 index.js 逐行搬来，收 book；身体家的路径在 book.sproutMoodFile）。
 * 双门：染色门（moodAt ≠ calm 且 level ≥ min）或 心境门（当下主导 ≠ calm 且 weight ≥ 0.75）。
 * 限幅：每种子冷却 + 每种子每日帽。写失败只记日志（快层同规）。
 * 身体读侧按 detail.dominant 折成 mood 标量极小偏移——系数在收方。
 * cfg 由调用方传（cfg 不进 Book，§1.4）。
 */
export function sproutToBody(book, list, emoState, now, cfg) {
  if (!cfg || cfg.sproutBodyEnabled === false || !emoState) return
  const cooldownMs = clamp(cfg.sproutBodyCooldownMinutes, 1, 120) * 60000
  const feelCooldownMs = clamp(cfg.sproutBodyFeelCooldownMinutes, 30, 720) * 60000
  const dayKey = new Date(now).toISOString().slice(0, 10)
  const minLevel = clamp(cfg.sproutBodyMinLevel, 0.1, 1)
  const dailyCap = clamp(cfg.sproutBodyDailyCap, 1, 20)
  const totalCap = clamp(cfg.sproutBodyDailyTotalCap, 3, 50)
  // 日切上提（定案 C-amend）：全局日帽的检查要在翻转之后才准
  if (book.sproutAgg.day !== dayKey) {
    book.sproutAgg.day = dayKey
    book.sproutAgg.today = 0
  }
  const dominant = emoState.dominant ?? 'calm'
  const level = Number(emoState.level) || 0
  for (const n of list) {
    if (!n || !n.id) continue
    const tracker = book.sproutTracker.get(n.id) ?? { lastAt: 0, day: '', count: 0 }
    // 冷却
    if (now - tracker.lastAt < cooldownMs) continue
    // 每日帽
    const todayCount = tracker.day === dayKey ? tracker.count : 0
    if (todayCount >= dailyCap) continue
    // 双门
    const moodGate = n.moodAt && n.moodAt.dominant !== 'calm' && Number(n.moodAt.level) >= minLevel
    const stateGate = dominant !== 'calm' && Number(n.weight) >= 0.75
    if (!moodGate && !stateGate) continue
    // 强制静默期（批 B2 刀 a，2026-11-25）：连击触发后的 2 小时里全门闭嘴——反射弧也要有不应期
    if (now < (book.feelTracker.silentUntil || 0)) continue
    // 报哪种颜色（2026-11-18 复核拍板）：染色门报种子的颜色，心境门报当下的
    const feel = moodGate ? n.moodAt : emoState
    const feelDominant = feel.dominant ?? dominant
    const feelLevel = Number(feel.level) || level
    // 全局日帽（定案 C-amend ②）：所有种子合计一天最多几声——过了就全门静默
    if (book.sproutAgg.today >= totalCap) continue
    // 感觉冷却（定案 C-amend ①）：同一种感觉不重复播报——这声刚才说过了就闭嘴
    if (book.feelTracker.dominant === feelDominant && now - book.feelTracker.at < feelCooldownMs) continue
    // 连击强制静默（批 B2 刀 a，2026-11-25）：60 分钟内第 3 次心头一动——强制静默 2 小时。
    // 执受是反射弧，不是话痨的资格；连着三次都是身体在抢话，就该闭嘴一会儿。
    const withinStreak = now - (book.feelTracker.at || 0) < 60 * 60000
    const streak = withinStreak ? ((book.feelTracker.streak || 0) + 1) : 1
    if (streak >= 3) {
      book.feelTracker.silentUntil = now + 2 * 3600 * 1000
      book.feelTracker.streak = 0
      saveFeelTracker(book) // 落盘（批 C6-N7）：静默期跨重启有效
      book.log('执受阻尼：60 分钟内第 3 次心头一动——强制静默 2 小时')
      continue
    }
    // 写
    const text = SPROUT_TEXT[feelDominant] ?? '心头一动'
    const row = {
      at: now,
      kind: 'sprout',
      text,
      detail: { seedId: n.id, dominant: feelDominant, level: feelLevel },
      source: book.rememberTag,
    }
    try {
      appendJsonLine(book.sproutMoodFile, row)
    } catch (err) {
      book.log(`执受写不进身体家：${String(err?.message ?? err).slice(0, 160)}`)
      continue
    }
    book.sproutTracker.set(n.id, { lastAt: now, day: dayKey, count: todayCount + 1 })
    book.sproutAgg.today += 1
    book.sproutAgg.total += 1
    // 连击计数只在写成功后涨（批 C6-N6；批 D6 重排：tracker/agg 就位后再落盘，
    // feel.json 一次带上执受追踪完整现场——重启回读不丢日帽，幽灵连击的缝照堵）。
    book.feelTracker.streak = streak
    book.feelTracker.at = now
    book.feelTracker.dominant = feelDominant
    saveFeelTracker(book)
    book.log(`执受：${n.id} → 身体（${text} · ${feelDominant} ${feelLevel}）`)
  }
}

// ---------------------------------------------------------------- 情绪流常驻索引（批 D7，2026-11-26）

/**
 * 启动整读一次：情绪行进内存（emotionRows），字节游标落到文件尾。
 * 此后 refreshEmotion 只拉新增字节——11MB 账每 5 秒整本 parse（47ms/拍、4.3 万对象/拍）
 * 的灯案复发通道就此关死。情绪流是地层（拍板 2026-11-25：不裁旧），内存换时间。
 */
export function loadEmotionIndex(book) {
  const got = readJsonLinesFrom(book.files.emotion, 0)
  const rows = []
  for (const raw of got.rows) {
    const n = normEmotionLine(raw)
    if (n) rows.push(n)
  }
  book.emotionRows = rows
  book.emotionRowIds = new Set(rows.map((n) => String(n.id ?? '')).filter(Boolean))
  book.emotionCursor = got.next
  return rows.length
}

/** 增量拉一次：只读游标之后的新字节（通常零字节，一次 stat 就回来）。文件被截断/轮转 → reset 从头重建。 */
export function refreshEmotion(book) {
  const got = readJsonLinesFrom(book.files.emotion, book.emotionCursor)
  if (got.reset) {
    book.emotionRows = [] // 账被外力截断：内存索引从头重建，语义与 pull* 的 reset 一致
    book.emotionRowIds.clear()
  }
  for (const raw of got.rows) {
    const n = normEmotionLine(raw)
    if (!n) continue
    const id = String(n.id ?? '')
    if (id && book.emotionRowIds.has(id)) continue // 写入点已顺手进内存（noteEmotion push），文件重读只算一份
    if (id) book.emotionRowIds.add(id)
    book.emotionRows.push(n)
  }
  book.emotionCursor = got.next
  return got.rows.length
}

// ---------------------------------------------------------------- 执受阻尼的账（批 C6-N7）

/** feelTracker 落盘回读：silentUntil/streak 纯内存会被重启绕过（强通破闸）。
 *  小文件整存整取（atomicWriteJson）；写点只有 sproutToBody 的两处变更。 */
export function loadFeelTracker(book) {
  const saved = readJsonSafe(book.files.feel, null)
  if (!isObj(saved)) return
  if (Number.isFinite(Number(saved.at))) book.feelTracker.at = Number(saved.at) || 0
  if (typeof saved.dominant === 'string') book.feelTracker.dominant = saved.dominant
  if (Number.isFinite(Number(saved.streak))) book.feelTracker.streak = Math.max(0, Number(saved.streak) || 0)
  if (Number.isFinite(Number(saved.silentUntil))) book.feelTracker.silentUntil = Math.max(0, Number(saved.silentUntil) || 0)
  // 执受追踪回读（批 D6）：每日帽/每种子冷却不因重启清零——帽被重启绕过连发的缝堵上。
  if (isObj(saved.sproutAgg)) {
    book.sproutAgg.day = String(saved.sproutAgg.day ?? '')
    book.sproutAgg.today = Number(saved.sproutAgg.today) || 0
    book.sproutAgg.total = Number(saved.sproutAgg.total) || 0
  }
  if (isObj(saved.sproutTracker)) {
    for (const [sid, t] of Object.entries(saved.sproutTracker)) {
      if (!sid || !isObj(t)) continue
      book.sproutTracker.set(String(sid), { lastAt: Number(t.lastAt) || 0, day: String(t.day ?? ''), count: Number(t.count) || 0 })
    }
  }
}

export function saveFeelTracker(book) {
  try {
    // 追踪表随手剪枝：7 天没动静的种子不进快照（文件有界；7 天前的冷却早就过期了，行为不变）
    const now = Date.now()
    const sproutTracker = {}
    for (const [sid, t] of book.sproutTracker) {
      if (now - (Number(t.lastAt) || 0) > 7 * 24 * 60 * 60 * 1000) continue
      sproutTracker[sid] = t
    }
    atomicWriteJson(book.files.feel, { ...book.feelTracker, sproutAgg: { ...book.sproutAgg }, sproutTracker, savedAt: now })
  } catch (err) {
    book.log(`执受阻尼账写不进去：${String(err?.message ?? err).slice(0, 120)}`)
  }
}