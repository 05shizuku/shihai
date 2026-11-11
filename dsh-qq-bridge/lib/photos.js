/**
 * 照片三件套（v0.7.0）：收图落盘、递话时给本地路径（会话那头能 read_image 真看见）、
 * 回话里 [发图:xxx] 拆出来转成 OneBot 图片段。
 *
 * 存图边界：只存明确交给我的（私聊发我的、群里 @ 我发我的）；
 * 群里没 @ 我的图只留直链在消息流里，我不主动扒群相册。
 * 人像要本人点头 —— 这条纪律比功能重要，别拿「存了方便看」当借口。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 回话里的 [发图:xxx] 标记。半角/全角冒号、半角/全角方括号都认
 * （2026-11-07：表情标记被全角冒号坑过一次，照片的顺手一起修）。 */
export const PHOTO_MARK_RE = /[［\[]\s*发图\s*[:：]\s*([^\]］\r\n]+?)\s*[］\]]/g
/** 单张图上限（字节）—— 8MB，够看图，不够搬视频。 */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024
/** 一条消息最多存几张。 */
export const PHOTO_MAX_PER_MESSAGE = 4
/** 转 base64 兜底时的上限 —— 再大就别试了，协议端自己会噎。 */
export const PHOTO_MAX_BASE64_BYTES = 12 * 1024 * 1024

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
}

/** 回话里的 [发图:xxx] 拆出来，文字里不留痕。 */
export function parsePhotoMarkers(text) {
  const photos = []
  const clean = String(text ?? '').replace(PHOTO_MARK_RE, (_m, src) => {
    const s = String(src ?? '').trim()
    if (s) photos.push(s)
    return ''
  })
  return { text: clean.replace(/[ \t]+$/gm, '').trim(), photos }
}

/** 图段：网络直链用 url，本地路径用 file（OneBot v11 都认）。 */
export function imageSegment(src) {
  const s = String(src ?? '').trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return { type: 'image', data: { url: s } }
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('file://')) {
    return { type: 'image', data: { file: s } }
  }
  return null
}

/** 文字 + 图 → 消息段。 */
export function toSegments(text, photos = []) {
  const segs = []
  const t = String(text ?? '').trim()
  if (t) segs.push({ type: 'text', data: { text: t } })
  for (const src of photos) {
    const seg = imageSegment(src)
    if (seg) segs.push(seg)
  }
  return segs
}

/** 本地图转 base64:// 兜底（有的实现不吃本地路径）。 */
export function inlineBase64Segments(segments, maxBytes = PHOTO_MAX_BASE64_BYTES) {
  return (segments ?? []).map((seg) => {
    if (seg?.type !== 'image') return seg
    const file = seg?.data?.file
    if (!file || /^base64:\/\//i.test(String(file))) return seg
    try {
      const buf = readFileSync(String(file))
      if (buf.length > maxBytes) return seg
      return { type: 'image', data: { file: `base64://${buf.toString('base64')}` } }
    } catch {
      return seg
    }
  })
}

/** 扩展名：先看 content-type，再看链接里的后缀，都没有就当 jpg。 */
export function photoExt(url, contentType = '') {
  const ct = String(contentType).split(';')[0].trim().toLowerCase()
  if (EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct]
  const m = String(url).match(/\.(jpe?g|png|gif|webp|bmp)(?:$|[?#&])/i)
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg')
  return '.jpg'
}

/** 文件名：不许带路径和怪符号。 */
export function safePhotoName(base, ext = '.jpg') {
  const cleaned = String(base ?? '')
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 60)
  const stem = cleaned || 'photo'
  const e = ext && ext.startsWith('.') ? ext : '.jpg'
  return stem.toLowerCase().endsWith(e.toLowerCase()) ? stem : stem + e
}

/**
 * 收图落盘。返回 [{url,path,ok,bytes,error}]，坏链不炸。
 * 只下 http/https 直链；大小超限的记失败，不硬来。
 */
export async function downloadPhotos(images, opts = {}) {
  const {
    dir,
    fetchImpl = globalThis.fetch,
    maxBytes = PHOTO_MAX_BYTES,
    maxCount = PHOTO_MAX_PER_MESSAGE,
    prefix = 'photo'
  } = opts
  const out = []
  const list = (Array.isArray(images) ? images : []).slice(0, Math.max(0, maxCount))
  if (!list.length || !dir) return out
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 建不了目录就当存不下 */
  }
  for (let i = 0; i < list.length; i++) {
    const url = String(list[i]?.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) {
      out.push({ url, ok: false, error: '不是 http 直链' })
      continue
    }
    try {
      const res = await fetchImpl(url)
      if (!res || res.ok === false) {
        out.push({ url, ok: false, error: `HTTP ${res?.status ?? '?'}` })
        continue
      }
      const ct = String(res.headers?.get?.('content-type') ?? '')
      const len = Number(res.headers?.get?.('content-length') ?? 0)
      if (len && len > maxBytes) {
        out.push({ url, ok: false, error: `太大（${len}B）` })
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) {
        out.push({ url, ok: false, error: `太大（${buf.length}B）` })
        continue
      }
      const name = safePhotoName(`${prefix}-${i + 1}`, photoExt(url, ct))
      const path = join(dir, name)
      writeFileSync(path, buf)
      out.push({ url, path, ok: true, bytes: buf.length, contentType: ct })
    } catch (err) {
      out.push({ url, ok: false, error: String(err?.message ?? err) })
    }
  }
  return out
}

/** 存下来的图在递话里留一行本地路径（会话那头能 read_image 打开它）。 */
export function photoLines(saved) {
  const lines = []
  for (const p of saved ?? []) {
    if (p?.ok) lines.push(`\n[图片已存] ${p.path}`)
    else if (p) lines.push(`\n[图片没存下] ${p.error ?? '不知道为啥'}`)
  }
  return lines.join('')
}
