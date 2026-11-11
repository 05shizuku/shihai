/**
 * 心跳（v0.8.3）——「我还活着」的活体证据。
 *
 * 桥平时只在有消息时才写日志，安静的时候没法判断它是活着还是死了。
 * 所以每分钟往 <homeDir>/heartbeat.json 写一次：时间戳 + 版本 + 活了多久 + 队列里几条。
 * 谁都可以读它：selfcheck.mjs 会读、看门狗常驻也可以读（将来「我哑了替我喊一声」就靠它）。
 *
 * 纯逻辑，零依赖，方便单测。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 多久写一次 */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000
/** 超过这么久没写，就当它哑了（默认 3 分钟 = 三次没写） */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000

/** 攒一条心跳内容（数字都收成有限数，坏值给 0 / null） */
export function heartbeatInfo({ version = '', startedAt = 0, now = Date.now(), pending = 0, ws = null } = {}) {
  const t = Number(now)
  const s = Number(startedAt)
  return {
    at: Number.isFinite(t) ? t : 0,
    iso: new Date(Number.isFinite(t) ? t : 0).toISOString(),
    version: String(version ?? ''),
    uptimeMs: Number.isFinite(t) && Number.isFinite(s) ? Math.max(0, t - s) : 0,
    pending: Math.max(0, Math.floor(Number(pending) || 0)),
    ws: ws === null || ws === undefined ? null : Boolean(ws),
  }
}

/** 原子写：先写 .tmp 再改名，读到一半的坏文件不会出现 */
export function writeHeartbeat(file, info) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(info)}\n`)
  renameSync(tmp, file)
  return info
}

/** 读一条心跳；读不出 / 坏 JSON → null */
export function readHeartbeat(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    // 数组也是 object，但心跳必须是一条记录 —— 数组当坏文件
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** 心跳多旧（毫秒）；没有 / 坏 → Infinity */
export function heartbeatAgeMs(file, now = Date.now()) {
  const hb = readHeartbeat(file)
  if (!hb || !Number.isFinite(hb.at)) return Infinity
  return Math.max(0, Number(now) - Number(hb.at))
}

/** 一句判断：还活着吗（alive / ageMs / why），给人看的 why 用中文 */
export function heartbeatVerdict(file, { now = Date.now(), staleMs = HEARTBEAT_STALE_MS } = {}) {
  const ageMs = heartbeatAgeMs(file, now)
  if (ageMs === Infinity) return { alive: false, ageMs: Infinity, why: '没有心跳（桥从来没写过，或者文件坏了）' }
  if (ageMs <= staleMs) return { alive: true, ageMs, why: `心跳新鲜（${Math.round(ageMs / 1000)} 秒前）` }
  return { alive: false, ageMs, why: `心跳停了：最后一下在 ${Math.round(ageMs / 1000)} 秒前` }
}
