/**
 * report.js —— 设置页要的那份读数，以及"改配置"的校验（纯函数，零依赖）
 *
 * 边界：这个文件只负责两件事
 *   ① 把散在插件内存里和磁盘上的东西拼成一份**给人看**的 JSON；
 *   ② 把设置页递上来的补丁**校验后**合并进 config.json 的覆盖层。
 *
 * 它不读文件、不写文件（tailLines 例外：只读日志尾部），也不碰插件状态 ——
 * 这样 `node --test` 里可以只喂数据就能验。
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { parseHHMM } from './body.js'

/** 允许从设置页改的键（白名单，别的键一律拒） */
export const EDITABLE = [
  'sleep.start',
  'sleep.end',
  'meals',
  'maxCatchUpHours',
  'missedGraceMinutes',
  'topUpEnabled',
  'debug',
  'applyToAll',
  'targetRoot',
  'targetSessionIds',
  'allowRoots',
  'denyRoots',
  'sectionName',
  'sectionOrder',
  'eventsFile',
  'eventsEnabled',
  'fastEnabled',
  'fastSectionName',
  'fastSectionOrder',
  'fastTtlMinutes',
  'fastMaxLines',
  'fastMaxChars',
]

function normTime(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  // 设置页里手打的 "7:5" / "7：05" 也认 —— 只要落点是真的一天里的某个时刻
  const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(s)
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return null
  if (parseHHMM(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`) == null) return null
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function normBool(v) {
  return typeof v === 'boolean' ? v : null
}

function normNumber(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

function clone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj ?? {}))
  } catch {
    return {}
  }
}

/**
 * 把设置页的补丁合并进覆盖层。
 *
 * @param {object} input
 * @param {object} input.overrides   现在磁盘上的覆盖层（config.json 原文）
 * @param {object} input.effective   合并后的生效配置（改三餐时要拿它当底）
 * @param {object} input.patch       设置页递上来的补丁
 * @returns {{ok:boolean, overrides:object, accepted:string[], rejected:{key:string,reason:string}[]}}
 */
export function applyConfigPatch({ overrides = {}, effective = {}, patch = {} } = {}) {
  const next = clone(overrides)
  const accepted = []
  const rejected = []
  const p = patch && typeof patch === 'object' ? patch : {}

  // ---- 睡眠窗 ----
  if (p.sleep && typeof p.sleep === 'object') {
    const sleep = { ...(next.sleep && typeof next.sleep === 'object' ? next.sleep : {}) }
    for (const k of ['start', 'end']) {
      if (p.sleep[k] === undefined) continue
      const t = normTime(p.sleep[k])
      if (!t) {
        rejected.push({ key: `sleep.${k}`, reason: '要写成 HH:MM（24 小时制）' })
        continue
      }
      sleep[k] = t
      accepted.push(`sleep.${k}`)
    }
    if (accepted.some((k) => k.startsWith('sleep.'))) next.sleep = sleep
  }

  // ---- 三餐 ----
  if (p.meals !== undefined) {
    if (!Array.isArray(p.meals)) {
      rejected.push({ key: 'meals', reason: '要是一个数组' })
    } else {
      const base = Array.isArray(effective.meals) ? effective.meals.map((m) => ({ ...m })) : []
      const byId = new Map(base.map((m) => [String(m.id), m]))
      let touched = false
      for (const item of p.meals) {
        if (!item || typeof item !== 'object') continue
        const id = String(item.id ?? '')
        const meal = byId.get(id)
        if (!meal) {
          rejected.push({ key: `meals.${id || '?'}`, reason: '没有这一顿' })
          continue
        }
        if (item.at !== undefined) {
          const t = normTime(item.at)
          if (!t) {
            rejected.push({ key: `meals.${id}.at`, reason: '要写成 HH:MM' })
            continue
          }
          meal.at = t
          touched = true
        }
        if (item.windowMinutes !== undefined) {
          const n = normNumber(item.windowMinutes, 0, 360)
          if (n == null) {
            rejected.push({ key: `meals.${id}.windowMinutes`, reason: '要落在 0–360 分钟' })
            continue
          }
          meal.windowMinutes = Math.round(n)
          touched = true
        }
        if (item.label !== undefined) {
          const s = String(item.label).trim()
          if (!s || s.length > 12) {
            rejected.push({ key: `meals.${id}.label`, reason: '不超过十二个字' })
            continue
          }
          meal.label = s
          touched = true
        }
        accepted.push(`meals.${id}`)
      }
      if (touched) next.meals = base
    }
  }

  // ---- 标量 ----
  if (p.maxCatchUpHours !== undefined) {
    const n = normNumber(p.maxCatchUpHours, 0, 72)
    if (n == null) rejected.push({ key: 'maxCatchUpHours', reason: '要落在 0–72 小时' })
    else {
      next.maxCatchUpHours = n
      accepted.push('maxCatchUpHours')
    }
  }

  if (p.missedGraceMinutes !== undefined) {
    const n = normNumber(p.missedGraceMinutes, 0, 720)
    if (n == null) rejected.push({ key: 'missedGraceMinutes', reason: '要落在 0–720 分钟' })
    else {
      next.missedGraceMinutes = Math.round(n)
      accepted.push('missedGraceMinutes')
    }
  }

  for (const key of ['debug', 'applyToAll', 'topUpEnabled']) {
    if (p[key] === undefined) continue
    const b = normBool(p[key])
    if (b == null) {
      rejected.push({ key, reason: '只能是 true / false' })
      continue
    }
    next[key] = b
    accepted.push(key)
  }

  if (p.targetRoot !== undefined) {
    if (typeof p.targetRoot !== 'string') {
      rejected.push({ key: 'targetRoot', reason: '要是一个路径字符串' })
    } else {
      next.targetRoot = p.targetRoot.trim()
      accepted.push('targetRoot')
    }
  }

  if (p.targetSessionIds !== undefined) {
    if (!Array.isArray(p.targetSessionIds)) {
      rejected.push({ key: 'targetSessionIds', reason: '要是一个数组' })
    } else {
      next.targetSessionIds = p.targetSessionIds.map((s) => String(s).trim()).filter(Boolean)
      accepted.push('targetSessionIds')
    }
  }

  // ---- 隔离工作区（对齐 dsh-remember 的 allowRoots／denyRoots） ----
  // denyRoots 优先于一切放行（applyToAll 也拦），先隔离、后放行；
  // allowRoots 是显式白名单，填了就按名单来（targetRoot 不再兼职放行）。
  for (const key of ['allowRoots', 'denyRoots']) {
    if (p[key] === undefined) continue
    if (!Array.isArray(p[key])) {
      rejected.push({ key, reason: '要是一个路径数组' })
      continue
    }
    next[key] = p[key].map((s) => String(s).trim()).filter(Boolean)
    accepted.push(key)
  }

  if (p.sectionName !== undefined) {
    const s = String(p.sectionName).trim()
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(s)) {
      rejected.push({ key: 'sectionName', reason: '只能用字母数字和 ._:-，不超过 64 字符' })
    } else {
      next.sectionName = s
      accepted.push('sectionName')
    }
  }

  if (p.sectionOrder !== undefined) {
    const n = normNumber(p.sectionOrder, 0, 100000)
    if (n == null) rejected.push({ key: 'sectionOrder', reason: '要落在 0–100000' })
    else {
      next.sectionOrder = Math.round(n)
      accepted.push('sectionOrder')
    }
  }

  // ---- 快层：刚刚发生的事 ----
  if (p.eventsFile !== undefined) {
    if (typeof p.eventsFile !== 'string') {
      rejected.push({ key: 'eventsFile', reason: '要是一个路径字符串（留空 = 默认位置）' })
    } else {
      next.eventsFile = p.eventsFile.trim()
      accepted.push('eventsFile')
    }
  }

  for (const key of ['eventsEnabled', 'fastEnabled']) {
    if (p[key] === undefined) continue
    const b = normBool(p[key])
    if (b == null) {
      rejected.push({ key, reason: '只能是 true / false' })
      continue
    }
    next[key] = b
    accepted.push(key)
  }

  if (p.fastSectionName !== undefined) {
    const s = String(p.fastSectionName).trim()
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(s)) {
      rejected.push({ key: 'fastSectionName', reason: '只能用字母数字和 ._:-，不超过 64 字符' })
    } else {
      next.fastSectionName = s
      accepted.push('fastSectionName')
    }
  }

  if (p.fastSectionOrder !== undefined) {
    const n = normNumber(p.fastSectionOrder, 0, 100000)
    if (n == null) rejected.push({ key: 'fastSectionOrder', reason: '要落在 0–100000' })
    else {
      next.fastSectionOrder = Math.round(n)
      accepted.push('fastSectionOrder')
    }
  }

  if (p.fastTtlMinutes !== undefined) {
    const n = normNumber(p.fastTtlMinutes, 0, 10080)
    if (n == null) rejected.push({ key: 'fastTtlMinutes', reason: '要落在 0–10080 分钟（一星期）' })
    else {
      next.fastTtlMinutes = Math.round(n)
      accepted.push('fastTtlMinutes')
    }
  }

  if (p.fastMaxLines !== undefined) {
    const n = normNumber(p.fastMaxLines, 1, 20)
    if (n == null) rejected.push({ key: 'fastMaxLines', reason: '要落在 1–20 行' })
    else {
      next.fastMaxLines = Math.round(n)
      accepted.push('fastMaxLines')
    }
  }

  if (p.fastMaxChars !== undefined) {
    const n = normNumber(p.fastMaxChars, 80, 2000)
    if (n == null) rejected.push({ key: 'fastMaxChars', reason: '要落在 80–2000 字' })
    else {
      next.fastMaxChars = Math.round(n)
      accepted.push('fastMaxChars')
    }
  }

  return { ok: rejected.length === 0 && accepted.length > 0, overrides: next, accepted, rejected }
}

/**
 * 读文件末尾几行（日志用）。大文件只读尾部 64KB，不会把内存吃掉。
 * 坏文件/不存在一律返回空数组 —— 设置页读不到日志不该变红。
 */
export function tailLines(file, n = 8, maxBytes = 65536) {
  if (!file || !existsSync(file)) return []
  let text = ''
  try {
    const size = statSync(file).size
    if (size <= 0) return []
    const fd = openSync(file, 'r')
    try {
      if (size <= maxBytes) {
        const buf = Buffer.alloc(size)
        readSync(fd, buf, 0, size, 0)
        text = buf.toString('utf8')
      } else {
        const buf = Buffer.alloc(maxBytes)
        readSync(fd, buf, 0, maxBytes, size - maxBytes)
        text = buf.toString('utf8')
        const cut = text.indexOf('\n')
        if (cut >= 0) text = text.slice(cut + 1) // 第一行大概率是半截，丢掉
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  return lines.slice(-Math.max(1, n))
}
