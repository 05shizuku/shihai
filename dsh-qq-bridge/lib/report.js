/**
 * lib/report.js —— 桥配置的白名单校验（对齐 dsh-body/lib/report.js 的口径）。
 *
 * 设置页 POST /dsh-qq-bridge/config 的正文先过这里：白名单外的键不认，
 * 坏值不写盘、给出 reason；数值越界按边界收。返回 { ok, accepted, rejected, overrides }。
 * overrides 只收「这回真的改了的键」，调用方把它合并写回 config.json。
 */

/** 键 → 校验器；返回 { value } = 收下，{ reason } = 拒收 */
export const VALIDATORS = {
  enabled: (v) => (typeof v === 'boolean' ? { value: v } : { reason: '要是 true/false' }),

  onebotHttp: (v) => {
    const s = String(v ?? '').trim()
    if (!/^https?:\/\//.test(s)) return { reason: '要 http(s):// 开头的地址' }
    return { value: s }
  },
  onebotWs: (v) => {
    const s = String(v ?? '').trim()
    if (s && !/^wss?:\/\//.test(s)) return { reason: '要 ws(s):// 开头的地址' }
    return { value: s }
  },
  httpToken: (v) => ({ value: String(v ?? '').trim() }),
  wsToken: (v) => ({ value: String(v ?? '').trim() }),
  selfUin: (v) => {
    const s = String(v ?? '').trim()
    if (s && !/^\d+$/.test(s)) return { reason: '只能是数字 QQ 号（或留空）' }
    return { value: s }
  },
  sessionId: (v) => ({ value: String(v ?? '').trim() }),
  promptPrefix: (v) => {
    const s = String(v ?? '')
    if (!s.trim()) return { reason: '不能是空的（认「这轮是替 QQ 回的」全靠它）' }
    if ([...s].length > 20) return { reason: '最长 20 个字' }
    return { value: s }
  },

  allowUsers: listVal,
  allowGroups: listVal,

  pokeBack: (v) => (typeof v === 'boolean' ? { value: v } : { reason: '要是 true/false' }),
  replyMaxChars: intBetween(1, 2000, 500),
  staleSeconds: intBetween(30, 86400, 300),

  messageLogEnabled: (v) => (typeof v === 'boolean' ? { value: v } : { reason: '要是 true/false' }),
  messageLogMaxLines: intBetween(100, 100000, 2000),

  // 表情包标记（v0.8.0）：回话里的 [表情:名字] 能不能变真图片段发出去
  stickerEnabled: (v) => (typeof v === 'boolean' ? { value: v } : { reason: '要是 true/false' }),

  targetRoot: (v) => ({ value: String(v ?? '').trim() }),
  allowRoots: listVal,
  denyRoots: listVal,
}

/** 号码/路径那一类：数组，元素转成非空字符串，坏的丢掉 */
function listVal(v) {
  if (v == null) return { value: [] }
  if (!Array.isArray(v)) return { reason: '要是数组' }
  const out = v
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  return { value: out }
}

function intBetween(lo, hi, dflt) {
  return (v) => {
    const n = Math.floor(Number(v))
    if (!Number.isFinite(n)) return { value: dflt, clamped: `坏值，按 ${dflt} 算` }
    if (n < lo) return { value: lo, clamped: `太小，按下限 ${lo} 算` }
    if (n > hi) return { value: hi, clamped: `太大，按上限 ${hi} 算` }
    return { value: n }
  }
}

/**
 * applyConfigPatch({ overrides, effective, patch })
 * - overrides：现在 config.json 里那一份（只装「设置页改过的键」）
 * - effective：现在真正生效的那一份（DEFAULTS + profile + overrides）
 * - patch：设置页递来的正文
 * 收下的键写进 overrides；拒收的进 rejected（带 reason）；越界的收下但带 clamped 提示。
 */
export function applyConfigPatch({ overrides = {}, patch = {} } = {}) {
  const base = overrides && typeof overrides === 'object' ? { ...overrides } : {}
  const body = patch && typeof patch === 'object' ? patch : {}
  const accepted = []
  const rejected = []
  for (const [key, validate] of Object.entries(VALIDATORS)) {
    if (!(key in body)) continue
    const r = validate(body[key])
    if (r.reason) {
      rejected.push({ key, reason: r.reason })
      continue
    }
    base[key] = r.value
    accepted.push(r.clamped ? `${key}（${r.clamped}）` : key)
  }
  for (const key of Object.keys(body)) {
    if (!(key in VALIDATORS)) rejected.push({ key, reason: '白名单外的键，不认' })
  }
  return { ok: rejected.length === 0, accepted, rejected, overrides: base }
}
