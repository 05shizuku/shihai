# G-1.5 · 拓扑对称与观测纪律（三审吸收批）

> 2026-11-22 定稿。来源：amikar/docs/审查报告-技术缺陷与逻辑漏洞-2026-11-22.md 三审
> （新-1 拓扑不对称 / 新-2 junction=热改在役器官 / 新-7 启动行版本号——新-7 已落 v0.26.1）
> + 本侧自查（观测探针旗标化）。执行时点：11-26 观测收口后、G-2 之前——
> **拓扑对称是服务化的前置：服务要管的器官，必须全部在版本控制内。**

## 1. 新-1 拓扑对称：bridge/she 收编进仓

**现状**：remember/body/reach 的运行体 = git 仓（junction→E:\大肥鱼\shihai\）✓；
**追记（2026-11-27，ADR-0008）**：本节承诺全部兑现——bridge/she 已收编进仓，五 junction（remember/body/reach/qq-bridge/she）现役装载位 = profiles\desktop\node_modules，SHA-256 对拍全一致；Plugin\ 下两 junction 转墓碑语义（侧门 _say.mjs 邻接工作，保留不删）；仓外成员 dsh-look/dsh-model-failover 如实记不入识海仓。台账全文见 ADR-0008。

**qq-bridge 与 she 的运行体 = junction→Plugin 仓外副本**，仓里另有一份手工同步的拷贝
（2026-11-22 逐字节一致，但无任何同步机制）。三审原话：最活跃的 bridge（群参与 v1 所在）
运行体不在版本控制内，「三个月后就是这次事故的微型复刻」。

**修法（半小时）**：
1. 搬目录：`E:\大肥鱼\Plugin\dsh-qq-bridge` → `E:\大肥鱼\shihai\dsh-qq-bridge`；dsh-she 同
2. 重建 junction：`profiles\node_modules\dsh-qq-bridge` → `shihai\dsh-qq-bridge`（she 同）
3. 归一校验：搬移前后逐文件 SHA256 对拍；junction 解析探针照 G-0 的 realpath 法
4. 复跑：bridge 自家测试 + remember 全套（单测/冒烟/考卷）不回归
5. 台账：十三⑫ 模式——旧位置墓碑 + 版本记录，Plugin\ 下不再有在役插件真身

**验收**：node_modules 的 junction 目标全部落进 shihai\；Plugin\ 无在役真身；副本归一。

## 2. 新-2 git 操作纪律（junction = 热改在役器官）

- **推送通道（2026-11-25 起）**：GitHub Desktop 内嵌 git——
  `C:\Users\10113\AppData\Local\GitHubDesktop\app-3.6.11\resources\app\git\cmd\git.exe`
  （版本 2.56.1，随 Desktop 更新换代，用前 glob app-* 取最新）。真历史/真对象库，
  优先于 REST 快照通道（REST 只在应急时用；REST 推送不写本地对象，事后
  `git fetch origin` 即愈——2026-11-25 已愈，浅引用限制作废）。
- **push 500 的已知解法（2026-11-25 实证）**：GitHub receive-pack 对 thin-pack
  偶发 Internal Server Error（读通写挂、status 全绿、连挂三次）——
  `git push --no-thin origin main` 即过。先 `git ls-remote` 确认读通再动刀。

- git 操作（add 除外）只在**安静时段**做——她不活跃、无会话中途回话的窗口
- 操作**前后各跑一次体检**：amikar 侧 check.mjs，shihai 侧考卷 + 冒烟
- DSH 插件管理器对 junction 内插件的安装/更新会穿透写脏工作树——升级类操作视同发版，按两段式走
- 违反症状速查：bridge.log 断流 / 装载行消失 / 21:30 探针报错

## 3. 观测探针旗标化（本侧自查）

**病**：21:30 探针的产出落在对话里，依赖 lead 会话在位与人的记性——
「写了没接线」的观测版：检查在跑，但产出没有消费者。

**改法（今晚起生效）**：
- 每次探针产出写旗标文件：`E:\大肥鱼\amikar\data\observation\observation-YYYY-MM-DD.json`
- 形状：`{at, day, items:[{key, pass, note}], exceptions:[…]}`——九项清单逐项 pass/fail
- 异常（渲染失败 / O(N²) 复发 / sprout 滥触 / 账本 SHRANK / 考卷数字漂移）→ 当日报 +
  exceptions 非空
- 中枢/桥/未来的 G-2 服务都可读它——**观测的产出第一次成为机器可读的账**
- 连续两天 exceptions 非空 → 收口报告升级为工单

## 4. 认仓公理（三审 7.1 与 G-0 探针独立收敛，2026-11-22 同日）

> **「认仓要认 .git，认路径要认 junction——目录名会骗人。」**

- 任何审计/拆核/同步动作开工前，第一步是 realpath 探针（G-0 同款 node -e，两分钟）
- 任何文档引用目录，必须写明「这个目录是不是版本控制的工作树」
- 审计需要拓扑图作输入，**不许从目录名推断拓扑**（三审 P0-1 误判的根因）

## 5. 施工与验收

- 批次：**v0.26.2**（bridge/she 收编 + 本纪律进 ADR-0007 或独立成条）
- 验收：收编后三份副本归一（全仓 SHA256 对拍）+ bridge 测试绿 + 群参与 v1 真机不回归
  + observation 旗标文件连续三天产出
