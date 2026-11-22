// Book——账本协议的显式状态容器（G-1 批③前置件，2026-11-22）。
//
// 为什么有这个文件：批③要把 index.js 里的账本协议（loadBook/pullFast/pullIntent/
// loadEchoIndex/loadVikarmaIndex/saveNodes/keepTail/展示与三写入点）从闭包里抽出来。
// 抽法（大肥鱼批③绿灯时定的）：闭包状态不逐函数传参——全部装进一个 Book，
// 协议函数统一收 book 首参。三个好处：闭包变显式状态（抽错编译期就报）；
// 九工具侧只传一个东西；G-2 服务化时服务持有的就是同一个 Book。
//
// 本文件当前只含 createBook 工厂（纯新增，无人引用，零风险）——批③的手术是：
// index.js 的 22+2 项闭包状态按 docs/g1-batch3-book-skeleton.md 的字段表装进来，
// 协议函数逐个改收 book。字段表以那份文档为准，本文的工厂只负责「形状」。
//
// 独立性纪律：本目录（core/protocol/）不 import core/ 的纯函数件之外的东西，
// 也不 import index.js —— 账本协议是被抽出来的地基，不许反向依赖宿主胶水。

import { join } from 'node:path'

/**
 * 组装 Book：账本协议的全部显式状态。
 *
 * @param {{ dataDir: string, log: Function, dshHome: string }} init
 *   dataDir——账本数据目录（index.js 已按 baseConfig/resolveDshHome 归一）；
 *   log——makeFileLogger 造好的日志函数（协议内部写日志走它）；
 *   dshHome——DSH 家目录（resolveDshHome() 的结果，sproutMoodFile 等家目录推导用）。
 * @returns Book 对象（字段清单见 docs/g1-batch3-book-skeleton.md §1，逐项对应 index.js 现声明）
 */
export function createBook({ dataDir, log, dshHome }) {
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
  }

  return {
    // 环境
    dataDir,
    dshHome,
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
    feelTracker: { dominant: '', at: 0 },    // 同感冷却（全局单槽）

    // 快层 / 意图层（L456-482）
    fastIndex: [],            // 快层副本索引（裁旧受 fastMaxEvents）
    fastAllIds: new Set(),
    intentIndex: [],          // 意图层副本索引
    intentAllIds: new Set(),
    intentTombstoned: new Set(),
    intentTombKey: (mid) => `tomb:${mid}`, // 墓碑键（现声明 L482 的一致实现）

    // 缓存（读路径 5 秒纪律的产物）
    emotionLinesCache: { at: 0, lines: [] },
    echoStatsCache: { at: 0, stats: new Map() },

    // 游标（内存态；落盘 files.fastCursor / files.intentCursor，语义零变化）
    cursor: { fast: {}, intent: {} },

    // 段渲染缓存（批④随段注册进 Book 的候选，骨架先占位）
    streamCache: { day: '', text: '' },
  }
}
