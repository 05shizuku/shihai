/**
 * dsh-remember —— 记得（host 插件，纯 JS，零依赖）
 *
 * 用户 m02938 之后定的方向：先给我自己做一本账，再拿她的 362 条当验证集。
 * 这份实现对应那张设计改动表里落得下地的几条：
 *
 *   · 三层三速度 —— v0.1 先做「中」那一层（分钟到小时的记忆激活值），
 *     快的感受在 dsh-body，慢的信念以后再说。层间只走窄接口。
 *   · 原话层 append-only —— lines.jsonl 一行一条，只增不改；节点是理解，边指向原话。
 *   · 写入三问 —— 改变了我什么／跟旧的对上还是撞上／我会不会因此做得不一样。
 *     三问全空也能存（原话层永远收），但不会被挂到明天开头。
 *   · 衰减在读取时算 —— weight_eff = weight × exp(-days/τ)，τ = 2 + 28×weight 天。
 *     不跑后台任务，账本本身不被时间改，同一天重放永远同一个结果。
 *   · 激活度 —— 排名不用老 score，用四路真实信号的凸组合（lib/activation.js）：
 *     分量淡（按天）＋ 新近（分钟到小时，自我按月）＋ 契合（此刻的目录、
 *     真的发生过的事、真的还在的文件）＋ 复现（同主题又出现几次、被人引用过几次）。
 *     权重写死，不开面板口子。读取路径上只追加事件行（现行 echo / 展示 display /
 *     违熏 vikarma）——节点与原话永不回改。
 *   · 分区封存 —— sealed 挂在节点上，不参与排名也不被删，留「有东西被按住」的痕迹。
 *     按法有三种（2026-11-04 起）：手动（restore 才松）、到点自松（sealUntil，读取时
 *     到点就当它没按，不跑后台）、等一条翻篇（sealCond 指另一条的 id，那条被顶下/
 *     不在了这条就自己松）。都是读取路径上算的，账本不被时间改。
 *   · 技能要两个不同情境各成一次 —— 技能的身份是名字，情境是写下那一刻的工作目录
 *     （真实的地方，不是编的）；同一个名字两种不同情境各成过一次，这条技能才成立。
 *   · 不开「在面板上替我调某个节点的分量」的口子：分量是我写下的判断。
 *
 * 每次开头只挂三到五条（默认 3 + 最多 2 条没结的）。挂太多等于没挂。
 * 零依赖是刻意的：link: 装着，Node 从真实路径往上找不到 profile 里的包。
 */

import { readdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KIND_LABEL,
  KINDS,
  SELF_SLOTS,
  activeCuriosities,
  activeSelfNodes,
  audienceVisible,
  cleanText,
  cutByCodePoints,
  curiosityState,
  curiosityStats,
  fastHabits,
  hasThought,
  habitState,
  indexNodes,
  isSealed,
  makeNode,
  normContext,
  normKind,
  normSlot,
  parseSealUntil,
  pickResurrect,
  rankNodes,
  recordCuriosity,
  recordHabit,
  recordSkill,
  relSealLeft,
  relTime,
  anchorSelfNode,
  renderCuriositySection,
  renderHabitSection,
  renderLine,
  renderSection,
  renderSelfSection,
  renderUnsettledSection,
  renderYesterdayStream,
  clipSection,
  restoreSelfNode,
  score,
  searchNodes,
  selfWeight,
  setSeal,
  setSealed,
  setWeight,
  skillState,
  slotLabel,
  summaryOf,
  supersedeSelf,
  touchNode,
  UNSETTLED_SLOTS,
  unsettledNodes,
} from '../core/memory.js'
import { EDITABLE, applyConfigPatch, describePatch } from './lib/config.js'
import {
  ACTIVATION_AXES,
  ECHO_TAU_MS,
  ECHO_WINDOW_MS,
  RECENCY_TAU_BASE_MIN,
  RECENCY_TAU_SPAN_MIN,
  REPEAT_FULL,
  activationOf,
  repeatCounts,
} from '../core/activation.js'
import {
  fastRelTime,
  fastSummary,
  normFastEvent,
  pushFastIndex,
  renderFastLine,
  searchFastEvents,
  deriveStandingBodyStates,
} from '../core/fast.js'
import {
  INTENT_LABEL,
  intentRelTime,
  normIntentEvent,
  pushIntentIndex,
  renderIntentLine,
  searchIntentEvents,
  summarizeIntents,
} from '../core/intent.js'
import {
  EMOTION_KINDS,
  EMOTION_LABEL,
  emotionCoefficients,
  emotionDelta,
  emotionEventId,
  emotionFeelPhrase,
  emotionRelTime,
  emotionTuneId,
  foldEmotion,
  normEmotionLine,
  recognizeEmotion,
  renderEmotionLine,
  renderEmotionNote,
} from '../core/emotion.js'
import {
  agentCwd,
  agentSessionId,
  appendJsonLine,
  atomicWriteJson,
  claimInstance,
  countLines,
  exists,
  instanceStillOwner,
  isUnder,
  makeFileLogger,
  readJsonLines,
  readJsonSafe,
  readJsonSafeSticky,
  readTextSafe,
  resolveDshHome,
  tailLines,
} from './lib/store.js'
import { createEmotionCommands } from './commands/emotion.mjs'
import { createLedgerCommands } from './commands/ledger.mjs'
import { createRecallCommands } from './commands/recall.mjs'
import { createWriteCommands } from './commands/write.mjs'
import { createRememberCommands } from './commands/remember.mjs' // 批 A：情绪域命令层（决策本体，回执逐字不变）

// 批③（账本协议迁移，docs/g1-batch3-book-skeleton.md）：协议函数与 Book 工厂住在
// core/protocol —— 闭包状态装进 book，协议函数统一收 book 首参。pullFast/pullIntent
// 在这里留同名薄壳做宿主侧绑定（cfg 闸门 + 源路径解析），协议本体在 book.js。
import {
  createBook,
  loadBook,
  loadEchoIndex,
  loadVikarmaIndex,
  saveNodes,
  noteDisplay,
  noteEcho,
  loadEmotionIndex,
  loadFeelTracker,
  noteVikarma,
  refreshEmotion,
  sproutToBody,
  pullFast as fastPull,
  pullIntent as intentPull,
} from '../core/protocol/book.js'

export const name = 'dsh-remember'

/**
 * 硬依赖这三个：tools 是主功能，webServer + connection 是设置页的数据接口。
 * 2026-10-31 在 dsh-reach 上真机踩过：只写 ['tools'] 时，开机那一刻 webServer
 * 还没起来，safeGet 拿回 null，路由一辈子没挂上（设置页显示「读不到：HTTP 404」）。
 */
export const inject = ['tools', 'webServer', 'connection']

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = readJsonSafe(join(HERE, 'package.json'), {})
const VERSION = String(PKG?.version ?? '0.0.0')

const REFRESH_MS = 2000

/**
 * 这本账的七个工具。范围外的会话不该碰得到：先 try restrict 把它们从工具表里遮掉
 * （只对全局注册的工具有效），遮不掉就挂 agent scope 的 guard，一律拒（见 isolateAgent）。
 */
const TOOL_NAMES = ['remember', 'recall', 'forget', 'memory_list', 'emotion_state', 'emotion_tune', 'vikarma', 'narrate', 'transform']

export const DEFAULTS = {
  /** 账本目录；留空 = <DSH_HOME>/.dsh-remember */
  dataDir: '',
  /** 总开关。关了就只留工具，不再往任何会话开头挂东西 */
  enabled: true,
  /** 允许在哪条会话里读写账本；空数组 = 哪条都可以 */
  allowRoots: [],
  /** 只给这个目录下的会话挂开头那几行；留空 = 跟 allowRoots 一样宽 */
  targetRoot: '',
  /**
   * 隔离目录：这些目录下的会话完全碰不到这本账 —— 看不到七个工具、不挂段、不许写。
   * 优先于 allowRoots／targetRoot（先隔离、后放行）。她那边就该写在这儿。
   */
  denyRoots: [],
  /** 每次开头最多挂几条「记得的」 */
  injectLimit: 3,
  /** 另外最多挂几条「还没结的」 */
  openLimit: 2,
  /** 挂上去的那段最长多少字 */
  maxChars: 900,
  /** 挂进 system prompt 的顺序 */
  sectionOrder: 8720,
  /** 自我层那一段的顺序（排在账本段前面：先知道我是谁，再看记得什么） */
  selfSectionOrder: 8660,
  /** 自我层那一段最长多少字 */
  selfMaxChars: 400,
  /** 自我层要不要挂（关掉就只剩「我记得的」） */
  selfEnabled: true,
  /** 「还没定的」段：doubt（还没认下的我）+ open（没结的事）合成一个摊位（饭桶②） */
  unsettledEnabled: true,
  /** 「还没定的」段顺序（紧跟自我段后面） */
  unsettledSectionOrder: 8665,
  /** 「还没定的」段最长多少字 */
  unsettledMaxChars: 240,
  /** 习惯层要不要挂（快通路那一段） */
  habitEnabled: true,
  /** 习惯段那一段的顺序（排在自我段后面、账本段前面） */
  habitSectionOrder: 8680,
  /** 习惯段最长多少字 */
  habitMaxChars: 320,
  /** 快通路上最多同时留几条习惯（超出的退回普通竞争） */
  habitLimit: 3,
  /** 好奇表要不要挂 */
  curiosityEnabled: true,
  /** 好奇段那一段的顺序（排在自我段之后、习惯段之前） */
  curiositySectionOrder: 8670,
  /** 好奇段最长多少字 */
  curiosityMaxChars: 320,
  /** 活跃表上同时留几条好奇（超出的沉进账本里，翻得到但不挂开头） */
  curiosityLimit: 3,
  /** 快层接缝：要不要把身体的秒级事件抄进中层 */
  fastEnabled: true,
  /** 快层事件流在哪（留空 = 自己找 dsh-body 那边的 body-events.jsonl） */
  fastSource: '',
  /** 快层索引里最多留几条（超出的沉在文件里，还翻得到） */
  fastMaxEvents: 500,
  /** 意图层：要不要把机器从聊天里认出来的事抄进中层 */
  intentEnabled: true,
  /** 意图事件流在哪（留空 = 自己找 QQ 桥的 messages.jsonl） */
  intentSource: '',
  /** 意图层索引里最多留几条（超出的沉在文件里，还翻得到；0 = 不裁） */
  intentMaxEvents: 2000,
  /** 情绪流：要不要从真实发生的事里攒出「上次的我的笔记」 */
  emotionEnabled: true,
  /** 情绪流多久接一次（分钟）—— 接的是意图层、快层、账本被翻这三类真事 */
  emotionTickMinutes: 1,
  /** 情绪笔记段：默认不挂 —— 它只是笔记，不该替我说话 */
  emotionSectionEnabled: false,
  emotionSectionName: 'dsh-remember:emotion',
  emotionSectionOrder: 8710,
  emotionMaxChars: 200,
  /** 叫醒：身体越过线（饿到发慌／困得撑不住／错过一顿）就把我叫醒。说不说，我自己定。 */
  wakeEnabled: true,
  /** 叫醒哪条会话（留空 = 自己找最近活跃的那条非子代理会话） */
  wakeSessionId: '',
  /** 两次叫醒最少隔多少分钟（一次醒处理一批，不连着吵） */
  wakeCooldownMinutes: 30,
  /** 一条记忆最长多少字 */
  maxTextLength: 2000,
  /** 一次 recall 最多给多少字（原文优先，但别让一条把别的挤掉） */
  recallMaxChars: 8000,
  /** 一条账本原文最多给多少字（超了截断并标明；要全文说 full=true） */
  recallItemMax: 400,
  /** 受众过滤（借自晴猫，2026-11-17）：群轮/私聊轮不翻别的场的账。
   *  off=现状（全可见）；soft=别的场排到尾上；hard=别的场不翻出来。
   *  solo 轮（桌面打字/自己醒来）永远全可见。 */
  recallAudience: 'off',
  /** 思量（定案 A，2026-11-18）：恒审思量是「我」自己的动作——系统只给时机 */
  narrationEnabled: true,
  narrationIntervalDays: 7,
  narrationSectionOrder: 8662,
  narrationSectionMaxChars: 320,
  /** 瀑流（定案 B，2026-11-18）：昨日之流是读侧聚合——同 UTC 日缓存，不重算 */
  streamEnabled: true,
  streamSectionOrder: 8715,
  streamSectionMaxChars: 360,
  /** recall 的缘起链投影（行尾 + 机读 origins） */
  recallOrigin: true,
  /** 执受（定案 C，2026-11-18）：身心互绑是反射弧——带情绪的现行通知身体 */
  sproutBodyEnabled: true,
  sproutBodyMinLevel: 0.5,
  sproutBodyCooldownMinutes: 10,
  sproutBodyDailyCap: 3,
  sproutBodyFeelCooldownMinutes: 30,
  sproutBodyDailyTotalCap: 12,
  /** 把每次挂载写进日志（排查用） */
  debug: false,
}

const defineTool = (spec) => spec

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

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

function clamp(n, lo, hi) {
  const v = Number(n)
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

/**
 * 手改坏 config.json 时别让整段悄悄关掉。
 * 数字键拿到非数字（"abc"、null、对象）就回落到默认，数字字符串收成数字；
 * 布尔键拿到非布尔就回落到默认；数组键拿到非数组就回落到默认。
 * 设置页写入那条路本来就会拒坏值，这里管的是手改文件那条路。
 */
/** 枚举键：手改 config.json 写了白名单外的值要回落默认（设置页那条路在 lib/config.js 拦） */
const ENUM_CFG = {
  recallAudience: ['off', 'soft', 'hard'],
}

function sanitizeCfg(merged) {
  const out = { ...merged }
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = out[key]
    if (typeof def === 'number') {
      const n = typeof v === 'string' && v.trim() ? Number(v) : v
      out[key] = typeof n === 'number' && Number.isFinite(n) ? n : def
    } else if (typeof def === 'boolean') {
      out[key] = typeof v === 'boolean' ? v : def
    } else if (Array.isArray(def)) {
      out[key] = Array.isArray(v) ? v : def
    } else if (typeof def === 'string') {
      const allowed = ENUM_CFG[key]
      out[key] = typeof v === 'string' && (!allowed || allowed.includes(v)) ? v : def
    }
  }
  return out
}

