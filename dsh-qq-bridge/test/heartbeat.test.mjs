import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  heartbeatAgeMs,
  heartbeatInfo,
  heartbeatVerdict,
  readHeartbeat,
  writeHeartbeat,
} from '../lib/heartbeat.js'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'hb-'))
}

test('heartbeatInfo：时间戳/版本/活了多久/队列条数都收成干净值', () => {
  const info = heartbeatInfo({ version: '0.8.3', startedAt: 1000, now: 61_000, pending: 2 })
  assert.equal(info.at, 61_000)
  assert.equal(info.version, '0.8.3')
  assert.equal(info.uptimeMs, 60_000)
  assert.equal(info.pending, 2)
  assert.equal(info.ws, null)
  assert.match(info.iso, /^1970-01-01T00:01:01/)
})

test('heartbeatInfo：坏值不给 NaN —— pending 负数/小数收成 0 或整数', () => {
  const info = heartbeatInfo({ version: null, startedAt: 'x', now: NaN, pending: -3 })
  assert.equal(info.at, 0)
  assert.equal(info.version, '')
  assert.equal(info.uptimeMs, 0)
  assert.equal(info.pending, 0)
  const info2 = heartbeatInfo({ now: 10_000, startedAt: 0, pending: 2.9 })
  assert.equal(info2.pending, 2)
})

test('writeHeartbeat：目录不存在也能写；写回来的和读回来的一致；不留 .tmp 残渣', () => {
  const dir = tmpDir()
  try {
    const file = join(dir, 'nested', 'heartbeat.json')
    const info = heartbeatInfo({ version: '0.8.3', startedAt: 0, now: 5000, pending: 1 })
    writeHeartbeat(file, info)
    assert.ok(existsSync(file))
    assert.deepEqual(readHeartbeat(file), info)
    assert.ok(!existsSync(`${file}.tmp`))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).at, 5000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readHeartbeat：文件不在 / 不是 JSON / 是数组 → null', () => {
  const dir = tmpDir()
  try {
    assert.equal(readHeartbeat(join(dir, 'nope.json')), null)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ 这不是 json')
    assert.equal(readHeartbeat(bad), null)
    const arr = join(dir, 'arr.json')
    writeFileSync(arr, '[1,2,3]')
    assert.equal(readHeartbeat(arr), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('heartbeatAgeMs：没有心跳是 Infinity；有的话是 now - at', () => {
  const dir = tmpDir()
  try {
    const file = join(dir, 'hb.json')
    assert.equal(heartbeatAgeMs(file, 1000), Infinity)
    writeHeartbeat(file, { at: 1000 })
    assert.equal(heartbeatAgeMs(file, 4000), 3000)
    // 时钟倒着走也不给负数
    assert.equal(heartbeatAgeMs(file, 500), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('heartbeatVerdict：新鲜＝活着；超过三次没写＝停了；没有＝没心跳', () => {
  const dir = tmpDir()
  try {
    const file = join(dir, 'hb.json')
    const now = 1_000_000
    assert.equal(heartbeatVerdict(file, { now }).alive, false)
    assert.match(heartbeatVerdict(file, { now }).why, /没有心跳/)

    writeHeartbeat(file, { at: now - 10_000 })
    assert.equal(heartbeatVerdict(file, { now }).alive, true)
    assert.match(heartbeatVerdict(file, { now }).why, /新鲜/)

    writeHeartbeat(file, { at: now - HEARTBEAT_STALE_MS - 1 })
    const v = heartbeatVerdict(file, { now })
    assert.equal(v.alive, false)
    assert.match(v.why, /心跳停了/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('常量：一分钟写一次、三分钟算哑（写进测试里，改的人得先看见）', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 60_000)
  assert.equal(HEARTBEAT_STALE_MS, 180_000)
})
