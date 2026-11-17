/**
 * store.js —— 磁盘上那几件小东西：目录、原子写、日志、路径判断
 *
 * 为什么自己写一份（不复用 dsh-body 的）：两个插件各自独立安装、独立卸载，
 * 互相 import 会让"只装一个"变成"必须装两个"。这几个函数加起来不到一百行。
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** DSH 的 home：优先 DSH_HOME，其次 ~/.dsh */
export function resolveDshHome() {
  const env = String(process.env.DSH_HOME ?? '').trim()
  if (env) return resolve(env)
  return join(homedir(), '.dsh')
}

export function ensureDir(dir) {
  try {
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore: 目录建不出来，后面的写会自己报 */
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
  const text = readTextSafe(file, '')
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 文件在不在 */
export function fileExists(file) {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

/** 删掉一个文件；删不掉也不算错（可能正被占着） */
export function removeFileSafe(file) {
  try {
    if (existsSync(file)) rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 原子写 JSON：先写 .tmp 再 rename。
 * 权限 0600 —— 这个目录里放的是"还没说出口的话"，不该给别人看。
 */
export function atomicWriteJson(file, data, mode = 0o600) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    chmodSync(tmp, mode)
  } catch {
    /* Windows 上 chmod 是空操作，失败不算错 */
  }
  renameSync(tmp, file)
}

/** 统一成小写、正斜杠、无尾斜杠，用来比较"是不是同一棵树下面" */
export function normPath(p) {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export function isUnder(child, parent) {
  const c = normPath(child)
  const p = normPath(parent)
  if (!c || !p) return false
  return c === p || c.startsWith(`${p}/`)
}

/** 简单的文件日志：超过 512KB 就滚成 .1，不会无限长 */
export function makeFileLogger(file, { maxBytes = 512 * 1024 } = {}) {
  return function log(line) {
    try {
      ensureDir(dirname(file))
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
      } catch {
        /* 没有旧文件 / 被占用：无所谓 */
      }
      appendFileSync(file, `${new Date().toISOString()} [dsh-reach] ${line}\n`, 'utf8')
    } catch {
      /* 日志写不进去不能影响主流程 */
    }
  }
}

/** 读文件末尾 n 行（大文件只读尾巴，不整份读进来） */
export function tailLines(file, n = 10, maxBytes = 65536) {
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    if (len <= 0) return []
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, len, start)
    } finally {
      closeSync(fd)
    }
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (start > 0) lines.shift()
    return lines.filter((l) => l !== '').slice(-n)
  } catch {
    return []
  }
}

/** agent 的 sessionId：宿主的 Agent 接口只声明了 id，实际对象上有 session */
export function agentSessionId(agent) {
  return String(agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id ?? '')
}

/** agent 的 cwd：dsh-body / dsh-fish 都用同一串兜底顺序取 */
export function agentCwd(agent) {
  return String(
    agent?.session?.header?.cwd ?? agent?.header?.cwd ?? agent?.session?.cwd ?? agent?.cwd ?? '',
  )
}
