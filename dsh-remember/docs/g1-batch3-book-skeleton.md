# G-1 批③ · Book 对象骨架设计稿

> 2026-11-22。批③（账本协议迁 core/protocol）的冷启动简报：把 index.js 的闭包状态
> 装进一个显式 Book，core/protocol 的函数统一收 `book` 参数。抽错变量从运行期风险
> 变成编译期报错。本文是权威清单——动工时以这里的状态表为准，不凭记忆。

## 1. Book 形状（字段表，逐项对照 index.js 现声明）

### 1.1 协议核心态

| book 字段 | 现声明（index.js） | 种类 | 语义 |
| --- | --- | --- | --- |
| `book.nodes` | `let nodes`（L395，loadBook 赋值，restore 会重赋） | 数组 | 账本节点（normNodes 过的） |
| `book.files` | `const files`（L349） | 只读对象 | 全部落盘路径（memory/lines/echo/emotion/vikarma/fast/fastCursor/intent/intentCursor/config/log） |
| `book.log` | `const log`（L372，makeFileLogger） | 函数 | 日志（协议函数内部 log 走它） |
| `book.meta` | `const meta`（L443：startedAt/renderCount/lastRenderAt/lastRenderError/savedAt/saveError） | 对象 | 运行元数据 |
| `book.broken` | `let memoryBroken`（L393） | 布尔 | 账本损坏红灯 |
| `book.backupOk` | `let memoryBackupOk`（L394） | 布尔 | 损坏原文是否滚进 .bak |
| `book.echoAt` | `const echoAt`（L498，Map：id→时间戳数组） | Map | 熏习索引 |
| `book.echoDedupe` | `const echoDedupe`（L500，ECHO_DEDUPE_MS=10 分同键） | Map | 回声去重 |
| `book.recolorAt` | `const recolorAt`（L502） | Map | 染色冷却 |
| `book.latestEchoRow` | `const latestEchoRow`（L504，{at,rowId,query,with}） | Map | 最近现行行（缘起链/违熏反查） |
| `book.displayDays` | `const displayDays`（L506） | Map | 展示天集 |
| `book.displayDedupe` | `const displayDedupe`（L551） | Map | 展示记账去重（日期\|排序 id 集） |
| `book.vikarmaAt` | `const vikarmaAt`（L508） | Map | 违熏索引（seedId→{at,reason,count}） |
| `book.vikarmaAgg` | `const vikarmaAgg`（L512，{total,byReason,byDay}） | 对象 | 违熏聚合 |
| `book.sproutTracker` | `const sproutTracker`（L3486） | Map | 执受每种子追踪 |
| `book.sproutAgg` | `const sproutAgg`（L3491，{day,today,total}） | 对象 | 执受累计 |
| `book.feelTracker` | `const feelTracker`（L3489，{dominant,at}） | 对象 | 同感冷却（全局单槽） |
| `book.emotionLinesCache` | `let emotionLinesCache`（L1109，{at,lines}） | 对象 | 情绪流读缓存（tune/display 写时失效） |
| `book.echoStatsCache` | `let echoStatsCache`（L1371，{at,stats:Map}） | 对象 | 熏习统计缓存（hub 5 秒纪律） |

### 1.2 快层/意图层（含游标，语义零变化）

| book 字段 | 现声明 | 种类 | 语义 |
| --- | --- | --- | --- |
| `book.fastIndex` | `let fastIndex`（L456） | 数组 | 快层副本索引（裁旧受 fastMaxEvents） |
| `book.fastAllIds` | `const fastAllIds`（L458） | Set | 快层已见 id |
| `book.cursor.fast` | `readJsonSafeSticky(files.fastCursor)`（L776，内存态；落盘 files.fastCursor） | 对象 | 字节游标（characterization 钉：只前进） |
| `book.intentIndex` | `let intentIndex`（L471） | 数组 | 意图层副本索引 |
| `book.intentAllIds` | `const intentAllIds`（L473） | Set | 意图已见 id |
| `book.intentTombstoned` | `const intentTombstoned`（L480） | Set | 墓碑（撤回遮罩） |
| `book.intentTombKey` | `const intentTombKey`（L482） | 函数 | 墓碑键（mid） |
| `book.cursor.intent` | `readJsonSafeSticky(files.intentCursor)`（L989，v2 形状 {version:2,files:{名:{offset,copied,at}}}；落盘 L1067） | 对象 | 分册游标（每源文件各一个） |

### 1.3 环境字段

| book 字段 | 来源 | 说明 |
| --- | --- | --- |
| `book.dataDir` | `const dataDir`（L348） | 数据目录 |
| `book.sproutMoodFile` | `const sproutMoodFile`（L3504，resolveDshHome() 推导） | 身体家 mood-events.jsonl（runtime/ 的 resolveDshHome） |

### 1.4 不进 Book（留在 index.js）

- `cfgCache` / `getCfg`——配置层，不是账本协议（G-2 若拆服务再议）。
- `wakeState` / WAKE_* 常量 / wakeBeat——叫醒编排。它**读**身体状态（经 fastAllEvents）
  但不持有账本协议态；批③不动它，G-2 服务化时随工具一起走。
