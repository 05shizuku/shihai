/**
 * ResourceFit（scope / path / topic）这一路的单测。
 *
 * 全是纯函数：不碰文件系统，存在性由假的 exists 注入，事件是手写的字。
 * 所以这里不需要临时目录，也不需要清理，跑多快都不会弄脏机器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FIT_AXES,
  extractPaths,
  fitOf,
  pathFit,
  scopeFit,
  topicFit,
} from '../lib/fit.js'

test('extractPaths：挑出像路径的词，丢掉普通词和尾标点', () => {
  const text = '改了 dsh-body/lib/fast.js 和 E:\\示例\\Plugin\\README.md，没有路径，别的 E:\\a\\b.js。'
  const got = extractPaths(text)
  assert.ok(got.includes('dsh-body/lib/fast.js'), '相对路径要挑出来')
  assert.ok(got.includes('E:\\示例\\Plugin\\README.md'), '带盘符的绝对路径要挑出来')
  assert.ok(got.includes('E:\\a\\b.js'), '句号后面的路径也要挑出来')
  assert.ok(!got.includes('没有路径'), '普通词不算路径')
  assert.ok(!got.includes('别的'), '普通词不算路径')
  assert.ok(!got.includes('改了'), '普通词不算路径')
})

test('extractPaths：去重、甩掉尾部标点、只看后缀也认', () => {
  const got = extractPaths('a/b.js 和 a/b.js；再看 README.md。')
  assert.deepEqual(got, ['a/b.js', 'README.md'])
  assert.deepEqual(extractPaths('看 dsh-body/lib/fast.js.'), ['dsh-body/lib/fast.js'])
  assert.deepEqual(extractPaths('看 dsh-body/lib/fast.js,'), ['dsh-body/lib/fast.js'])
  assert.deepEqual(extractPaths('没有路径'), [])
  assert.deepEqual(extractPaths(''), [])
  assert.deepEqual(extractPaths(null), [])
})

test('extractPaths：长度门槛和最多 20 条', () => {
  const long = `${'x'.repeat(199)}.js` // 203 个字符，太长
  assert.deepEqual(extractPaths(long), [])
  const many = Array.from({ length: 30 }, (_, i) => `dir/f${i}.js`).join(' ')
  const got = extractPaths(many)
  assert.equal(got.length, 20)
  assert.equal(got[0], 'dir/f0.js')
})

test('scopeFit：相对路径在 cwd 下 → 1；在别的目录 → 0', () => {
  const node = { text: '改了 lib/fit.js' }
  // 相对路径拼到 cwd 底下，落在 cwd 里
  assert.equal(scopeFit(node, { cwd: 'E:\\work' }), 1)
  // 没有 cwd，相对路径拼不出来，就不算证据
  assert.equal(scopeFit(node, { roots: ['E:\\work'] }), 0)
  // 绝对路径指着别处 → 不在我待的地方
  assert.equal(scopeFit({ text: '改了 E:\\other\\lib\\fit.js' }, { cwd: 'E:\\work' }), 0)
  // 绝对路径落在 roots 底下 → 1
  assert.equal(scopeFit({ text: '改了 E:\\work\\lib\\fit.js' }, { roots: ['E:\\work'] }), 1)
  // 大小写不敏感（Windows 上路径本来就不分大小写）
  assert.equal(scopeFit({ text: '改了 e:\\work\\lib\\fit.js' }, { cwd: 'E:\\work' }), 1)
})

test('scopeFit：分段比较，E:\\ab 不算在 E:\\a 底下', () => {
  const node = { text: 'E:\\ab\\lib\\fit.js' }
  assert.equal(scopeFit(node, { roots: ['E:\\a'] }), 0, 'E:\\ab 不是 E:\\a 的子目录')
  assert.equal(scopeFit(node, { roots: ['E:\\ab'] }), 1)
  assert.equal(scopeFit(node, { roots: ['E:\\a'] }), 0, 'E:\\a 也不该匹配 E:\\ab')
})

test('scopeFit：tag 命中目录名 → 0.5', () => {
  const node = { text: 'Plugin 这个目录', tags: ['Plugin'] }
  assert.equal(scopeFit(node, { roots: ['E:\\示例\\Plugin'] }), 0.5)
  assert.equal(scopeFit(node, { cwd: 'E:\\示例\\Plugin' }), 0.5)
  assert.equal(scopeFit({ text: '别的目录', tags: ['Other'] }, { roots: ['E:\\示例\\Plugin'] }), 0)
  // 路径命中（1）比 tag 命中（0.5）重
  const both = { text: 'E:\\示例\\Plugin\\lib\\fit.js', tags: ['Plugin'] }
  assert.equal(scopeFit(both, { roots: ['E:\\示例\\Plugin'] }), 1)
})

test('pathFit：存在的条数占比；没提路径 → 0.5', () => {
  const node = { text: 'a/one.js b/two.js c/three.js' }
  const seen = []
  const got = pathFit(node, {
    cwd: 'E:\\work',
    exists: (p) => {
      seen.push(p)
      return p.endsWith('one.js')
    },
  })
  assert.equal(got, 1 / 3)
  assert.equal(seen.length, 3)
  assert.ok(seen[0].startsWith('E:\\work'), '相对路径要先拼到 cwd 底下')
  assert.equal(pathFit({ text: '只是说说' }, { cwd: 'E:\\work', exists: () => true }), 0.5)
})

test('pathFit：没有 cwd 的相对路径直接跳过，不去问 exists', () => {
  let called = 0
  const got = pathFit(
    { text: 'lib/fit.js' },
    {
      exists: () => {
        called += 1
        return true
      },
    },
  )
  assert.equal(got, 0.5)
  assert.equal(called, 0, '拼不出来的路径不该拿去过问存在性')
})

test('pathFit：绝对路径直接问 exists，最多看 5 条', () => {
  const seen = []
  const node = { text: 'a/1.js b/2.js c/3.js d/4.js e/5.js f/6.js g/7.js' }
  const got = pathFit(node, {
    cwd: 'E:\\work',
    exists: (p) => {
      seen.push(p)
      return true
    },
  })
  assert.equal(seen.length, 5, '最多看 5 条')
  assert.equal(got, 1)
})

test('topicFit：有共同中文词 → 大于 0；完全无关 → 0；没事件 → 0.5', () => {
  const node = { text: '刚把中文分词那部分写完了', tags: [] }
  assert.ok(topicFit(node, { events: ['中文分词写完了'] }) > 0)
  assert.equal(topicFit(node, { events: ['完全无关的内容'] }), 0)
  assert.equal(topicFit(node, { events: [] }), 0.5)
  assert.equal(topicFit({ text: 'English only' }, { events: ['中文'] }), 0.5, 'node 没中文 gram → 中性')
})

test('topicFit：事件写成 { text } 也认，跟字符串一样', () => {
  const node = { text: '刚把中文分词那部分写完了' }
  const fromObj = topicFit(node, { events: [{ text: '中文分词写完了' }] })
  assert.ok(fromObj > 0)
  assert.equal(fromObj, topicFit(node, { events: ['中文分词写完了'] }))
})

test('topicFit：tag 里的中文也算这一边的话', () => {
  const node = { text: '', tags: ['中文分词'] }
  assert.equal(topicFit(node, { events: ['中文分词写完了'] }), 1)
})

test('fitOf：按 FIT_AXES 加权', () => {
  const node = { text: '刚改了 lib/fit.js 的中文分词' }
  const r = fitOf(node, {
    cwd: 'E:\\work',
    exists: () => true,
    events: ['刚改了中文分词'],
  })
  assert.equal(r.scope, 1)
  assert.equal(r.path, 1)
  assert.ok(r.topic > 0)
  assert.equal(r.fit, FIT_AXES.scope * r.scope + FIT_AXES.path * r.path + FIT_AXES.topic * r.topic)
  assert.ok(Math.abs(r.fit - 0.95) < 1e-12, `fit 应约等于 0.95，实际 ${r.fit}`)
  assert.equal(FIT_AXES.scope, 0.45)
  assert.equal(FIT_AXES.path, 0.25)
  assert.equal(FIT_AXES.topic, 0.30)
})

test('fitOf(null)：全 0', () => {
  assert.deepEqual(fitOf(null), { fit: 0, scope: 0, path: 0, topic: 0 })
  assert.deepEqual(fitOf(null, { cwd: 'E:\\work', events: ['中文'], exists: () => true }), {
    fit: 0,
    scope: 0,
    path: 0,
    topic: 0,
  })
})

test('fit 恒在 0..1', () => {
  const cases = [
    { node: { text: '改了 E:\\work\\lib\\fit.js', tags: ['work'] }, ctx: { cwd: 'E:\\work', exists: () => true, events: ['改了 fit'] } },
    { node: { text: '改了 E:\\work\\lib\\fit.js', tags: ['work'] }, ctx: { cwd: 'E:\\work', exists: () => false, events: ['完全无关'] } },
    { node: { text: '只是说说今天天气', tags: [] }, ctx: { cwd: '', exists: () => true, events: [] } },
    { node: { text: '改了 E:\\ab\\lib\\fit.js', tags: ['ab'] }, ctx: { cwd: 'E:\\a', exists: () => false, events: ['改了'] } },
  ]
  for (const c of cases) {
    const r = fitOf(c.node, c.ctx)
    assert.ok(r.fit >= 0 && r.fit <= 1, `fit 越界：${r.fit}`)
    assert.ok(r.scope >= 0 && r.scope <= 1, `scope 越界：${r.scope}`)
    assert.ok(r.path >= 0 && r.path <= 1, `path 越界：${r.path}`)
    assert.ok(r.topic >= 0 && r.topic <= 1, `topic 越界：${r.topic}`)
  }
})
