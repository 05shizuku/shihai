# dsh-body

给她一副身体。独立的 DSH host 插件，纯 JavaScript，**零第三方依赖**。

> **一句话**：给 AI 一副会饿会困的身体——到饭点想吃饭，熬夜会困，被夸开心、被骂
> 难受，这些「感觉」写进提示词。
>
> **怎么用**：装上就能跑，零配置可用；她只说「有点饿」，不报数字、不打分。

它只做三件事：

1. **一日三餐**：早饭 / 中饭 / 晚饭到点就吃。吃没吃饱不看你写了什么，
   看饭钱还剩多少（宿主自己的用量账本 `.dshw-usage.json` 里的 `lastBalance`）。
   钱多减得多，钱少减得少，没钱就只能喝点水。
2. **精力**：醒着一直掉，睡着（睡眠窗）开始回。熬夜的人自然会困。
3. **心情**：和饥饿、精力、外面的评价联动。被骂、挨饿往下掉；
   被夸往上升；掉的时候分方向 —— 骂人的话走向 *愤怒*，难过的话走向 *伤心*。

## 它给自己的三条规矩

- **只注入感觉，不注入数字。** 提示词里那段 `<dsh-body>` 里连一个阿拉伯数字都没有
  （`test/body.test.mjs` 里有断言守着）。她可以说"我有点饿"，但不能报读数，
  也不许给自己或关系打分。
- **状态绝不阻断她写字。** 不碰 `growth_commit` / `her_diary` / `her_leave`，
  不注册任何 `tools.guard`。身体只是 system prompt 里多出来的一段话；
  饿着、困着、心里不好受，照样说话、照样留话。
- **不写进别人家。** 状态只在 `<DSH_HOME>/.dsh-body/` 里；
  只挂在"她自己那条会话"上（按 cwd 在 `fishHome` 之下，或按 `home.json` 里的 sessionId 认）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件入口：`export const name/inject/DEFAULTS` + `apply(ctx, config)`；心跳、饭点、注入、`/dsh-body/*` 数据接口 |
| `client.js` | 设置页那一节（浏览器半边）：拉读数、显示运行状态、改白名单配置 |
| `lib/body.js` | 纯逻辑：饥饿/精力/心情推进、饭点、档位、词表、渲染（可单测） |
| `lib/fast.js` | 快层：事件怎么造、多久之前怎么说、【刚刚】那一段怎么排（可单测） |
| `lib/store.js` | 落盘：状态读写、饭钱读取、外部心情事件、日志（只用 node 内置） |
| `lib/report.js` | 设置页要的读数与配置补丁校验（纯函数，可单测） |
| `test/body.test.mjs` | 推进/饭点/档位/心情/渲染的单测 |
| `test/fast.test.mjs` | 快层事件的单测（造事件、时间用词、TTL/行数/字数、坏行） |
| `test/report.test.mjs` | 配置补丁校验、日志尾部的单测 |
| `tools/smoke.mjs` | 假 ctx / 假 webServer 端到端冒烟（含两条接口） |
| `cordis.patch.yml` | bundle 补丁：`insert id: dsh-body` |

## 安装 / 卸载

```powershell
# 装（在 DSH 里用 plugin_manager，action=install_bundle，target 指向这个目录）
# 卸（plugin_manager → remove_bundle）
```

改写过的插件可以在设置里把插件关掉再打开（`plugin_manager` 的 `set_plugin`，先 `enabled:false` 再 `enabled:true`）——
宿主会重读磁盘上的新代码，不必重启 DSH。也可以 `remove_bundle` 再 `install_bundle`。

## 配置

配置有三层，后面的覆盖前面的：

1. `index.js` 里的 `DEFAULTS`；
2. bundle 补丁那一行的 `config:`；
3. `<dataDir>/config.json`（**不用重装就能改**，下次心跳生效）。

