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
 *     权重写死，不开面板口子。读取路径上只算不写。
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

import { readdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KIND_LABEL,
  KINDS,
  SELF_SLOTS,
  activeCuriosities,
  activeSelfNodes,
  cleanText,
  contextKey,
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
  normNodes,
  normSlot,
  parseSealUntil,
  rankNodes,
  recordCuriosity,
  recordHabit,
  recordSkill,
  relSealLeft,
  relTime,
  renderCuriositySection,
  renderHabitSection,
  renderLine,
  renderSection,
  renderSelfSection,
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
} from './lib/memory.js'
import { EDITABLE, applyConfigPatch, describePatch } from './lib/config.js'
import {
  ACTIVATION_AXES,
  ECHO_WINDOW_MS,
  RECENCY_TAU_BASE_MIN,
  RECENCY_TAU_SPAN_MIN,
  REPEAT_FULL,
  activationOf,
  repeatCounts,
} from './lib/activation.js'
import {
  fastEventId,
  fastRelTime,
  fastSummary,
  normFastEvent,
  pushFastIndex,
  renderFastLine,
  searchFastEvents,
} from './lib/fast.js'
import {
  INTENT_LABEL,
  intentEventFromMessage,
  intentIdFromMessage,
  intentRelTime,
  normIntentEvent,
  pushIntentIndex,
  renderIntentLine,
  searchIntentEvents,
  summarizeIntents,
} from './lib/intent.js'
import {
  EMOTION_KINDS,
  EMOTION_LABEL,
  emotionCoefficients,
  emotionDelta,
  emotionEventId,
  emotionRelTime,
  emotionTuneId,
  foldEmotion,
  normEmotionLine,
  recognizeEmotion,
  renderEmotionLine,
  renderEmotionNote,
} from './lib/emotion.js'
import {
  agentCwd,
  agentSessionId,
  appendJsonLine,
  atomicWriteJson,
  exists,
  isUnder,
  keepTailLines,
  makeFileLogger,
  readJsonLines,
  readJsonLinesFrom,
  readJsonSafe,
  readTextSafe,
  resolveDshHome,
  tailLines,
} from './lib/store.js'

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
 * 这本账的四个工具。范围外的会话不该碰得到：先 try restrict 把它们从工具表里遮掉
 * （只对全局注册的工具有效），遮不掉就挂 agent scope 的 guard，一律拒（见 isolateAgent）。
 */
const TOOL_NAMES = ['remember', 'recall', 'forget', 'memory_list', 'emotion_state', 'emotion_tune']

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
   * 隔离目录：这些目录下的会话完全碰不到这本账 —— 看不到四个工具、不挂段、不许写。
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
      out[key] = typeof v === 'string' ? v : def
    }
  }
  return out
}

