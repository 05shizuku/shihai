/**
 * OnebotClient 的 onOpen 契约（v0.8.9 掉线补抄的挂点）：
 * - WS open 时回调一次，retries 归零
 * - 回调抛错只记日志，连接照常活着
 * - 没传 onOpen 也不炸
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { OnebotClient } from '../lib/onebot.js'

/** 假 WebSocket：把 addEventListener 收到的监听存起来，手动放事件。 */
class FakeWS {
  constructor() {
    this.listeners = new Map()
    FakeWS.last = this
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  emit(type, ev) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }

  close() {}
}

function withFakeWS() {
  const real = globalThis.WebSocket
  globalThis.WebSocket = FakeWS
  return () => {
    globalThis.WebSocket = real
  }
}

test('open 时回调 onOpen 一次，retries 归零', () => {
  const restore = withFakeWS()
  try {
    const opens = []
    const c = new OnebotClient({ wsUrl: 'ws://x', onOpen: () => opens.push(Date.now()) })
    c.retries = 3 // 假装已经重连过几回
    c.connect()
    FakeWS.last.emit('open')
    assert.equal(opens.length, 1)
    assert.equal(c.retries, 0)
  } finally {
    restore()
  }
})

test('onOpen 抛错只记日志，不炸连接', () => {
  const restore = withFakeWS()
  try {
    const logs = []
    const c = new OnebotClient({
      wsUrl: 'ws://x',
      log: (m) => logs.push(m),
      onOpen: () => {
        throw new Error('故意炸的')
      }
    })
    c.connect()
    FakeWS.last.emit('open')
    assert.ok(logs.some((m) => m.includes('onOpen 回调出错') && m.includes('故意炸的')))
  } finally {
    restore()
  }
})

test('没传 onOpen 也能正常连', () => {
  const restore = withFakeWS()
  try {
    const c = new OnebotClient({ wsUrl: 'ws://x' })
    c.connect()
    FakeWS.last.emit('open')
    assert.ok(FakeWS.last)
  } finally {
    restore()
  }
})