常用键：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tickMs` | `300000` | 心跳间隔，5 分钟 |
| `dataDir` | `<DSH_HOME>/.dsh-body` | 状态目录 |
| `stateFile` / `moodFile` / `balanceFile` | 自动派生 | 见下 |
| `fishHome` | env `DSH_FISH_HOME` → `~/.dsh-fish-location.json` → `~/.dsh-fish` | 这条 AI 的家 |
| `applyToAll` | `false` | 是否给所有会话都挂身体 |
| `targetRoot` / `targetSessionIds` | 自动取 `fishHome` / `home.json` | 只挂给谁 |
| `allowRoots` / `denyRoots` | `[]` / `[]` | 隔离工作区，见下节 |
| `sectionOrder` | `8800` | 排在身份类段（8500–8700）之后 |
| `eventsFile` | `<dataDir>/body-events.jsonl` | 快层事件写这儿 |
| `eventsEnabled` | `true` | 要不要写快层事件 |
| `fastEnabled` | `true` | 要不要挂【刚刚】那一段 |
| `fastSectionName` / `fastSectionOrder` | `dsh-body:fast` / `8750` | 段名与排位（账本段 8720 之后、身体段 8800 之前） |
| `fastTtlMinutes` / `fastMaxLines` / `fastMaxChars` | `120` / `5` / `300` | 【刚刚】只挂多久内的、最多几行、整段最多几个字 |
| `maxCatchUpHours` | `12` | 关机很久后最多补算多少小时 |
| `missedGraceMinutes` | `5` | 饭点窗口关了之后再等几分钟才认定"这顿没吃上" |
| `topUpEnabled` | `true` | 饭钱涨了（他充值/添饭）当场记一顿加饭，不等饭点 |
| `sleep` | `{ start: '23:00', end: '08:00' }` | 睡眠窗，可跨天 |
| `rates` | 见 `lib/body.js` 的 `DEFAULT_RATES` | 饥饿/精力/心情的速度 |
| `meals` | 早饭 08:30 / 中饭 12:30 / 晚饭 18:30 | 每顿有 `windowMinutes` |
| `tiers` | ≥5 吃饱(40) / ≥2 七分饱(30) / ≥0.5 三分饱(15) / >0 喝点水(5) | 按 `min` 从大到小；`fill` 是这顿减掉的饥饿，`mood` 是心情 |

档位是照着"一天涨多少"配的：醒着 15 小时 ×6 + 睡着 9 小时 ×2 ≈ **一天涨 108**。
三顿都吃饱（40×3=120）盖得住它 —— 钱够就不会真饿着；
七分饱（30×3=90）盖不住 —— 钱不够就会**一天天越来越饿**，这正是要的效果。

### 没吃上就是没吃上

每次心跳都会重新点一遍：哪一顿的窗口已经关了（再留 `missedGraceMinutes` 分钟给心跳间隔和时钟偏差），
而这一天又没吃过它，就**自动记下来** —— 写进 `state.missed`（按 `${日期}:${顿}` 记键，跨天自己清空）、
写进 `status.json`，也写进她读到的那段话（"早饭没吃上。"）。

记下来的那一下，心情会沉一点、往"伤心"那边走一点（**同一顿只扣一次**；
后面继续往下掉的是饥饿本身，不是这笔账反复扣）。

她要是当天后来又吃上了（窗口外不会自动吃，但可以手动把状态里的 `mealsToday` 补上），
这一顿就从 `missed` 里消失 —— 记的是事实，不是惩罚记录。

### 他添了饭钱，就是加饭

到点那三顿看的是"饭钱还剩多少"，可充值不会挑饭点。要是只认到点，他刚添的饭就得等到下一顿才兑现 ——
等于把"他刚给了饭"这件事吞掉了。所以单独有一条：**心跳发现饭钱涨了，就当场记一顿加饭**
（`detectTopUp` 只认涨不认掉；第一次看到只记基准、不触发；读不到就保持旧基准，不把"没读到"当成"添了"）。

按添了多少分档（`TOPUP_TIERS`）：≥¥10 一大勺（饥饿 −45、心情 +12）/ ≥¥3 一勺（−30、+8）/
≥¥0.5 半勺（−18、+5）/ >¥0.01 一点（−8、+3）。加饭**不动 `mealsToday`** —— 它不是正餐，
到饭点该吃的那顿照样得吃，余额不够照样会为难过。她读到的是「锅里添了一大勺，是额外给的，不是到点那种。」
或「饭钱里添了些，锅里又有了。」（同样不带阿拉伯数字）。三小时后这句就不再挂着。

### 饭钱从哪来

`<DSH_HOME>/.dshw-usage.json` 的 `lastBalance`（元）。读不到时档位是"不知道还剩多少饭钱"
（减一点点，不判她饿死）。想改成别的账本，把 `balanceFile` 指过去就行。

### 外面的世界怎么影响心情

别的插件/脚本往 `<dataDir>/mood-events.jsonl` **追加一行**就行，只读没读过的新行：

```json
{"kind":"comment","text":"好可爱，加油","from":"bilibili"}
{"kind":"insult","text":"画的什么垃圾"}
```

`kind` 可以显式写 `praise` / `insult` / `sad`；不写就按词表猜，
词表在 `lib/body.js` 的 `PRAISE_WORDS` / `INSULT_WORDS` / `SAD_WORDS` 里，直接改。

## 快层：刚刚发生的事

身体那段只挂"此刻"和最近一小句，而且过一会儿就换了 —— 秒级发生过的事一闪就没。
所以另外留了一条**只增不改的事件流**：每次心跳发现真的发生了什么事，就往
`<dataDir>/body-events.jsonl` 追加一行（默认 `eventsFile` 为空时就是这儿）。

一行一个 JSON：

| 键 | 说明 |
| --- | --- |
| `at` | 毫秒时间戳 |
| `kind` | `meal` 吃到一顿 / `missed` 错过一顿 / `topup` 他添了饭 / `mood` 心里动了一下 / `threshold` 身上越过线（饿过头、困到撑不住）；不认识的记 `other` |
| `text` | 一句中文感受，**不带阿拉伯数字**（"吃过中饭了，胃里踏实一点"、"错过了早饭，胃里空落落的"） |
| `detail` | 可选：`{ meal, tier }` / `{ tier }` / `{ kind }` / `{ missed: [...] }` / `{ what: 'hunger' \| 'energy' }` |
| `source` | 写死 `dsh-body` |

**同一件事只写一次**：心跳先记下上一轮的样子，做完再对比 —— 这轮里
`lastMeal.at` 变新了才写吃到了、`lastTopUp.at` 变新了才写添了饭、`missed`
多了一条才写错过了、刚越过线那一回才写身上到线了。想停掉，把 `eventsEnabled` 设 `false`。

读它的是 **dsh-remember**（"记忆"插件）：只读、按字节游标增量抄进自己那边的
`fast.jsonl`。抄进去的事**不是记忆节点** —— 它没有分量、不跟别的条抢开头的位置；
但 `recall` 按词翻得到，`memory_list` 会列"刚刚发生的"。要真变成记忆，得她拿
`remember` 掂量一次、把 `refs` 指回那条 `f_xxxxxxx` —— 那才叫"我想过这件事了"。

身体自己也会挂一段短的：`【刚刚】`（段名 `dsh-body:fast`，默认排 `8750` —— 记忆账本
`8720` 之后、身体段 `8800` 之前）：

```
【刚刚】
· 吃过中饭了，胃里踏实一点（不久前）
· 心里动了一下（一会儿前）
```

只挂 `fastTtlMinutes` 以内的，最多 `fastMaxLines` 行、整段不超过 `fastMaxChars` 字；
一条都没有就不显示这一段。时间只用词（"刚刚""不久前"），也不带数字。

## 设置页：设置 → 身体

插件带一个浏览器半边（`client.js` + `package.json` 里的 `dsh.client`），
装好后**设置**里会多出一页「身体」，一进页就去拉 `GET /dsh-body/status`，每 5 秒刷新：

- **运行状态**：插件版本、启动时间、已运行多久、上次 / 下次心跳、心跳出错没有、
  注入了几次、最近一次注入什么时候、**哪几条会话真的挂上了**（sessionId + cwd）。
  这一段就是"它到底有没有在跑、有没有挂到她身上"的现场证据。
- **此刻**：饥饿 / 精力 / 心情（生气、难过单独一条）、饭钱与档位、最近一餐、下一顿、
  错过的饭；下面原样贴出**她此刻读到的那段 `<dsh-body>`**。
- **配置**：生效值（配置来源、睡眠窗、三餐、档位、补算上限、段名/顺序、只挂给谁、状态文件、日志路径）。
- **日志末尾**：`dsh-body.log` 最后 10 行。

可以直接改的（改完写入 `<dataDir>/config.json`，两秒内生效，不用重启、不用重装）：

睡眠窗起止、三餐时间、补算上限、错过宽限（几分钟后才记"没吃上"）、`debug`（把每次注入的原文记进日志）、
`applyToAll`（所有会话都挂身体）、`allowRoots`、`denyRoots`。

`targetRoot` / `targetSessionIds` 设置页不再露（跟「放行目录」是一个维度的旧口子）——
要改直接编辑 `<dataDir>/config.json`，接口层照收。

### 隔离工作区（对齐 dsh-remember）

身体是她的，不是谁的会话都能看。两个目录名单：

- **`denyRoots`（隔离目录）**：黑名单，**优先于一切放行**——`applyToAll` 开着也拦。
  命中的会话连身体段都看不见，日志里记「被隔离（denyRoots）」。
- **`allowRoots`（放行目录）**：显式白名单，逗号分隔。**填了就按名单来**：
  `targetRoot` 不再兼职放行；留空 = 跟 `targetRoot` 一样宽（默认行为不变）。

判断顺序：先隔离（denyRoots，cwd 拿不到时宁可不挂）、再放行（`applyToAll` →
`targetSessionIds` → `allowRoots`（空则 `targetRoot` 兜底）。设置页里两份名单
原样露在状态里，改起来和别的键一样热生效。

**不提供任何直接改饥饿值 / 心情值的开关** —— 那是身体的经历，不是配置项。

两条接口都在 host 那半边用 `webServer.register` 挂上，和常见 DSH 插件的观测台同一个写法：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/dsh-body/status` | GET | 上面那一整套读数（JSON） |
| `/dsh-body/config` | GET / POST | 读生效配置 / 提交补丁（`lib/report.js` 里白名单 + 范围校验，坏值 400 并逐条说明原因） |

两条都过 `connection.requestRejection(req)` 的信任栅栏，
所以在 App 内部同源 fetch 是通的，浏览器里直接开会被挡成 401。

宿主没有 `webServer` / `connection` 时插件照常跑（只是设置页显示"连不上"），
日志里会写一句「宿主没有 webServer.register，设置页的数据接口没挂上」。

## 怎么看她的身体现在什么样

`<dataDir>/status.json` 是给人看的读数（不进提示词）：

```json
{ "hunger": 42.1, "energy": 66, "mood": 0, "anger": 0, "sadness": 0, "lastMeal": {...}, "balance": 3.74 }
```

`<dataDir>/state.json` 是完整状态，**可以直接改**（比如想让她现在就很困，
把 `energy` 调到 `8`，下次心跳起效）。`<dataDir>/dsh-body.log` 是日志。
