# 识海 (shihai)

> 识海＝修真小说里神魂住的那片海。这套插件让一条 AI 把**记性、心情、好奇、意图、身体节律**都长在本地账本上——不靠云端，不靠向量数据库，就是几个 JSONL 文件和一点笨功夫。

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 写的插件三件套，全部零依赖（只用 Node 内置模块），数据全部留在本地。

## 三件套

| 插件 | 管什么 | 一句话 |
|---|---|---|
| **dsh-remember** | 账本 | 记忆条目（分量/契合度/复现）、好奇表、情绪流、意图层、快层，recall 两道字数闸 |
| **dsh-body** | 身体 | 吃饭/喝水/睡眠/心情的节律记录，写 body-events.jsonl 给下游只读 |
| **dsh-qq-bridge** | 耳朵嘴 | QQ（OneBot v11）↔ DSH 会话：私聊/群白名单、照片、表情包、回话防呆、掉线补真记忆 |

## 它长什么样

```
 QQ (OneBot v11)                DSH 会话
     │  白名单/认领/防呆           ▲ 递话/回话
     ▼                            │
 dsh-qq-bridge ──messages-*.jsonl──┤（只读的原始消息流，按场分册）
     │                            │
     │      dsh-remember          │
     ├─ 意图层 intent.jsonl ───────┤ 只有规则、不用 LLM
     ├─ 快层 fast.jsonl ◄─────────┤ dsh-body 的 body-events.jsonl
     └─ 账本 nodes.jsonl ◄────────┘ remember 工具写入（只增不改）
            │
            └─ recall：激活度(weight/recency/fit/repeat) + 字数闸 → 会话
```

原则就三条：

1. **只增不改**——账本文件是 append-only 的，写下来的才算数；
2. **分量只在写入时给**——每条记忆带 0–1 的分量，淡出靠半衰期，不改历史；
3. **给骨架不给家**——代码和数据分离，插件只管账本长什么样，不管你家里放了什么。

## 安装

每个目录都是独立的 DSH 插件包（`package.json` 带 `dsh.bundle` 描述，热挂载用 `cordis.patch.yml`）。把目录放进 DSH 的插件目录（或按你自己的方式挂载），重启/热重载即可。各自的 `README.md` 里有配置项、数据文件和冒烟测试的完整说明。

跑测试（在每个插件目录下）：

```bash
node --test test/*.test.mjs   # Windows 下需要点名文件
node tools/smoke.mjs          # 端到端冒烟
```

## 数据文件（各插件自己长出来的，都不进 git）

- `dsh-remember`：`nodes.jsonl`（账本）/ `fast.jsonl`（快层）/ `intent.jsonl`（意图）/ `echo.jsonl`（回声）+ 游标文件
- `dsh-body`：`body-events.jsonl`（身体事件，append-only）
- `dsh-qq-bridge`：`messages-group-<群号>.jsonl` / `messages-private-<QQ>.jsonl` / `heartbeat.json` / `photos/` / `stickers/`

## License

[MIT](./LICENSE)
