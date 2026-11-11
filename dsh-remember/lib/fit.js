/**
 * ResourceFit —— 中层「激活值」里那一路必须是真的信号。
 *
 * 中层算一条记忆该在多大程度上浮到开头，靠四路归一化信号凸组合：
 * 权重、近期性、ResourceFit、复现次数。这个模块只负责 ResourceFit 这一路，
 * 再拆成三小路：
 *   · scope —— 它讲的东西，是不是就在我现在待的地方；
 *   · path  —— 它讲的那个东西还在不在（真的还在，不是猜的）；
 *   · topic —— 它讲的话，跟刚才真发生过的事对不对得上。
 *
 * 两条硬规矩：
 *   · 不碰文件系统。存在性由调用方注入 exists(absPath) => boolean，
 *     所以这里全是纯函数：同一份输入永远同一个输出，测起来也不用造临时目录。
 *   · 不编分数。没有证据就还中性（0.5），不装作有证据 —— ResourceFit 这一路
 *     要是编出来的，凸组合出来的激活值就只是看起来像那么回事。
 */

export const FIT_AXES = { scope: 0.45, path: 0.25, topic: 0.30 }

// 切分用的边界：空白 + 中文标点 + 常见 ASCII 标点。
// 为什么不含 . 和 : —— 切在它们上面，dsh-body/lib/fast.js 和 同目录的 README.md 就碎了；
// 路径里这两个字符是骨头，交给「尾部清理」处理，不当切分点。
const SEP_RE = /[\s\u3000-\u303f\uff00-\uffef!?,;()\[\]{}"'`]+/

// 句子尾巴上常挂的标点：路径后面跟一个句号，不算路径的一部分。
const TRAIL_RE = /[!?,.;:()\[\]{}"'`。，；：、（）【】《》“”‘’]+$/

// 像文件名的后缀：只有这些结尾的词，即使没斜杠也算「像路径的词」（README.md 就是一条路径）。
const EXT_RE = /\.(js|mjs|json|md|yml|yaml|ts|tsx|py|css|html)$/i

// 中文话题的证据只认汉字（含扩展 A 和兼容区），标点、字母、数字都不算。
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

function asText(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * 从一段文字里挑出「像路径的词」。
 * 为什么这样挑：路径是这条记忆最硬的证据 —— 它指向一个真的地方。
 * 但也不能什么都当路径（普通词没资格指向证据），所以守三条：
 * 含分隔符或像文件名、长度有限、去重且最多留 20 条
 * （再多就不像「这条记忆在讲什么」，像流水账）。
 */
export function extractPaths(text) {
  const raw = asText(text)
  if (!raw) return []
  const out = []
  const seen = new Set()
  for (const piece of raw.split(SEP_RE)) {
    const token = piece.replace(TRAIL_RE, '').trim()
    if (token.length < 2 || token.length > 200) continue
    if (!/[/\\]/.test(token) && !EXT_RE.test(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= 20) break
  }
  return out
}

/** 绝对路径：带盘符（`:\`）或者以 `/` 开头。 */
function isAbsolutePath(p) {
  const s = asText(p)
  return s.includes(':\\') || s.startsWith('/')
}

/**
 * 把相对路径拼到 cwd 底下。
 * 为什么自己拼而不用 path.join：cwd 的分隔符风格得原样留着
 * （E:\ 底下还是 E:\），不然 exists 拿到的路径会变味。
 */
function joinUnder(cwd, rel) {
  const base = asText(cwd).trim()
  const tail = asText(rel).trim()
  if (!base || !tail) return ''
  const sep = base.includes('\\') ? '\\' : '/'
  const left = base.replace(/[\\/]+$/, '')
  const right = tail.replace(/^[\\/]+/, '')
  if (!left) return right
  return `${left}${sep}${right}`
}

/** 路径分段（全小写）：比 startsWith 严谨，`E:\a` 不该匹配 `E:\ab`。 */
function pathSegments(p) {
  return asText(p)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase())
}

/** target 是否落在 base 底下：逐段比，分段不一致就算不在里面。 */
function underBase(target, base) {
  const t = asText(target)
  const b = asText(base).trim()
  if (!t || !b) return false
  if (b === '/' || b === '\\') return t.startsWith('/') || t.startsWith('\\')
  const ts = pathSegments(t)
  const bs = pathSegments(b)
  if (!bs.length || bs.length > ts.length) return false
  for (let i = 0; i < bs.length; i += 1) {
    if (ts[i] !== bs[i]) return false
  }
  return true
}

/** 目录名（basename）：tag 命中目录名时用。 */
function baseName(p) {
  const parts = pathSegments(p)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * scope —— 这条记忆讲的东西，是不是就在我现在待的地方。
 * 为什么分两档：路径落在 cwd/roots 底下是硬证据（1）；
 * 只在 tag 里点了目录名，是软证据（0.5）—— 说过这个目录，不等于就在这个目录里干过活。
 */
export function scopeFit(node, { cwd = '', roots = [] } = {}) {
  if (!node) return 0
  const cwdStr = asText(cwd).trim()
  const bases = []
  for (const r of Array.isArray(roots) ? roots : []) {
    const s = asText(r).trim()
    if (s) bases.push(s)
  }
  if (cwdStr) bases.push(cwdStr)

  let best = 0
  for (const p of extractPaths(node.text)) {
    // 相对路径没有 cwd 就拼不出来 —— 拼不出来就不算证据，不硬猜。
    const target = isAbsolutePath(p) ? p : cwdStr ? joinUnder(cwdStr, p) : ''
    if (!target) continue
    for (const base of bases) {
      if (underBase(target, base)) {
        best = Math.max(best, 1)
        break
      }
    }
  }

  const tags = Array.isArray(node.tags) ? node.tags : []
  for (const tag of tags) {
    const t = asText(tag).trim().toLowerCase()
    if (!t) continue
    for (const base of bases) {
      if (baseName(base) === t) {
        best = Math.max(best, 0.5)
        break
      }
    }
  }
  return best
}

/**
 * path —— 它讲的那个东西还在不在。
 * 存在性只看注入进来的 exists：这里不 stat、不 import fs，文件系统不归这一层管。
 * 没提路径 → 0.5（中性：没提路径不等于路径没了）；提了但问不了 → 同样中性。
 */
export function pathFit(node, { cwd = '', exists } = {}) {
  const cwdStr = asText(cwd).trim()
  const paths = extractPaths(node?.text).slice(0, 5)
  const targets = []
  for (const p of paths) {
    if (isAbsolutePath(p)) targets.push(p)
    else if (cwdStr) targets.push(joinUnder(cwdStr, p))
  }
  if (!targets.length) return 0.5
  if (typeof exists !== 'function') return 0.5
  let hit = 0
  for (const t of targets) {
    if (exists(t)) hit += 1
  }
  return hit / targets.length
}

/** 只留汉字，再切相邻两字的 bigram；不足两字就算一个 gram。 */
function cjkGrams(s) {
  const cjk = asText(s).replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, '')
  if (!cjk) return []
  if (cjk.length < 2) return [cjk]
  const out = []
  for (let i = 0; i + 1 < cjk.length; i += 1) out.push(cjk.slice(i, i + 2))
  return out
}

/**
 * topic —— 它讲的话，跟刚才真发生过的事对不对得上。
 * 为什么用中文 bigram：话题的重合处往往就落在相邻两字上（「分词」「写完」），
 * 按词切还得先分词，分词器反而会把「刚改」「改完」这类说法切碎。
 * 分母取两边较小的 gram 数：短的那边被覆盖得越满，越说明说的是同一件事。
 */
export function topicFit(node, { events = [] } = {}) {
  const tags = Array.isArray(node?.tags) ? node.tags : []
  const nodeGrams = new Set(cjkGrams(`${asText(node?.text)} ${tags.map((t) => asText(t)).join(' ')}`))
  if (!nodeGrams.size) return 0.5

  const list = Array.isArray(events) ? events : []
  let best = 0
  let usable = false
  for (const ev of list) {
    const text = typeof ev === 'string' ? ev : ev && typeof ev === 'object' ? asText(ev.text) : ''
    const evGrams = new Set(cjkGrams(text))
    if (!evGrams.size) continue
    usable = true
    let inter = 0
    for (const g of evGrams) {
      if (nodeGrams.has(g)) inter += 1
    }
    const sim = inter / Math.min(nodeGrams.size, evGrams.size)
    if (sim > best) best = sim
  }
  if (!usable) return 0.5
  return best
}

/**
 * fitOf —— 把三小路按 FIT_AXES 凸组合起来。
 * node 为 null → 全 0（没有东西可算，别拿中性值充数）。
 */
export function fitOf(node, ctx = {}) {
  if (!node) return { fit: 0, scope: 0, path: 0, topic: 0 }
  const scope = clamp01(scopeFit(node, ctx))
  const path = clamp01(pathFit(node, ctx))
  const topic = clamp01(topicFit(node, ctx))
  const fit = clamp01(FIT_AXES.scope * scope + FIT_AXES.path * path + FIT_AXES.topic * topic)
  return { fit, scope, path, topic }
}
