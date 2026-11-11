/**
 * 文件与路径。零依赖，只用 node 内置。
 *
 * 这里的取舍：账本要经得起「写一半断电」。节点表用 .tmp + rename 原子换；
 * 原话层是 append-only，一行一条，坏了也只坏一行。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'

export function resolveDshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
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
    const value = JSON.parse(raw)
    return value ?? fallback
  } catch {
    return fallback
  }
}

export function atomicWriteJson(file, data, mode = 0o600) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode })
  renameSync(tmp, file)
}

/** 原话层：一行一条 JSON，只加不改 */
export function appendJsonLine(file, value) {
  ensureDir(dirname(file))
  appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
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

/** 文件大小（字节）。 */
export function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

export function normPath(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  return normalize(resolve(s)).replace(/[\\/]+$/, '').toLowerCase()
}

export function isUnder(child, parent) {
  const c = normPath(child)
  const p = normPath(parent)
  if (!c || !p) return false
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 日志：超过 maxBytes 就滚成 .1，不无限长 */
export function makeFileLogger(file, { maxBytes = 512 * 1024, prefix = 'dsh-remember' } = {}) {
  try {
    if (fileSize(file) > maxBytes) {
      const rolled = `${file}.1`
      try {
        renameSync(file, rolled)
      } catch {
        /* 滚不动就算了 */
      }
    }
  } catch {
    /* ignore */
  }
  return (line) => {
    try {
      ensureDir(dirname(file))
      appendFileSync(file, `${new Date().toISOString()} [${prefix}] ${String(line)}\n`, 'utf8')
    } catch {
      /* 日志写不进去不该让插件崩 */
    }
  }
}

export function tailLines(file, n = 10, maxBytes = 65536) {
  try {
    const size = statSync(file).size
    if (size <= 0) return []
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, len, start)
    } finally {
      closeSync(fd)
    }
    const text = buf.toString('utf8')
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-n)
  } catch {
    return []
  }
}

export function exists(file) {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

/** 宿主里 agent 的会话 id / cwd —— 字段名随版本挪过，四路都试 */
export function agentSessionId(agent) {
  return String(agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id ?? '').trim()
}

export function agentCwd(agent) {
  return String(
    agent?.session?.header?.cwd ?? agent?.header?.cwd ?? agent?.session?.cwd ?? agent?.cwd ?? '',
  ).trim()
}
