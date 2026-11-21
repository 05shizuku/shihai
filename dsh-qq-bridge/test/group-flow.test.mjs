import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from '../index.js'

function groupEvent({ text, atMe = false, userId = '892634078', nickname = '决胜小康', groupId = '615628177' }) {
  const message = []
  if (atMe) message.push({ type: 'at', data: { qq: '2754618374' } })
  message.push({ type: 'text', data: { text } })
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: Number(groupId),
    user_id: Number(userId),
    sender: { nickname },
    message_id: `m${Math.random().toString(36).slice(2, 8)}`,
    time: Math.floor(Date.now() / 1000),
    self_id: 2754618374,
    message
  }
}

function makeBridge(t, { groupFlow }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-flow-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const prompts = []
  const bridge = createBridge({
    cfg: { selfUin: '2754618374', allowGroups: ['615628177'], groupFlow, sessionId: 'session-test', promptPrefix: '【QQ】' },
    log: () => {},
    sessionController: { prompt: async (req) => { prompts.push(req) }, list: async () => ({ items: [] }) },
    homeDir: home,
    pendingFile: join(home, 'pending.json')
  })
  t.after(() => bridge.dispose())
  return { bridge, prompts }
}

test('groupFlow 开：@ 递话开窗，窗内非 @ 消息不唤醒，过期结算合并为一轮群流', async (t) => {
  const { bridge, prompts } = makeBridge(t, { groupFlow: true })
  await bridge.handleOnebotEvent(groupEvent({ text: '叫我一声', atMe: true }))
  assert.equal(prompts.length, 1)
  await bridge.handleOnebotEvent(groupEvent({ text: '忘了 @ 的第一句' }))
  await bridge.handleOnebotEvent(groupEvent({ text: '忘了 @ 的第二句' }))
  assert.equal(prompts.length, 1)
  bridge.flushExpiredFlows(Date.now() + 9 * 60 * 1000)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(prompts.length, 2)
  const flow = prompts[1].content[0].text
  assert.match(flow, /群流·仅供知悉/)
  assert.match(flow, /忘了 @ 的第一句/)
  assert.match(flow, /忘了 @ 的第二句/)
})

test('groupFlow 关：非 @ 消息一律不递（现状不破坏）', async (t) => {
  const { bridge, prompts } = makeBridge(t, { groupFlow: false })
  await bridge.handleOnebotEvent(groupEvent({ text: '叫一声', atMe: true }))
  assert.equal(prompts.length, 1)
  await bridge.handleOnebotEvent(groupEvent({ text: '没 @ 的闲聊' }))
  bridge.flushExpiredFlows(Date.now() + 9 * 60 * 1000)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(prompts.length, 1)
})

test('窗缓存上限 20 条：第 21 条起丢弃最早的', async (t) => {
  const { bridge, prompts } = makeBridge(t, { groupFlow: true })
  await bridge.handleOnebotEvent(groupEvent({ text: '开窗', atMe: true }))
  for (let i = 1; i <= 25; i++) {
    await bridge.handleOnebotEvent(groupEvent({ text: `闲聊第 ${i} 句` }))
  }
  bridge.flushExpiredFlows(Date.now() + 9 * 60 * 1000)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(prompts.length, 2)
  const flow = prompts[1].content[0].text
  assert.match(flow, /闲聊第 20 句/)
  assert.doesNotMatch(flow, /闲聊第 1 句/)
})
