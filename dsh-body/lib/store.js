/**
 * store.js —— 落盘相关：状态文件、饭钱账本、外部心情事件、日志
 *
 * 只用 node 内置模块。插件是 link 安装（软链接到 profile 外），
 * 依赖解析找不到 profile 的 node_modules，所以**不能**引第三方包。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return String(env).trim()
  return join(homedir(), '.dsh')
}

export function readTextSafe(file) {
  try {
    if (!file || !existsSync(file)) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function readJsonSafe(file, fallback = null) {
  const text = readTextSafe(file)
  if (text == null) return fallback
  try {
    const j = JSON.parse(text)
    return j == null ? fallback : j
  } catch {
    return fallback
  }
}

export function atomicWriteJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 状态文件读取；坏文件不让插件崩，退回默认值 */
export function loadState(file, nowMs, makeDefault) {
  const raw = readJsonSafe(file, null)
  if (!raw || typeof raw !== 'object') return makeDefault(nowMs)
  return { ...makeDefault(nowMs), ...raw }
}

/** 饭钱：读宿主自己的用量账本里的 lastBalance（元） */
export function readBalance(balanceFile, dshHome) {
  const file = balanceFile || join(dshHome, '.dshw-usage.json')
  const j = readJsonSafe(file, null)
  const b = Number(j?.lastBalance)
  return Number.isFinite(b) ? b : null
}

/**
 * 外部心情事件（别的插件/脚本往 mood-events.jsonl 追加行）：
 *   {"kind":"praise|insult|comment|sad","text":"...","from":"..."}
 * 只读尚未消费过的行，返回新的行下标。
 */
export function readMoodEvents(file, fromIndex = 0) {
  const text = readTextSafe(file)
  if (text == null) return { events: [], nextIndex: fromIndex }
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const start = Number.isFinite(fromIndex) && fromIndex > 0 ? fromIndex : 0
  const events = []
  for (const line of lines.slice(start)) {
    try {
      const j = JSON.parse(line)
      if (j && typeof j === 'object') events.push(j)
    } catch {
      /* 坏行跳过，不算崩 */
    }
  }
  return { events, nextIndex: lines.length }
}

export function loadOverrides(stateDir) {
  const j = readJsonSafe(join(stateDir, 'config.json'), null)
  return j && typeof j === 'object' ? j : {}
}

export function normPath(p) {
  let out = resolve(String(p ?? '')).replace(/[\\/]+$/, '')
  if (process.platform === 'win32') out = out.toLowerCase()
  return out
}

/** child 是否在 root 之下（含相等） */
export function isUnder(child, root) {
  if (!child || !root) return false
  const c = normPath(child)
  const r = normPath(root)
  if (!c || !r) return false
  return c === r || c.startsWith(r + sep) || c.startsWith(r + '/')
}

/** 把外部事件写在 schema 里的字段抄出来，方便日志 */
export function describeEvent(ev) {
  return `${String(ev?.kind ?? 'event')}:${String(ev?.text ?? '').slice(0, 40)}`
}

/** 简易文件日志；超过 512KB 直接重开，不让它长成怪物 */
export function makeFileLogger(file, sizeLimit = 512 * 1024) {
  return (line) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size > sizeLimit) writeFileSync(file, '', 'utf8')
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      /* 写不进去就算了，日志不能反过来把插件拖死 */
    }
  }
}