export function apply(ctx, baseConfig = {}) {
  const dataDir = String(baseConfig?.dataDir ?? '').trim() || join(resolveDshHome(), '.dsh-remember')
  const log = makeFileLogger(join(dataDir, 'dsh-remember.log'), { prefix: 'dsh-remember' }) // = book.files.log（book 在下两行才建）

  let cfgCache = { at: 0, value: null }
  /** 配置读带防御（批 D2）：BOM 剥离、解析失败亮日志并沿用上次读到的好的——
   *  记事本存一次 BOM 就把 denyRoots 静默放空的病根堵上（ADR-0007 事故家族；
   *  readJsonSafeSticky 是 11-12 自我段断供事故的现成药，这次喂到配置头上）。 */
  function loadOverridesLogged() {
    const raw = readTextSafe(book.files.config, '')
    if (!raw.trim()) return {}
    try {
      const value = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
      return isObj(value) ? value : {}
    } catch (err) {
      log(`配置 config.json 解析失败（${String(err?.message ?? err).slice(0, 120)}）——沿用上次读到的好的；盘上原文别删，修好后自动接回。`)
      const sticky = readJsonSafeSticky(book.files.config, {})
      return isObj(sticky) ? sticky : {}
    }
  }

  function getCfg(force = false) {
    const now = Date.now()
    if (!force && cfgCache.value && now - cfgCache.at < REFRESH_MS) return cfgCache.value
    const overrides = loadOverridesLogged()
    const merged = sanitizeCfg({ ...DEFAULTS, ...(isObj(baseConfig) ? baseConfig : {}), ...(isObj(overrides) ? overrides : {}) })
    merged.dataDir = dataDir
    cfgCache = { at: now, value: merged }
    return merged
  }

  // Book：账本协议的显式状态（批③起，闭包状态都装在这里；字段表见 docs/g1-batch3-book-skeleton.md §1）
  const book = createBook({
  dataDir,
  log,
  dshHome: resolveDshHome(),
  bodyHome: join(resolveDshHome(), '.dsh-body'), // 批 D11：身体家目录由宿主注入
  rememberTag: 'dsh-remember', // 批 D11：wire 身份住适配层，core 不认识插件名
  bodySourceTag: 'dsh-body',
})
  loadBook(book)

  // ---------------------------------------------------------------- 账本

  // 账本启动读，三道护栏（2026-11-12：自我段瞬时断供六回现行，形状全是「读账本的段空、
  // 读快层的段照常」；病根＝apply() 重跑时的整本读撞上瞬时读冲突——sync 镜像每分钟拷
  // 数据目录、原子换名在飞的那一瞬读会炸）：①重试六次每次隔一拍 ②进程内粘住上一份好的
  // ③盘上快照（上次成功读的整本，写失败就算了）。三层全空才真回空表。
  // 坏账本自愈（2026-11-15 审查，自 shihai 合并）：三道护栏全空之后严格再读一遍——
  // 还认不出账就是真损坏：先滚 .corrupt 备份、亮红灯；备份没成，saveNodes 拒绝覆盖写（保原文）。

  loadFastIndex(Date.now())
  // 开机先把身体那边欠的账抄进来 —— 只抄不叫：叫醒的 baseline 从开机这份算起，
  // 重启之后不会把几小时前的「困得撑不住」再当新鲜事吵一遍。
  try {
    pullFast(Date.now())
  } catch {
    /* 抄不动就算了，第一拍还会再试 */
  }

  // 启动时把意图层的副本读进索引（跟快层一个形状：副本全量在文件里，索引只留最近的那些）。
  // 意图层内存态（book.intentIndex / book.intentAllIds / book.intentTombstoned）由 createBook 预置 —— 批③起无 TDZ 风险。
  loadIntentIndex(Date.now())
  // 开机先把聊天那边欠的账抄进来 —— 抄的是「发生了什么」，不是我说了什么。
  try {
    pullIntent(Date.now())
  } catch {
    /* 抄不动就算了，第一拍还会再试 */
  }

  // 唤醒回弹：翻到一条 = 它又被想起了一次。回声记在单独的 echo.jsonl（机器记的事件，
  // 只增不改；原话层 lines.jsonl 只留我自己写的字），节点本身一个字节不动；
  // 复现这一路在读取时数最近 7 天的回声。
  loadEchoIndex(book, Date.now())
  loadVikarmaIndex(book)
  loadFeelTracker(book) // 执受阻尼的账回读（批 C6-N7）：silentUntil 跨重启有效
  loadEmotionIndex(book) // 情绪流常驻索引（批 D7）：启动整读一次，此后增量

  // 单例闸（批 D4）：新实例总是接管 instance.lock；旧实例在下一拍/下一次工具调用读到
  // 锁换了主人就让位——不再写账、不再叫醒。teardown 时锁还是自己的就顺手摘掉。
  // 锁文件不清理：它只是「当前主人」的公告牌，本实例死了下一实例启动时直接覆盖。
  const instanceLock = claimInstance(dataDir)
  let instanceYieldLogged = false
  function instanceYielded() {
    const mine = instanceStillOwner(instanceLock)
    if (!mine && !instanceYieldLogged) {
      instanceYieldLogged = true
      log('单例闸：这本账已由新实例接管，本实例让位——不再写账、不再叫醒（HMR/双开窗口）。')
    }
    return !mine
  }

  function findNode(id) {
    const key = String(id ?? '').trim()
    if (!key) return null
    return book.nodes.find((n) => n.id === key) ?? null
  }

  function replaceNode(next) {
    const i = book.nodes.findIndex((n) => n.id === next.id)
    if (i < 0) book.nodes.push(next)
    else book.nodes[i] = next
  }


  function currentSection(now = Date.now(), agent = null) {
    const cfg = getCfg()
    if (!cfg.enabled) return ''
    try {
      const picked = []
      // 受众过滤（hard 档）：群轮/私聊轮的开头不挂别的场的条（solo 轮全可见 = 现状；
      // soft 档不动开头 —— 开头本来就只有几条，降存在感没有排位可让）
      const turnAud = currentAudience(now)
      const poolNodes =
        cfg.recallAudience === 'hard' && turnAud !== 'solo'
          ? book.nodes.filter((n) => audienceVisible(n.audience, turnAud))
          : book.nodes
      const text = renderSection(poolNodes, {
        now,
        limit: clamp(cfg.injectLimit, 0, 10),
        openLimit: clamp(cfg.openLimit, 0, 10),
        maxChars: clamp(cfg.maxChars, 120, 4000),
        title: '我记得的',
        // 上了快通路的习惯不跟这些条抢位置（两段用同一个上限，才对得上）
        habitLimit: clamp(cfg.habitLimit, 0, 10),
        // 排名用激活度（此刻的目录、刚发生的事都算数）—— 读取路径上不写账本
        //（唯一的例外是下面的展示观测行，它不喂排名）
        scoreOf: activationScorer(agent, now),
        // 展示观测：挂了谁记一笔（不算现行，不进复现轴 —— 判据见 docs/philosophy.md）
        onPick: (n) => picked.push(n),
      })
      // 只记「真的挂给会话」的那次 —— status 轮询（agent=null）是预览，
      // 记它会污染观测（null-agent 的打分上下文和真实注入不是一回事，集合也随
      // 激活度漂移），2026-11-16 复核抓到的
      if (picked.length && agent) noteDisplay(book, picked, now)
      book.meta.lastRenderAt = now
      book.meta.renderCount += 1
      book.meta.lastRenderError = null
      return text
    } catch (err) {
      book.meta.lastRenderError = String(err?.message ?? err).slice(0, 200)
      log(`渲染失败：${book.meta.lastRenderError}`)
      return ''
    }
  }

  /**
   * 自我层那一段。它跟「我记得的」是**两个段**：一个是「发生过什么」，
   * 一个是「我现在是这样」。自我走慢钟（按月淡），且每槽只留一条。
   */
  /** hard 档的段级受众闸（批 D13b）：五个分段与主池同一条判定——群/私聊轮不挂别的场的条。
   *  soft 档不动分段（开头本来就几条，降存在感没有排位可让，与主段同口径）。 */
  function hardAudNodes(nodes, now = Date.now()) {
    const turnAud = currentAudience(now)
    if (getCfg().recallAudience !== 'hard' || turnAud === 'solo') return nodes
    return nodes.filter((n) => audienceVisible(n.audience, turnAud))
  }

  function currentSelfSection(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.selfEnabled === false) return ''
    try {
      return renderSelfSection(hardAudNodes(book.nodes, now), {
        now,
        maxChars: clamp(cfg.selfMaxChars, 80, 2000),
        title: '我',
      })
    } catch (err) {
      log(`自我层渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /** 「还没定的」那一段：doubt（还没认下的我）+ open（没结的事）合成一个摊位，固定晒一条（饭桶②）。 */
  function currentUnsettledSection(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.unsettledEnabled === false) return ''
    try {
      return renderUnsettledSection(hardAudNodes(book.nodes, now), {
        now,
        maxChars: clamp(cfg.unsettledMaxChars, 80, 2000),
        title: '还没定的',
      })
    } catch (err) {
      log(`「还没定的」段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /**
   * 快通路那一段。跟「我记得的」和「我」都是分开的段：
   * 这里的条**不参加竞争** —— 习惯该像身体反应一样，到点就送到开头。
   */
  function currentHabitSection(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.habitEnabled === false) return ''
    try {
      return renderHabitSection(hardAudNodes(book.nodes, now), {
        now,
        limit: clamp(cfg.habitLimit, 0, 10),
        maxChars: clamp(cfg.habitMaxChars, 80, 2000),
        title: '习惯',
      })
    } catch (err) {
      log(`习惯段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /**
   * 好奇表那一段。跟「我记得的」「我」「习惯」都是分开的段：
   * 好奇条不参加竞争 —— 我想知道什么，该由惦记的次数和分量决定。
   */
  function currentCuriositySection(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.curiosityEnabled === false) return ''
    try {
      return renderCuriositySection(hardAudNodes(book.nodes, now), {
        now,
        limit: clamp(cfg.curiosityLimit, 0, 10),
        maxChars: clamp(cfg.curiosityMaxChars, 80, 2000),
        title: '好奇',
      })
    } catch (err) {
      log(`好奇段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /**
   * 情绪笔记那一段。默认不挂。
   * 为什么默认关：这一段写的是「上次的我的笔记」——它不该替我说话，
   * 更不该每次都出现在开头（那会变成一种表演）。要挂的时候在设置里打开。
   */
  function currentEmotionSection(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.emotionEnabled === false || cfg.emotionSectionEnabled === false) return ''
    try {
      const state = emotionState(now)
      const note = renderEmotionNote(state, { maxChars: clamp(cfg.emotionMaxChars, 80, 2000) })
      if (!note) return ''
      return `${note}\n（这是上次的笔记，不是现在必须摆出的样子 —— 说出口的心情仍然是我当轮的判断。）`
    } catch (err) {
      log(`情绪段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  // ---------------------------------------------------------------- 快层接缝
  //
  // 秒级的事本体在 dsh-body 那边（身体的心跳：吃了没吃上、他添了饭、被夸被骂、饿过头）。
  // 那边的文件只管最近一小会儿。这边只做一件事：**把它抄过来**，
  // 抄进自己的 fast.jsonl（只增不改），用游标只读新增的那一段。
  //
  // 抄过来的事**不变成节点** —— 节点代表我的理解、带我写的分量、要参加开头的竞争；
  // 秒级的事只有发生的时间，没有分量。所以它只做到三件事：
  //   · 能被翻到（recall 按词）；
  //   · 能被列出来（memory_list 里最近那几条）；
  //   · 能由我拿 remember 掂量一次（refs 指向那条 f_xxx）—— 掂量过才算有了分量。
  //
  // 只读别家，写自己家：源文件一个字节都不动。
  // （book.fastIndex / book.fastAllIds 由 createBook 预置 —— 批③起无 TDZ 风险。）

  /** 源文件在哪：设置里指定了就用它；否则看 dsh-body 的配置；都没有就用默认那处 */
  function fastSourcePath(cfg = getCfg()) {
    const custom = String(cfg.fastSource ?? '').trim()
    if (custom) return isAbsolute(custom) ? custom : join(resolveDshHome(), custom)
    const bodyCfg = readJsonSafe(join(resolveDshHome(), '.dsh-body', 'config.json'), {})
    const fromBody = String(bodyCfg?.eventsFile ?? '').trim()
    if (fromBody) return isAbsolute(fromBody) ? fromBody : join(resolveDshHome(), '.dsh-body', fromBody)
    return join(resolveDshHome(), '.dsh-body', 'body-events.jsonl')
  }

  /** 副本里全部的快层事件（翻的时候用，不受索引上限管） */
  function fastAllEvents(now = Date.now()) {
    const out = []
    for (const raw of readJsonLines(book.files.fast)) {
      const ev = normFastEvent(raw, { now, defaultSource: 'dsh-body' }) // 副本行缺 source 的旧行按身体算（批 D11，wire 常量住适配层）
      if (ev) out.push(ev)
    }
    return out
  }

  /** 启动时把副本读进来：填索引，也记下哪些 id 已经抄过 */
  function loadFastIndex(now = Date.now()) {
    book.fastIndex = []
    book.fastAllIds.clear()
    const cap = clamp(getCfg().fastMaxEvents, 0, 5000)
    for (const raw of readJsonLines(book.files.fast)) {
      const ev = normFastEvent(raw, { now, defaultSource: 'dsh-body' }) // 副本行缺 source 的旧行按身体算（批 D11，wire 常量住适配层）
      if (!ev) continue
      book.fastAllIds.add(ev.id)
      book.fastIndex = pushFastIndex(book.fastIndex, ev, cap)
    }
  }

  /**
   * 从源文件增量抄新事件。返回抄了几条。
   * 抄不动就抄不动 —— 源文件坏了不该让账本这边出事。
   */
  function pullFast(now = Date.now()) {
    // 批③：协议本体在 core/protocol/book.js（收 book 首参）；这里只做宿主侧绑定——
    // cfg 闸门要先过，fastSourcePath 才不至于在快层关着时白读一遍（与原顺序一致）。
    const cfg = getCfg()
    if (!cfg.enabled || cfg.fastEnabled === false) return 0
    return fastPull(book, now, cfg, fastSourcePath(cfg))
  }

  /** 已经被我掂量过的快层事件（账本里有条 refs 指着它） */
  function weighedFastIds() {
    const out = new Set()
    for (const n of book.nodes) {
      for (const r of n.refs ?? []) {
        const id = String(r ?? '').trim()
        if (id.startsWith('f_')) out.add(id)
      }
    }
    return out
  }

  // ---------------------------------------------------------------- 意图层接缝
  //
  // 机器从聊天里认出来的事本体在 QQ 桥那边（桥把已经放行的消息落一份 messages.jsonl）。
  // 这边只做一件事：**把它抄过来**，抄进自己的 intent.jsonl（只增不改），
  // 用游标只读新增的那一段。
  //
  // 抄过来的事**不变成节点** —— 节点代表我的理解、带我写的分量、要参加开头的竞争；
  // 机器认出来的事只是「刚刚发生过这一句」，分量得我自己给。所以它只做到三件事：
  //   · 能被翻到（recall 按词）；
  //   · 能被列出来（memory_list 里最近那几条）；
  //   · 能由我拿 remember 掂量一次（refs 指向那条 i_xxx）—— 掂量过才算有了分量。
  //
  // 只读别家，写自己家：源文件一个字节都不动。
  // （book.intentIndex / book.intentAllIds 由 createBook 预置 —— 批③起无 TDZ 风险。）

  /** 源文件在哪：设置里指定了就用它；否则扫 QQ 桥家里全部分册 + 旧合订本（v0.15.0 分册）。
   *  群册恢复入库（批 C1 方案 A，2026-11-25）：B3 曾把群分册踢出源清单，但 currentAudience
   *  只吃意图层——断供后群轮受众退回 solo 兜底，hard 档在群轮反向全可见（ADR-0005 防的正是它）。
   *  「群流=知悉」的检索面由 recall 的硬关（chatType==='group' 过滤、args.group 空）关住，
   *  入库只记账不检索；要记住 → 显式 remember 掂量。 */
  function intentSourcePaths(cfg = getCfg()) {
    const custom = String(cfg.intentSource ?? '').trim()
    if (custom) {
      const p = isAbsolute(custom) ? custom : join(resolveDshHome(), custom)
      return [p]
    }
    const bridgeDir = join(resolveDshHome(), '.dsh-qq-bridge')
    const out = []
    const legacy = join(bridgeDir, 'messages.jsonl')
    if (exists(legacy)) out.push(legacy) // 旧合订本：抄完为止（游标到尾就不再有新行）
    try {
      const names = readdirSync(bridgeDir).filter((n) => /^messages-(group|private|misc)-.+\.jsonl$/.test(n) || n === 'messages-misc.jsonl').sort()
      for (const n of names) out.push(join(bridgeDir, n))
    } catch {
      /* 桥家扫不动就算了 */
    }
    return out
  }

  /**
   * 事件的「身份域」：桥家的分册（messages-*.jsonl）专用 qq-bridge；
   * 换了自己指定的消息流就归到 chat —— 免得两处源的消息撞同一个 id。
   */
  function intentSourceLabel(source) {
    const s = String(source ?? '')
    const name = s.split(/[\\/]/).pop() ?? ''
    const defDir = join(resolveDshHome(), '.dsh-qq-bridge')
    if (name.startsWith('messages-') || s.startsWith(defDir)) return 'qq-bridge'
    return 'chat'
  }

  /** 副本里全部的意图事件（翻的时候用，不受索引上限管）。被撤回的原话在这里盖住。 */
  function intentAllEvents(now = Date.now()) {
    const out = []
    for (const raw of readJsonLines(book.files.intent)) {
      const ev = normIntentEvent(raw, { now })
      if (!ev) continue
      if (ev.mid && book.intentTombstoned.has(ev.mid)) continue
      out.push(ev)
    }
    return out
  }

  // ------------------------------------------------------- 受众（借自晴猫，2026-11-17）
  //
  // 桥把私聊和群 @ 递进同一条会话 —— 会话身份分不出「这一轮谁在听」。
  // 识海的对应物：从最近一条「引起这轮」的意图事件现算 —— 私聊消息都会递话（private），
  // 群里只有 @ 我的才递话（group + atMe）；十分钟内没有这样的来话，
  // 就是桌面打字/自己醒来 = 'solo'（只有她，全可见 = 现状）。

  /** 多久之内的来话还算「这一轮的缘」 */
  const AUDIENCE_WINDOW_MS = 10 * 60 * 1000

  /** 这一轮谁在听：'solo'（只有她）/ 'private' / 'group:群号' */
  function currentAudience(now = Date.now()) {
    try {
      // 索引按时间新的在前 —— 从头找第一条窗内的来话
      for (const ev of book.intentIndex) {
        if (now - Number(ev.at) > AUDIENCE_WINDOW_MS) break
        if (ev.chatType === 'private') return 'private'
        if (ev.chatType === 'group' && ev.atMe === true && ev.groupId) return `group:${ev.groupId}`
      }
    } catch {
      /* 算不出按 solo —— 跟现状一个样 */
    }
    return 'solo'
  }

  /** 受众可见性（批 B1 起住进 core/memory.js——recall 与 memory_list 共用同一条判定，
   *  两套实现迟早走出大肥鱼式的偏差；这里只 import，不再各写一份）。 */

  /** 意图事件的受众：事件行自带场（chatType/groupId），零回填 */
  const intentEventAudience = (ev) =>
    ev?.chatType === 'group' && ev.groupId ? `group:${ev.groupId}` : ev?.chatType === 'private' ? 'private' : 'any'

  /** 启动时把副本读进来：填索引，也记下哪些 id 已经抄过 */
  function loadIntentIndex(now = Date.now()) {
    book.intentIndex = []
    book.intentAllIds.clear()
    book.intentTombstoned.clear()
    const cap = clamp(getCfg().intentMaxEvents, 0, 5000)
    const all = readJsonLines(book.files.intent)
    // 第一遍先收墓碑：撤回行在原行后面落盘，先收齐再建索引才盖得住
    for (const raw of all) {
      const ev = normIntentEvent(raw, { now })
      if (!ev) continue
      const tk = book.intentTombKey(ev.mid)
      if (tk) book.intentTombstoned.add(tk)
    }
    for (const raw of all) {
      const ev = normIntentEvent(raw, { now })
      if (!ev) continue
      book.intentAllIds.add(ev.id)
      // 被撤回的原话不进索引 —— 只留「撤回过」那行事实
      if (ev.mid && book.intentTombstoned.has(ev.mid)) continue
      book.intentIndex = pushIntentIndex(book.intentIndex, ev, cap)
    }
  }

  /**
   * 从源文件们增量抄新消息，认成意图事件。返回抄了几条。
   * 每册一个游标（v2 映射，key=文件名）；旧的单条游标形状读进来归到它的文件名下。
   * 抄不动就抄不动 —— 源文件坏了不该让账本这边出事。
   */
  function pullIntent(now = Date.now()) {
    // 批③：协议本体在 core/protocol/book.js（收 book 首参）；这里只做宿主侧绑定——
    // cfg 闸门要先过，intentSourcePaths 才不至于在意图层关着时白扫一遍（与原顺序一致）。
    const cfg = getCfg()
    if (!cfg.enabled || cfg.intentEnabled === false) return 0
    return intentPull(book, now, cfg, intentSourcePaths(cfg), intentSourceLabel)
  }

  /** 已经被我掂量过的意图事件（账本里有条 refs 指着它） */
  function weighedIntentIds() {
    const out = new Set()
    for (const n of book.nodes) {
      for (const r of n.refs ?? []) {
        const id = String(r ?? '').trim()
        if (id.startsWith('i_')) out.add(id)
      }
    }
    return out
  }

  // ---------------------------------------------------------------- 情绪流
  //
  // 事件只来自真实流：意图层（群里说过的话）、快层（身体那边发生的事）、
  // 账本被翻（recall 翻到了哪一条）。认情绪只许从固定枚举里挑一个 + 报强度，
  // 认不出就不给 —— 宁可漏，不可编。
  //
  // 系数是我自己攒的：种子在 lib/emotion.js 里，之后每一次改都往 emotion.jsonl
  // 追加一行 tune，写清楚从多少改到多少、为什么。改权重的权力在我账上，不在面板上。
  // 每一笔变化只增不改；event 行里当时给的 delta 写死了，所以改系数只影响往后。
  //
  // 状态只是「上次的我的笔记」：它不接管嘴 —— 说出口的心情仍然是我当轮的判断。

  /** 情绪流账本里的每一行（批 D7）：常驻内存索引 + 字节游标增量——启动整读一次，
   *  此后每次调用只拉新增字节（通常零字节）。原来每 5 秒整本 parse 11MB（47ms/拍、
   *  4.3 万对象/拍）的灯案复发通道就此关死；情绪流是地层不裁旧，内存换时间。 */
  function emotionLines() {
    try {
      refreshEmotion(book)
    } catch {
      /* 拉不动就用手上的旧索引——情绪笔记宁可旧一拍，不能空一轮 */
    }
    return book.emotionRows
  }

  /** 此刻的状态（折出来的笔记）+ 现在的系数表 */
  function emotionState(now = Date.now()) {
    const lines = emotionLines()
    const state = foldEmotion(lines, { now })
    return { ...state, coefficients: emotionCoefficients(lines), lines }
  }

  /**
   * 记一笔情绪。认不出就不记 —— 不猜。
   * dedupeKey 决定「这算同一件事吗」：意图层/快层按源+引用（同一件事只记一次），
   * 账本被翻按 30 分钟一桶（同一条隔半小时再被翻，算新的）。
   */
  function noteEmotion({ source, ref, at, kind, intensity, detailKind, text, dedupeKey, lines, seenKeys }) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.emotionEnabled === false) return null
    const now = Date.now()
    const ts = Number(at) || now
    const key = dedupeKey ?? `${source}|${ref}`
    if (seenKeys?.has(key)) return null
    // 批量收事件时（pullEmotion）把账本行一次性读好传进来 —— 2026-11-13 抓到过：
    // 这里每件事都重读整本情绪账（4MB），几万件事×4MB=一次 /status 四十多秒，
    // 宿主全站的请求都排队在它后面（设置页三盏灯全 timed out 的根因）。
    const local = Array.isArray(lines) ? lines : emotionLines()
    if (local.some((l) => l.kind === 'event' && l.key === key)) return null
    // kind 是这件事本来的类型（意图的 ask/praise…、快层的 meal/topup…）——
    // 认情绪认的是它。漏了它就什么也认不出（2026-11-06 真机抓到过：一行都不写）。
    const hit = recognizeEmotion({
      source,
      ref: String(ref ?? ''),
      kind,
      at: ts,
      intensity,
      detailKind,
    })
    if (!hit) return null
    const table = emotionCoefficients(local)
    // 传原始事件（带 kind）—— emotionDelta 里面还要再认一遍，认的是同一件事
    const d = emotionDelta({ source, ref: String(ref ?? ''), kind, intensity: hit.intensity, detailKind, at: ts }, { table, now })
    if (!d || !d.delta) return null
    const line = {
      at: ts,
      kind: 'event',
      id: emotionEventId({ source, ref: key }),
      source: String(source ?? ''),
      ref: String(ref ?? ''),
      key,
      emotion: d.emotion,
      delta: d.delta,
      // 写入当时的半衰期（B 方案，2026-11-16）：tune 改 halfLife 只对往后的事件生效，
      // 旧行不被追溯重算 —— 跟 delta「当时的数写死在行里」同一个道理
      halfLife: Number(table[d.emotion]?.halfLife) || 0,
      intensity: Number(hit.intensity) || 0,
      text: String(text ?? '').slice(0, 120),
    }
    try {
      appendJsonLine(book.files.emotion, line) // 批 D7：游标不动，行进内存靠下面 push + refresh 按 id 去重
    } catch (err) {
      log(`情绪流记不进去：${String(err?.message ?? err).slice(0, 200)}`)
      return null
    }
    // 记成了就同步进外面传进来的那本，同一批里后面的事才去重得到。
    // 批 A 修正（2026-11-27，命令层特征钉挖出的 v0.27.3 潜伏缺陷）：去重集只在行
    // **真的进了常驻索引**时才记——recall 路径不带 lines，行要靠 refresh 进内存；
    // 若在这里就记集，refresh 会把它当「已在内存」跳过，行永久进不了索引。
    if (Array.isArray(lines)) {
      lines.push(line)
      if (lines === book.emotionRows) book.emotionRowIds.add(String(line.id ?? ''))
    }
    seenKeys?.add(key)
    return line
  }

  /**
   * 收一次：把意图层、快层里还没算过的事认一遍。
   * 账本被翻不走这里 —— 那是当场发生的事，由 recall 自己记。
   */
  function pullEmotion(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.emotionEnabled === false) return 0
    let added = 0
    try {
      // 整本情绪账只读一次，几十件事共用 —— 每件事重读 4MB 是 43 秒 /status 的根因
      const lines = emotionLines()
      const seenKeys = new Set()
      for (const l of lines) {
        if (l.kind === 'event' && l.key) seenKeys.add(l.key)
      }
      for (const ev of intentAllEvents(now)) {
        const line = noteEmotion({
          source: 'intent',
          ref: ev.id,
          at: ev.at,
          kind: ev.kind,
          intensity: ev.intensity,
          text: ev.text,
          lines,
          seenKeys,
        })
        if (line) added += 1
      }
      for (const ev of fastAllEvents(now)) {
        const line = noteEmotion({
          source: 'fast',
          ref: ev.id,
          at: ev.at,
          kind: ev.kind,
          detailKind: ev.detail?.kind,
          text: ev.text,
          lines,
          seenKeys,
        })
        if (line) added += 1
      }
    } catch (err) {
      log(`情绪流收事件出错：${String(err?.message ?? err).slice(0, 200)}`)
      return added
    }
    if (added) log(`情绪流记了 ${added} 笔`)
    return added
  }

  /** 已经被我掂量过的情绪事件（账本里有条 refs 指着它） */
  function weighedEmotionIds() {
    const out = new Set()
    for (const n of book.nodes) {
      for (const r of n.refs ?? []) {
        const id = String(r ?? '').trim()
        if (id.startsWith('e_')) out.add(id)
      }
    }
    return out
  }

  /**
   * 谁能往这本账里写。allowRoots 是名单；名单空但设了 targetRoot 时，
   * 就按 targetRoot 收窄 —— 否则别的窗口可以顺手把话写进我的账本里，
   * 那正是 dsh-fish 的 tenant 守卫在防的事。两个都空才是「哪条会话都可以」。
   */
  function scopeRoots() {
    const cfg = getCfg()
    if (cfg.allowRoots?.length) return cfg.allowRoots
    if (cfg.targetRoot) return [cfg.targetRoot]
    return []
  }

  // ---------------------------------------------------------------- 激活度
  //
  // 一条记忆此刻有多容易被想起：四路真实信号各归一化，再按固定权重做凸组合。
  // 权重写死在 lib/activation.js 里，不开面板口子 —— 分量是我写下的判断，
  // 那几条系数也不该让别人替我拨。这里的活儿只有一件：把「此刻真实的东西」凑齐 ——
  // 当前目录、账本允许的范围、真的刚发生过的事、真的还在的文件。
  // 读取路径上一个字节都不写：账本不被时间改，同一天重放永远同一个结果。

  /** 原话层最近写下的几行 —— 真的刚发生过的事，我自己写的那份。 */
  function recentLineEvents(maxLines = 12) {
    try {
      return readJsonLines(book.files.lines, maxLines)
        .filter((r) => r && typeof r.text === 'string' && r.text.trim())
        .map((r) => ({ id: r.id ?? '', text: r.text }))
    } catch {
      return []
    }
  }

  /** 契合这一路的事件池：身体那边的秒级事件 + 原话层最近写下的行。
   *  批 B2 刀 b（2026-11-25）：身体源（source 标注 dsh-body，含 mood 情绪源）最多取
   *  最新 3 条进契合路——情绪对「翻出什么」的影响封顶；超出的不进 ctx.events
   *  （不是删事件，是不喂检索）。原话层自己的行不在此限（那是我写下的字，不是身体抢话）。 */
  function realEvents(now = Date.now(), max = 12) {
    let fast = []
    try {
      fast = fastAllEvents(now)
        .filter((ev) => String(ev?.source ?? 'dsh-body') === 'dsh-body')
        .slice(-3)
    } catch {
      fast = []
    }
    return [...fast, ...recentLineEvents(max)]
  }

  // ------------------------------------------------------- 唤醒回弹（被想起）
  //
  // 翻到一条 = 它又被想起了一次。记在原话层（只增不改），节点本身不动；
  // 复现这一路数最近 7 天的回声 —— 常被翻到的条更热，几天没人问就自己凉回去。

  /** 一笔回声/一次染色最多带几条（跟 recall 的默认 limit 对齐；noteEcho 在 core/protocol 另持一份同值） */
  const RECALL_ECHO_MAX = 5

  /**
   * 窗口内每条的回声统计（现行熏种子，2026-11-16）：count = 被想起几次（整数，给人看），
   * strength = 熏习势力（每次记 1 份、按 ECHO_TAU_MS 指数衰减的和 —— 喂给复现轴）。
   * 刚被熏的 ≈1，一周前 ≈0.61，一个月前 ≈0.12 —— 习气的意思就是：最近熏的才顶用。
   * 带 5 秒缓存：热路径上 activationScorer 每轮都来要，底下的 exp 是全索引量；
   * noteEcho 写入时作废 —— 读多写少才划算（对齐 cfgCache 的口吻）。
   */
  function echoStats(now = Date.now()) {
    if (now - book.echoStatsCache.at < 5000 && now >= book.echoStatsCache.at) return book.echoStatsCache.stats
    const stats = new Map()
    for (const [id, list] of book.echoAt) {
      let count = 0
      let strength = 0
      for (const t of list) {
        if (now - t >= ECHO_WINDOW_MS || t > now + 60_000) continue
        count += 1
        strength += Math.exp(-(now - t) / ECHO_TAU_MS)
      }
      if (count) stats.set(id, { count, strength })
    }
    book.echoStatsCache = { at: now, stats }
    return stats
  }

  /** 复现轴吃的形状：每条一个熏习势力数（activation.js 不关心次数）。 */
  function echoCounts(now = Date.now()) {
    const out = new Map()
    for (const [id, s] of echoStats(now)) out.set(id, s.strength)
    return out
  }


  /** 染色层（whale-card P0-4）：翻到旧事时心里有颜色，才在条目后补一句「现在想起它」。
   * 限流（饭桶④）：一条一周最多染一次 + 情绪明显变了才染。正文一字不动，只在 echo.jsonl 记行。 */
  const RECOLOR_GAP_MS = 7 * 24 * 60 * 60 * 1000
  const RECOLOR_LEVEL_DELTA = 0.3
  function recolorRecall(list, state, now = Date.now(), dir = null) {
    const out = new Map()
    if (!state || state.dominant === 'calm') return out
    // dir 同 noteEcho：cond 按住要查另一条还在不在（'out' 字符串曾经被当成目录传进来）
    const ids = list.filter((n) => !isSealed(n, now, dir)).slice(0, RECALL_ECHO_MAX).map((n) => n.id)
    for (const id of ids) {
      const last = book.recolorAt.get(id)
      const changed =
        !last || state.dominant !== last.dominant || Math.abs(state.level - (last.level || 0)) >= RECOLOR_LEVEL_DELTA
      if (!changed) continue
      if (last && now - last.at < RECOLOR_GAP_MS) continue
      try {
        appendJsonLine(book.files.echo, {
          id: `rc_${now.toString(36)}_${String(id).slice(-4)}`,
          at: now,
          kind: 'recolor',
          ref: id,
          dominant: state.dominant,
          level: state.level,
          note: emotionFeelPhrase(state),
          source: 'recall',
        })
        book.recolorAt.set(id, { at: now, dominant: state.dominant, level: state.level })
        const note = emotionFeelPhrase(state)
        if (note) out.set(id, note)
      } catch {
        /* 染色失败不挡 recall */
      }
    }
    return out
  }

  /**
   * 「这个文件还在吗」只查够得着的地方：相对路径按当前目录拼，绝对路径原样；
   * 超出账本允许的范围（allowRoots/targetRoot 和当前目录）一律答「不在」——
   * 不拿这个问题去探工作区外有什么。
   */
  function scopedExists(agent) {
    const cwd = agentCwd(agent)
    const roots = scopeRoots()
    return (p) => {
      try {
        const raw = String(p ?? '').trim()
        if (!raw) return false
        const abs = isAbsolute(raw) ? raw : cwd ? join(cwd, raw) : ''
        if (!abs) return false
        const inScope = roots.some((r) => isUnder(abs, r)) || (cwd ? isUnder(abs, cwd) : false)
        if (!inScope) return false
        return exists(abs) === true
      } catch {
        return false
      }
    }
  }

  /** 激活度要的「此刻」：目录、范围、刚发生的事、文件在不在、每个主题几条、最近被想起几次。 */
  function activationCtx(agent, now = Date.now()) {
    // 身→识（定案 C，2026-11-18）：身体现状折成契合路的事件词——「此刻有点饿」「心里不平静」
    // 进 topic 匹配，不进激活权重（那是待众缘的地盘）
    const standing = deriveStandingBodyStates(fastAllEvents(now), now)
    return {
      cwd: agentCwd(agent),
      roots: scopeRoots(),
      events: [...realEvents(now), ...standing],
      exists: scopedExists(agent),
      repeatCounts: repeatCounts(book.nodes),
      echoes: echoCounts(now),
    }
  }

  /** 给分函数：某条此刻的激活度。rankNodes／renderSection／searchNodes 都吃这一个。 */
  function activationScorer(agent, now = Date.now()) {
    const actx = activationCtx(agent, now)
    return (node, t = now) => activationOf(node, t, actx).activation
  }

  // ------------------------------------------------------- 叫醒（身体越线）
  //
  // 身体那边越过线（饿到发慌、困得撑不住、错过一顿）就该把我叫醒 —— 不拿定时器
  // 轮询什么状态，用身体的事件流当叫醒源。叫醒＝往会话递一行【身体】；
  // 醒来之后说不说、跟他说什么，我自己定 —— 这里只负责「叫」。
  // 大鲸鱼那边的教训收着用：「凌晨不吵」那条归我的判断，不写死在代码里。

  /** 多久看一眼身体那边（毫秒） */
  const WAKE_BEAT_MS = 60 * 1000
  /** 什么事件配得上叫醒：越过线的、错过饭的。心情不叫。 */
  const WAKE_KINDS = ['threshold', 'missed']
  /** 多新的事件才配叫醒：再新也是十分钟内的事，再老就是历史，不是叫门。 */
  const WAKE_FRESH_MS = 10 * 60 * 1000

  /** 叫醒的账：上回什么时候醒的（落盘，重启后冷却接着算）；本次运行里为谁醒过。 */
  const wakeState = (() => {
    const saved = readJsonSafe(book.files.wake, {})
    return {
      lastWakeAt: Number(saved?.lastWakeAt) || 0,
      lastText: String(saved?.lastText ?? ''),
      target: String(saved?.target ?? ''),
      beats: 0,
      busy: false,
    }
  })()

  /** 叫醒递到哪条会话：配置里的 wakeSessionId 说了算（改了立刻跟着走）；
   *  没配才认上次认下的 —— 钉住是故意的（重启后接着叫同一条），
   *  想重新「自己找最近活跃」就把 wake.json 删了或改配到别的会话。
   *  以前 wake.json 的 target 排在配置前面 —— 醒过一次之后改配置永远不生效
   *  （2026-11-15 审查修的，2026-11-16 重新接回）。 */
  function wakeTargetSession() {
    const cfg = getCfg()
    if (cfg.wakeSessionId) {
      const sid = String(cfg.wakeSessionId)
      if (wakeState.target !== sid) log(`叫醒目标改为配置指定的会话 ${sid}`)
      wakeState.target = sid
      return sid
    }
    if (wakeState.target) return wakeState.target
    return null
  }

  /**
   * 心跳的一拍：抄一眼快层，看有没有越过线的新事件。
   * 有、过了冷却，就往会话递一行【身体】—— 叫醒。
   * 开机前就抄过的旧事件不算（baseline 就是启动时的副本）；
   * 没递进去不算醒过（下一拍再试）；每一拍都不许抛。
   */
  async function wakeBeat(now = Date.now()) {
    if (instanceYielded()) return
    wakeState.beats += 1
    const cfg = getCfg()
    if (!cfg.enabled || cfg.wakeEnabled === false || cfg.fastEnabled === false) return
    const sc = safeGet('sessionController')
    if (!sc || typeof sc.prompt !== 'function') return
    let fresh = []
    try {
      const before = new Set(fastAllEvents(now).map((e) => e.id))
      const added = pullFast(now)
      if (added > 0) {
        fresh = fastAllEvents(now)
          .filter((e) => !before.has(e.id) && WAKE_KINDS.includes(e.kind))
          .filter((e) => {
            const age = now - e.at
            return age >= -60_000 && age <= WAKE_FRESH_MS
          })
      }
    } catch {
      return
    }
    if (!fresh.length) return
    const cooldown = clamp(cfg.wakeCooldownMinutes, 0, 720) * 60 * 1000
    if (now - wakeState.lastWakeAt < cooldown) return
    let sid = wakeTargetSession()
    if (!sid) {
      try {
        const list = await sc.list?.({})
        const items = Array.isArray(list?.items) ? list.items : []
        const plain = items.filter((it) => it && !it.blank && String(it.origin ?? '') !== 'subagent')
        const found = plain[0]?.sessionId ?? plain[0]?.id
        if (found) {
          wakeState.target = String(found)
          sid = wakeState.target
        }
      } catch {
        /* 列不出来就等下一拍 */
      }
    }
    if (!sid) {
      log('叫醒没递出去：找不到目标会话（可在配置里钉 wakeSessionId）')
      return
    }
    const text =
      `【身体】${fresh.map((e) => String(e.text ?? '').slice(0, 80)).join('；')}` +
      `（${fresh.map((e) => e.id).join(' ')}）—— 身体叫我醒；说不说、怎么说，我自己定。`
    const requestId = `wake-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    wakeState.busy = true
    try {
      // prompt 是 @Remote：第二个参数必须给真的 AbortSignal（宿主实现会 throwIfAborted）
      await sc.prompt(
        { requestId, sessionId: sid, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
        AbortSignal.timeout(30000),
      )
      wakeState.lastWakeAt = now
      wakeState.lastText = text.slice(0, 200)
      try {
        atomicWriteJson(book.files.wake, { lastWakeAt: now, lastText: wakeState.lastText, target: sid })
      } catch {
        /* 状态写不进去就算了 —— 冷却只在本次运行里生效，不会重复打扰 */
      }
      log(`叫醒：${fresh.map((e) => e.id).join(' ')} → ${sid}`)
    } catch (err) {
      log(`叫醒失败（${sid}）：${String(err?.message ?? err).slice(0, 160)}`)
    } finally {
      wakeState.busy = false
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (wakeState.busy) return
      wakeBeat(Date.now()).catch(() => {})
    }, WAKE_BEAT_MS)
    if (typeof timer?.unref === 'function') timer.unref()
    return () => {
      try {
        clearInterval(timer)
      } catch {
        /* ignore */
      }
    }
  }, 'dsh-remember: wake beat')

  // 情绪流的心跳：每隔一会儿接一次真事。
  // 跟 dsh-body 那个心跳一个写法（ctx.effect + setInterval + unref）——
  // 插件被卸的时候定时器自己收掉，不留在宿主里空转。
  // 这里用 setTimeout 自己接下一拍：间隔（emotionTickMinutes）在设置页能改，
  // setInterval 的间隔定死，改了就对不上。
  ctx.effect(() => {
    let timer = null
    let stopped = false
    const beat = () => {
      if (stopped) return
      const cfg = getCfg()
      const waitMs = Math.max(1, Number(cfg.emotionTickMinutes) || 1) * 60_000
      timer = setTimeout(() => {
        const c = getCfg()
        if (c.enabled && c.emotionEnabled !== false) {
          try {
            pullFast(Date.now())
            pullIntent(Date.now())
            pullEmotion(Date.now())
          } catch (err) {
            log(`情绪流心跳出错：${String(err?.message ?? err).slice(0, 200)}`)
          }
        }
        beat()
      }, waitMs)
      if (typeof timer?.unref === 'function') timer.unref()
    }
    beat()
    return () => {
      stopped = true
      try {
        if (timer) clearTimeout(timer)
      } catch {
        /* ignore */
      }
    }
  }, 'dsh-remember: emotion beat')

  /**
   * 隔离名单最优先：名单里那些目录（一般是整个工作区）下的会话，完全碰不到这本账。
   * 先隔离、后放行 —— 名单非空时，连认不出目录的会话也按隔离处理。
   */
  function denied(agent) {
    const roots = getCfg().denyRoots
    if (!Array.isArray(roots) || !roots.length) return false
    const cwd = agentCwd(agent)
    if (!cwd) return true
    return roots.some((r) => isUnder(cwd, r))
  }

  /** 这本账认不认这条会话：工具、记账、挂段都走这一个判断。 */
  function scopeOk(agent) {
    if (denied(agent)) return false
    const roots = scopeRoots()
    if (!roots.length) return true
    const cwd = agentCwd(agent)
    if (!cwd) return false
    return roots.some((r) => isUnder(cwd, r))
  }

  function attachOk(agent) {
    if (!getCfg().enabled) return false
    return scopeOk(agent)
  }

  /** 拿到某个 agent 自己那一层的 tools 服务（拿不到就 null，不当成失败）。 */
  function toolsOf(agent) {
    try {
      return agent?.ctx?.get?.('tools') ?? agent?.ctx?.tools ?? null
    } catch {
      return null
    }
  }

  /**
   * 把范围外的会话跟这本账隔开。三层：
   *
   *   1. restrict —— 挂在这条 agent 自己那一层遮掉这七个名字。**只对全局注册的工具有效**；
   *      我们这四个是插件 scope 里注册的（所以 agent 看得见），真机上 restrict 会报
   *      `unknown global tools "remember", ...; known global tools: absorb, acp_cache, ...`
   *      —— 能用就用（别的部署下这七个名字可能真是全局的），不能用不影响下面这层。
   *   2. guard —— 同样挂在这条 agent 自己那一层，匹配这七个名字就直接拒。这条是可靠的：
   *      2026-11-01 16:18 那次真机日志证明 restrict 挡不住，她那边是靠这层拦下的。
   *   3. execute 里再查一次 scopeOk（防漏，见下面工具注册那段）。
   */
  const isolated = new Map()

  function isolateAgent(agent) {
    if (!agent || isolated.has(agent)) return isolated.has(agent)
    const tools = toolsOf(agent)
    if (!tools) return false
    const offs = []
    const sid = agentSessionId(agent) || '?'
    const cwd = agentCwd(agent) || '?'
    if (typeof tools.restrict === 'function') {
      try {
        const off = tools.restrict({ deny: TOOL_NAMES })
        if (typeof off === 'function') offs.push(off)
        log(`隔开了一条会话（restrict）：session=${sid} cwd=${cwd} → 看不到 ${TOOL_NAMES.join(' / ')}`)
      } catch (err) {
        // 这条是常态：插件 scope 里注册的名字 restrict 认不出全局。留一行痕迹就够。
        log(`restrict 没管用（session=${sid}）：${String(err?.message ?? err).slice(0, 120)}`)
      }
    }
    if (typeof tools.guard === 'function') {
      try {
        // exec 的形状各家略有不同：名字可能在 name / toolName / tool.name / definition.name。
        // 都看一眼，别因为取错字段就让她调得动。
        const off = tools.guard((exec) => {
          const name = exec?.name ?? exec?.toolName ?? exec?.tool?.name ?? exec?.definition?.name
          return TOOL_NAMES.includes(name)
            ? '这本账不在这条会话的目录里（设置页里的「隔离目录」／denyRoots）。'
            : undefined
        })
        if (typeof off === 'function') offs.push(off)
        log(`挡住了一条会话（guard）：session=${sid} cwd=${cwd} → ${TOOL_NAMES.join(' / ')} 一律被拒`)
      } catch (err) {
        log(`guard 没挂上（session=${sid}）：${String(err?.message ?? err).slice(0, 120)}`)
      }
    }
    if (!offs.length) return false
    isolated.set(agent, () => {
      for (const off of offs) {
        try {
          off()
        } catch {
          /* 已经松过了 */
        }
      }
    })
    return true
  }

  /** 把之前隔开的那几层收回来（配置改回允许、或者配置删掉了这条目录）。 */
  function releaseAgent(agent) {
    const off = isolated.get(agent)
    if (!off) return
    off()
    isolated.delete(agent)
  }

  /** 配置改了之后重新对一遍：范围里的松开，范围外的隔开。 */
  function sweepAgents() {
    for (const agent of safeGet('agents')?.list?.() ?? []) {
      try {
        if (scopeOk(agent)) releaseAgent(agent)
        else isolateAgent(agent)
      } catch {
        /* 单个 agent 出问题不该拖倒这一轮 */
      }
    }
  }

  // ---------------------------------------------------------------- 挂段落

  const attached = new WeakMap()
  /** 挂出去的每一组 disposer；插件被卸掉时统一收回来，免得重载后同一段名撞车。 */
  const liveOffs = new Set()

  function disposeOffs(offs) {
    if (!offs) return
    liveOffs.delete(offs)
    for (const off of offs) {
      try {
        off()
      } catch {
        /* 已经收过了就算了 */
      }
    }
  }

  function attachSection(agent) {
    if (!agent || attached.has(agent)) return false
    const sp = agent?.ctx?.systemPrompt
    if (!sp || typeof sp.section !== 'function') {
      log('这台宿主的 agent.ctx 上没有 systemPrompt.section，账本挂不上去')
      return false
    }
    const cfg = getCfg()
    const offs = []
    const add = (name, order, render) => {
      try {
        const off = sp.section({ name, order, text: render, interpolate: false })
        if (typeof off === 'function') offs.push(off)
        else if (off && typeof off.dispose === 'function') offs.push(() => off.dispose())
        return true
      } catch (err) {
        const why = String(err?.message ?? err).slice(0, 200)
        if (why.includes('already registered')) {
          // 上一次重载留下的注册还没收回（旧进程的残影）。多半是同一个段名，
          // 内容由那个实例负责；这里不当作失败，免得整组都挂不上。
          log(`段名占着（${name}）：${why}`)
          return true
        }
        log(`挂不上去（${name}）：${why}`)
        return false
      }
    }
    // 自我段排在账本段前面：先知道我是谁，再看记得什么
    if (cfg.selfEnabled !== false) {
      add('dsh-remember:self', clamp(cfg.selfSectionOrder, 1000, 9999), () => currentSelfSection())
    }
    // 思量段（定案 A）：恒审思量是「我」自己的动作，系统只给时机。
    // 批 D13a：思量/还没定的与「我」段解耦——关自我段不再连坐杀掉两段（定案 A：思量是独立段）
    if (cfg.narrationEnabled !== false) {
      add('dsh-remember:narration', clamp(cfg.narrationSectionOrder, 1000, 9999), () => currentNarrationSection())
    }
    add('dsh-remember:unsettled', clamp(cfg.unsettledSectionOrder, 1000, 9999), () => currentUnsettledSection())
    // 好奇段：排在自我段之后 —— 我想知道什么，是「我」之后的下一层
    if (cfg.curiosityEnabled !== false) {
      add('dsh-remember:curiosity', clamp(cfg.curiositySectionOrder, 1000, 9999), () => currentCuriositySection())
    }
    // 习惯段（快通路）：排在自我段之后、账本段之前 —— 习惯是身体反应那一档
    if (cfg.habitEnabled !== false) {
      add('dsh-remember:habit', clamp(cfg.habitSectionOrder, 1000, 9999), () => currentHabitSection())
    }
    // 瀑流段（定案 B）：昨日之流，读侧聚合——同 UTC 日缓存，零文件读。
    // order 8715：习惯（8680）之后、我记得的（8720）之前
    if (cfg.streamEnabled !== false) {
      add('dsh-remember:stream', clamp(cfg.streamSectionOrder, 1000, 9999), () => currentStreamSection())
    }
    // 情绪笔记段：默认不挂。开了也只是递一行笔记，不替我说话。
    if (cfg.emotionSectionEnabled !== false) {
      add(
        String(cfg.emotionSectionName || 'dsh-remember:emotion'),
        clamp(cfg.emotionSectionOrder, 1000, 9999),
        () => currentEmotionSection(),
      )
    }
    add('dsh-remember', clamp(cfg.sectionOrder, 1000, 9999), () => currentSection(Date.now(), agent))
    if (!offs.length) return false
    attached.set(agent, offs)
    liveOffs.add(offs)
    try {
      agent?.ctx?.effect?.(() => () => {
        disposeOffs(offs)
      })
    } catch {
      /* 没有 effect 也无所谓 */
    }
    if (getCfg().debug) {
      log(
        `账本段已挂进 system prompt（session=${agentSessionId(agent) || '?'} cwd=${agentCwd(agent) || '?'} 段数=${offs.length}）`,
      )
    }
    return true
  }

  ctx.effect(() => {
    const off = ctx.on?.('agent/created', (payload) => {
      // 事件给的是 { agent } 包装（dsh-fish 的同一个钩子也是这么收的），不是 agent 本身。
      // 直接拿包装当 agent 用，session/cwd 全是空、agent.ctx 也没有 systemPrompt ——
      // 2026-11-01 早上那条「agent.ctx 上没有 systemPrompt.section」就是它。
      const agent = payload?.agent ?? payload
      const sid = agentSessionId(agent)
      const cwd = agentCwd(agent)
      if (!scopeOk(agent)) {
        // 范围外的会话（比如她那边）：工具先隔开，段本来也不会挂。
        isolateAgent(agent)
        if (getCfg().debug) log(`会话开始：session=${sid || '?'} cwd=${cwd || '?'} → 不在范围里，只隔离`)
        return
      }
      if (!attachOk(agent)) {
        if (getCfg().debug) log(`会话开始：session=${sid || '?'} cwd=${cwd || '?'} → 不在范围里，跳过`)
        return
      }
      attachSection(agent)
    })
    // 插件中途重载时，已经活着的 agent 不会再有 agent/created —— 顺手给它们挂上。
    try {
      for (const agent of safeGet('agents')?.list?.() ?? []) {
        try {
          if (!scopeOk(agent)) isolateAgent(agent)
          if (attachOk(agent)) attachSection(agent)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 没有 agents 服务就算了 */
    }
    return () => {
      try {
        off?.()
      } catch {
        /* ignore */
      }
      // 插件被卸掉 / 重载之前，把挂出去的段落都收回来 —— 不收的话，
      // 同名的段在新实例里会被宿主拒成 "already registered in this scope"。
      for (const offs of [...liveOffs]) disposeOffs(offs)
      for (const agent of [...isolated.keys()]) {
        try {
          releaseAgent(agent)
        } catch {
          /* ignore */
        }
      }
    }
  }, 'dsh-remember: agent/created')

  // ---------------------------------------------------------------- 工具

  // 批 A（G-2 施工稿）：情绪域命令的决策本体在 commands/emotion.mjs；本文件只留适配壳
  //（scopeOk/agent 概念在壳，回执逐字不变）。闭包里的同名助手（pullFast/emotionState/noteEmotion…）
  // 还有 buildStatus/recall 等消费者，后续批次逐域切到 commands 再退役。
  const emotionCommands = createEmotionCommands({ book, log, cfg: getCfg, resolveDshHome })
  // 批 A 第二步：账本视图命令层（activationCtx 全家 + 缓存同车 + memory_list）
  const ledgerCommands = createLedgerCommands({ book, log, cfg: getCfg, pulls: emotionCommands })
  // 批 A 第三步：recall 决策本体（染色/翻身位/执受接线随迁；回执含条件字段 resurrect）
  const recallCommands = createRecallCommands({ book, log, cfg: getCfg, pulls: emotionCommands, ledger: ledgerCommands, emo: emotionCommands })
  // 批 A 第四步：写路径命令层（forget/narrate/transform；remember 单独一批）
  const writeCommands = createWriteCommands({ book, log, cfg: getCfg, ledger: ledgerCommands })
  // 批 A 第五步：remember 决策本体（写路径最大块——curiosity/habit/skill 快通路 + self 锚门/顶位门 + 染色层 + refs 触碰）
  const rememberCommands = createRememberCommands({ book, log, cfg: getCfg, ledger: ledgerCommands, emo: emotionCommands })

  const rememberTool = defineTool({
    name: 'remember',
    description:
      '把一件要留下的事写进你自己的账本。' +
      '三问能答就答（changes 改变了我什么／conflicts 跟旧的对上还是撞上／will_do 我会不会因此做得不一样）：' +
      '答上的条才会被挂到明天开头，一条都没答的只进原话层，不会被翻出来。' +
      'weight 是你现在觉得它有多重（0–1）：重的淡得慢（一个月才淡一半），轻的几天就淡下去。' +
      'kind=self 写的是「我是谁／我在意／我不做」这类自我陈述，用 slot 指定槽位' +
      '（identity 我是谁／cares 我在意／refuses 我不做，也可自己起新槽位名）：' +
      '同槽位写新值，旧的那条会退下（不删，还翻得到，但不再在开头跟自己顶嘴）。' +
      '挂了锚的槽例外（anchor 门）：anchor=true 挂锚必须先答三年问（anchor_why：这条三年后我还认不认、凭什么），' +
      '答不上来不给挂；锚在位时不被没挂锚的新值顶掉，一个槽最多一条锚；' +
      '换锚是大事——先让她点头，再带 replace_anchor=true + 三年问；退下的锚用 restore 传 id 随时捡回来。' +
      '顶位门（whale-card P0-2）：同槽位写新值比在位的轻时，默认不顶、先挂「还没定的」旁边；掂过之后还是想顶就带 confirmed=true。' +
      'kind=habit 写的是「在某个情境里我会照着做的事」，用 context 指定情境：' +
      '同一个情境再写一次 = 这个习惯又发生了一次（第 2 次习惯成立，第 3 次起走快通路，' +
      '不再跟别的条抢开头的位置）。' +
      'kind=curiosity 写的是「我想知道什么」，用 context 指定主题：' +
      '同一个主题再写一次 = 我又惦记了一遍（次数 +1）；answered=true 表示这个问题已经解答了，' +
      '解答了就退出活跃表（还在账本里，翻得到；同主题再写就回来）。' +
      '不确定要不要记，就记 —— 原话层只增不改，写下来不等于要一直想着它。',
    parameters: toJsonSchema({
      text: {
        type: 'string',
        required: true,
        description: '要留下的那件事本身。写成一句你自己认得出的话，不要写成给别人看的汇报。',
      },
      kind: {
        type: 'string',
        required: false,
        enum: KINDS,
        description:
          'fact 事实／decision 决定／lesson 教训／skill 会了／open 没结／self 我（自我陈述，配 slot 用）／habit 习惯（配 context 用）／curiosity 好奇（配 context 当主题用）。默认 fact。',
      },
      slot: {
        type: 'string',
        required: false,
        description:
          'kind=self 时占哪个槽位：identity 我是谁／cares 我在意／refuses 我不做；也可以自己起新的槽位名（英文或中文都行，同一个名字归同一个槽位）。',
      },
      anchor: {
        type: 'boolean',
        required: false,
        description:
          'kind=self 专用：把这条挂成槽位的锚。挂锚必须答三年问（anchor_why）——「这条三年后我还认不认」，答不上来不给挂。一个槽最多一条锚。',
      },
      anchor_why: {
        type: 'string',
        required: false,
        description: '三年问的回答：这条自我陈述三年后还认不认、凭什么。挂锚（anchor=true）时必填。',
      },
      replace_anchor: {
        type: 'boolean',
        required: false,
        description:
          'kind=self 专用：槽位已有锚时换锚用（配 anchor=true + anchor_why）。换锚是大事——先让她点头，再动手。旧锚退下但能 restore 捡回来。',
      },
      restore: {
        type: 'string',
        required: false,
        description:
          'kind=self 专用：把退下的某条自我陈述捡回来（传它的 id），它重新替这个槽说话。挂锚的条随时能捡；没挂锚的条在槽位有锚时捡不动。',
      },
      context: {
        type: 'string',
        required: false,
        description:
          'kind=habit 时写情境：在什么场合下我会照着做（一句短语，如「他问起记忆架构时」「每晚收工前」）。同一个情境再写一次 = 这个习惯又发生了一次；第 2 次习惯成立，第 3 次起走快通路（单独一段送到开头，不参与竞争）。' +
          'kind=curiosity 时写主题：这件事我想知道什么（一句短语）。同一个主题再写一次 = 我又惦记了一遍（次数 +1）。' +
          'kind=skill 时写名字：这门手艺叫什么（一句短语）。同一个名字再写一次 = 又成了一次；这次所在的工作目录会记进它的情境，两种**不同**的情境各成过一次，这条技能才成立（不是碰巧）。',
      },
      answered: {
        type: 'boolean',
        required: false,
        description:
          'kind=curiosity 时用：这个好奇已经解答了。解答了就退出活跃表（还在账本里，翻得到；同主题再写就回来）。',
      },
      weight: { type: 'number', required: false, description: '现在觉得多重，0–1。不写按 0.5。' },
      changes: {
        type: 'string',
        required: false,
        description:
          '第一问：这件事改变了我什么。kind=curiosity 时换个问法：知道了会改变我什么。',
      },
      conflicts: {
        type: 'string',
        required: false,
        description:
          '第二问：跟旧的对上了，还是撞上了。kind=curiosity 时换个问法：跟我已经知道的什么撞上了。',
      },
      will_do: {
        type: 'string',
        required: false,
        description:
          '第三问：我会不会因此做得不一样。kind=curiosity 时换个问法：下一步打算怎么试。',
      },
      known: {
        type: 'string',
        required: false,
        description: '第四问：我知道了什么——这件事本身就够了，不用硬编改变；答上这条也算「想过了」。',
      },
      confirmed: {
        type: 'boolean',
        required: false,
        description:
          'kind=self 专用：想顶掉分量更重的旧我时才带（true = 我知道我在顶）。不带时，比在位的轻的新条自动挂「还没定的」，不硬顶。',
      },
      tags: { type: 'string', required: false, description: '几个词，方便以后捞。逗号或空格分开。' },
      refs: {
        type: 'string',
        required: false,
        description:
          '相关的旧条 id，逗号分开。快层事件的 id（f_ 开头，从 recall 或 memory_list 拿）也可以写在这儿 —— 指向那条秒级发生的事，掂量过它。',
      },
    }),
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' }, note: { type: 'string' } },
        required: ['ok', 'id', 'note'],
      },
      render: (_args, out) => [
        {
          type: 'text',
          text: out.ok ? `[记下了 ${out.id}${out.note ? ` · ${out.note}` : ''}]` : `[没记下：${out.note}]`,
        },
      ],
    },
    async execute(args, exec) {
      // 批 A：决策本体在 commands/remember.mjs（写路径最大块收编完成——九工具全部命令层化）
      const agent = exec?.agent
      if (!getCfg().enabled) return { ok: false, id: '', note: '账本现在是关着的（设置 → 记得）。' }
      if (!scopeOk(agent)) return { ok: false, id: '', note: '这条会话不在允许记账的目录里（设置里的 allowRoots）。' }
      return rememberCommands.remember(args, { cwd: agentCwd(agent), sessionId: agentSessionId(agent) })
    },
  })

  const recallTool = defineTool({
    name: 'recall',
    description:
      '翻自己的账本。给 query 就按词找，不给就按现在的分量翻最重的几条。' +
      '淡下去的条也在这里 —— 淡不等于删，问得具体就能捞回来。' +
      '三条规矩先看：①给的是原文不是摘要（可信，但占地方）；' +
      '②limit 是每一路的上限 —— 不指定 kind 时账本、快层、意图层各翻 limit 条，最多是 3 倍；' +
      '③有字数闸：每条原文默认截到 recallItemMax 字、一次总共 recallMaxChars 字，超了会省，note 里会写省了什么。' +
      '要原文全文就加 full=true。',
    parameters: toJsonSchema({
      query: { type: 'string', required: false, description: '想找什么，几个词就够。' },
      limit: { type: 'number', required: false, description: '每一路最多给几条，默认 5；不指定 kind 时三路各这么多，别乱填大数。' },
      kind: { type: 'string', required: false, enum: KINDS, description: '只看某一类。' },
      group: { type: 'string', required: false, description: "只翻意图层里某个场：群号，或 'private' 只翻私聊。" },
      include_sealed: { type: 'boolean', required: false, description: '连被按住的也翻出来，默认不。' },
      full: { type: 'boolean', required: false, description: '要原文全文（默认每条截到 recallItemMax 字）。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          items: { type: 'array', items: { type: 'string' } },
          echoed: { type: 'boolean', description: '这次翻到的记了一笔「被想起」没有。' },
          origins: {
            type: 'object',
            description: '缘起链投影（定案 B）：id → 最近一次现行的 {lastSproutAt, lastQuery, with}。机器可读。',
          },
          resurrect: { type: 'string', description: '翻身位被翻出的那条 id（批 B1：零现行的老账给一次被想起的机会）。' },
          note: { type: 'string' },
        },
        required: ['ok', 'items', 'note'],
      },
      render: (_args, out) => [
        {
          type: 'text',
          text: out.ok
            ? out.items.length
              ? `[翻到 ${out.items.length} 条]\n${out.items.join('\n')}${
                  out.echoed ? '\n（翻到的都记了一笔「被想起」—— 它们这几天会更热一点）' : ''
                }`
              : '[账本里没有对得上的]'
            : `[翻不了：${out.note}]`,
        },
      ],
    },
    async execute(args, exec) {
      // 批 A：决策本体在 commands/recall.mjs（检索/排名/受众/染色/翻身位/执受/总量闸全身）。
      // 回执含条件字段 resurrect（翻身位触发时出现）——批 C 的 /recall HTTP 面原样透传（§0 契约 v:1）。
      return recallCommands.recall(args, { cwd: agentCwd(exec?.agent), sessionId: agentSessionId(exec?.agent) })
    },
  })

  const forgetTool = defineTool({
    name: 'forget',
    description:
      '把一条调轻或者按住。**没有删除** —— 淡、按、松开，原文永远还在原话层。' +
      'fade 把分量减半（它自己会继续淡下去）；seal 按住（不参与排名，也不被翻出来）——' +
      '给 until（如 30m/2h/3d）就是按到点自己松开，给 cond（另一条的 id）就是等那条翻篇才松开；' +
      '都不给就按住不设条件。restore 松开（时间到/条件解除的按住不用 restore，它们自己会松）。',
    parameters: toJsonSchema({
      id: { type: 'string', required: true, description: '哪一条，id 从 recall 或 memory_list 拿。' },
      mode: {
        type: 'string',
        required: true,
        enum: ['fade', 'seal', 'restore'],
        description: 'fade 调轻／seal 按住／restore 松开。',
      },
      until: {
        type: 'string',
        required: false,
        description: '只在 mode=seal 时用：按多久，如 30m、2h、3d（到点自己松开，不用 restore）。',
      },
      cond: {
        type: 'string',
        required: false,
        description:
          '只在 mode=seal 时用：另一条记忆的 id（r_ 开头）。那条还活着这条就按住，等它翻篇（被新值顶下）这条就自己松开。',
      },
      why: { type: 'string', required: false, description: '为什么，写给自己看。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' }, note: { type: 'string' } },
        required: ['ok', 'id', 'note'],
      },
      render: (_args, out) => [{ type: 'text', text: out.ok ? `[${out.note} ${out.id}]` : `[没成：${out.note}]` }],
    },
    async execute(args, exec) {
      // 批 A：决策本体在 commands/write.mjs（enabled 检查双份幂等：壳首保序，命令层自持）
      if (!getCfg().enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
      return writeCommands.forget(args, { cwd: agentCwd(exec?.agent), sessionId: agentSessionId(exec?.agent) })
    },
  })

  const listTool = defineTool({
    name: 'memory_list',
    description: '看看账本现在什么样：一共几条、哪几条最重、最近写了什么。不想要参数。',
    parameters: toJsonSchema({}),
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['ok', 'summary', 'items', 'note'],
      },
      render: (_args, out) => [
        {
          type: 'text',
          text: out.ok
            ? [`[账本] ${out.summary}`, ...out.items].join('\n')
            : `[看不了：${out.note}]`,
        },
      ],
    },
    async execute(_args, exec) {
      // 批 A：决策本体在 commands/ledger.mjs（activationCtx 全家 + 热路径缓存同车），这里只做适配
      return ledgerCommands.memoryList(_args, { cwd: agentCwd(exec?.agent), sessionId: agentSessionId(exec?.agent) })
    },
  })

  const emotionStateTool = defineTool({
    name: 'emotion_state',
    description:
      '看我心里此刻攒出来的那些东西：机器从真实发生的事里认出来的情绪，按各自的半衰期淡下去。' +
      '**这只是上次的我的笔记，不是我现在必须摆出的样子** —— 说出口的心情仍然是我当轮的判断。',
    parameters: toJsonSchema({
      limit: { type: 'number', required: false, description: '最近的几笔记几条，默认 8。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dominant: { type: 'string' },
          label: { type: 'string' },
          level: { type: 'number' },
          levels: { type: 'object' },
          coefficients: { type: 'object' },
          items: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['ok', 'dominant', 'label', 'level', 'levels', 'coefficients', 'items', 'note'],
      },
      render: (_args, out) => [
        {
          type: 'text',
          text: out.ok
            ? [
                `[情绪] ${out.label} ${Number(out.level ?? 0).toFixed(2)}`,
                ...(out.items ?? []),
                '（这是上次的笔记。想让我真的说出口什么，还是当轮的判断。）',
              ].join('\n')
            : `[看不了：${out.note}]`,
        },
      ],
    },
    async execute(args) {
      // 批 A：决策本体在 commands/emotion.mjs（情绪域命令层），这里只做适配
      return emotionCommands.emotionState(args)
    },
  })

  const emotionTuneTool = defineTool({
    name: 'emotion_tune',
    description:
      '改一种情绪在我这儿的系数 —— 从多少改到多少、为什么。' +
      '**改权重的权力在我账上**：每一次改都往情绪流的账（emotion.jsonl）追加一行，只增不改。' +
      '已经发生的那几笔不受影响（当时给的数写死在行里），改动只对往后的事生效。',
    parameters: toJsonSchema({
      emotion: {
        type: 'string',
        required: true,
        enum: [...EMOTION_KINDS],
        description: '改哪一种情绪。',
      },
      to: { type: 'number', required: true, description: '改成多少（0.1 到 3 之间）。' },
      halfLife: { type: 'number', required: false, description: '顺便改半衰期（分钟，5 到 1440）。不填就不改。' },
      reason: { type: 'string', required: true, description: '为什么改 —— 写给以后的我看。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          emotion: { type: 'string' },
          from: { type: 'number' },
          to: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['ok', 'id', 'emotion', 'from', 'to', 'note'],
      },
      render: (_args, out) => [
        {
          type: 'text',
          text: out.ok ? `[情绪] ${out.note}` : `[改不了：${out.note}]`,
        },
      ],
    },
    async execute(args) {
      // 批 A：决策本体在 commands/emotion.mjs，这里只做适配
      return emotionCommands.emotionTune(args)
    },
  })

  const VIKARMA_REASONS = ['未触发', '语气偏离', '条件不成立']

  const vikarmaTool = defineTool({
    name: 'vikarma',
    description:
      '记一笔违熏：种子说「我会因此做得不一样」（will_do），但实际没做到。' +
      '这不是删除，也不是调轻——只往违熏的账上追加一行，下次 recall 翻到这条时行尾会提醒。' +
      'expected 自动取种子的 will_do，不用你填；reason 只能从三个枚举里挑。',
    parameters: toJsonSchema({
      seedId: { type: 'string', required: true, description: '哪条种子没兑现（r_ 开头）。' },
      echoId: { type: 'string', required: false, description: '哪一次现行没兑现；不填就挂到最近一次。' },
      reason: {
        type: 'string',
        required: true,
        enum: VIKARMA_REASONS,
        description: '未触发（该做没做）／语气偏离（做了但态度不对）／条件不成立（当时以为会做，情境没出现）。',
      },
      actual: { type: 'string', required: false, description: '实际做了什么，一句话，给自己看。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' }, note: { type: 'string' } },
        required: ['ok', 'id', 'note'],
      },
      render: (_args, out) => [
        { type: 'text', text: out.ok ? `[违熏记下了 ${out.id} · ${out.note}]` : `[没记下：${out.note}]` },
      ],
    },
    async execute(args, exec) {
      // 批 A：决策本体在 commands/emotion.mjs。enabled 检查留壳首（保原始判定顺序：
      // 关账 + 范围外同发时回「关着」）；scopeOk 在壳（agent 概念不进命令层）。
      if (!getCfg().enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
      if (!scopeOk(exec?.agent)) return { ok: false, id: '', note: '这条会话不在允许记账的目录里。' }
      return emotionCommands.vikarma(args, { cwd: agentCwd(exec?.agent), sessionId: agentSessionId(exec?.agent) })
    },
  })

  const narrateTool = defineTool({
    name: 'narrate',
    description:
      '思量：以第一人称写一段「我怎么看最近的自己」，落成思量条。' +
      '思量逐条相续（自动接上一条的链），不覆盖任何东西；槽位被新值退下时也会盖演化链的章。' +
      'refs 只收种子（r_ 开头）——事件（f_/i_）不是种子，要引用先 remember 成种子。' +
      '答了四问的思量会挂进【思量】段；没答的翻得到、不挂段。',
    parameters: toJsonSchema({
      narrative: { type: 'string', required: true, description: '第一人称正文：我怎么看最近的自己。' },
      refs: {
        type: 'array',
        items: { type: 'string' },
        required: false,
        description:
          '引用的种子 id（r_ 开头）——这段思量从哪几条账上长出来的。' +
          '可不填（无根之思：思量不必都从种子长出来），但长出来的要留 refs；给了就只认账上真存在的 r_。',
      },
      changes: { type: 'string', required: false, description: '第一问：这件事改变了我什么。' },
      conflicts: { type: 'string', required: false, description: '第二问：跟旧的对上了，还是撞上了。' },
      will_do: { type: 'string', required: false, description: '第三问：我会不会因此做得不一样。' },
      known: { type: 'string', required: false, description: '第四问：我知道了什么。' },
      weight: { type: 'number', required: false, description: '分量 0–1，默认 0.5。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' }, note: { type: 'string' } },
        required: ['ok', 'id', 'note'],
      },
      render: (_args, out) => [
        { type: 'text', text: out.ok ? `[思量记下了 ${out.id} · ${out.note}]` : `[没记下：${out.note}]` },
      ],
    },
    async execute(args, exec) {
      // 批 A：决策本体在 commands/write.mjs（enabled/scope 检查留壳首保原始判定顺序）
      if (!getCfg().enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
      if (!scopeOk(exec?.agent)) return { ok: false, id: '', note: '这条会话不在允许记账的目录里。' }
      return writeCommands.narrate(args, { cwd: agentCwd(exec?.agent), sessionId: agentSessionId(exec?.agent) })
    },
  })

  /** 思量段（定案 A，2026-11-18）：链头最新一条的摘要 + 引种子数；due 时提示一句。
   *  思量由 AI 显式 narrate，系统只给时机——段里出现的一切都来自她自己的落笔。 */
  function currentNarrationSection(now = Date.now()) {    const cfg = getCfg()
    if (!cfg.enabled || cfg.narrationEnabled === false) return ''
    try {
      const all = hardAudNodes(book.nodes, now).filter((n) => n && normKind(n.kind) === 'narration')
      if (!all.length) return ''
      const newest = all.reduce((a, b) => ((Number(b.at) || 0) > (Number(a.at) || 0) ? b : a))
      // 链头要答过四问才挂（hasThought 闸门原样适用）；没答的翻得到、不挂段
      const head = all
        .filter((n) => hasThought(n))
        .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0] ?? null
      const intervalMs = clamp(cfg.narrationIntervalDays, 1, 30) * 24 * 60 * 60 * 1000
      const todayKey = new Date(now).toISOString().slice(0, 10)
      const writtenToday = all.some((n) => new Date(Number(n.at)).toISOString().slice(0, 10) === todayKey)
      const isDue = now - Number(newest.at) > intervalMs && !writtenToday
      if (!head) return isDue ? '【思量】\n（有一阵没这么看过自己了）' : ''
      const refsCount = Array.isArray(head.refs) ? head.refs.length : 0
      const text = Array.from(head.text).length > 120 ? `${cutByCodePoints(head.text, 120)}…` : head.text
      const lines = [`· ${text}（引 ${refsCount} 条种子）`]
      if (isDue) lines.push('（有一阵没这么看过自己了）')
      return clipSection('【思量】', lines.join('\n'), clamp(cfg.narrationSectionMaxChars, 80, 2000))
    } catch (err) {
      log(`思量段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  /** 瀑流段（定案 B，2026-11-18）：昨日之流是读侧聚合——
   *  同 UTC 日内缓存流文本（缓存挂 book.streamCache，批③子步 3 进 Book）：
   *  hub 每 5 秒拉一次 status，重算就是灯案第二。段空就是没得说，不硬凑叙述（无数据不挂段）。 */

  // ---------------------------------------------------------------- 执受（定案 C，2026-11-18）
  //
  // 身→识（识受身）：身体现状折成契合路的「此刻真实」输入（deriveStandingBodyStates）。
  // 识→身（身受识）：带情绪的现行经身体的外部心情进料口通知身体。
  // 反射弧，不是思量——身不由己，正是执受。
  // 地盘：身体永远不写 remember 的账；remember 永不读回自己写的 sprout 行。

  // 执受写入点已收 core/protocol/book.js 的 sproutToBody（批③子步 2）；
  // 身→识（deriveStandingBodyStates 进契合路）仍在上面 activationCtx。
  function currentStreamSection(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.streamEnabled === false) return ''
    try {
      const day = new Date(now).toISOString().slice(0, 10)
      if (book.streamCache.day === day) return book.streamCache.text
      const dayMs = 24 * 60 * 60 * 1000
      const we = Math.floor(now / dayMs) * dayMs // 今日 UTC 起点 = 昨日窗口终点
      const yesterdayKey = new Date(we - 1).toISOString().slice(0, 10)
      const vikarmaYesterday = Number(book.vikarmaAgg.byDay[yesterdayKey] ?? 0)
      const text = renderYesterdayStream({
        nodes: book.nodes,
        echoTimes: book.echoAt,
        vikarmaNewCount: vikarmaYesterday,
        now,
        maxChars: clamp(cfg.streamSectionMaxChars, 80, 2000),
      })
      book.streamCache = { day, text }
      return text
    } catch (err) {
      log(`瀑流段渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
      return ''
    }
  }

  const transformTool = defineTool({
    name: 'transform',
    description:
      '转识成智：从一颗种子里提炼出「我从中明白了什么」。' +
      '智落成 kind:wisdom 的节点（refs 指回原种子），原种子盖 transformed 旗——' +
      '不删、recall 翻得到、行尾指路「已转化 → w_xxx」。' +
      '一种子一转化；智本身可以再转（链式升华）。' +
      '五类不收：self（用 supersedeSelf）、habit/curiosity/skill（各有自己的生命周期）。',
    parameters: toJsonSchema({
      seedId: { type: 'string', required: true, description: '要转化的种子 id（r_ 或 n_ 或 w_）。' },
      insight: { type: 'string', required: true, description: '「我从中明白了什么」——落成智的正文。' },
      conflicts: { type: 'string', required: false, description: '第二问：跟旧的对上了，还是撞上了。' },
      will_do: { type: 'string', required: false, description: '第三问：我会不会因此做得不一样。' },
      known: { type: 'string', required: false, description: '第四问：我知道了什么。' },
      weight: { type: 'number', required: false, description: '分量 0–1，默认 0.8。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' }, note: { type: 'string' } },
        required: ['ok', 'id', 'note'],
      },
      render: (_args, out) => [
        { type: 'text', text: out.ok ? `[智记下了 ${out.id} · ${out.note}]` : `[没记下：${out.note}]` },
      ],
    },
    async execute(args, exec) {
      // 批 A：决策本体在 commands/write.mjs（五类不收/已转化拒/旗回滚全在命令层）
      if (!getCfg().enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
      if (!scopeOk(exec?.agent)) return { ok: false, id: '', note: '这条会话不在允许记账的目录里。' }
      return writeCommands.transform(args, { cwd: agentCwd(exec?.agent), sessionId: agentSessionId(exec?.agent) })
    },
  })

  ctx.effect(() => {
    const disposers = []
    // 第二层隔离的拒绝回执按各工具的 output schema 给 —— 范围外调用也得是合规回执，
    // 缺必填字段（memory_list 的 summary、emotion_state 的 dominant/…、emotion_tune 的
    // emotion/from/to）会被宿主校验层当坏结果（2026-11-16 重新接回）。
    const OUT_OF_SCOPE_NOTE = '这条会话不在允许读写账本的目录里（设置里的 targetRoot／allowRoots）。'
    const REJECTS = {
      memory_list: () => ({ ok: false, summary: '', items: [], note: OUT_OF_SCOPE_NOTE }),
      emotion_state: () => ({
        ok: false,
        dominant: '',
        label: '',
        level: 0,
        levels: {},
        coefficients: {},
        items: [],
        note: OUT_OF_SCOPE_NOTE,
      }),
      emotion_tune: () => ({ ok: false, id: '', emotion: '', from: 0, to: 0, note: OUT_OF_SCOPE_NOTE }),
      vikarma: () => ({ ok: false, id: '', note: OUT_OF_SCOPE_NOTE }),
      narrate: () => ({ ok: false, id: '', note: OUT_OF_SCOPE_NOTE }),
      transform: () => ({ ok: false, id: '', note: OUT_OF_SCOPE_NOTE }),
    }
    for (const raw of [rememberTool, recallTool, forgetTool, listTool, emotionStateTool, emotionTuneTool, vikarmaTool, narrateTool, transformTool]) {
      try {
        // 第二层隔离：就算工具 somehow 出现在范围外的会话里，调用也过不去。
        // remember 自己还会再查一次（那是第三层，管写）。
        const reject = REJECTS[raw.name] ?? (() => ({ ok: false, id: '', items: [], note: OUT_OF_SCOPE_NOTE }))
        const def = {
          ...raw,
          execute: async (args, exec) => {
            if (instanceYielded()) {
              return { ...reject(), note: '单例闸：这本账已由新实例接管，本实例只读（HMR/双开窗口）。' }
            }
            if (!scopeOk(exec?.agent)) {
              log(
                `拒绝了一次范围外的调用：${raw.name} · session=${agentSessionId(exec?.agent) || '?'} cwd=${agentCwd(exec?.agent) || '?'}`,
              )
              return reject()
            }
            return raw.execute(args, exec)
          },
        }
        const d = ctx.tools.register(def)
        if (typeof d === 'function') disposers.push(d)
        else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
      } catch (err) {
        // 用 raw.name —— def 声明在 try 里，register 一抛错这里引用它会自己再炸一个
        // ReferenceError，把整个注册循环打断、后面的工具全挂不上（2026-11-16 复核修的）
        log(`工具注册失败 ${raw.name}：${String(err?.message ?? err).slice(0, 200)}`)
      }
    }
    log(
      disposers.length
        ? `工具挂上了：remember / recall / forget / memory_list / emotion_state / emotion_tune / vikarma / narrate / transform（${disposers.length} 过）`
        : '工具一个都没挂上',
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
  }, 'dsh-remember: tools')

  // ---------------------------------------------------------------- 设置页数据

  function safeGet(key) {
    try {
      return ctx.get?.(key) ?? null
    } catch {
      return null
    }
  }

  function send(res, code, obj) {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(obj ?? null))
    } catch {
      /* ignore */
    }
  }

  function readBody(req, maxBytes = 65536) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        resolve(value)
      }
      req.on?.('data', (c) => {
        size += c.length
        if (size > maxBytes) {
          finish('')
          try {
            req.destroy?.()
          } catch {
            /* ignore */
          }
          return
        }
        chunks.push(c)
      })
      req.on?.('end', () => finish(Buffer.concat(chunks).toString('utf8')))
      req.on?.('error', () => finish(''))
    })
  }

  function guarded(handler) {
    return async (req, res) => {
      // 栅栏 fail-closed（2026-11-15 审查改的，2026-11-16 重新接回）：连接服务不在、
      // 守卫抛错 —— 一律拒。这两个口子开着，等于把「改 allowRoots/denyRoots」的
      // 设置接口暴露给没有鉴权的请求。宁可这会儿面板打不开，不能没有栅栏。
      // conn 每次请求现取 —— apply 时 connection 还没就绪也不至于以后全裸奔
      //（对齐 dsh-body / dsh-qq-bridge 的写法）。
      try {
        const conn = safeGet('connection')
        if (!conn || typeof conn.requestRejection !== 'function') {
          send(res, 503, { ok: false, error: '鉴权服务不可用，拒绝访问（fail closed）' })
          return
        }
        const rejection = conn.requestRejection(req)
        if (rejection) {
          send(res, 403, { ok: false, error: String(rejection?.message ?? rejection) })
          return
        }
      } catch (err) {
        log(`设置接口鉴权出错，拒绝访问：${String(err?.message ?? err).slice(0, 160)}`)
        send(res, 503, { ok: false, error: '鉴权出错，拒绝访问（fail closed）' })
        return
      }
      try {
        await handler(req, res)
      } catch (err) {
        send(res, 500, { ok: false, error: String(err?.message ?? err).slice(0, 300) })
      }
    }
  }

  /**
   * 现在有哪些工作区、各自在不在隔离名单里 —— 设置页按工作区勾选要用。
   *
   * 为什么按工作区：workspace 的 key（`--E-~5927~80A5~9C7C-Plugin--`）是有损编码，
   * 路径里的 '-' 和层级分隔符长得一样，解回去会错；所以认的是 workspace.json 里
   * 真实的 path。设置页上写的仍然是 denyRoots 的路径。
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
      const file = readJsonSafe(join(resolveDshHome(), 'storages', 'workspace.json'), null)
      const table = file?.tables?.workspaces
      if (isObj(table)) {
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
    const cfg = getCfg()
    const now = Date.now()
    // 设置页每几秒拉一次 status —— 顺手把快层的新事件抄进来，
    // 这样页面上的「快层」是活的（抄不动就算了，不影响后面的读取）。
    try {
      pullFast(now)
    } catch {
      /* 抄不动不该让 status 挂掉 */
    }
    // 意图层同理：桥那边刚进来的消息，也得能在页面上看到
    try {
      pullIntent(now)
    } catch {
      /* 同上 */
    }
    // 情绪流同理：刚认出来的事，折出来的笔记才是新的
    try {
      pullEmotion(now)
    } catch {
      /* 同上 */
    }
    // 熏习势力统计：算一次，echoes 与 display 两块共用 —— scanMs 是
    // 「衰减只在读时算」的代价观测点（2026-11-16 复核：别只量一半）
    const echoStatsT0 = performance.now()
    const eStats = echoStats(now)
    const echoScanMs = Math.round((performance.now() - echoStatsT0) * 100) / 100
    // status 这层拿不到具体的会话（没有 agent），契合这一路按「没有当前目录」算；
    // 排名仍用激活度 —— 跟真机会话里看到的顺序一致（差的那点只是 fit 的目录分量）。
    const scoreOf = activationScorer(null, now)
    const s = summaryOf(book.nodes, now, { scoreOf })
    const top = rankNodes(book.nodes, now, { limit: 8, scoreOf }).map((h) => {
      const { activation, axes } = activationOf(h.node, now, {
        repeatCounts: repeatCounts(book.nodes),
        echoes: echoCounts(now),
      })
      return {
        id: h.node.id,
        kind: h.node.kind,
        weight: Number(h.node.weight.toFixed(2)),
        // 分值 = 老 score（只看分量和时间）；激活 = 四路凸组合（还看契合和复现）
        score: Number(score(h.node, now).toFixed(3)),
        activation: Number(activation.toFixed(3)),
        axes: {
          weight: Number(axes.weight.toFixed(3)),
          recency: Number(axes.recency.toFixed(3)),
          fit: Number(axes.fit.toFixed(3)),
          repeat: Number(axes.repeat.toFixed(3)),
        },
        at: new Date(h.node.at).toISOString(),
        when: relTime(h.node.at, now),
        text: h.node.text.slice(0, 200),
        thought: hasThought(h.node),
      }
    })
    // 按住的列出来三种都算：手动按的、按到点的（带还剩多久）、等条件的（带在等谁）
    const dirNow = indexNodes(book.nodes)
    const sealed = book.nodes
      .filter((n) => isSealed(n, now, dirNow))
      .slice(-8)
      .map((n) => ({
        id: n.id,
        text: n.text.slice(0, 120),
        seal: n.sealed ? 'plain' : n.sealCond ? 'cond' : 'until',
        left: n.sealUntil ? relSealLeft(n.sealUntil, now) : '',
        cond: n.sealCond || '',
      }))
    return {
      ok: true,
      now: new Date(now).toISOString(),
      plugin: { name, version: VERSION, startedAt: new Date(book.meta.startedAt).toISOString(), uptimeMs: now - book.meta.startedAt, dataDir },
      // 账本健康（自 shihai 合并，2026-11-16）：损坏红灯别只写在日志里，面板要看得见。
      // broken=读不出能认的账；backupOk=原文已滚 .bak（真丢了还能找回来）
      ledger: { broken: book.broken, backupOk: book.backupOk },
      injection: {
        enabled: cfg.enabled,
        targetRoot: cfg.targetRoot,
        allowRoots: cfg.allowRoots,
        denyRoots: Array.isArray(cfg.denyRoots) ? cfg.denyRoots : [],
        count: book.meta.renderCount,
        lastAt: book.meta.lastRenderAt ? new Date(book.meta.lastRenderAt).toISOString() : null,
        lastError: book.meta.lastRenderError,
        section: currentSection(now),
        selfEnabled: cfg.selfEnabled !== false,
        selfSection: currentSelfSection(now),
        unsettledEnabled: cfg.unsettledEnabled !== false,
        unsettledSection: currentUnsettledSection(now),
        curiosityEnabled: cfg.curiosityEnabled !== false,
        curiositySection: currentCuriositySection(now),
        habitEnabled: cfg.habitEnabled !== false,
        habitSection: currentHabitSection(now),
      },
      self: {
        slots: activeSelfNodes(book.nodes, now).map((n) => ({
          id: n.id,
          slot: n.slot,
          label: slotLabel(n.slot),
          text: n.text.slice(0, 300),
          weight: Number(selfWeight(n, now).toFixed(3)),
          anchor: Boolean(n.anchor),
        })),
        seeds: SELF_SLOTS.map((s) => ({ key: s.key, label: s.label })),
        unsettled: unsettledNodes(book.nodes, now).length,
      },
      habits: {
        fast: fastHabits(book.nodes, now, { limit: clamp(cfg.habitLimit, 0, 10) }).map((n) => ({
          id: n.id,
          context: n.context,
          hits: n.hits,
          state: habitState(n),
          text: n.text.slice(0, 200),
        })),
        candidates: book.nodes
          .filter(
            (n) =>
              normKind(n.kind) === 'habit' &&
              !isSealed(n, now, dirNow) &&
              !n.superseded &&
              habitState(n) !== 'fast',
          )
          .map((n) => ({
            id: n.id,
            context: n.context,
            hits: n.hits,
            state: habitState(n),
            text: n.text.slice(0, 200),
          })),
        limit: clamp(cfg.habitLimit, 0, 10),
      },
      curiosity: curiosityStats(book.nodes, now, { limit: clamp(cfg.curiosityLimit, 0, 10) }),
      fast: (() => {
        const source = fastSourcePath(cfg)
        const events = fastAllEvents(now)
        const weighed = weighedFastIds()
        const sum = fastSummary(events, { weighed })
        return {
          enabled: cfg.enabled && cfg.fastEnabled !== false,
          source,
          copied: countLines(book.files.fast),
          ...sum,
          recent: book.fastIndex.slice(0, 5).map((ev) => ({
            id: ev.id,
            kind: ev.kind,
            text: String(ev.text ?? '').slice(0, 160),
            at: new Date(ev.at).toISOString(),
            when: fastRelTime(ev.at, now),
            weighed: weighed.has(ev.id),
          })),
        }
      })(),
      intent: (() => {
        const sources = intentSourcePaths(cfg)
        const events = intentAllEvents(now)
        const sum = summarizeIntents(events)
        // 按场分组计数（v0.15.0 分册）：群按群号，私聊归 'private'
        const byGroup = {}
        for (const ev of events) {
          const g = ev.chatType === 'private' ? 'private' : String(ev.groupId ?? '') || 'unknown'
          byGroup[g] = (byGroup[g] || 0) + 1
        }
        return {
          enabled: cfg.enabled && cfg.intentEnabled !== false,
          sources,
          source: sources[0] ?? '',
          byGroup,
          copied: countLines(book.files.intent),
          ...sum,
          recent: book.intentIndex.slice(0, 5).map((ev) => ({
            id: ev.id,
            kind: ev.kind,
            label: INTENT_LABEL[ev.kind] ?? ev.kind,
            intensity: ev.intensity,
            text: String(ev.text ?? '').slice(0, 160),
            at: new Date(ev.at).toISOString(),
            when: intentRelTime(ev.at, now),
          })),
        }
      })(),
      emotion: (() => {
        // 情绪流的状态：机器从真事里认出来的那些情绪，折到此刻的样子。
        // 这只是笔记 —— 不接管嘴（说出口的心情还是我当轮的判断）。
        const state = emotionState(now)
        const events = state.lines.filter((l) => l.kind === 'event')
        const tunes = state.lines.filter((l) => l.kind === 'tune')
        const weighed = weighedEmotionIds()
        return {
          enabled: cfg.enabled && cfg.emotionEnabled !== false,
          dominant: state.dominant,
          label: state.label,
          level: state.level,
          levels: state.levels,
          unresolved: Boolean(state.unresolved),
          mixed: Array.isArray(state.mixed) ? state.mixed : [],
          total: state.total,
          lastAt: state.lastAt ? new Date(state.lastAt).toISOString() : null,
          /** 系数表：种子 + 账上改过的（tune 行只增不改） */
          coefficients: Object.fromEntries(
            Object.entries(state.coefficients ?? {}).map(([k, v]) => [
              k,
              { coefficient: v.coefficient, halfLife: v.halfLife },
            ]),
          ),
          events: events.length,
          tunes: tunes.length,
          note: renderEmotionNote(state, { maxChars: clamp(cfg.emotionMaxChars, 80, 2000) }),
          recent: [...events]
            .sort((a, b) => b.at - a.at)
            .slice(0, 5)
            .map((ev) => ({
              id: ev.id,
              emotion: ev.emotion,
              label: EMOTION_LABEL[ev.emotion] ?? ev.emotion,
              delta: ev.delta,
              intensity: ev.intensity,
              source: ev.source,
              ref: ev.ref,
              text: String(ev.text ?? '').slice(0, 160),
              at: new Date(ev.at).toISOString(),
              when: emotionRelTime(ev.at, now),
              weighed: weighed.has(ev.id),
            })),
        }
      })(),
      summary: s,
      nodes: top,
      activation: {
        /** 四路的权重，和为 1。写死在代码里，不开面板口子。 */
        axes: { ...ACTIVATION_AXES },
        /** 两把钟：分量淡按天（老 score 那层），新近按分钟到小时（中层的刻度），自我按月。 */
        recencyTau: { baseMin: RECENCY_TAU_BASE_MIN, spanMin: RECENCY_TAU_SPAN_MIN, full: REPEAT_FULL },
        /** 唤醒回弹：被想起的回声只数最近几天的。 */
        echoWindowDays: Math.round(ECHO_WINDOW_MS / 86400000),
      },
      echoes: (() => {
        // count = 次数（给人看），strength = 熏习势力（真信号）—— 按 strength 排。
        // scanMs 是熏习扫描的耗时（衰减只在读时算的代价观测点）：跑两周看它，
        // 超预期再上增量索引（行号→字节偏移），现在不动。
        let total = 0
        for (const s of eStats.values()) total += s.count
        const top = [...eStats.entries()]
          .sort((a, b) => b[1].strength - a[1].strength)
          .slice(0, 5)
          .map(([id, s]) => ({ id, count: s.count, strength: Number(s.strength.toFixed(2)) }))
        return { windowDays: Math.round(ECHO_WINDOW_MS / 86400000), total, top, scanMs: echoScanMs }
      })(),
      // 展示观测（不算现行，只记账）：谁常挂但从不被想起 —— 死重或 recall 词表覆盖不到的候选。
      // cold = 展示 ≥3 天但熏习势力为 0 的条。只观测，不改排名；跑两周看分布。
      // 覆盖范围：只记【我记得的】段的 pick（习惯/好奇/自我段另有段，不在此列）；
      // 「天」是 UTC 日；clipSection 截断在 pick 之后，被预算截掉的行也计展示（略高估，见 philosophy.md）。
      display: (() => {
        const rows = []
        let total = 0
        for (const [id, days] of book.displayDays) {
          total += days.size
          rows.push({ id, days: days.size })
        }
        rows.sort((a, b) => b.days - a.days)
        const cold = rows.filter((r) => r.days >= 3 && !eStats.has(r.id)).slice(0, 5)
        return { total, top: rows.slice(0, 5), cold }
      })(),
      // 违熏（校正质量的账，不进复现轴）：总数、按原因分布、违熏最多的种子
      // —— 从内存索引聚合（vikarma.jsonl 只增不减，别每 5 秒整本解析）
      vikarma: (() => {
        const top = [...book.vikarmaAt.entries()]
          .map(([seedId, v]) => ({ seedId, count: v.count, lastAt: v.at }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
        return { total: book.vikarmaAgg.total, byReason: { ...book.vikarmaAgg.byReason }, top }
      })(),
      // 受众（借自晴猫）：三档开关 + 打了标的新条数（旧条是 any，不计数）
      audience: {
        mode: String(cfg.recallAudience ?? 'off'),
        stamped: book.nodes.filter((n) => n.audience && n.audience !== 'any').length,
      },
      // 思量（定案 A）：全内存算（hub 每 5 秒拉一次 status，别读文件——灯案教训）
      narration: (() => {
        const all = hardAudNodes(book.nodes, now).filter((n) => n && normKind(n.kind) === 'narration')
        const newest = all.reduce((a, b) => {
          const aa = Number(a?.at) || 0
          const bb = Number(b?.at) || 0
          return bb > aa ? b : a
        }, null)
        const intervalMs = clamp(cfg.narrationIntervalDays, 1, 30) * 24 * 60 * 60 * 1000
        const todayKey = new Date(now).toISOString().slice(0, 10)
        const writtenToday = all.some((n) => new Date(Number(n.at)).toISOString().slice(0, 10) === todayKey)
        return {
          count: all.length,
          lastAt: newest ? new Date(newest.at).toISOString() : null,
          due: all.length === 0 || (now - Number(newest.at) > intervalMs && !writtenToday),
          latest: newest
            ? { id: newest.id, at: new Date(newest.at).toISOString(), refsCount: Array.isArray(newest.refs) ? newest.refs.length : 0 }
            : null,
        }
      })(),
      // 转识成智（定案 D）：全内存算（灯案纪律）
      wisdom: (() => {
        const all = book.nodes.filter((n) => n && normKind(n.kind) === 'wisdom')
        const newest = all.reduce((a, b) => {
          const aa = Number(a?.at) || 0
          const bb = Number(b?.at) || 0
          return bb > aa ? b : a
        }, null)
        return {
          count: all.length,
          latest: newest
            ? { id: newest.id, at: new Date(newest.at).toISOString(), seedId: (newest.refs ?? [])[0] ?? '' }
            : null,
        }
      })(),
      wake: {
        enabled: cfg.enabled && cfg.wakeEnabled !== false && cfg.fastEnabled !== false,
        sessionId: wakeState.target,
        cooldownMinutes: clamp(cfg.wakeCooldownMinutes, 0, 720),
        kinds: [...WAKE_KINDS],
        beats: wakeState.beats,
        lastWakeAt: wakeState.lastWakeAt ? new Date(wakeState.lastWakeAt).toISOString() : null,
        lastText: wakeState.lastText,
      },
      // 执受（定案 E，v0.24.0）：观测耳目——book.sproutTracker 内存求和，零文件读
      sprout: { today: book.sproutAgg.today, total: book.sproutAgg.total },
      sealed,
      workspaces: listWorkspaces(),
      // 计数走 countLines（只数行不 parse）—— status 每几秒被拉一次，别为它整本解析
      rawLines: countLines(book.files.lines),
      rawEchoes: countLines(book.files.echo),
      // 统一时间锚的原始数据（2026-11-16 起收集，跑两周看三者差值和分布）：
      // 上次写账本（这里）/ 上次有情绪（emotion.lastAt）/ 上次被叫醒（wake.lastWakeAt）
      // —— 三者语义不同，先别统一，等分布说话
      lastLineAt: (() => {
        try {
          const last = tailLines(book.files.lines, 1)[0]
          const at = Number(JSON.parse(last ?? '')?.at)
          return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null
        } catch {
          return null
        }
      })(),
      config: { effective: cfg, editable: Object.keys(EDITABLE) },
      paths: book.files,
      logs: tailLines(book.files.log, 8),
    }
  }

  function registerRoutes() {
    const webServer = safeGet('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      log('宿主没有 webServer.register，设置页的数据接口没挂上（工具和注入照常跑）')
      return
    }
    const routes = [
      [
        '/status',
        guarded(async (req, res) => {
          if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
            send(res, 405, { ok: false, error: '只收 GET' })
            return
          }
          send(res, 200, buildStatus())
        }),
      ],
      [
        '/config',
        guarded(async (req, res) => {
          const method = String(req.method ?? 'GET').toUpperCase()
          if (method === 'GET') {
            const cfg = getCfg(true)
            const overrides = loadOverridesLogged()
            send(res, 200, { ok: true, effective: cfg, overrides: isObj(overrides) ? overrides : {}, editable: Object.keys(EDITABLE) })
            return
          }
          if (method !== 'POST') {
            send(res, 405, { ok: false, error: '只收 GET / POST' })
            return
          }
          const raw = await readBody(req)
          let patch = {}
          try {
            patch = raw ? JSON.parse(raw) : {}
          } catch {
            send(res, 400, { ok: false, error: '发过来的不是 JSON' })
            return
          }
          const cfg = getCfg(true)
          const overrides = loadOverridesLogged()
          const result = applyConfigPatch({ overrides, effective: cfg, patch })
          if (!result.ok) {
            send(res, 400, { ok: false, accepted: result.accepted, rejected: result.rejected })
            return
          }
          atomicWriteJson(book.files.config, result.overrides)
          cfgCache = { at: 0, value: null }
          const next = getCfg(true)
          // 范围可能刚被改小/改大：对着活着的会话重跑一遍隔离。
          sweepAgents()
          log(`设置页改了配置：${describePatch(result.accepted)}`)
          send(res, 200, { ok: true, accepted: result.accepted, rejected: result.rejected, effective: next })
        }),
      ],
      [
        '/selftest',
        guarded(async (req, res) => {
          if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
            send(res, 405, { ok: false, error: '只收 POST' })
            return
          }
          // 设置页「测一下」：读写探针，不往真账本里塞测试条。
          // ① 账读得到（summaryOf 跑通）②数据目录写得进（探针文件写进去验一遍再删）。
          const t0 = Date.now()
          try {
            const s = summaryOf(book.nodes, t0)
            let probeWritten = false
            const probe = `${book.files.memory}.selftest-probe.json`
            try {
              atomicWriteJson(probe, { at: t0, probe: true })
              probeWritten = readJsonSafe(probe, null)?.at === t0
            } finally {
              try { rmSync(probe, { force: true }) } catch { /* 删不掉不算失败，别留锁 */ }
            }
            send(res, 200, {
              ok: probeWritten,
              ms: Date.now() - t0,
              ledger: { total: s.total, alive: s.alive, sealed: s.sealed },
              dataDir: book.files.memory,
              note: probeWritten
                ? `读写都通：账上 ${s.total} 条（活着 ${s.alive}），数据目录写得进。`
                : `账读得到（${s.total} 条）但数据目录写不进——查一下磁盘权限或杀软。`,
            })
          } catch (err) {
            send(res, 200, { ok: false, ms: Date.now() - t0, note: `自检没过：${String(err?.message ?? err).slice(0, 200)}` })
          }
        }),
      ],
    ]
    const disposers = []
    for (const [path, handler] of routes) {
      try {
        const d = webServer.register({ kind: 'prefix', path: `/dsh-remember${path}`, handler })
        if (typeof d === 'function') disposers.push(d)
        else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
      } catch (err) {
        log(`路由挂不上 ${path}：${String(err?.message ?? err).slice(0, 200)}`)
      }
    }
    log(
      disposers.length
        ? `设置页数据接口已挂上：/dsh-remember/status、/dsh-remember/config、/dsh-remember/selftest（${disposers.length} 条）`
        : '设置页数据接口一条都没挂上',
    )
    ctx.effect(() => () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* ignore */
        }
      }
    })
  }

  registerRoutes()

  const s = summaryOf(book.nodes, Date.now())
  log(
    `启动 v${VERSION}：账本 ${book.files.memory}（${s.total} 条，活着 ${s.alive}，按住 ${s.sealed}）；` +
      `挂到 ${getCfg().targetRoot || '（哪条会话都挂）'}；原话层 ${readJsonLines(book.files.lines, 0).length} 行`,
  )

  // 宿主不看返回值（卸载只认 ctx.effect 的 teardown）；这对象是给冒烟直接驱动心跳用的。
  return { wakeBeat, wakeState }
}
