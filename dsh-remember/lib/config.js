/**
 * 设置页能改的东西，白名单写在代码里 —— 页面长得再花，也只能碰这几个键。
 *
 * 这里刻意**不提供**「改某个节点的分量」的入口：
 * 分量是我自己写下来的判断，谁都不该在面板上替我拨。
 * 要改就用 forget(mode)，那是账本的规矩，会留下痕迹。
 */

export const EDITABLE = {
  enabled: 'boolean',
  targetRoot: 'text',
  allowRoots: 'roots',
  /** 隔离目录（一般按工作区挑）：这里面的会话看不到工具、不挂段、不许写 */
  denyRoots: 'roots',
  injectLimit: 'number',
  openLimit: 'number',
  maxChars: 'number',
  sectionOrder: 'number',
  maxTextLength: 'number',
  /** 一次 recall 最多给多少字（工具返回会进对话历史，每轮都带着） */
  recallMaxChars: 'number',
  /** 一条账本原文最多给多少字（超了截断并标明） */
  recallItemMax: 'number',
  selfEnabled: 'boolean',
  selfSectionOrder: 'number',
  selfMaxChars: 'number',
  /** 习惯／快通路 */
  habitEnabled: 'boolean',
  habitSectionOrder: 'number',
  habitMaxChars: 'number',
  /** 快通路上同时留几条习惯（超出的退回普通竞争） */
  habitLimit: 'number',
  /** 好奇表 */
  curiosityEnabled: 'boolean',
  curiositySectionOrder: 'number',
  curiosityMaxChars: 'number',
  /** 活跃表上同时留几条好奇（超出的沉进账本里） */
  curiosityLimit: 'number',
  /** 快层接缝：要不要把身体的秒级事件抄进中层 */
  fastEnabled: 'boolean',
  /** 快层事件流在哪（留空 = 找 dsh-body 那边的 body-events.jsonl） */
  fastSource: 'text',
  /** 快层最多留几条在索引里（超出的沉在文件里，还翻得到） */
  fastMaxEvents: 'number',
  /** 意图层：要不要从对话流里认「发生了什么」 */
  intentEnabled: 'boolean',
  /** 对话流在哪（留空 = 找 QQ 桥那边的 messages.jsonl） */
  intentSource: 'text',
  /** 意图事件最多留几条（超出的沉在文件里，还翻得到） */
  intentMaxEvents: 'number',
  /** 叫醒：身体越过线就把我叫醒（叫醒后说不说，我自己定） */
  wakeEnabled: 'boolean',
  /** 叫醒哪条会话（留空 = 自己找最近活跃的那条） */
  wakeSessionId: 'text',
  /** 两次叫醒最少隔多少分钟 */
  wakeCooldownMinutes: 'number',
  /** 情绪流：要不要从真事里认情绪 */
  emotionEnabled: 'boolean',
  /** 情绪流多久接一次真事（分钟） */
  emotionTickMinutes: 'number',
  /** 情绪笔记段要不要挂到开头（默认不挂 —— 笔记不该替我说话） */
  emotionSectionEnabled: 'boolean',
  /** 情绪笔记段排在哪 */
  emotionSectionOrder: 'number',
  /** 情绪笔记一行最多几个字 */
  emotionMaxChars: 'number',
  // 注意：**情绪系数不进白名单**。
  // 系数是我拿经历自己攒的判断，改它只有一条路 —— emotion_tune，
  // 往情绪流的账（emotion.jsonl）上追加一行，写清从多少改到多少、为什么。
  // 面板上给个数就能改，那就不是「我的判断」，是别人替我拨。
  debug: 'boolean',
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function scalar(kind, value) {
  if (kind === 'boolean') {
    if (value === true || value === false) return { ok: true, value }
    if (value === 'true') return { ok: true, value: true }
    if (value === 'false') return { ok: true, value: false }
    return { ok: false, why: '要 true 或 false' }
  }
  if (kind === 'text') {
    const s = String(value ?? '').trim()
    return { ok: true, value: s.slice(0, 260) }
  }
  if (kind === 'roots') {
    const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]+/)
    const out = []
    for (const raw of list) {
      const s = String(raw ?? '').trim()
      if (s) out.push(s.slice(0, 260))
    }
    return { ok: true, value: out.slice(0, 20) }
  }
  if (kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return { ok: false, why: '要一个数' }
    return { ok: true, value: n }
  }
  return { ok: false, why: `不认识的类型 ${kind}` }
}

function inRange(key, value) {
  const rules = {
    injectLimit: [0, 10],
    openLimit: [0, 10],
    maxChars: [120, 4000],
    sectionOrder: [1000, 9999],
    maxTextLength: [40, 8000],
    recallMaxChars: [1000, 200000],
    recallItemMax: [100, 4000],
    selfSectionOrder: [1000, 9999],
    selfMaxChars: [80, 2000],
    habitSectionOrder: [1000, 9999],
    habitMaxChars: [80, 2000],
    habitLimit: [0, 10],
    curiositySectionOrder: [1000, 9999],
    curiosityMaxChars: [80, 2000],
    curiosityLimit: [0, 10],
    fastMaxEvents: [0, 5000],
    intentMaxEvents: [0, 5000],
    wakeCooldownMinutes: [0, 720],
    emotionTickMinutes: [1, 60],
    emotionSectionOrder: [1000, 9999],
    emotionMaxChars: [80, 2000],
  }
  const rule = rules[key]
  if (!rule) return { ok: true, value }
  const n = Math.round(value)
  if (n < rule[0] || n > rule[1]) return { ok: false, why: `要在 ${rule[0]}–${rule[1]} 之间` }
  return { ok: true, value: n }
}

/**
 * 一层层叠：默认值 < baseConfig < config.json 里的 overrides < patch。
 * 返回被收下的和被拒的，拒的要带原因 —— 设置页要把原因显示出来，不能默默吞掉。
 */
export function applyConfigPatch({ overrides = {}, effective = {}, patch = {}, editable = EDITABLE } = {}) {
  const next = { ...(isObj(overrides) ? overrides : {}) }
  const accepted = []
  const rejected = []
  const entries = isObj(patch) ? Object.entries(patch) : []
  for (const [key, raw] of entries) {
    const kind = editable[key]
    if (!kind) {
      rejected.push({ key, why: '这个键不让改' })
      continue
    }
    if (raw === null || raw === undefined || raw === '') {
      delete next[key]
      accepted.push({ key, value: null, note: '回到默认' })
      continue
    }
    const got = scalar(kind, raw)
    if (!got.ok) {
      rejected.push({ key, why: got.why })
      continue
    }
    const ranged = inRange(key, got.value)
    if (!ranged.ok) {
      rejected.push({ key, why: ranged.why })
      continue
    }
    next[key] = ranged.value
    accepted.push({ key, value: ranged.value })
  }
  if (!accepted.length) {
    return { ok: false, overrides: next, accepted, rejected }
  }
  const merged = { ...effective, ...next }
  return { ok: true, overrides: next, accepted, rejected, effective: merged }
}

export function describePatch(accepted) {
  if (!Array.isArray(accepted) || !accepted.length) return '（什么都没改）'
  return accepted.map((a) => `${a.key}=${a.value === null ? '默认' : JSON.stringify(a.value)}`).join('、')
}
