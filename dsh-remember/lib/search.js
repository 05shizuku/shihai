// 检索内核：把「按词翻」从子串撞词升级成 BM25F + 字符 trigram + 口语词对扩展。
//
// 为什么重做：searchNodes 原来是 hay.includes(term) —— 「吃饭」翻不到「吃过中饭了」，
// 同义改述全漏。这里抄大鲸鱼（汐）那套被验证过的路数，四条教训一并抄来：
//  ① df 按文档计数（同文档跨字段只记一次，否则 idf 变负）
//  ② 分词＝中文 bigram（1.0）+ 单字兜底（0.4）+ 英文按词（1.0）+ 带数字的串（1.25）
//  ③ trigram 覆盖率的分母是查询不是正文（dice 会被长文稀释到没意义）
//  ④ 查询扩展最多取 2 个概念、扩展词权重 0.6 —— 扩展是撒网，不是换query
//
// 独立文件、零 import：memory.js 要用本文件，本文件不许回头 import memory（防环）。

const CJK_RUN = /[\u4e00-\u9fff]+/g
const WORD_RUN = /[A-Za-z0-9][A-Za-z0-9._+-]*/g
const NORM_RUN = /[\u4e00-\u9fffA-Za-z0-9]+/g

// 超常用的虚字单字不入索引——兜底单字是给「实字」用的，不是给「的了是在才就都」用的
const STOP_SINGLE = new Set(
  '的了是在有和就不没这那都还很也又被把给跟或我你他她它吗呢吧啊嗯哦呀哇哈才就再又太更最先只让使从到在于'.split(''),
)

/** 一段文字拆成带权词条：中文 bigram(1.0)+单字兜底(0.4)、英文按词(1.0)、含数字串(1.25)。 */
export function splitTerms(text) {
  const out = []
  if (text == null) return out
  const s = String(text)
  for (const m of s.matchAll(WORD_RUN)) {
    const t = m[0].toLowerCase()
    out.push({ t, w: /\d/.test(t) && t.length >= 2 ? 1.25 : 1.0 })
  }
  for (const m of s.matchAll(CJK_RUN)) {
    const run = m[0]
    for (let i = 0; i + 1 < run.length; i++) out.push({ t: run.slice(i, i + 2), w: 1.0 })
    for (const ch of run) if (!STOP_SINGLE.has(ch)) out.push({ t: ch, w: 0.4 })
  }
  return out
}

/** 归一化字符串的字符 trigram 集合（查询与正文同一条路子切）。 */
export function trigrams(text) {
  const grams = new Set()
  if (!text) return grams
  const s = String(text).match(NORM_RUN)?.join('') ?? ''
  for (let i = 0; i + 2 < s.length; i++) grams.add(s.slice(i, i + 3))
  return grams
}