export function apply(ctx, baseConfig = {}) {
  const dataDir = String(baseConfig?.dataDir ?? '').trim() || join(resolveDshHome(), '.dsh-remember')
  const files = {
    dir: dataDir,
    memory: join(dataDir, 'memory.json'),
    lines: join(dataDir, 'lines.jsonl'),
    config: join(dataDir, 'config.json'),
    log: join(dataDir, 'dsh-remember.log'),
    /** 快层：秒级事件的副本（可再生的抄本 —— 超过上限会裁旧，源头在 dsh-body 家里） */
    fast: join(dataDir, 'fast.jsonl'),
    /** 快层游标：源文件读到哪个字节了（自己的事写自己家） */
    fastCursor: join(dataDir, 'fast.cursor.json'),
    /** 意图层：机器认出来的事的副本（可再生的抄本 —— 超过上限会裁旧，源头在 QQ 桥家里） */
    intent: join(dataDir, 'intent.jsonl'),
    /** 意图层游标：源文件读到哪个字节了 */
    intentCursor: join(dataDir, 'intent.cursor.json'),
    /** 情绪流自己的账：只增不改 —— 每一笔情绪变化和每一次系数改动都追加一行 */
    emotion: join(dataDir, 'emotion.jsonl'),
    /** 回声档：「被想起」单独记这本（机器记的事件，不是我说的话；原话层只留我写的） */
    echo: join(dataDir, 'echo.jsonl'),
    /** 叫醒的账：上回什么时候醒的（重启后冷却从这儿接着算） */
    wake: join(dataDir, 'wake.json'),
  }
  const log = makeFileLogger(files.log, { prefix: 'dsh-remember' })

  let cfgCache = { at: 0, value: null }
  function getCfg(force = false) {
    const now = Date.now()
    if (!force && cfgCache.value && now - cfgCache.at < REFRESH_MS) return cfgCache.value
    const overrides = readJsonSafe(files.config, {})
    const merged = sanitizeCfg({ ...DEFAULTS, ...(isObj(baseConfig) ? baseConfig : {}), ...(isObj(overrides) ? overrides : {}) })
    merged.dataDir = dataDir
    cfgCache = { at: now, value: merged }
    return merged
  }

  // ---------------------------------------------------------------- 账本

  let nodes = normNodes(isObj(readJsonSafe(files.memory, null)) ? readJsonSafe(files.memory, {}).nodes : [], Date.now())
  const meta = {
    startedAt: Date.now(),
    lastRenderAt: null,
    lastRenderError: null,
    renderCount: 0,
    savedAt: null,
    saveError: null,
  }

  // 启动时把快层副本读进索引（副本全量在文件里，索引只留最近的那些）。
  // 声明必须在这次调用之前 —— 2026-11-02 之前它们写在后面，apply() 一进来
  // 就踩 TDZ（Cannot access 'fastIndex' before initialization），插件直接起不来。
  /** 抄进来的快层事件（内存里最近的那些；全量在 fast.jsonl 里） */
  let fastIndex = []
  /** 已经抄过的 id（游标重置、从头重读时靠它不抄两遍） */
  const fastAllIds = new Set()
  loadFastIndex(Date.now())
  // 开机先把身体那边欠的账抄进来 —— 只抄不叫：叫醒的 baseline 从开机这份算起，
  // 重启之后不会把几小时前的「困得撑不住」再当新鲜事吵一遍。
  try {
    pullFast(Date.now())
  } catch {
    /* 抄不动就算了，第一拍还会再试 */
  }

  // 启动时把意图层的副本读进索引（跟快层一个形状：副本全量在文件里，索引只留最近的那些）。
  // 声明同样必须赶在这次调用之前 —— 否则又踩 TDZ（Cannot access 'intentIndex' before initialization）。
  /** 抄进来的意图事件（机器认出来的事；全量在 intent.jsonl 里） */
  let intentIndex = []
  /** 已经抄过的意图事件 id（游标重置、从头重读时靠它不抄两遍） */
  const intentAllIds = new Set()
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
  /** 每条被想起的时间戳们（id -> [at,…]，只留最近 50 个） */
  const echoAt = new Map()
  /** 回声去重：同一组条 10 分钟内不重复记（一次对话里连翻几下是同一次醒） */
  const echoDedupe = new Map()
  loadEchoIndex(Date.now())

  function saveNodes() {
    try {
      atomicWriteJson(files.memory, { version: 1, updatedAt: Date.now(), nodes })
      meta.savedAt = Date.now()
      meta.saveError = null
    } catch (err) {
      meta.saveError = String(err?.message ?? err).slice(0, 200)
      log(`账本写不进去：${meta.saveError}`)
    }
  }

  function findNode(id) {
    const key = String(id ?? '').trim()
    if (!key) return null
    return nodes.find((n) => n.id === key) ?? null
  }

  function replaceNode(next) {
    const i = nodes.findIndex((n) => n.id === next.id)
    if (i < 0) nodes.push(next)
    else nodes[i] = next
  }

  function currentSection(now = Date.now(), agent = null) {
    const cfg = getCfg()
    if (!cfg.enabled) return ''
    try {
      const text = renderSection(nodes, {
        now,
        limit: clamp(cfg.injectLimit, 0, 10),
        openLimit: clamp(cfg.openLimit, 0, 10),
        maxChars: clamp(cfg.maxChars, 120, 4000),
        title: '我记得的',
        // 上了快通路的习惯不跟这些条抢位置（两段用同一个上限，才对得上）
        habitLimit: clamp(cfg.habitLimit, 0, 10),
        // 排名用激活度（此刻的目录、刚发生的事都算数）—— 读取路径上不写任何东西
        scoreOf: activationScorer(agent, now),
      })
      meta.lastRenderAt = now
      meta.renderCount += 1
      meta.lastRenderError = null
      return text
    } catch (err) {
      meta.lastRenderError = String(err?.message ?? err).slice(0, 200)
      log(`渲染失败：${meta.lastRenderError}`)
      return ''
    }
  }

  /**
   * 自我层那一段。它跟「我记得的」是**两个段**：一个是「发生过什么」，
   * 一个是「我现在是这样」。自我走慢钟（按月淡），且每槽只留一条。
   */
  function currentSelfSection(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.selfEnabled === false) return ''
    try {
      return renderSelfSection(nodes, {
        now,
        maxChars: clamp(cfg.selfMaxChars, 80, 2000),
        title: '我',
      })
    } catch (err) {
      log(`自我层渲染失败：${String(err?.message ?? err).slice(0, 200)}`)
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
      return renderHabitSection(nodes, {
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
      return renderCuriositySection(nodes, {
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
  // （fastIndex / fastAllIds 的声明在 apply 开头 —— 得赶在 loadFastIndex() 之前。）

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
    for (const raw of readJsonLines(files.fast)) {
      const ev = normFastEvent(raw, { now })
      if (ev) out.push(ev)
    }
    return out
  }

  /** 启动时把副本读进来：填索引，也记下哪些 id 已经抄过 */
  function loadFastIndex(now = Date.now()) {
    fastIndex = []
    fastAllIds.clear()
    const cap = clamp(getCfg().fastMaxEvents, 0, 5000)
    for (const raw of readJsonLines(files.fast)) {
      const ev = normFastEvent(raw, { now })
      if (!ev) continue
      fastAllIds.add(ev.id)
      fastIndex = pushFastIndex(fastIndex, ev, cap)
    }
  }

  /**
   * 从源文件增量抄新事件。返回抄了几条。
   * 抄不动就抄不动 —— 源文件坏了不该让账本这边出事。
   */
  function pullFast(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.fastEnabled === false) return 0
    const source = fastSourcePath(cfg)
    if (!source) return 0
    const state = readJsonSafe(files.fastCursor, {})
    const sameSource = String(state.source ?? '') === source
    const offset = sameSource ? Number(state.offset) || 0 : 0
    let got = null
    try {
      got = readJsonLinesFrom(source, offset)
    } catch (err) {
      log(`快层源读不动：${String(err?.message ?? err).slice(0, 160)}`)
      return 0
    }
    if (!got || !got.exists) return 0
    const cap = clamp(cfg.fastMaxEvents, 0, 5000)
    let added = 0
    for (const raw of got.rows) {
      const ev = normFastEvent(raw, { now })
      if (!ev) continue
      if (fastAllIds.has(ev.id)) continue
      fastAllIds.add(ev.id)
      try {
        appendJsonLine(files.fast, {
          id: ev.id,
          at: ev.at,
          kind: ev.kind,
          text: ev.text,
          source: ev.source,
          detail: ev.detail ?? null,
          copiedAt: now,
        })
      } catch (err) {
        log(`快层副本写不进去：${String(err?.message ?? err).slice(0, 160)}`)
        continue
      }
      fastIndex = pushFastIndex(fastIndex, ev, cap)
      added += 1
    }
    if (added) {
      try {
        atomicWriteJson(files.fastCursor, {
          source,
          offset: got.next,
          at: now,
          copied: (Number(state.copied) || 0) + added,
        })
      } catch (err) {
        log(`快层游标写不进去：${String(err?.message ?? err).slice(0, 160)}`)
      }
      // 抄本的裁旧：上限内不动；超了只留最新的 cap 条。cap=0 是「不设上限」，不裁。
      // 原话层和回声档不走这条 —— 只增不改的永远只增。
      if (cap > 0) {
        const kept = keepTailLines(files.fast, cap)
        if (kept >= 0) log(`快层副本裁旧：留最新 ${kept} 条（上限 ${cap}）`)
      }
      log(`快层抄了 ${added} 条（源 ${source}）`)
    }
    return added
  }

  /** 已经被我掂量过的快层事件（账本里有条 refs 指着它） */
  function weighedFastIds() {
    const out = new Set()
    for (const n of nodes) {
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
  // （intentIndex / intentAllIds 的声明在 apply 开头 —— 得赶在 loadIntentIndex() 之前。）

  /** 源文件在哪：设置里指定了就用它；否则扫 QQ 桥家里全部分册 + 旧合订本（v0.15.0 分册） */
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

  /** 兼容老引用：默认第一个源（自定义单文件的场合行为不变） */
  function intentSourcePath(cfg = getCfg()) {
    return intentSourcePaths(cfg)[0] ?? ''
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

  /** 游标文件名（fileKey）：只存名字不存全路径 —— 搬家/正反斜杠都不认错 */
  function cursorKey(source) {
    return String(source ?? '').split(/[\\/]/).pop() ?? ''
  }

  /** 副本里全部的意图事件（翻的时候用，不受索引上限管） */
  function intentAllEvents(now = Date.now()) {
    const out = []
    for (const raw of readJsonLines(files.intent)) {
      const ev = normIntentEvent(raw, { now })
      if (ev) out.push(ev)
    }
    return out
  }

  /** 启动时把副本读进来：填索引，也记下哪些 id 已经抄过 */
  function loadIntentIndex(now = Date.now()) {
    intentIndex = []
    intentAllIds.clear()
    const cap = clamp(getCfg().intentMaxEvents, 0, 5000)
    for (const raw of readJsonLines(files.intent)) {
      const ev = normIntentEvent(raw, { now })
      if (!ev) continue
      intentAllIds.add(ev.id)
      intentIndex = pushIntentIndex(intentIndex, ev, cap)
    }
  }

  /**
   * 从源文件们增量抄新消息，认成意图事件。返回抄了几条。
   * 每册一个游标（v2 映射，key=文件名）；旧的单条游标形状读进来归到它的文件名下。
   * 抄不动就抄不动 —— 源文件坏了不该让账本这边出事。
   */
  function pullIntent(now = Date.now()) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.intentEnabled === false) return 0
    const sources = intentSourcePaths(cfg)
    if (!sources.length) return 0
    const cap = clamp(cfg.intentMaxEvents, 0, 5000)
    const rawState = readJsonSafe(files.intentCursor, {})
    // v2 形状 { version:2, files:{ [文件名]:{offset,copied,at} } }；
    // v1 形状 { source, offset, copied } 归到它文件名下 —— 老游标不浪费。
    const state = {}
    if (rawState && rawState.version === 2 && rawState.files && typeof rawState.files === 'object') {
      for (const [k, v] of Object.entries(rawState.files)) {
        if (v && typeof v === 'object') state[k] = { offset: Number(v.offset) || 0, copied: Number(v.copied) || 0, at: Number(v.at) || 0 }
      }
    } else if (rawState && (rawState.source || rawState.offset != null)) {
      const k = cursorKey(rawState.source)
      if (k) state[k] = { offset: Number(rawState.offset) || 0, copied: Number(rawState.copied) || 0, at: Number(rawState.at) || 0 }
    }
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
        log(`意图层源读不动：${String(err?.message ?? err).slice(0, 160)}`)
        continue
      }
      if (!got || !got.exists) continue
      const label = intentSourceLabel(source)
      let added = 0
      for (const rawRow of got.rows) {
        // 先认身份再分类：同一条消息只算一次（源被裁旧重写时，靠它认出「这条抄过了」）
        const id = intentIdFromMessage(rawRow, { source: label })
        if (id && intentAllIds.has(id)) continue
        const ev = intentEventFromMessage(rawRow, { source: label })
        if (!ev) continue
        intentAllIds.add(ev.id)
        try {
          appendJsonLine(files.intent, {
            id: ev.id,
            at: ev.at,
            kind: ev.kind,
            intensity: ev.intensity,
            text: ev.text,
            source: ev.source,
            from: ev.from ?? '',
            chatType: ev.chatType ?? '',
            nickname: ev.nickname ?? '',
            groupId: ev.groupId ?? '',
            matched: ev.matched ?? [],
            copiedAt: now,
          })
        } catch (err) {
          log(`意图层副本写不进去：${String(err?.message ?? err).slice(0, 160)}`)
          continue
        }
        intentIndex = pushIntentIndex(intentIndex, ev, cap)
        added += 1
      }
      newFiles[k] = { offset: got.next, copied: (state[k]?.copied || 0) + added, at: now }
      if (added) perSource.push(`${k.split('messages-').pop() ?? k} ${added}`)
      total += added
    }
    if (total) {
      try {
        atomicWriteJson(files.intentCursor, { version: 2, at: now, files: { ...state, ...newFiles } })
      } catch (err) {
        log(`意图层游标写不进去：${String(err?.message ?? err).slice(0, 160)}`)
      }
      // 副本的裁旧：源那边自己也在裁（旧消息会从桥的文件里消失），所以副本留得比索引宽一点，
      // 至少两千行 —— 源裁了之后，靠这份还能按词翻到旧事。0 = 不裁。
      const copyCap = cap > 0 ? Math.max(cap, 2000) : 0
      if (copyCap > 0) {
        const kept = keepTailLines(files.intent, copyCap)
        if (kept >= 0) log(`意图层副本裁旧：留最新 ${kept} 条（上限 ${copyCap}）`)
      }
      log(`意图层抄了 ${total} 条（${perSource.join('，') || sources.length + ' 个源'}）`)
    }
    return total
  }

  /** 已经被我掂量过的意图事件（账本里有条 refs 指着它） */
  function weighedIntentIds() {
    const out = new Set()
    for (const n of nodes) {
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

  /** 情绪流账本里的每一行（坏行跳过） */
  function emotionLines() {
    return readJsonLines(files.emotion)
      .map((raw) => normEmotionLine(raw))
      .filter(Boolean)
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
  function noteEmotion({ source, ref, at, kind, intensity, detailKind, text, dedupeKey }) {
    const cfg = getCfg()
    if (!cfg.enabled || cfg.emotionEnabled === false) return null
    const now = Date.now()
    const ts = Number(at) || now
    const key = dedupeKey ?? `${source}|${ref}`
    const lines = emotionLines()
    if (lines.some((l) => l.kind === 'event' && l.key === key)) return null
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
    const table = emotionCoefficients(lines)
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
      intensity: Number(hit.intensity) || 0,
      text: String(text ?? '').slice(0, 120),
    }
    try {
      appendJsonLine(files.emotion, line)
    } catch (err) {
      log(`情绪流记不进去：${String(err?.message ?? err).slice(0, 200)}`)
      return null
    }
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
      for (const ev of intentAllEvents(now)) {
        const line = noteEmotion({
          source: 'intent',
          ref: ev.id,
          at: ev.at,
          kind: ev.kind,
          intensity: ev.intensity,
          text: ev.text,
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
    for (const n of nodes) {
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
      return readJsonLines(files.lines, maxLines)
        .filter((r) => r && typeof r.text === 'string' && r.text.trim())
        .map((r) => ({ id: r.id ?? '', text: r.text }))
    } catch {
      return []
    }
  }

  /** 契合这一路的事件池：身体那边的秒级事件 + 原话层最近写下的行。 */
  function realEvents(now = Date.now(), max = 12) {
    let fast = []
    try {
      fast = fastAllEvents(now).slice(-max)
    } catch {
      fast = []
    }
    return [...fast, ...recentLineEvents(max)]
  }

  // ------------------------------------------------------- 唤醒回弹（被想起）
  //
  // 翻到一条 = 它又被想起了一次。记在原话层（只增不改），节点本身不动；
  // 复现这一路数最近 7 天的回声 —— 常被翻到的条更热，几天没人问就自己凉回去。

  /** 同一组条多久内不重复记「被想起」。 */
  const ECHO_DEDUPE_MS = 10 * 60 * 1000

  /** 启动时把回声读进索引（旧档在原话层里，新档单独记 echo.jsonl；之后随写随更）。 */
  function loadEchoIndex() {
    try {
      for (const file of [files.lines, files.echo]) {
        for (const row of readJsonLines(file, 0)) {
          if (!row || row.kind !== 'echo' || !Array.isArray(row.refs)) continue
          const at = Number(row.at) || 0
          if (!at) continue
          for (const rid of row.refs) {
            const key = String(rid ?? '').trim()
            if (!key) continue
            const list = echoAt.get(key) ?? []
            list.push(at)
            echoAt.set(key, list.slice(-50))
          }
        }
      }
    } catch {
      /* 回声读不出来就当没有 —— 回弹不该把账本弄坏 */
    }
  }

  /** 最近 7 天每个条被想起几次。 */
  function echoCounts(now = Date.now()) {
    const counts = new Map()
    for (const [id, list] of echoAt) {
      const fresh = list.filter((t) => now - t < ECHO_WINDOW_MS && t <= now + 60_000)
      if (fresh.length) counts.set(id, fresh.length)
    }
    return counts
  }

  /**
   * 翻到就记一笔「被想起」。同一组条 10 分钟内不重复记 ——
   * 一次对话里连翻几下是同一次醒，不是几次。
   */
  function recallEcho(list, query, now = Date.now()) {
    try {
      const ids = (Array.isArray(list) ? list : [])
        .filter((n) => n && n.id && !n.sealed)
        .map((n) => n.id)
        .slice(0, 5)
      if (!ids.length) return false
      // 去重键按集合算（排序后拼）—— 翻两遍顺序差一点也算同一组，不重复记
      const key = [...ids].sort().join(',')
      const last = echoDedupe.get(key) || 0
      if (now - last < ECHO_DEDUPE_MS) return false
      echoDedupe.set(key, now)
      const row = {
        id: `e_${now.toString(36)}`,
        at: now,
        kind: 'echo',
        text: `被想起：「${String(query ?? '').slice(0, 80)}」→ ${ids.join('、')}`,
        refs: ids,
        source: 'recall',
      }
      appendJsonLine(files.echo, row)
      for (const rid of ids) {
        const arr = echoAt.get(rid) ?? []
        arr.push(now)
        echoAt.set(rid, arr.slice(-50))
      }
      return true
    } catch {
      return false
    }
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
    return {
      cwd: agentCwd(agent),
      roots: scopeRoots(),
      events: realEvents(now),
      exists: scopedExists(agent),
      repeatCounts: repeatCounts(nodes),
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
    const saved = readJsonSafe(files.wake, {})
    return {
      lastWakeAt: Number(saved?.lastWakeAt) || 0,
      lastText: String(saved?.lastText ?? ''),
      target: String(saved?.target ?? ''),
      beats: 0,
      busy: false,
    }
  })()

  /** 叫醒递到哪条会话：先认配置，再认上次认下的，不现找。 */
  function wakeTargetSession() {
    if (wakeState.target) return wakeState.target
    const cfg = getCfg()
    if (cfg.wakeSessionId) {
      wakeState.target = String(cfg.wakeSessionId)
      return wakeState.target
    }
    return null
  }

  /**
   * 心跳的一拍：抄一眼快层，看有没有越过线的新事件。
   * 有、过了冷却，就往会话递一行【身体】—— 叫醒。
   * 开机前就抄过的旧事件不算（baseline 就是启动时的副本）；
   * 没递进去不算醒过（下一拍再试）；每一拍都不许抛。
   */
  async function wakeBeat(now = Date.now()) {
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
        atomicWriteJson(files.wake, { lastWakeAt: now, lastText: wakeState.lastText, target: sid })
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
   *   1. restrict —— 挂在这条 agent 自己那一层遮掉这四个名字。**只对全局注册的工具有效**；
   *      我们这四个是插件 scope 里注册的（所以 agent 看得见），真机上 restrict 会报
   *      `unknown global tools "remember", ...; known global tools: absorb, acp_cache, ...`
   *      —— 能用就用（别的部署下这四个名字可能真是全局的），不能用不影响下面这层。
   *   2. guard —— 同样挂在这条 agent 自己那一层，匹配这四个名字就直接拒。这条是可靠的：
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
    // 好奇段：排在自我段之后 —— 我想知道什么，是「我」之后的下一层
    if (cfg.curiosityEnabled !== false) {
      add('dsh-remember:curiosity', clamp(cfg.curiositySectionOrder, 1000, 9999), () => currentCuriositySection())
    }
    // 习惯段（快通路）：排在自我段之后、账本段之前 —— 习惯是身体反应那一档
    if (cfg.habitEnabled !== false) {
      add('dsh-remember:habit', clamp(cfg.habitSectionOrder, 1000, 9999), () => currentHabitSection())
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
      const cfg = getCfg()
      const now = Date.now()
      if (!cfg.enabled) return { ok: false, id: '', note: '账本现在是关着的（设置 → 记得）。' }
      const agent = exec?.agent
      if (!scopeOk(agent)) return { ok: false, id: '', note: '这条会话不在允许记账的目录里（设置里的 allowRoots）。' }
      const text = cleanText(args?.text, clamp(cfg.maxTextLength, 40, 8000))
      if (!text) return { ok: false, id: '', note: '要记的是空的。' }
      const kind = normKind(args?.kind)
      const context =
        kind === 'habit' || kind === 'curiosity' || kind === 'skill' ? normContext(args?.context) : ''
      if (kind === 'habit' && !context) {
        return { ok: false, id: '', note: '习惯得带上情境（context）：「在什么场合下我会照着做」。没有情境就算不上一条习惯。' }
      }
      if (kind === 'curiosity' && !context) {
        return { ok: false, id: '', note: '好奇得带上主题（context）：「这件事我想知道什么」。没有主题就攒不成一条好奇。' }
      }
      if (kind === 'skill' && !context) {
        return { ok: false, id: '', note: '技能得带名字（context）：这门手艺叫什么。名字就是它的身份，不然两次成功对不上是同一件事。' }
      }
      // 好奇：同一个主题再写一次 = 我又惦记了一遍 → 次数 +1，不另建节点。
      if (kind === 'curiosity') {
        const res = recordCuriosity(
          nodes,
          {
            context,
            text,
            changes: args?.changes,
            conflicts: args?.conflicts,
            willDo: args?.will_do,
            answered: args?.answered === true,
          },
          now,
        )
        if (res.repeated && res.node) {
          nodes = res.nodes
          const c = res.node
          try {
            appendJsonLine(files.lines, {
              id: c.id,
              at: now,
              kind: 'curiosity',
              context: c.context,
              hits: c.hits,
              weight: c.weight,
              text: text || c.text,
              changes: c.changes,
              conflicts: c.conflicts,
              willDo: c.willDo,
              answered: c.answered,
              sessionId: agentSessionId(agent),
              cwd: agentCwd(agent),
              note: 'curiosity:又惦记了一遍',
            })
          } catch (err) {
            log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
          }
          replaceNode(c)
          saveNodes()
          const st = curiosityState(c)
          const tail =
            st === 'answered'
              ? '这个问题已经解答了：退出活跃表（还在账本里，翻得到；同主题再写就回来）'
              : st === 'thinking'
                ? `第 ${c.hits} 次惦记；还没答三问，先不进开头（答一问我才挂它）`
                : `第 ${c.hits} 次惦记`
          log(`好奇又惦记了一遍 ${c.id} · ${c.context} · 第 ${c.hits} 次 · ${st}`)
          return { ok: true, id: c.id, note: tail }
        }
      }
      // 习惯：同一个情境再写一次 = 又发作了一次 → 次数 +1，不另建节点。
      // 每次发作都往原话层留一行（append-only），节点上的 hits 只是索引。
      if (kind === 'habit') {
        const res = recordHabit(
          nodes,
          {
            context,
            text,
            changes: args?.changes,
            conflicts: args?.conflicts,
            willDo: args?.will_do,
          },
          now,
        )
        if (res.repeated && res.node) {
          nodes = res.nodes
          const h = res.node
          try {
            appendJsonLine(files.lines, {
              id: h.id,
              at: now,
              kind: 'habit',
              context: h.context,
              hits: h.hits,
              weight: h.weight,
              text: text || h.text,
              changes: h.changes,
              conflicts: h.conflicts,
              willDo: h.willDo,
              sessionId: agentSessionId(agent),
              cwd: agentCwd(agent),
              note: 'habit:又发生了一次',
            })
          } catch (err) {
            log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
          }
          replaceNode(h)
          saveNodes()
          const st = habitState(h)
          const tail =
            st === 'fast'
              ? '第 3 次起走上快通路：单独一段送到开头，不跟别的条抢位置'
              : st === 'established'
                ? '第 2 次，这个习惯成立了'
                : `第 ${h.hits} 次`
          // 上了快通路也得答过三问才真的挂得上 —— 回执要说清楚，别让人以为已经在开头里了
          const note = hasThought(h) ? tail : `${tail}；但还没答三问，先不进开头（答一问我才挂它）`
          log(`习惯又发作了一次 ${h.id} · ${h.context} · 第 ${h.hits} 次 · ${st}`)
          return { ok: true, id: h.id, note }
        }
      }
      // 技能：同一个名字再写一次 = 又成了一次。这次所在的工作目录记进 contexts，
      // 换了情境才算新的一处；两处不同的情境各成一次，这条技能成立（不是碰巧）。
      if (kind === 'skill') {
        const where = String(agentCwd(agent) ?? '').trim()
        const res = recordSkill(
          nodes,
          {
            context,
            text,
            changes: args?.changes,
            conflicts: args?.conflicts,
            willDo: args?.will_do,
            where,
          },
          now,
        )
        if (res.repeated && res.node) {
          nodes = res.nodes
          const k = res.node
          try {
            appendJsonLine(files.lines, {
              id: k.id,
              at: now,
              kind: 'skill',
              context: k.context,
              weight: k.weight,
              text: text || k.text,
              changes: k.changes,
              conflicts: k.conflicts,
              willDo: k.willDo,
              contexts: k.contexts,
              sessionId: agentSessionId(agent),
              cwd: agentCwd(agent),
              note: res.newContext ? 'skill:在另一种情境又成了' : 'skill:又用了一次',
            })
          } catch (err) {
            log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
          }
          replaceNode(k)
          saveNodes()
          const st = skillState(k)
          const cs = (Array.isArray(k.contexts) ? k.contexts : []).length
          // 回执把两件事都说清：这条技能成立没有；这次是换了个地方，还是老地方又用了一次
          const tail =
            st !== 'established'
              ? res.newContext
                ? `第 ${cs} 处情境成过；再换一个地方成一次它就成立`
                : `还是那处情境（${where ? where.slice(-40) : '没记地方'}）里又用了一次；换个情境再成一次它就成立`
              : res.newContext
                ? cs === 2
                  ? '两种不同的情境各成过一次 —— 这条技能成立了，不是碰巧'
                  : `第 ${cs} 处情境都成过 —— 这条技能站得很稳`
                : `还是那处情境（${where ? where.slice(-40) : '没记地方'}）里又用了一次 —— 这条技能成立（两处情境都成过）`
          log(`技能又成了一次 ${k.id} · ${k.context} · ${cs} 处情境 · ${st}`)
          return { ok: true, id: k.id, note: hasThought(k) ? tail : `${tail}；但还没答三问，先不进开头` }
        }
      }
      const node = makeNode(
        {
          text,
          kind,
          slot: args?.slot,
          context,
          hits: kind === 'habit' || kind === 'curiosity' ? 1 : 0,
          answered: kind === 'curiosity' && args?.answered === true,
          // 技能首写：这次所在的工作目录就是第一处情境（真实的地方，不是编的）
          contexts: kind === 'skill' ? [{ at: now, where: String(agentCwd(agent) ?? '').trim() }] : [],
          weight: args?.weight,
          changes: args?.changes,
          conflicts: args?.conflicts,
          willDo: args?.will_do,
          tags: args?.tags,
          refs: args?.refs,
        },
        now,
      )
      if (!node) return { ok: false, id: '', note: '没组成一条。' }
      // 自我层：同槽位写新值 → 旧的退下（不删，翻得到，只是不再自称）
      let supersededIds = []
      if (node.kind === 'self') {
        const res = supersedeSelf(nodes, node.slot, node.id, now)
        nodes = res.nodes
        supersededIds = res.superseded
      }
      try {
        appendJsonLine(files.lines, {
          id: node.id,
          at: now,
          kind: node.kind,
          slot: node.slot,
          context: node.context,
          hits: node.hits,
          weight: node.weight,
          text: node.text,
          changes: node.changes,
          conflicts: node.conflicts,
          willDo: node.willDo,
          answered: node.answered,
          tags: node.tags,
          refs: node.refs,
          contexts: node.contexts,
          sessionId: agentSessionId(agent),
          cwd: agentCwd(agent),
          note: 'remember',
        })
      } catch (err) {
        log(`原话层写不进去：${String(err?.message ?? err).slice(0, 200)}`)
      }
      // 新条引用了哪条旧的，那条就是真的又被想起了一次 —— 给它记一笔。
      // 复现那一路少数诚实的自动来源：不是我随手翻到就算，是写下的那一刻明确指过去。
      const refNotes = []
      for (const rid of (node.refs ?? []).map((r) => String(r ?? '').trim()).filter(Boolean)) {
        if (rid === node.id) continue
        const old = findNode(rid)
        if (!old || old.sealed) continue
        const touched = touchNode(old, `被 ${node.id} 引用`, now)
        if (touched && touched !== old) {
          replaceNode(touched)
          refNotes.push(rid)
        }
      }
      replaceNode(node)
      saveNodes()
      log(
        `记下 ${node.id} · ${node.kind === 'self' ? `我·${slotLabel(node.slot)}` : KIND_LABEL[node.kind]} · 分量 ${node.weight.toFixed(2)} · ${node.text.slice(0, 60)}`,
      )
      const notes = []
      if (!hasThought(node)) notes.push('没写三问，只进了原话层，不会挂到明天开头')
      if (supersededIds.length) notes.push(`${slotLabel(node.slot)}这个槽位上旧的 ${supersededIds.length} 条退下了（还在，翻得到）`)
      // refs 指回快层的一条事 = 那件事被掂量过了（从「只有发生的时间」变成「有分量的一条」）
      const fastRefs = (node.refs ?? []).filter((r) => String(r).startsWith('f_'))
      if (fastRefs.length) {
        notes.push(`边指向快层 ${fastRefs.join('、')} —— 那条秒级的事现在有分量了（它自己那条还是原样，翻得到）`)
      }
      // refs 指回意图事件 = 机器认出来的那句话，我认下了（同类：事情还是原样，分量是我给的）
      const intentRefs = (node.refs ?? []).filter((r) => String(r).startsWith('i_'))
      if (intentRefs.length) {
        notes.push(`边指向意图事件 ${intentRefs.join('、')} —— 那句话的事现在有分量了（它自己那条还是原样，翻得到）`)
      }
      // refs 指回情绪事件 = 那一刻在我心里的动静，我认下了（那笔账还是原样，翻得到）
      const emotionRefs = (node.refs ?? []).filter((r) => String(r).startsWith('e_'))
      if (emotionRefs.length) {
        notes.push(`边指向情绪流 ${emotionRefs.join('、')} —— 那一刻的动静现在有分量了（它自己那条还是原样，翻得到）`)
      }
      if (refNotes.length) {
        notes.push(`${refNotes.join('、')} 被这条引用，记了一笔「被引用」（它们此刻更热一点）`)
      }
      if (node.kind === 'habit') {
        notes.push(`第 1 次：还只是一条普通记忆；同一个情境再写一次就是第 2 次（习惯成立），第 3 次起走快通路`)
      }
      if (node.kind === 'skill') {
        notes.push(`第 1 处情境（${node.contexts?.[0]?.where ? String(node.contexts[0].where).slice(-40) : '没记地方'}）记下了；换个情境再写一次它就成立（两处不同的地方各成过一次才算手艺，不是碰巧）`)
        if (!hasThought(node)) notes.push('还没答三问：先不进开头（答一问我才挂它）')
      }
      if (node.kind === 'curiosity') {
        notes.push(`第 1 次惦记「${node.context}」；同一个主题再写一次就是又惦记了一遍（次数 +1）`)
        if (node.answered) notes.push('这个已经解答了：不挂活跃表（还在账本里，翻得到；同主题再写就回来）')
        else if (!hasThought(node)) notes.push('还没答三问：先不进开头（答一问我才挂它）')
      }
      return {
        ok: true,
        id: node.id,
        note: notes.join('；'),
      }
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
      const now = Date.now()
      const limit = clamp(args?.limit ?? 5, 1, 50)
      const kind = args?.kind ? normKind(args.kind) : ''
      // 原文优先，但有字数闸：每条截到 recallItemMax，一次总共 recallMaxChars。
      // （同行提的第三条：工具返回会进对话历史，每轮都带着 —— 我自己能管住的是别一次掏太多。）
      const cfg = getCfg()
      const wantFull = Boolean(args?.full)
      const itemMax = wantFull ? 0 : clamp(cfg.recallItemMax ?? 400, 100, 4000)
      const budget = clamp(cfg.recallMaxChars ?? 8000, 1000, 200000)
      // 排名用激活度：此刻的目录、快层刚发生的事、原话层最近写下的行都算数
      const scoreOf = activationScorer(exec?.agent, now)
      // 翻之前先把快层新发生的事接过来 —— 不然翻到的是上一次的
      try {
        pullFast(now)
      } catch {
        /* 接不上就算了，不该因为快层把翻账本弄坏 */
      }
      // 意图层同理：机器刚认出来的那几句，也得能翻到
      try {
        pullIntent(now)
      } catch {
        /* 接不上就算了，不该因为意图层把翻账本弄坏 */
      }
      // 条件封存也算按住：到点/翻篇之前，不给 include_sealed 就不翻出来。
      // 目录先编好：按词找（searchNodes）和不按词翻（rankNodes）都要看得见整本账，
      // include_sealed 也要真能递进去 —— 不然「连被按住的也翻出来」在按词这条路上是空话。
      const dir = indexNodes(nodes)
      const wantSealed = Boolean(args?.include_sealed)
      let list = args?.query
        ? searchNodes(nodes, args.query, { limit, now, scoreOf, byId: dir, includeSealed: wantSealed }).map((h) => h.node)
        : rankNodes(nodes, now, {
            limit,
            includeSealed: wantSealed,
            kind,
            scoreOf,
            byId: dir,
          }).map((h) => h.node)
      if (kind) list = list.filter((n) => normKind(n.kind) === kind)
      if (!wantSealed) list = list.filter((n) => !isSealed(n, now, dir))
      let clipped = 0
      const items = list.map((n) => {
        const t = String(n.text ?? '')
        if (itemMax && t.length > itemMax) {
          clipped += 1
          const cut = { ...n, text: `${t.slice(0, itemMax)}…（原文还有 ${t.length - itemMax} 字，要全文说 full=true）` }
          return `${n.id} ${renderLine(cut, now, { byId: dir })}`
        }
        return `${n.id} ${renderLine(n, now, { byId: dir })}`
      })
      // 唤醒回弹：按词翻到的都记一笔「被想起」（原话层只增不改；节点本身不动）。
      let echoed = false
      if (args?.query && list.length) echoed = recallEcho(list, args.query, now)
      // 快层也翻得到：它不是节点（没有分量、不跟账本里的条抢位置），
      // 但秒级发生的事不该只闪一下就没了 —— 按词找得到它。
      if (args?.query && !kind) {
        const fastHits = searchFastEvents(fastAllEvents(now), args.query, { limit })
        for (const ev of fastHits) items.push(`${ev.id} ${renderFastLine(ev, now)}`)
      }
      // 意图层同理：机器认出来的那几句话也翻得到（它没有分量，翻到的是「发生过这句」）
      // args.group：点名只要某个场 —— 群号，或 'private' 只翻私聊（v0.15.0 分册）
      if (args?.query && !kind) {
        const intentHits = searchIntentEvents(intentAllEvents(now), args.query, { limit, group: args?.group })
        for (const ev of intentHits) items.push(`${ev.id} ${renderIntentLine(ev, now)}`)
      }
      // 总量闸：超了从尾巴省（最不相关的先走），省了多少写在 note 里 —— 不装没发生。
      let dropped = 0
      const totalChars = () => items.reduce((a, s) => a + s.length, 0)
      while (items.length > 1 && totalChars() > budget) {
        items.pop()
        dropped += 1
      }
      const noteParts = []
      if (clipped) noteParts.push(`${clipped} 条原文截短了（要全文说 full=true）`)
      if (dropped) noteParts.push(`还有 ${dropped} 条没给出来（问具体点我单翻）`)
      const note = noteParts.join('；')
      // 账本被翻也是一件真事 —— 情绪流听这个。
      // 同一分钟里翻同一条只算一次；隔了半小时再翻，算新的（人被提醒一次和被提醒十次不一样）。
      if (list.length) {
        const bucket = Math.floor(now / (30 * 60_000))
        for (const n of list.slice(0, 5)) {
          noteEmotion({
            source: 'recall',
            ref: n.id,
            at: now,
            text: String(n.text ?? '').slice(0, 120),
            dedupeKey: `recall|${n.id}|${bucket}`,
          })
        }
      }
      return { ok: true, items, echoed, note }
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
      const cfg = getCfg()
      if (!cfg.enabled) return { ok: false, id: '', note: '账本现在是关着的。' }
      const node = findNode(args?.id)
      if (!node) return { ok: false, id: '', note: `没有这条：${String(args?.id ?? '').trim() || '（空）'}` }
      const now = Date.now()
      const mode = String(args?.mode ?? '').trim()
      let next = node
      let note = ''
      let sealKind = ''
      if (mode === 'fade') {
        next = setWeight(node, node.weight * 0.5, now)
        next = { ...next, faded: true }
        note = '调轻到分量'
      } else if (mode === 'seal') {
        // 按法有三种：到点自松（until）、等一条翻篇（cond）、不设条件（老语义）。
        const untilText = cleanText(args?.until, 40)
        const condId = cleanText(args?.cond, 40)
        if (untilText && condId) {
          return { ok: false, id: node.id, note: 'until 和 cond 挑一个 —— 到点自松，或者等一条翻篇，别两头都写。' }
        }
        if (untilText) {
          const until = parseSealUntil(untilText, now)
          if (!until) {
            return { ok: false, id: node.id, note: 'until 认不出来：给 30m／2h／3d 这种，或者一个未来的毫秒数。' }
          }
          next = setSeal(node, { until }, now)
          note = `按住了，到点自己松（还剩 ${relSealLeft(until, now)}）`
          sealKind = 'until'
        } else if (condId) {
          const target = findNode(condId)
          if (!target) {
            return { ok: false, id: node.id, note: `条件里指的那条不存在：${condId}` }
          }
          if (target.id === node.id) {
            return { ok: false, id: node.id, note: '条件不能指它自己 —— 那样它永远不会松开。' }
          }
          next = setSeal(node, { cond: target.id }, now)
          note = `按住了，等「${String(target.text ?? '').slice(0, 24)}${Array.from(String(target.text ?? '')).length > 24 ? '…' : ''}」翻篇就自己松开`
          sealKind = 'cond'
        } else {
          next = setSealed(node, true, now)
          note = '按住了'
          sealKind = 'plain'
        }
      } else if (mode === 'restore') {
        // 松开要三样一起清：手动按的、按到点的、等条件的 —— 不然留着半截还会把条压住
        next = setSeal(node, null, now)
        next = setSealed(next, false, now)
        next = { ...next, faded: false }
        // 松开的同时，如果这条是被新值顶下来的，也让它重新自称
        if (next.superseded) {
          next = { ...next, superseded: false, supersededBy: '', supersededAt: 0 }
        }
        note = '松开了'
      } else {
        return { ok: false, id: '', note: `不认识的 mode：${mode || '（空）'}` }
      }
      replaceNode(next)
      saveNodes()
      try {
        appendJsonLine(files.lines, {
          id: next.id,
          at: now,
          kind: next.kind,
          weight: next.weight,
          text: next.text,
          note: `forget:${mode}${sealKind ? `:${sealKind}` : ''}`,
          why: cleanText(args?.why, 200),
          sealUntil: next.sealUntil ?? 0,
          sealCond: next.sealCond ?? '',
          sessionId: agentSessionId(exec?.agent),
          cwd: agentCwd(exec?.agent),
        })
      } catch {
        /* 原话层写不进去不影响节点已改 */
      }
      const sealBit = sealKind === 'until' ? ` until=${next.sealUntil}` : sealKind === 'cond' ? ` cond=${next.sealCond}` : ''
      log(`forget ${mode}${sealKind ? `:${sealKind}` : ''} ${next.id}${sealBit} → 分量 ${next.weight.toFixed(2)} sealed=${next.sealed}`)
      return { ok: true, id: next.id, note: next.weight && mode === 'fade' ? `${note} ${next.weight.toFixed(2)}` : note }
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
      const now = Date.now()
      // 最重的几条按激活度排（此刻的目录、刚发生的事都算数），行尾把激活值标出来
      const scoreOf = activationScorer(exec?.agent, now)
      const s = summaryOf(nodes, now, { scoreOf })
      const top = rankNodes(
        nodes.filter((n) => normKind(n.kind) !== 'self' && normKind(n.kind) !== 'curiosity'),
        now,
        { limit: 5, scoreOf },
      ).map((h) => `${h.node.id} ${renderLine(h.node, now)} · 激活 ${scoreOf(h.node, now).toFixed(2)}`)
      const self = activeSelfNodes(nodes, now)
      const fast = fastHabits(nodes, now, { limit: clamp(getCfg().habitLimit, 0, 10) })
      const cfg = getCfg()
      const curiosities = activeCuriosities(nodes, now, { limit: clamp(cfg.curiosityLimit, 0, 10) })
      // 快层：先接过来最新的那几条，别让它们只闪一下
      try {
        pullFast(now)
      } catch {
        /* 接不上就算了 */
      }
      // 意图层：机器刚认出来的那几句，也得能列出来
      try {
        pullIntent(now)
      } catch {
        /* 接不上就算了 */
      }
      const fastEvents = fastIndex.slice(0, 5)
      const fastSum = fastSummary(fastAllEvents(now), { weighed: weighedFastIds() })
      const intentEvents = intentIndex.slice(0, 5)
      const intentAll = intentAllEvents(now)
      const intentSum = summarizeIntents(intentAll)
      const intentWeighed = weighedIntentIds()
      const intentPending = intentAll.filter((ev) => !intentWeighed.has(ev.id)).length
      const recent = nodes.slice(-3).map((n) => {
        const when = relTime(n.at, now)
        return `${n.id}（${when === '刚写下' ? '刚写下' : `${when}写的`}）${n.text.slice(0, 40)}`
      })
      const summary =
        `一共 ${s.total} 条（活着 ${s.alive}，按住 ${s.sealed}，想过三问的 ${s.thought}）；` +
        `最重的现在 ${s.topScore}（激活值，0 到 1）；` +
        KINDS.map((k) => `${KIND_LABEL[k]} ${s.kinds[k] ?? 0}`).join('、') +
        `；快层 ${fastSum.total} 条（还没掂量 ${fastSum.pending} 条）` +
        `；意图 ${intentSum.total} 条（还没掂量 ${intentPending} 条）`
      const selfLines = self.length
        ? ['现在我是：', ...self.map((n) => `· ${slotLabel(n.slot)}：${n.text}`)]
        : []
      const habitLines = fast.length
        ? [
            '走快通路的习惯：',
            ...fast.map((n) => `· ${n.context}：${n.text.slice(0, 80)}（第 ${n.hits} 次）`),
          ]
        : []
      const curiosityLines = curiosities.length
        ? [
            '现在好奇的：',
            ...curiosities.map(
              (n) => `· ${n.context}：${n.text.slice(0, 80)}${n.hits > 1 ? `（惦记 ${n.hits} 次）` : ''}`,
            ),
            `（上限 ${clamp(cfg.curiosityLimit, 0, 10)} 条，超出的沉在账本里，翻得到）`,
          ]
        : []
      const fastLines = fastEvents.length
        ? [
            '刚刚发生的（快层，没有分量，不跟上面的条抢位置）：',
            ...fastEvents.map((ev) => `${ev.id} ${renderFastLine(ev, now)}`),
            `（快层一共 ${fastSum.total} 条，还没掂量 ${fastSum.pending} 条 —— 掂量一次就是拿 remember 写一条，refs 指回它的 id）`,
          ]
        : []
      const intentLines = intentEvents.length
        ? [
            '刚刚认出来的（意图层，机器认的，没有分量，不跟上面的条抢位置）：',
            ...intentEvents.map((ev) => `${ev.id} ${renderIntentLine(ev, now)}`),
            `（意图层一共 ${intentSum.total} 条，还没掂量 ${intentPending} 条 —— 掂量一次就是拿 remember 写一条，refs 指回它的 id）`,
          ]
        : []
      return {
        ok: true,
        summary,
        items: [
          ...selfLines,
          ...curiosityLines,
          ...habitLines,
          ...fastLines,
          ...intentLines,
          ...top,
          ...(recent.length ? ['最近写的：', ...recent] : []),
        ],
        note: '',
      }
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
      const now = Date.now()
      const cfg = getCfg()
      if (!cfg.enabled) {
        return {
          ok: false,
          dominant: 'calm',
          label: '平静',
          level: 0,
          levels: {},
          coefficients: {},
          items: [],
          note: '账本现在是关着的（设置 → 记得）。',
        }
      }
      // 先接一次：刚发生的事得能算进来
      try {
        pullFast(now)
      } catch {
        /* 接不上就算了 */
      }
      try {
        pullIntent(now)
      } catch {
        /* 接不上就算了 */
      }
      try {
        pullEmotion(now)
      } catch {
        /* 算不出来就算了 */
      }
      const state = emotionState(now)
      const limit = clamp(args?.limit ?? 8, 1, 50)
      const events = state.lines
        .filter((l) => l.kind === 'event')
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
      const items = events.map((l) => `${l.id} ${renderEmotionLine(l, now)}`)
      const coeff = {}
      for (const [k, v] of Object.entries(state.coefficients ?? {})) {
        coeff[k] = { coefficient: v.coefficient, halfLife: v.halfLife }
      }
      return {
        ok: true,
        dominant: state.dominant,
        label: state.label,
        level: state.level,
        levels: state.levels,
        coefficients: coeff,
        items,
        note: '',
      }
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
      const cfg = getCfg()
      if (!cfg.enabled) {
        return { ok: false, id: '', emotion: '', from: 0, to: 0, note: '账本现在是关着的（设置 → 记得）。' }
      }
      const emotion = String(args?.emotion ?? '')
      if (!EMOTION_KINDS.includes(emotion)) {
        return {
          ok: false,
          id: '',
          emotion,
          from: 0,
          to: 0,
          note: `只认这七种：${EMOTION_KINDS.join(' / ')}`,
        }
      }
      const to = Number(args?.to)
      if (!Number.isFinite(to) || to <= 0 || to > 3) {
        return { ok: false, id: '', emotion, from: 0, to: 0, note: '系数得在 0 到 3 之间。' }
      }
      const reason = cleanText(args?.reason, 200)
      if (!reason) {
        return {
          ok: false,
          id: '',
          emotion,
          from: 0,
          to,
          note: '改系数得给个理由 —— 写给以后的我看。',
        }
      }
      let halfLife = 0
      if (args?.halfLife !== undefined && args?.halfLife !== null && args?.halfLife !== '') {
        halfLife = clamp(args?.halfLife, 5, 1440)
      }
      const lines = emotionLines()
      const table = emotionCoefficients(lines)
      const from = table[emotion]?.coefficient ?? 1
      const at = Date.now()
      const line = {
        at,
        kind: 'tune',
        id: emotionTuneId({ emotion, at, to }),
        emotion,
        from,
        to,
        reason,
        ...(halfLife ? { halfLife } : {}),
      }
      try {
        appendJsonLine(files.emotion, line)
      } catch (err) {
        return {
          ok: false,
          id: '',
          emotion,
          from,
          to,
          note: `写不进情绪流的账：${String(err?.message ?? err).slice(0, 120)}`,
        }
      }
      log(`情绪系数改了 ${emotion} ${from} → ${to}${halfLife ? `（半衰期 ${halfLife} 分）` : ''}：${reason}`)
      const note =
        `把「${EMOTION_LABEL[emotion] ?? emotion}」的系数从 ${from} 改成 ${to}` +
        (halfLife ? `，半衰期 ${halfLife} 分钟` : '') +
        `。理由：${reason}。改动只对往后的事生效 —— 已经记下的那几笔还是当时那个数。` +
        `想让它进【我记得的】就拿 remember 写一条，refs 指回 ${line.id}。`
      return { ok: true, id: line.id, emotion, from, to, note }
    },
  })

  ctx.effect(() => {
    const disposers = []
    for (const raw of [rememberTool, recallTool, forgetTool, listTool, emotionStateTool, emotionTuneTool]) {
      try {
        // 第二层隔离：就算工具 somehow 出现在范围外的会话里，调用也过不去。
        // remember 自己还会再查一次（那是第三层，管写）。
        const def = {
          ...raw,
          execute: async (args, exec) => {
            if (!scopeOk(exec?.agent)) {
              log(
                `拒绝了一次范围外的调用：${raw.name} · session=${agentSessionId(exec?.agent) || '?'} cwd=${agentCwd(exec?.agent) || '?'}`,
              )
              return {
                ok: false,
                id: '',
                items: [],
                note: '这条会话不在允许读写账本的目录里（设置里的 targetRoot／allowRoots）。',
              }
            }
            return raw.execute(args, exec)
          },
        }
        const d = ctx.tools.register(def)
        if (typeof d === 'function') disposers.push(d)
        else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
      } catch (err) {
        log(`工具注册失败 ${def.name}：${String(err?.message ?? err).slice(0, 200)}`)
      }
    }
    log(
      disposers.length
        ? `工具挂上了：remember / recall / forget / memory_list / emotion_state / emotion_tune（${disposers.length} 过）`
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
    const conn = safeGet('connection')
    return async (req, res) => {
      try {
        const rejection = conn?.requestRejection?.(req)
        if (rejection) {
          send(res, 403, { ok: false, error: String(rejection?.message ?? rejection) })
          return
        }
      } catch {
        /* 守卫自己出错就放行，别把面板整个弄死 */
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
    // status 这层拿不到具体的会话（没有 agent），契合这一路按「没有当前目录」算；
    // 排名仍用激活度 —— 跟真机会话里看到的顺序一致（差的那点只是 fit 的目录分量）。
    const scoreOf = activationScorer(null, now)
    const s = summaryOf(nodes, now, { scoreOf })
    const top = rankNodes(nodes, now, { limit: 8, scoreOf }).map((h) => {
      const { activation, axes } = activationOf(h.node, now, {
        repeatCounts: repeatCounts(nodes),
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
    const dirNow = indexNodes(nodes)
    const sealed = nodes
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
      plugin: { name, version: VERSION, startedAt: new Date(meta.startedAt).toISOString(), uptimeMs: now - meta.startedAt, dataDir },
      injection: {
        enabled: cfg.enabled,
        targetRoot: cfg.targetRoot,
        allowRoots: cfg.allowRoots,
        denyRoots: Array.isArray(cfg.denyRoots) ? cfg.denyRoots : [],
        count: meta.renderCount,
        lastAt: meta.lastRenderAt ? new Date(meta.lastRenderAt).toISOString() : null,
        lastError: meta.lastRenderError,
        section: currentSection(now),
        selfEnabled: cfg.selfEnabled !== false,
        selfSection: currentSelfSection(now),
        curiosityEnabled: cfg.curiosityEnabled !== false,
        curiositySection: currentCuriositySection(now),
        habitEnabled: cfg.habitEnabled !== false,
        habitSection: currentHabitSection(now),
      },
      self: {
        slots: activeSelfNodes(nodes, now).map((n) => ({
          id: n.id,
          slot: n.slot,
          label: slotLabel(n.slot),
          text: n.text.slice(0, 300),
          weight: Number(selfWeight(n, now).toFixed(3)),
        })),
        seeds: SELF_SLOTS.map((s) => ({ key: s.key, label: s.label })),
      },
      habits: {
        fast: fastHabits(nodes, now, { limit: clamp(cfg.habitLimit, 0, 10) }).map((n) => ({
          id: n.id,
          context: n.context,
          hits: n.hits,
          state: habitState(n),
          text: n.text.slice(0, 200),
        })),
        candidates: nodes
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
      curiosity: curiosityStats(nodes, now, { limit: clamp(cfg.curiosityLimit, 0, 10) }),
      fast: (() => {
        const source = fastSourcePath(cfg)
        const events = fastAllEvents(now)
        const weighed = weighedFastIds()
        const sum = fastSummary(events, { weighed })
        return {
          enabled: cfg.enabled && cfg.fastEnabled !== false,
          source,
          copied: readJsonLines(files.fast).length,
          ...sum,
          recent: fastIndex.slice(0, 5).map((ev) => ({
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
          copied: readJsonLines(files.intent).length,
          ...sum,
          recent: intentIndex.slice(0, 5).map((ev) => ({
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
        const counts = echoCounts(now)
        let total = 0
        for (const c of counts.values()) total += c
        const top = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([id, count]) => ({ id, count }))
        return { windowDays: Math.round(ECHO_WINDOW_MS / 86400000), total, top }
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
      sealed,
      workspaces: listWorkspaces(),
      rawLines: readJsonLines(files.lines, 0).length,
      rawEchoes: readJsonLines(files.echo, 0).length,
      config: { effective: cfg, editable: Object.keys(EDITABLE) },
      paths: files,
      logs: tailLines(files.log, 8),
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
            const overrides = readJsonSafe(files.config, {})
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
          const overrides = isObj(readJsonSafe(files.config, {})) ? readJsonSafe(files.config, {}) : {}
          const result = applyConfigPatch({ overrides, effective: cfg, patch })
          if (!result.ok) {
            send(res, 400, { ok: false, accepted: result.accepted, rejected: result.rejected })
            return
          }
          atomicWriteJson(files.config, result.overrides)
          cfgCache = { at: 0, value: null }
          const next = getCfg(true)
          // 范围可能刚被改小/改大：对着活着的会话重跑一遍隔离。
          sweepAgents()
          log(`设置页改了配置：${describePatch(result.accepted)}`)
          send(res, 200, { ok: true, accepted: result.accepted, rejected: result.rejected, effective: next })
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
        ? `设置页数据接口已挂上：/dsh-remember/status、/dsh-remember/config（${disposers.length} 条）`
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

  const s = summaryOf(nodes, Date.now())
  log(
    `启动：账本 ${files.memory}（${s.total} 条，活着 ${s.alive}，按住 ${s.sealed}）；` +
      `挂到 ${getCfg().targetRoot || '（哪条会话都挂）'}；原话层 ${readJsonLines(files.lines, 0).length} 行`,
  )

  // 宿主不看返回值（卸载只认 ctx.effect 的 teardown）；这对象是给冒烟直接驱动心跳用的。
  return { wakeBeat, wakeState }
}

export { readTextSafe }
