/**
 * lib/scope.js —— 会话隔离的栅栏（对齐 dsh-body / dsh-remember 的三把钥匙）。
 *
 * 判定顺序（跟 dsh-body 一致：先隔离、后放行）：
 *   ① denyRoots —— 黑名单，命中就拦，优先于一切放行；
 *   ② allowRoots —— 显式白名单，填了就只放行名单里的（targetRoot 不再兼职）；
 *   ③ targetRoot —— 兜底放行根；留空 = 不按路径收窄。
 *
 * 栅栏只管数据文件：seen.json / pending.json / bridge.log(.1) / messages-*.jsonl。
 * config.json 豁免 —— 栅栏键自己就住在里面，把它也锁外面就读不到钥匙了。
 */

import { resolve, sep } from 'node:path'

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

/** 把配置里的一个根列表洗干净：只留非空字符串。数字/对象/null 一律丢掉，不抛。
 *  返回的是洗过的原样字符串（不归一路径）——比较时 isUnder 会各自 normPath。 */
export function normalizeRoots(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * scopeOk(file, gates) → { ok, why }
 * gates = { targetRoot, allowRoots, denyRoots }（值可以没洗，这里再洗一遍也不亏）
 * 路径容错交给 normPath/isUnder：大小写（win32）、正反斜杠、尾斜杠都认。
 */
export function scopeOk(file, gates = {}) {
  const deny = normalizeRoots(gates.denyRoots)
  for (const d of deny) {
    if (isUnder(file, d)) return { ok: false, why: `denyRoots 命中 ${d}` }
  }
  const allow = normalizeRoots(gates.allowRoots)
  if (allow.length) {
    return allow.some((a) => isUnder(file, a))
      ? { ok: true, why: 'allowRoots 放行' }
      : { ok: false, why: '不在 allowRoots 名单里' }
  }
  const target = String(gates.targetRoot ?? '').trim()
  if (target) {
    return isUnder(file, target)
      ? { ok: true, why: 'targetRoot 放行' }
      : { ok: false, why: `不在 targetRoot（${target}）之下` }
  }
  return { ok: true, why: '未收窄' }
}
