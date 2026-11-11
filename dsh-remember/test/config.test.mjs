import test from 'node:test'
import assert from 'node:assert/strict'

import { EDITABLE, applyConfigPatch, describePatch } from '../lib/config.js'

const effective = { enabled: true, injectLimit: 3, openLimit: 2, maxChars: 900, targetRoot: '', allowRoots: [] }

test('认识的键才收，不认识的当场拒并说为什么', () => {
  const r = applyConfigPatch({ overrides: {}, effective, patch: { injectLimit: 5, 我乱写的: 1 } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.accepted, [{ key: 'injectLimit', value: 5 }])
  assert.equal(r.rejected.length, 1)
  assert.equal(r.rejected[0].key, '我乱写的')
  assert.ok(r.rejected[0].why)
})

test('给空就是回到默认（把覆盖删掉，不是写个空值进去）', () => {
  const r = applyConfigPatch({ overrides: { injectLimit: 5, maxChars: 500 }, effective, patch: { injectLimit: '' } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.overrides, { maxChars: 500 })
  assert.deepEqual(r.accepted, [{ key: 'injectLimit', value: null, note: '回到默认' }])
})

test('数字越界要拒，布尔要认字符串', () => {
  const bad = applyConfigPatch({ overrides: {}, effective, patch: { injectLimit: 99 } })
  assert.equal(bad.ok, false)
  assert.equal(bad.rejected[0].key, 'injectLimit')
  const bad2 = applyConfigPatch({ overrides: {}, effective, patch: { maxChars: 10 } })
  assert.equal(bad2.ok, false)
  const tri = applyConfigPatch({ overrides: {}, effective, patch: { debug: 'true' } })
  assert.equal(tri.ok, true)
  assert.equal(tri.overrides.debug, true)
  const notBool = applyConfigPatch({ overrides: {}, effective, patch: { debug: '也许' } })
  assert.equal(notBool.ok, false)
})

test('allowRoots 收字符串也收数组，去掉空的', () => {
  const a = applyConfigPatch({ overrides: {}, effective, patch: { allowRoots: 'E:\\a\n\n  E:\\b  ' } })
  assert.equal(a.ok, true)
  assert.deepEqual(a.overrides.allowRoots, ['E:\\a', 'E:\\b'])
  const b = applyConfigPatch({ overrides: {}, effective, patch: { allowRoots: ['E:\\c', '  ', 7] } })
  assert.deepEqual(b.overrides.allowRoots, ['E:\\c', '7'])
})

test('一层层叠：覆盖层是深拷贝，不改入参', () => {
  const overrides = { injectLimit: 4 }
  const r = applyConfigPatch({ overrides, effective, patch: { maxChars: 1200 } })
  assert.deepEqual(overrides, { injectLimit: 4 }, '入参不该被改')
  assert.deepEqual(r.overrides, { injectLimit: 4, maxChars: 1200 })
  assert.equal(r.effective.maxChars, 1200)
  assert.equal(r.effective.enabled, true, '没提到的键保持生效值')
})

test('一条都没收下就是 ok:false', () => {
  const r = applyConfigPatch({ overrides: {}, effective, patch: { 乱写: 1 } })
  assert.equal(r.ok, false)
  assert.equal(describePatch(r.accepted), '（什么都没改）')
})

test('分量不在可改名单里 —— 面板上不许替我拨', () => {
  assert.equal(EDITABLE.weight, undefined)
  assert.equal(EDITABLE.nodeWeight, undefined)
  const r = applyConfigPatch({ overrides: {}, effective, patch: { weight: 0.1 } })
  assert.equal(r.ok, false)
  assert.equal(r.rejected[0].why, '这个键不让改')
})

test('自我层那三个键能改，边界照样拦', () => {
  assert.equal(EDITABLE.selfEnabled, 'boolean')
  assert.equal(EDITABLE.selfSectionOrder, 'number')
  assert.equal(EDITABLE.selfMaxChars, 'number')
  const ok = applyConfigPatch({ overrides: {}, effective, patch: { selfEnabled: false, selfSectionOrder: 8700, selfMaxChars: 600 } })
  assert.equal(ok.ok, true)
  assert.equal(ok.overrides.selfEnabled, false)
  assert.equal(ok.overrides.selfSectionOrder, 8700)
  const tooBig = applyConfigPatch({ overrides: {}, effective, patch: { selfMaxChars: 5000 } })
  assert.equal(tooBig.ok, false)
  assert.equal(tooBig.rejected[0].key, 'selfMaxChars')
  const tooSmall = applyConfigPatch({ overrides: {}, effective, patch: { selfSectionOrder: 5 } })
  assert.equal(tooSmall.ok, false)
  // 自我条的分量仍然不在这里改
  assert.equal(EDITABLE.selfWeight, undefined)
})

test('习惯那四个键能改，边界照样拦', () => {
  assert.equal(EDITABLE.habitEnabled, 'boolean')
  assert.equal(EDITABLE.habitSectionOrder, 'number')
  assert.equal(EDITABLE.habitMaxChars, 'number')
  assert.equal(EDITABLE.habitLimit, 'number')
  const ok = applyConfigPatch({ overrides: {}, effective, patch: { habitEnabled: false, habitSectionOrder: 8690, habitMaxChars: 500, habitLimit: 5 } })
  assert.equal(ok.ok, true)
  assert.equal(ok.overrides.habitEnabled, false)
  assert.equal(ok.overrides.habitLimit, 5)
  const tooMany = applyConfigPatch({ overrides: {}, effective, patch: { habitLimit: 99 } })
  assert.equal(tooMany.ok, false)
  assert.equal(tooMany.rejected[0].key, 'habitLimit')
  const tooLong = applyConfigPatch({ overrides: {}, effective, patch: { habitMaxChars: 5000 } })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.rejected[0].key, 'habitMaxChars')
  const tooEarly = applyConfigPatch({ overrides: {}, effective, patch: { habitSectionOrder: 5 } })
  assert.equal(tooEarly.ok, false)
  assert.equal(tooEarly.rejected[0].key, 'habitSectionOrder')
})

test('好奇那四个键能改，边界照样拦', () => {
  assert.equal(EDITABLE.curiosityEnabled, 'boolean')
  assert.equal(EDITABLE.curiositySectionOrder, 'number')
  assert.equal(EDITABLE.curiosityMaxChars, 'number')
  assert.equal(EDITABLE.curiosityLimit, 'number')
  const ok = applyConfigPatch({ overrides: {}, effective, patch: { curiosityEnabled: false, curiositySectionOrder: 8670, curiosityMaxChars: 400, curiosityLimit: 5 } })
  assert.equal(ok.ok, true)
  assert.equal(ok.overrides.curiosityEnabled, false)
  assert.equal(ok.overrides.curiosityLimit, 5)
  const tooMany = applyConfigPatch({ overrides: {}, effective, patch: { curiosityLimit: 99 } })
  assert.equal(tooMany.ok, false)
  assert.equal(tooMany.rejected[0].key, 'curiosityLimit')
  const tooLong = applyConfigPatch({ overrides: {}, effective, patch: { curiosityMaxChars: 5000 } })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.rejected[0].key, 'curiosityMaxChars')
  const tooEarly = applyConfigPatch({ overrides: {}, effective, patch: { curiositySectionOrder: 5 } })
  assert.equal(tooEarly.ok, false)
  assert.equal(tooEarly.rejected[0].key, 'curiositySectionOrder')
})

test('describePatch 把改了什么说明白', () => {
  const r = applyConfigPatch({ overrides: {}, effective, patch: { targetRoot: 'E:\\示例\\Plugin', enabled: false } })
  assert.equal(describePatch(r.accepted), 'targetRoot="E:\\\\示例\\\\Plugin"、enabled=false')
})