- `streamCache`——批③不动（她点名要进 Book，但它只服务瀑流段渲染，**批④随段注册
  一起进**或批③尾补进；✓ 已拍板（2026-11-22 审阅）：批③尾进 Book（与 echoStatsCache 同类的观测缓存，打勾完成）。
- 九工具 schema、七段注册、设置页路由、agent 钩子——批④的留任者。

## 2. 协议函数签名（core/protocol/book.js）

全部收 `book` 首参；返回值约定：纯查询返回数据，变更就地改 book 字段（协议态就是
book 本身）。现有函数 → 新签名逐一对照：

| 现函数（index.js） | 新签名 | 备注 |
| --- | --- | --- |
| `loadBook()`（L395 IIFE） | `loadBook(book)` | 6 次重试/粘读/快照/损坏 .bak+broken/backupOk；赋 `book.nodes`；characterization 已钉终局行为 |
| `pullFast(book, now)`（L771） | 同名 | 读 files.fastCursor→book.cursor.fast；裁旧推进 fastIndex；落盘游标（形状 v1 不变） |
| `pullIntent(book, now)`（L989） | 同名 | v2 分册游标；墓碑查 `book.intentTombstoned` |
| `loadEchoIndex(book)` | 同名 | 重建 echoAt/latestEchoRow/echoDedupe |
| `loadVikarmaIndex(book)` | 同名 | 重建 vikarmaAt/vikarmaAgg |
| `saveNodes(book)`（L516） | 同名 | broken&&!backupOk 拒写；写成即解除 broken（characterization 钉） |
| `keepTail(book, …)` | 同名 | 镜像裁旧（fast/intent 各自上限） |
| 展示记账（displayDays/displayDedupe 维护段） | `noteDisplay(book, ids, now)` | 展示不算现行的拍板不变 |
| 回声/违熏/执受写入点 | `noteEcho(book, …)` / `noteVikarma(book, …)` / `sproutToBody(book, list, emoState, now)` | 现逻辑逐行搬，闭包引用改 book.* |

## 3. 迁移映射（机械对照表）

闭包引用 → book 引用，全文件机械替换（改完 grep 双验：`echoAt.get` 应只剩
`book.echoAt.get` 形态；裸 `nodes.` 在协议外应归零）：

```
nodes → book.nodes                 files → book.files
meta → book.meta                   memoryBroken → book.broken
memoryBackupOk → book.backupOk     echoAt → book.echoAt
echoDedupe → book.echoDedupe       recolorAt → book.recolorAt
latestEchoRow → book.latestEchoRow displayDays → book.displayDays
displayDedupe → book.displayDedupe vikarmaAt → book.vikarmaAt
vikarmaAgg → book.vikarmaAgg       sproutTracker → book.sproutTracker
sproutAgg → book.sproutAgg         feelTracker → book.feelTracker
emotionLinesCache → book.emotionLinesCache
echoStatsCache → book.echoStatsCache
fastIndex → book.fastIndex         fastAllIds → book.fastAllIds
intentIndex → book.intentIndex     intentAllIds → book.intentAllIds
intentTombstoned → book.intentTombstoned
fastCursor 内存态 → book.cursor.fast    intentCursor 内存态 → book.cursor.intent
```

## 4. index.js 瘦身后的形态（批④预览）

```js
import { createBook, loadBook, pullFast, …, saveNodes } from '../core/protocol/book.js'
export function apply(ctx, baseConfig = {}) {
  const book = createBook({ dataDir, log, dshHome: resolveDshHome() })
  loadBook(book)                    // 批③起协议函数收 book
  // … 九工具：schema 逐字不变；execute 里闭包引用改 book.*，回执逐字不变 …
  // … 七段注册 / 设置页路由 / agent 钩子：转译调 core，行为逐字不变 …
}
```

## 5. 批③验收清单（照四关折算）

1. 211+4（characterization）单测绿——characterization 是本批的主判官（它钉的就是协议行为）
2. 冒烟 409 绿（含逐字回执断言）
3. 考卷复跑逐题一致（R@5 0.938 / MRR 0.74 / 负题 0）
4. 真账字节级：memory.json / lines.jsonl / echo.jsonl 前缀零变化；
   emotion.jsonl / vikarma.jsonl 同口径；intent.jsonl 按 hash 对 hash（快照型修剪镜像，
   大肥鱼 2026-11-22 批①②验收时定的口径）
5. 每个子步跑一次考卷（不是最后跑）——哪批开始挂，范围锁死在那一批

## 6. 已知坑（批①②踩过的，批③别再踩）

- import 必须带文件名（`'../core/protocol/book.js'`）——目录导入撞 ERR_UNSUPPORTED_DIR_IMPORT
- 相对层级按文件深度算：index.js 一层、test/tools 两层、tools/exam 三层
- 测试夹具的 MIN_RELEVANCE 标定域：两三节点玩具语料要 pad（F-fix 教训）
- HMR 不盯 dsh-reach（体检实锤）——remember 的 HMR 活着，但拆核期间的热重载窗口
  会让 21:30 探针有几秒噪音（探针会标记，没关系）
