// 文件 I/O 助手（core/protocol 用，2026-11-22 批③）。
//
// 为什么是副本不是 import：账本协议住在 core/，独立性纪律不许 core 反向依赖
// 宿主胶水（dsh-remember/lib/store.js），所以协议要用的这几个小助手在这里逐字
// 同源复制了一份。它们是冻结的小函数（tmp+rename 原子写、粘读、偏移读）——
// 要改就两边一起改，characterization 与冒烟盯着行为。原版在
// dsh-remember/lib/store.js，语义以原版为准。
//
// 独立性纪律：本目录不 import core/ 纯函数件之外的东西，也不 import index.js。

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, normalize, resolve, sep } from 'node:path'

/** 路径归一（批 A 自 lib/store.js 逐字同源归位——normPath 多实现债的第一刀收口）：小写、正斜杠统一、去尾分隔符 */
export function normPath(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  return normalize(resolve(s)).replace(/[\\\\/]+$/, '').toLowerCase()
}

/** child 是否在 parent 里（或就是它）——allowRoots/denyRoots 的判定底座 */
export function isUnder(child, parent) {
  const c = normPath(child)
  const p = normPath(parent)
  if (!c || !p) return false
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 已经有了或者建不了，后面的写入会自己报错 */
  }
}

export function readTextSafe(file, fallback = '') {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

export function readJsonSafe(file, fallback = null) {
  try {
    const raw = readFileSync(file, 'utf8')
    // BOM 剥离（批 D2）：记事本存一次带 BOM 的配置，JSON.parse 就炸——隔离名单静默放空的病根
    const value = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    return value ?? fallback
  } catch {
    return fallback
  }
}

/**
 * 读坏了沿用上一份好的 —— 段构建宁可旧一拍，不能空一轮。
 *
 * 2026-11-12 晚：自我段（【我】【还没定的】【我记得的】）瞬时断供连续四回现行，
 * 形状全是「读账本的段消失、读快层的段照常」，一两轮后原样回来。
 * 病根＝memory.json 读的瞬间撞上镜像/拷贝（sync 每分钟一轮），readJsonSafe
 * 返回 null → 节点表空 → 段空 → billion-context 锚相似度跌破 0.7 整个换锚。
 * 这层兜底：读成功就记进 lastGood，读失败/读出 null 就还上一份好的。
 * 原子写（tmp+rename）保证读到的要么是旧整本要么是新整本，粘住只救瞬时故障。
 */
const lastGoodJson = new Map()

export function readJsonSafeSticky(file, fallback = null) {
  try {
    const raw = readFileSync(file, 'utf8')
    // BOM 剥离（批 D2）：记事本存一次带 BOM 的配置，JSON.parse 就炸——隔离名单静默放空的病根
    const value = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    if (value != null) {
      lastGoodJson.set(file, value)
      return value
    }
    return lastGoodJson.get(file) ?? fallback
  } catch {
    return lastGoodJson.get(file) ?? fallback
  }
}

/**
 * 原子写：tmp + rename，**先 fsync 再 rename**。
 * 「写一半断电」要真兜得住，得保证数据落盘之后才换名 —— 不 fsync 的话，
 * rename 成功了、内容还躺在页缓存里，掉电就是空文件（2026-11-15 审查修的）。
 * fsync 失败就吞掉继续（个别文件系统不支持对文件 fsync）—— tmp 留着、
 * 原文件没动，下一次写重来；真掉电兜不住的场景换文件系统才兜得住。
 */
export function atomicWriteJson(file, data, mode = 0o600) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const body = `${JSON.stringify(data, null, 2)}\n`
  const fd = openSync(tmp, 'w', mode)
  try {
    writeSync(fd, Buffer.from(body, 'utf8'))
    try {
      fsyncSync(fd)
    } catch {
      /* 个别文件系统不支持对文件 fsync —— 内容已写，rename 照走 */
    }
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

/** 原话层：一行一条 JSON，只加不改 */
export function appendJsonLine(file, value) {
  ensureDir(dirname(file))
  appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** 读一行一条 JSON 的文件；坏行跳过，不因为一行坏了丢整本 */
export function readJsonLines(file, maxLines = 0) {
  const text = readTextSafe(file, '')
  if (!text) return []
  let lines = text.split('\n').filter(Boolean)
  if (maxLines > 0) lines = lines.slice(-maxLines)
  const out = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/**
 * 从某个字节偏移往后读「一行一条 JSON」的文件 —— 只取新追加的行。
 *
 * 为什么用偏移不用行号：文件是 append-only 的，偏移能保证只读新行，
 * 不用每次把整个文件读一遍。半行（还没写完的尾巴）留在原地等下次，
 * 绝不把没写完的一行当成一条数据。
 *
 * 文件被截断或换过（size < offset）就从头重读，并把 reset 标出来。
 */
export function readJsonLinesFrom(file, fromOffset = 0) {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return { rows: [], next: 0, reset: false, exists: false }
  }
  let offset = Math.max(0, Number(fromOffset) || 0)
  let reset = false
  if (offset > size) {
    offset = 0
    reset = true
  }
  if (size <= offset) return { rows: [], next: offset, reset, exists: true }
  let buf = null
  try {
    const len = size - offset
    buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, len, offset)
    } finally {
      closeSync(fd)
    }
  } catch {
    return { rows: [], next: offset, reset, exists: true }
  }
  // 找最后一个换行字节：换行之前的是完整行，换行之后是还没写完的尾巴
  let lastNl = -1
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    if (buf[i] === 0x0a) {
      lastNl = i
      break
    }
  }
  const complete = lastNl >= 0 ? buf.subarray(0, lastNl) : Buffer.alloc(0)
  const rows = []
  for (const line of complete.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  const next = lastNl >= 0 ? offset + lastNl + 1 : offset
  return { rows, next, reset, exists: true, pending: lastNl < buf.length - 1 }
}

export function exists(file) {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

/**
 * 副本的裁旧：只留文件里最新的 maxLines 行（按文件顺序，尾部是新的）。
 * 超过就整本重写（tmp + rename），没超过一行都不动。返回留下的行数；-1 = 没动/不该动。
 * 用在快层抄本这种「可再生的副本」上 —— 原话层和 echo 档永远只增，不走这里。
 */
export function keepTailLines(file, maxLines) {
  try {
    const n = Number(maxLines)
    if (!Number.isFinite(n) || n <= 0) return -1
    if (!exists(file)) return -1
    const raw = readTextSafe(file, '')
    if (!raw) return -1
    const lines = raw.split('\n').filter((l) => l.trim())
    if (lines.length <= n) return lines.length
    const kept = lines.slice(-n)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${kept.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return kept.length
  } catch {
    return -1
  }
}
