import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PHOTO_MARK_RE,
  downloadPhotos,
  imageSegment,
  inlineBase64Segments,
  parsePhotoMarkers,
  photoExt,
  photoLines,
  safePhotoName,
  toSegments
} from '../lib/photos.js'

test('parsePhotoMarkers 把 [发图:xxx] 拆出来，文字里不留痕', () => {
  const out = parsePhotoMarkers('看这个 [发图:E:\\a\\b.jpg] 好看吗')
  assert.equal(out.photos.length, 1)
  assert.equal(out.photos[0], 'E:\\a\\b.jpg')
  assert.equal(out.text, '看这个  好看吗')
})

test('parsePhotoMarkers 多个标记、空标记、没有标记', () => {
  const two = parsePhotoMarkers('[发图:https://x/a.png]和[发图:https://x/b.png]')
  assert.deepEqual(two.photos, ['https://x/a.png', 'https://x/b.png'])
  assert.equal(two.text, '和')
  assert.deepEqual(parsePhotoMarkers('空 [发图:] 标记').photos, [])
  assert.deepEqual(parsePhotoMarkers('没有标记').photos, [])
  assert.equal(parsePhotoMarkers('没有标记').text, '没有标记')
  assert.equal(parsePhotoMarkers(undefined).text, '')
})

test('imageSegment 直链走 url，本地路径走 file，认不出的不给', () => {
  assert.deepEqual(imageSegment('https://x/a.png'), { type: 'image', data: { url: 'https://x/a.png' } })
  assert.deepEqual(imageSegment('E:\\pics\\a.png'), { type: 'image', data: { file: 'E:\\pics\\a.png' } })
  assert.deepEqual(imageSegment('/tmp/a.png'), { type: 'image', data: { file: '/tmp/a.png' } })
  assert.equal(imageSegment('不是路径'), null)
  assert.equal(imageSegment(''), null)
})

test('toSegments 文字在前图在后，空文字不占段', () => {
  const segs = toSegments('在这儿', ['https://x/a.png'])
  assert.equal(segs.length, 2)
  assert.deepEqual(segs[0], { type: 'text', data: { text: '在这儿' } })
  assert.equal(segs[1].type, 'image')
  assert.deepEqual(toSegments('', ['https://x/a.png']), [{ type: 'image', data: { url: 'https://x/a.png' } }])
  assert.deepEqual(toSegments('只有字', []), [{ type: 'text', data: { text: '只有字' } }])
})

test('photoExt 先看 content-type 再看后缀，都没有就 jpg', () => {
  assert.equal(photoExt('https://x/a', 'image/png; charset=x'), '.png')
  assert.equal(photoExt('https://x/a.png?rkey=1'), '.png')
  assert.equal(photoExt('https://x/a.jpeg'), '.jpg')
  assert.equal(photoExt('https://x/a'), '.jpg')
})

test('safePhotoName 去掉路径和怪符号', () => {
  assert.equal(safePhotoName('p-1', '.jpg'), 'p-1.jpg')
  assert.equal(safePhotoName('p-1.jpg', '.jpg'), 'p-1.jpg')
  assert.equal(safePhotoName('../../evil', '.png'), 'evil.png')
  assert.equal(safePhotoName('', '.png'), 'photo.png')
})

test('downloadPhotos 下图落盘，坏链和超大的记失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amikar-photos-'))
  try {
    const fakeFetch = async (url) => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
    })
    const saved = await downloadPhotos([{ url: 'https://x/a.png' }], { dir, fetchImpl: fakeFetch, prefix: 'g-1' })
    assert.equal(saved.length, 1)
    assert.equal(saved[0].ok, true)
    assert.equal(saved[0].bytes, 4)
    assert.ok(existsSync(saved[0].path))
    assert.ok(saved[0].path.endsWith('.png'))

    const bad = await downloadPhotos([{ url: 'not-http' }], { dir, fetchImpl: fakeFetch })
    assert.equal(bad[0].ok, false)
    assert.match(bad[0].error, /http/)

    const tooBig = await downloadPhotos([{ url: 'https://x/b.png' }], { dir, fetchImpl: fakeFetch, maxBytes: 2 })
    assert.equal(tooBig[0].ok, false)
    assert.match(tooBig[0].error, /太大/)

    const none = await downloadPhotos([], { dir, fetchImpl: fakeFetch })
    assert.deepEqual(none, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadPhotos 一条消息最多存 maxCount 张', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amikar-photos-'))
  try {
    let n = 0
    const fakeFetch = async () => {
      n++
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([1]).buffer
      }
    }
    const saved = await downloadPhotos([{ url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' }, { url: 'https://x/3.jpg' }], { dir, fetchImpl: fakeFetch, maxCount: 2 })
    assert.equal(saved.length, 2)
    assert.equal(n, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('photoLines 存的和没存的分开说', () => {
  const lines = photoLines([
    { ok: true, path: 'E:\\photos\\g-1-1.png' },
    { ok: false, error: 'HTTP 404' }
  ])
  assert.match(lines, /\[图片已存\] E:\\photos\\g-1-1\.png/)
  assert.match(lines, /\[图片没存下\] HTTP 404/)
  assert.equal(photoLines([]), '')
})

test('inlineBase64Segments 本地图转 base64://，读不到就不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amikar-b64-'))
  try {
    const p = join(dir, 'a.png')
    writeFileSync(p, Buffer.from([1, 2, 3]))
    const out = inlineBase64Segments([{ type: 'image', data: { file: p } }])
    assert.match(out[0].data.file, /^base64:\/\//)
    const missing = inlineBase64Segments([{ type: 'image', data: { file: join(dir, 'no.png') } }])
    assert.equal(missing[0].data.file, join(dir, 'no.png'))
    const url = inlineBase64Segments([{ type: 'image', data: { url: 'https://x/a.png' } }])
    assert.equal(url[0].data.url, 'https://x/a.png')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PHOTO_MARK_RE 只认 [发图:...]，别把普通方括号吃了', () => {
  assert.equal(PHOTO_MARK_RE.test('没有标记'), false)
  assert.equal(PHOTO_MARK_RE.test('[发图:https://x/a.png]'), true)
})