// 同义改述对表：一行 = 一组同义说法（口语 ↔ 书面 ↔ 俗话）。
// 查询里出现组内任意一个，就把同组其它说法以 0.6 权重撒进候选 —— 同义说法互相命中。
// 从真语料慢慢养，别一次塞满——每条都得是「真有人说」的换法。
//
// 纯数据表：人能读能改，改完不用懂代码。坏值（不是数组 / 空串 / 非字符串）自动跳过，
// 不崩、不误伤——那一行就当没写。
export const QUERY_PAIRS = [
  // —— 身体词：吃饭、困、心情 ——
  ['吃饭', '添饭'], ['吃饭', '吃过'], ['吃饭', '用膳'],
  ['困', '累'], ['困', '撑不住'], ['累', '撑不住'],
  ['开心', '高兴'], ['生气', '恼火'], ['难过', '伤心'],

  // —— 手上的活：记得、改、备份、找 ——
  ['记得', '记住'], ['修正', '修复'], ['修正', '改'],
  ['备份', '回档'], ['备份', '快照'],
  ['找', '翻'], ['搜索', '检索'], ['搜索', '查'],
  ['协议端', 'SnowLuma'], ['桥', 'bridge'],
  ['表扬', '夸'], ['教', '纠'],

  // —— 这本账自己的词：记忆、账本、群、程序、卡住、隔离、验收、情绪、聊天记录 ——
  ['记忆', '记性', '脑子里存着的'],
  ['账本', '账', '记账', '记事'],
  ['群聊', '群里', '群'],
  ['程序', '程序儿', '代码', '写的东西'],
  ['卡住', '挂着', '不动了'],
  ['隔离', '隔开', '不碰'],
  ['验收', '查账', '对账'],
  ['情绪', '心情'],
  ['聊天记录', '会话记录'],

  // —— 说清一件事的其它说法 ——
  ['记下来', '记下', '写下来'],
  ['记错', '写错'],
  ['忘了', '想不起来', '记不起'],
  ['认账', '算数', '作数'],
  ['分量', '份量'],
  ['重载', '热重载', '热更'],
  ['重启', '重起'],
  ['宿主', 'host'],
  ['冒烟', '烟测', 'smoke'],
  ['单测', '单元测试', 'unittest'],

  // —— 聊天里那些动作的说法（意图层那 11 类也用这些词）——
  ['顶嘴', '吵架', '拌嘴'],
  ['认同', '同意', '点头'],
  ['分享', '发我'],
  ['告别', '拜拜', '下线'],
  ['招呼', '打招呼', '在吗'],
  ['问我', '问', '打听'],
  ['教我', '教', '教一下', '指点'],
  ['夸我', '夸', '夸赞'],

  // —— 缓存这一仗留下的词（2026-11-10 养厚）——
  ['缓存', 'cache', '命中'],
  ['重锚', 'reanchor'],
  ['补丁', 'patch'],
  ['上线', '装上', '生效', '上岗'],
  ['回滚', '还原', '退回去'],
  ['锁死', '卡死'],
  ['归档', '留档', '收档'],

  // —— 桥上的话怎么走 ——
  ['图片', '照片', '发图'],
  ['表情包', '表情'],
  ['侧门', '私发', '直接发'],
  ['回话', '回复'],
  ['挂起', '认领', '接上'],
  ['没收到', '没到', '没发过来', '丢了'],

  // —— amikar 家里那套 ——
  ['正本', '原件'],
  ['镜像', '抄本', '副本'],
  ['影子账', '影子'],
  ['心跳', '常驻'],
  ['体检', '自检'],
  ['搬家', '拷目录', '演练'],
  ['看门狗', 'watchdog'],

  // —— 说事的其它说法 ——
  ['授权', '点头', '批准'],
  ['只读', '别动'],
  ['配置', '设置'],
  ['端口', '网页地址'],
  ['报数', '报账', '量出来'],
]

// 英文/数字词（如 SnowLuma、host）：按词整体进索引，小写化。
const ASCII_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/** 一个说法切成「能落进索引的单元」：英文按词、中文 1 字按字、2 字按 bigram、3 字以上按 bigram 串。 */
function memberUnits(member) {
  if (typeof member !== 'string') return []
  const units = []
  for (const part of member.trim().split(/\s+/)) {
    if (!part) continue
    if (ASCII_WORD.test(part)) { units.push(part.toLowerCase()); continue }
    if (part.length === 1) { units.push(part); continue }
    for (let i = 0; i + 1 < part.length; i++) units.push(part.slice(i, i + 2))
  }
  return units
}

/** 这个说法是不是在查询里出现了：它的单元得全在才算（长说法要求整句在，不能靠一个字蒙对）。 */
function memberHit(member, have) {
  const units = memberUnits(member)
  if (!units.length) return false
  return units.every((u) => have.has(u))
}

/** 往查询里补的单元：中文只补头两个字（够认出「写的东西」这类说法，又不拿一串 bigram 撒网）。 */
function memberAdds(member) {
  if (typeof member !== 'string') return []
  const out = []
  for (const part of member.trim().split(/\s+/)) {
    if (!part) continue
    if (ASCII_WORD.test(part)) { out.push(part.toLowerCase()); continue }
    out.push(part.slice(0, 2))
  }
  return out
}

/** 表里坏值不认：不是数组、或者凑不出两个像样的说法，整行跳过（就当那行没写）。 */
function validGroups(table) {
  if (!Array.isArray(table)) return []
  const groups = []
  for (const row of table) {
    if (!Array.isArray(row)) continue
    const members = []
    for (const raw of row) {
      if (typeof raw !== 'string') continue
      const s = raw.trim()
      if (!s || members.includes(s)) continue
      members.push(s)
    }
    if (members.length < 2) continue
    groups.push(members)
  }
  return groups
}

/** 查询扩展：命中同义组的其它说法以 0.6 权重补进词条，最多 2 个概念（一组算一个概念）。 */
export function expandQuery(terms) {
  const base = Array.isArray(terms)
    ? terms.filter((x) => x && typeof x.t === 'string' && x.t)
    : []
  const have = new Set(base.map((x) => x.t))
  const out = base.slice()
  let concepts = 0
  for (const group of validGroups(QUERY_PAIRS)) {
    if (concepts >= 2) break
    if (!group.some((m) => memberHit(m, have))) continue
    const adds = []
    for (const m of group) {
      for (const u of memberAdds(m)) {
        if (have.has(u) || adds.includes(u)) continue
        adds.push(u)
      }
    }
    if (!adds.length) continue
    for (const t of adds) {
      out.push({ t, w: 0.6 })
      have.add(t)
    }
    concepts += 1
  }
  return out
}

