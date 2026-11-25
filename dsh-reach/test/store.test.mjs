// 原子写耐久形状钉（批 D5）：fsync 版落盘即完整、无残骸
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson } from '../lib/store.js'

test('atomicWriteJson：落盘即完整、二次写覆盖、无 tmp 残骸（批 D5）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reach-atomic-'))
  try {
    const f = join(dir, 'state.json')
    atomicWriteJson(f, { hello: '识海' })
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).hello, '识海', '写成即完整')
    atomicWriteJson(f, { hello: 'again' })
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).hello, 'again', '二次写覆盖')
    const residue = readdirSync(dir).filter((x) => x.endsWith('.tmp'))
    assert.equal(residue.length, 0, `无 tmp 残骸（${residue.join('、')}）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
