// 原子写耐久形状钉（批 D5）：tmp 带时刻唯一、落盘即完整、无残骸
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson } from '../lib/store.js'

test('atomicWriteJson：落盘即完整、二次写覆盖、无 tmp 残骸（批 D5）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'body-atomic-'))
  try {
    const f = join(dir, 'state.json')
    atomicWriteJson(f, { hunger: 42 })
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).hunger, 42, '写成即完整')
    atomicWriteJson(f, { hunger: 43 })
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).hunger, 43, '二次写覆盖（tmp 带时刻不互踩）')
    const residue = readdirSync(dir).filter((x) => x.endsWith('.tmp'))
    assert.equal(residue.length, 0, `无 tmp 残骸（${residue.join('、')}）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