// 检索字段与权重：tags/情境比正文贵 —— 标签里唯一一次的命中不该被长正文稀释。
const FIELDS = [
  ['text', 1.0],
  ['tags', 1.4],
  ['context', 1.3],
  ['changes', 1.2],
  ['conflicts', 1.2],
  ['willDo', 1.2],
  ['skillWhere', 1.2],
  ['kindLabel', 0.8],
]

function fieldText(node, field) {
  if (field === 'tags') return (Array.isArray(node.tags) ? node.tags : []).join(' ')
  if (field === 'skillWhere') {
    return (Array.isArray(node.contexts) ? node.contexts : []).map((c) => c?.where ?? '').join(' ')
  }
  if (field === 'kindLabel') return node.kind ?? ''
  return node[field] ?? ''
}

function buildDoc(node) {
  const doc = { lens: {}, tfs: {} }
  for (const [field] of FIELDS) {
    const terms = splitTerms(fieldText(node, field))
    doc.lens[field] = terms.length
    const tf = new Map()
    for (const { t, w } of terms) tf.set(t, (tf.get(t) ?? 0) + w)
    doc.tfs[field] = tf
  }
  doc.grams = trigrams([fieldText(node, 'text'), fieldText(node, 'context'), fieldText(node, 'tags')].join(' '))
  return doc
}

const clamp01 = (x) => Math.max(0, Math.min(1, x))

/** 搜索的入选门槛：低于它的相关度当没翻到（兜底单字会带进「沾一个字」的假命中）。 */
export const MIN_RELEVANCE = 0.12

/**
 * 对一批节点按 query 打相关度，返回 Map<node, {relevance, bm25, trigram}>。
 * relevance ∈ [0,1]：0.6×BM25F(按结果集最大值归一) + 0.25×trigram覆盖率。
 * 完全没有词条命中的节点不在 Map 里 —— 「翻不到」仍然是翻不到，不是排后面。
 */
export function rankByQuery(nodes, query, { k1 = 1.2, b = 0.75, expand = true } = {}) {
  let qTerms = splitTerms(query)
  if (expand) qTerms = expandQuery(qTerms)
  const result = new Map()
  if (!qTerms.length || !Array.isArray(nodes) || nodes.length === 0) return result

  const docs = nodes.map((n) => buildDoc(n))
  const N = docs.length

  // df 按文档计数：一个词在一份文档的几个字段出现都只记 1（教训②）
  const df = new Map()
  const avgLen = {}
  for (const [field] of FIELDS) avgLen[field] = 0
  docs.forEach((doc, i) => {
    const seen = new Set()
    for (const [field] of FIELDS) {
      avgLen[field] += doc.lens[field]
      for (const t of doc.tfs[field].keys()) seen.add(t)
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
  })
  for (const [field] of FIELDS) avgLen[field] = Math.max(1e-9, avgLen[field] / N)

  const idf = (t) => {
    const d = df.get(t) ?? 0
    return Math.log(1 + (N - d + 0.5) / (d + 0.5)) // 恒正（教训①）
  }

  // 每份文档：BM25F 分数 + trigram 覆盖率
  const bm = new Array(N).fill(0)
  const cov = new Array(N).fill(0)
  const qg = trigrams(query)
  docs.forEach((doc, i) => {
    let s = 0
    for (const { t, w: qw } of qTerms) {
      const w_idf = idf(t) * qw
      if (w_idf <= 0) continue
      for (const [field, wField] of FIELDS) {
        const tf = doc.tfs[field].get(t) ?? 0
        if (tf <= 0) continue
        const norm = 1 - b + b * (doc.lens[field] / avgLen[field])
        s += wField * w_idf * ((tf * (k1 + 1)) / (tf + k1 * norm))
      }
    }
    bm[i] = s
    if (qg.size) {
      let hit = 0
      for (const g of qg) if (doc.grams.has(g)) hit += 1
      cov[i] = hit / qg.size // 分母是查询（教训③）
    }
  })

  const maxBm = Math.max(...bm, 0)
  docs.forEach((doc, i) => {
    if (bm[i] <= 0) return
    const bmNorm = maxBm > 0 ? bm[i] / maxBm : 0
    const relevance = clamp01(0.6 * bmNorm + 0.25 * cov[i])
    if (relevance <= 0) return
    result.set(nodes[i], { relevance: Number(relevance.toFixed(4)), bm25: Number(bmNorm.toFixed(4)), trigram: Number(cov[i].toFixed(4)) })
  })
  return result
}
