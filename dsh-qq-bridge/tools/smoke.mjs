/**
 * dsh-qq-bridge 冒烟：假宿主 + 桥芯直驱（不开 WS），HTTP 动作口打到本机假服务器。
 * 跑法：node tools/smoke.mjs —— 纯顺序脚本，末尾打总数。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'

let passed = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  passed++
  console.log(`  · ${what}`)
}
const TICK = (ms = 80) => new Promise((r) => setTimeout(r, ms))

function makeCtx() {
  const handlers = []
  const prompted = []
  const effects = []
  const ctx = {
    sessionController: {
      async list() {
        return { items: [{ sessionId: 'session-x', running: true, blank: false, origin: 'user' }] }
      },
      async prompt(request) {
        prompted.push(request)
        return { accepted: true }
      }
    },
    on(name, fn) {
      handlers.push([name, fn])
      return () => {
        const i = handlers.findIndex(([n, f]) => n === name && f === fn)
        if (i >= 0) handlers.splice(i, 1)
      }
    },
    effect(setup, label) {
      // 宿主契约：setup 立刻跑，返回的 teardown 存起来等卸载
      const teardown = setup()
      effects.push(teardown)
    },
    off(name, fn) {
      const i = handlers.findIndex(([n, f]) => n === name && f === fn)
      if (i >= 0) handlers.splice(i, 1)
    },
    __emit(session, event) {
      for (const [n, f] of [...handlers]) if (n === 'session/event') f(session, event)
    },
    __dispose() {
      for (const t of effects.splice(0)) {
        try {
          t?.()
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { ctx, prompted }
}

async function main() {
  const dir = join(tmpdir(), `dsh-qq-bridge-smoke-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  process.env.DSH_HOME = dir

  // 收图不联网：把 QQ 图链的 fetch 掐掉，回一张 8 字节的假 PNG（冒烟不碰真网络）
  const realFetchMain = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('multimedia.nt.qq.com.cn')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer
      }
    }
    return realFetchMain(url, opts)
  }

  // 假 OneBot HTTP 动作口
  const sent = []
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      sent.push({ action: req.url.replace(/^\//, ''), auth: req.headers.authorization ?? '', body: body ? JSON.parse(body) : {} })
      res.setHeader('content-type', 'application/json')
      // 学真机：SnowLuma 对 invite: 形状的 flag 常常匹配不上（retcode 100）
      const reqBody = body ? JSON.parse(body) : {}
      const retcode = req.url.includes('set_group_add_request') && String(reqBody.flag ?? '').startsWith('invite:') ? 100 : 0
      // 学真机：get_group_file_url 给回下载直链
      const data = req.url.includes('get_group_file_url')
        ? { url: `https://multimedia.nt.qq.com.cn/fs/${encodeURIComponent(String(reqBody.file_id ?? ''))}` }
        : null
      res.end(JSON.stringify({ status: retcode === 0 ? 'ok' : 'failed', retcode, data }))
    })
  })
  await new Promise((r) => http.listen(0, '127.0.0.1', r))
  const port = http.address().port

  try {
    const { ctx, prompted } = makeCtx()
    const bridge = apply(ctx, {
      onebotHttp: `http://127.0.0.1:${port}`,
      httpToken: 'tok-http',
      onebotWs: '', // 冒烟里不真连 WS
      wsToken: 'tok-ws',
      allowUsers: [10001],
      allowGroups: [111111111],
      selfUin: 2754618374,
      sessionId: 'session-x',
      promptPrefix: '【QQ】'
    })

    ok(typeof bridge?.dispose === 'function', 'apply 返回桥（带 dispose）')

    // —— 去重：同一条 message_id 只递一次 ——
    const dupEv = {
      post_type: 'message',
      message_type: 'private',
      message_id: 9001,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '在吗' } }]
    }
    await bridge.handleOnebotEvent(dupEv)
    await bridge.handleOnebotEvent({ ...dupEv })
    await TICK()
    ok(prompted.length === 1, '同一条消息只递一次（message_id 去重）')
    ok(bridge.pendingSize === 1, '递话挂起等回')
    ok(prompted[0]?.sessionId === 'session-x', '递给配置的目标会话')
    ok(prompted[0]?.content?.[0]?.text === '【QQ】肥鱼（10001）说：在吗', '递话压成一行带前缀')

    // —— 认：我们的话从会话流里回来（user/message 没带 turn；rpcId 精认 + 无 turn/start 时兜底） ——
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: '【QQ】肥鱼（10001）说：在吗' }] },
        source: { kind: 'user', rpcId: prompted[0]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 7 } })
    // 一轮的第一步：只有 thinking 块（正文在后面的步）—— 旧版在这里就把思考发出去（2026-11-04 事故）
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 2,
      time: Date.now(),
      data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'thinking', text: '内心戏：先想想怎么回', thinking: '内心戏' }] } }
    })
    await TICK()
    ok(sent.filter((s) => s.action === 'send_private_msg').length === 0, '思考步不回话（thinking 块不出门）')
    // 第二步是正文；整轮收尾（turn/end）才发
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 3,
      time: Date.now(),
      data: { turn: 7, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '在的，怎么了？' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 7, reason: 'completed' } })
    await TICK()
    ok(bridge.pendingSize === 0, '回话接走，挂起清空')
    const reply = sent.find((s) => s.action === 'send_private_msg')
    ok(Boolean(reply), '回话打了 HTTP 动作口')
    ok(reply?.body?.user_id === 10001, '回话发给原号')
    ok(reply?.body?.message?.[0]?.data?.text === '在的，怎么了？', '整轮收尾才回话，内容只取 text 块')
    ok(reply?.auth === 'Bearer tok-http', 'HTTP 口带 token')

    // —— 挡：白名单外一个字不递 ——
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      user_id: 99999,
      sender: { nickname: '陌生人' },
      message: [{ type: 'text', data: { text: '你好' } }]
    })
    await TICK()
    ok(prompted.length === 1, '名单外不递话')
    ok(sent.filter((s) => s.action === 'send_private_msg').length === 1, '名单外不回话')

    // —— 挡：自己发的不理（防自环） ——
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      user_id: 2754618374,
      sender: { nickname: '桥' },
      message: [{ type: 'text', data: { text: '我自己' } }]
    })
    await TICK()
    ok(prompted.length === 1, '自己的号不递')

    // —— 群：只记日志不回 ——
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 111111111,
      user_id: 10001,
      message: [{ type: 'text', data: { text: '群友说话' } }]
    })
    await TICK()
    ok(prompted.length === 1, '群消息不递话')
    const logFile = join(dir, '.dsh-qq-bridge', 'bridge.log')
    ok(existsSync(logFile), '桥日志在')
    const logText = readFileSync(logFile, 'utf8')
    ok(logText.includes('群 111111111 · 10001：群友说话'), '群消息进了日志（只看不应）')
    ok(logText.includes('递进会话 session-x'), '递话有日志')

    // —— 未在群白名单的群：连日志都不进 ——
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 111,
      user_id: 10001,
      message: [{ type: 'text', data: { text: '别的群' } }]
    })
    await TICK()
    const logText2 = readFileSync(logFile, 'utf8')
    ok(!logText2.includes('111：'), '群外的不记')

    // —— 群邀请：白名单里的人邀就点头 ——
    await bridge.handleOnebotEvent({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      group_id: 222222222,
      user_id: 10001,
      flag: 'flag-1'
    })
    await TICK()
    const approved = sent.find((s) => s.action === 'set_group_add_request')
    ok(Boolean(approved), '白名单的人邀我，点头')
    ok(approved?.body?.flag === 'flag-1' && approved?.body?.approve === true, '点头带对 flag 和 approve')
    ok(readFileSync(logFile, 'utf8').includes('群 222222222 已加入'), '入群有日志')

    // —— 群邀请：陌生人邀不接 ——
    await bridge.handleOnebotEvent({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      group_id: 222,
      user_id: 99999,
      flag: 'flag-2'
    })
    await TICK()
    ok(sent.filter((s) => s.action === 'set_group_add_request').length === 1, '陌生人邀我不点头')

    // —— 群邀请：flag 匹配不上 → 卡片一到按 msgseq 点头（真机实测管用的路） ——
    await bridge.handleOnebotEvent({
      post_type: 'request',
      request_type: 'group',
      sub_type: 'invite',
      group_id: 222222222,
      user_id: 10001,
      flag: 'invite:222222222:u_abc'
    })
    await TICK()
    const inviteCard = {
      post_type: 'message',
      message_type: 'private',
      message_id: 9100,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{
        type: 'json',
        data: {
          data: JSON.stringify({
            app: 'com.tencent.tuwen.lua',
            prompt: '[链接]邀请你加入群聊',
            bizsrc: 'qun.invite',
            meta: {
              news: [{
                title: '邀请你加入群聊',
                jumpUrl: 'mqqapi://group/invite_join?src_type=internal&version=1&groupcode=222222222&msgseq=1793775964407909&groupname=dsh-fish%e4%ba%a4%e6%b5%81%e7%be%a4%e2%91%a1&senderuin=1000001&receiveruin=2754618374'
              }]
            }
          })
        }
      }]
    }
    await bridge.handleOnebotEvent(inviteCard)
    await TICK()
    const byCard = sent.find((s) => s.action === 'set_group_add_request' && s.body?.flag === '1793775964407909')
    ok(Boolean(byCard) && byCard.body?.approve === true, 'flag 不成时按卡片 msgseq 点头')
    const autoPrompt = prompted[prompted.length - 1]
    ok(String(autoPrompt?.content?.[0]?.text ?? '').includes('点头进去了'), '进群后往会话里递了一句自动话')
    ok(readFileSync(logFile, 'utf8').includes('按邀请卡片的 msgseq 点头'), '卡片点头有日志')

    // —— 图片消息压占位 ——
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'image', data: { file: 'x.jpg' } }]
    })
    await TICK(120)
    ok(prompted.length === 3, '图片占位也递（邀请卡片的自动话 + 图片，共三递）')
    ok(prompted[2]?.content?.[0]?.text === '【QQ】肥鱼（10001）说：[图片]', '图片压成占位')

    // —— 图直链递给会话（r_1wri69g 侧门进正门）：带 url 的图把直链带上，没 url 的只有占位 ——
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 9210,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [
        { type: 'text', data: { text: '看这张' } },
        { type: 'image', data: { file: 'a.jpg', url: 'https://multimedia.nt.qq.com.cn/a?rkey=k1' } },
        { type: 'image', data: { file: 'b.jpg' } }
      ]
    })
    await TICK(120)
    ok(prompted.length === 4, '带直链的图也递进会话')
    const pImg = String(prompted[3]?.content?.[0]?.text ?? '')
    ok(pImg.includes('[图片]'), '人话里还是 [图片] 占位')
    ok(pImg.includes('[图片直链] https://multimedia.nt.qq.com.cn/a?rkey=k1'), '直链单独一行递进来')
    ok(pImg.split('[图片直链]').length - 1 === 1, '没直链的图不编链接')
    // —— 照片三件套（v0.7.0）：交给我的图存下来，递本地路径给会话（认图）——
    ok(pImg.includes('[图片已存]'), '私聊交给我的图存下来了')
    const savedPath = String(pImg.match(/\[图片已存\] ([^\r\n]+)/)?.[1] ?? '').trim()
    ok(!!savedPath && existsSync(savedPath), '存的图在盘上（会话那头能 read_image 打开它）')

    // 把带直链的图那轮回完，后面挂起存档的断言回到老样子（旧链不被我扰）
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 2,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: pImg }] },
        source: { kind: 'user', rpcId: prompted[3]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 2, time: Date.now(), data: { turn: 20 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 2,
      time: Date.now(),
      data: { turn: 20, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到图了' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 20, reason: 'completed' } })
    await TICK()
    ok(sent.some((s) => s.action === 'send_private_msg' && s.body?.user_id === 10001), '私聊回话照发（直链那条回完了）')

    // —— 群文件上传（notice/group_upload）：记消息流，不递话 ——
    // v0.4.0 分册：一个群一册 messages-group-<群号>.jsonl
    const msgLogFile = join(dir, '.dsh-qq-bridge', 'messages-group-111111111.jsonl')
    const readMsgLines = () => { try { return readFileSync(msgLogFile, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
    const msgFileBefore = readMsgLines().length
    await bridge.handleOnebotEvent({
      post_type: 'notice',
      notice_type: 'group_upload',
      group_id: 111111111,
      user_id: 77004,
      nick: '群友丁',
      file: { id: 'F9', name: '心灵心理架构.docx', size: 4096, busid: 1 }
    })
    await TICK(120)
    ok(prompted.length === 4, '群文件上传不递话（不 @ 我的事不打扰）')
    const msgRowsFile = readMsgLines()
    ok(msgRowsFile.length === msgFileBefore + 1, '群文件上传记进消息流')
    const fileRow = JSON.parse(msgRowsFile[msgRowsFile.length - 1])
    ok(fileRow.text.includes('[文件] 心灵心理架构.docx（4KB）'), '文件行带名字和大小')
    ok(fileRow.text.includes('[文件直链] https://multimedia.nt.qq.com.cn/fs/F9'), '文件行带下载直链（get_group_file_url）')
    ok(fileRow.nickname === '群友丁', '文件行记上传人')

    // —— 群里的文件以 message/file 段发（真机形状，SnowLuma 2.4.0 实测）：不 @ 我，但直链要进消息流 ——
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 111111111,
      message_id: 9215,
      user_id: 77001,
      sender: { nickname: '群友丁' },
      message: [
        { type: 'file', data: { file: '心灵心理架构.docx', file_id: '/65f9978d', file_size: 8151, name: '心灵心理架构.docx', size: 8151, id: '/65f9978d', url: 'https://gzc-download.ftn.qq.com/ftn_handler/abc' } }
      ]
    })
    await TICK()
    ok(prompted.length === 4, '群文件消息（不 @ 我）不递话')
    const msgRowsFile2 = readMsgLines()
    const fileRow2 = JSON.parse(msgRowsFile2[msgRowsFile2.length - 1])
    ok(fileRow2.nickname === '群友丁' && fileRow2.atMe === false, '文件消息行记上传人（不 @ 我）')
    ok(fileRow2.text.includes('[文件] 心灵心理架构.docx（8KB）'), 'file 段名字大小进消息流')
    ok(fileRow2.text.includes('[文件直链] https://gzc-download.ftn.qq.com/ftn_handler/abc'), 'file 段自带直链进消息流')

    // —— 群里 @ 我：递进会话，回话回进群（m07835 他定的：不用全转他） ——
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 111111111,
      message_id: 9200,
      user_id: 77004,
      sender: { nickname: '柒' },
      message: [{ type: 'at', data: { qq: 2754618374 } }, { type: 'text', data: { text: '你会说话吗？' } }]
    })
    await TICK()
    ok(prompted.length === 5, '群里 @ 我的递进会话')
    ok(String(prompted[4]?.content?.[0]?.text ?? '').includes('@我（群 111111111）'), '群 @ 那行带群号')
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 111111111,
      message_id: 9201,
      user_id: 10001,
      message: [{ type: 'text', data: { text: '日常 chatter' } }]
    })
    await TICK()
    ok(prompted.length === 5, '不 @ 的群消息不递话')
    const gLine = String(prompted[4]?.content?.[0]?.text ?? '')
    // 宿主真章：prompt 的 requestId 以 source.rpcId 回显在 user/message 上；turn 由同线的 turn/start 给出
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 3,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: gLine }] },
        source: { kind: 'user', rpcId: prompted[4]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 3, time: Date.now(), data: { turn: 9 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 4,
      time: Date.now(),
      // 真实泄漏形状：一步里 thinking 块 + 正文块挤在同一个 message —— 只发正文
      data: { turn: 9, step: 1, message: { role: 'assistant', content: [{ type: 'thinking', text: '群里怎么回……', thinking: '群里怎么回……' }, { type: 'text', text: '会，看到就会应' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 5, time: Date.now(), data: { turn: 9, reason: 'completed' } })
    await TICK()
    // 群回话必须点名（@ 开头）——「会，看到就会应」没点名，一个字不发（2026-11-05 内部小结漏进群的事故）
    ok(!sent.some((s) => s.action === 'send_group_msg'), '没点名的群回话不发（内部小结漏不进群）')
    // 补一段点名的正文再收尾：这才发
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 6, time: Date.now(), data: { turn: 9, reason: 'completed' } })
    await TICK()
    ok(!sent.some((s) => s.action === 'send_group_msg'), '挂起已清，重放 turn/end 不重发')
    // 再来一轮点名的：这才发进群
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 111111111,
      message_id: 9202,
      user_id: 77004,
      sender: { nickname: '柒' },
      message: [{ type: 'at', data: { qq: 2754618374 } }, { type: 'text', data: { text: '那现在呢？' } }]
    })
    await TICK()
    ok(prompted.length === 6, '第二次群 @ 也递进会话')
    const gLine2 = String(prompted[5]?.content?.[0]?.text ?? '')
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 6,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: gLine2 }] },
        source: { kind: 'user', rpcId: prompted[5]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 6, time: Date.now(), data: { turn: 10 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 7,
      time: Date.now(),
      data: { turn: 10, step: 1, message: { role: 'assistant', content: [{ type: 'thinking', text: '先记一笔', thinking: '先记一笔' }, { type: 'text', text: '@柒 会，看到就会应' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 8, time: Date.now(), data: { turn: 10, reason: 'completed' } })
    await TICK()
    const groupReply = sent.find((s) => s.action === 'send_group_msg')
    ok(Boolean(groupReply), '点名的群回话打 send_group_msg')
    ok(groupReply?.body?.group_id === 111111111, '回话发回原群')
    ok(groupReply?.body?.message?.[0]?.data?.text === '@柒 会，看到就会应', '群回话内容就是点名那段')

    // —— 戳一戳：notice/notify/poke —— 谁戳我，戳回去；同一人一分钟内不连戳 ——
    await bridge.handleOnebotEvent({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      group_id: 111111111,
      user_id: 77003,
      target_id: 2754618374
    })
    await TICK()
    const poke1 = sent.find((s) => s.action === 'group_poke')
    ok(Boolean(poke1), '群里有人戳我，戳回去（group_poke）')
    ok(poke1?.body?.group_id === 111111111 && poke1?.body?.user_id === 77003, '戳回去对着戳我的人')
    await bridge.handleOnebotEvent({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      group_id: 111111111,
      user_id: 77003,
      target_id: 2754618374
    })
    await TICK()
    ok(sent.filter((s) => s.action === 'group_poke').length === 1, '一分钟内连戳不连回')
    await bridge.handleOnebotEvent({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      user_id: 10001,
      target_id: 2754618374
    })
    await TICK()
    const poke3 = sent.find((s) => s.action === 'friend_poke')
    ok(Boolean(poke3) && poke3?.body?.user_id === 10001, '私聊戳我，friend_poke 戳回去')
    await bridge.handleOnebotEvent({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      group_id: 111111111,
      user_id: 10001,
      target_id: 77003
    })
    await TICK()
    ok(sent.filter((s) => s.action === 'group_poke').length === 1, '戳的不是我，不理')

    // —— 串台闸：私聊挂起 + 这轮攒的是群答复（@ 开头）→ 拦下不发 ——
    // （2026-11-05 真事：几条消息排队时兜底取错挂起，把给群里的答复发进了私信）
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 9300,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '看看这个' } }]
    })
    await TICK()
    ok(prompted.length === 7, '私聊递话进会话')
    const pLine = String(prompted[6]?.content?.[0]?.text ?? '')
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 11,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: pLine }] },
        source: { kind: 'user', rpcId: prompted[6]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 11, time: Date.now(), data: { turn: 11 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 12,
      time: Date.now(),
      data: { turn: 11, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '@且先猫着 这是给群里的答复' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 13, time: Date.now(), data: { turn: 11, reason: 'completed' } })
    await TICK()
    ok(!sent.some((s) => s.action === 'send_private_msg' && String(s.body?.message?.[0]?.data?.text ?? '').includes('给群里的答复')), '串台闸：群答复不挂私聊挂起发出去')

    // —— GUI 转不抢挂起：没 prime（没 user/message 认领）的转，turn/end 不动挂起 ——
    // （2026-11-05 真事：我干活的小结转把小黑的挂起盲取吃了，正主的回话没发出去）
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 9301,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '第二条' } }]
    })
    await TICK()
    ok(prompted.length === 8, '第二条私聊也递进会话')
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 14,
      time: Date.now(),
      data: { turn: 12, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '干活的小结（不是回话）' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 15, time: Date.now(), data: { turn: 12, reason: 'completed' } })
    await TICK()
    ok(!sent.some((s) => s.action === 'send_private_msg' && String(s.body?.message?.[0]?.data?.text ?? '').includes('干活的小结')), '没认上号的转不取挂起（GUI 小结转不吃别人的回话资格）')
    // 正主来认领：user/message prime + assistant 首步认领 + turn/end 精确取
    const pLine2 = String(prompted[7]?.content?.[0]?.text ?? '')
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 16,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: pLine2 }] },
        source: { kind: 'user', rpcId: prompted[7]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 17,
      time: Date.now(),
      data: { turn: 13, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '这条才是回你的' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 18, time: Date.now(), data: { turn: 13, reason: 'completed' } })
    await TICK()
    ok(sent.some((s) => s.action === 'send_private_msg' && s.body?.user_id === 10001 && String(s.body?.message?.[0]?.data?.text ?? '') === '这条才是回你的'), '正主认领后才发（挂起跟消息对上号）')

    // —— 工具调用标记不当回话；只有工具步的那一轮，挂起作废（2026-11-08 真事回归）——
    // 真事：宿主把工具步回显成「<｜DSML｜ calls>」，桥原样当回话发进了她的私聊。
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 9302,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '第三条' } }]
    })
    await TICK()
    const pendBeforeTool = bridge.pendingSize
    const sendsBeforeTool = sent.filter((s) => s.action === 'send_private_msg').length
    const pLine3 = String(prompted[8]?.content?.[0]?.text ?? '')
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 19,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: pLine3 }] },
        source: { kind: 'user', rpcId: prompted[8]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 20,
      time: Date.now(),
      data: { turn: 14, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '<｜DSML｜ calls>' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 21, time: Date.now(), data: { turn: 14, reason: 'completed' } })
    await TICK()
    ok(sent.filter((s) => s.action === 'send_private_msg').length === sendsBeforeTool, '工具调用标记不当回话发出去（这一轮一个字都没发）')
    ok(bridge.pendingSize === pendBeforeTool, '只有工具步的那轮：挂起放回队首（v0.8.7 不没收，等真正的回话轮）')

    // —— 卸载：ctx.effect 的 teardown 收掉事件监听（宿主重载时全靠这个不漏实例） ——
    ctx.__dispose()
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 9,
      time: Date.now(),
      data: { turn: 8, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '死实例不应话' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 10, time: Date.now(), data: { turn: 8, reason: 'completed' } })
    await TICK()
    const sendsBefore = sent.filter((s) => s.action === 'send_private_msg').length
    ok(sendsBefore === 3, '卸载后的桥不再回话（teardown 收干净）')

    // —— 挂起存档：mark 之后盘上有 pending.json，热重载/重启不丢「等着回的话」 ——
    const pendingFile = join(dir, '.dsh-qq-bridge', 'pending.json')
    ok(existsSync(pendingFile), '挂起存档文件在')
    const savedPending = JSON.parse(readFileSync(pendingFile, 'utf8'))
    ok(Array.isArray(savedPending.items) && savedPending.items.length === 3, '没回完的挂起存进了盘上（进群自动话 + 图片占位 + 工具轮放回的那条）')
    ok(String(savedPending.items[1]?.text ?? '').includes('[图片]'), '存档里就是那条挂起的话')

    // —— 复活：新实例从盘上把挂起接回来（热重载就是这条路径） ——
    const revived = apply(makeCtx().ctx, {
      onebotHttp: `http://127.0.0.1:${port}`,
      onebotWs: '',
      allowUsers: [10001],
      sessionId: 'session-x'
    })
    ok(revived.pendingSize === 3, '新实例从盘上接回挂起')
    revived.dispose()

    bridge.dispose()
    ok(true, 'dispose 不炸')
  } finally {
    globalThis.fetch = realFetchMain
    http.close()
    rmSync(dir, { recursive: true, force: true })
  }

  // —— 白名单空＝桥待机 ——
  const dir2 = join(tmpdir(), `dsh-qq-bridge-smoke2-${process.pid}`)
  rmSync(dir2, { recursive: true, force: true })
  mkdirSync(dir2, { recursive: true })
  process.env.DSH_HOME = dir2
  try {
    const { ctx, prompted } = makeCtx()
    const bridge = apply(ctx, { onebotWs: '', allowUsers: [] })
    ok(typeof bridge?.dispose === 'function', '待机桥也返回 dispose')
    ok(prompted.length === 0, '没递话')
    bridge.dispose()
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }

  // —— 会话隔离（v0.5.0）：denyRoots 拦住数据文件，话照递 ——
  const dir3 = join(tmpdir(), `dsh-qq-bridge-smoke3-${process.pid}`)
  rmSync(dir3, { recursive: true, force: true })
  mkdirSync(dir3, { recursive: true })
  process.env.DSH_HOME = dir3
  try {
    const { ctx, prompted } = makeCtx()
    const bridge = apply(ctx, {
      onebotWs: '',
      allowUsers: [10001],
      sessionId: 'session-x',
      denyRoots: [dir3] // 整个家目录都拉黑 —— 数据文件一个都不许落盘
    })
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 9501,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '隔离期间也在吗' } }]
    })
    await TICK()
    ok(prompted.length === 1, '隔离开着，话照递（隔离只拦文件，不拦会话）')
    ok(!existsSync(join(dir3, '.dsh-qq-bridge', 'bridge.log')), 'denyRoots 拦住日志落盘')
    ok(!existsSync(join(dir3, '.dsh-qq-bridge', 'pending.json')), 'denyRoots 拦住挂起存档（退化为内存）')
    ok(bridge.pendingSize === 1, '挂起还在（内存里等回话）')
    bridge.dispose()
  } finally {
    rmSync(dir3, { recursive: true, force: true })
  }

  // —— 照片三件套（v0.7.0）：群里 @ 我带图 → 存下来；回话 [发图:路径] → 真发图片段 ——
  const dir4 = join(tmpdir(), `dsh-qq-bridge-smoke4-${process.pid}`)
  rmSync(dir4, { recursive: true, force: true })
  mkdirSync(dir4, { recursive: true })
  process.env.DSH_HOME = dir4
  const sent4 = []
  const http4 = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      sent4.push({ action: req.url.replace(/^\//, ''), body: body ? JSON.parse(body) : {} })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: null }))
    })
  })
  await new Promise((r) => http4.listen(0, '127.0.0.1', r))
  const port4 = http4.address().port
  const realFetch4 = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('multimedia.nt.qq.com.cn')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer
      }
    }
    return realFetch4(url, opts)
  }
  try {
    const { ctx, prompted } = makeCtx()
    const bridge = apply(ctx, {
      onebotHttp: `http://127.0.0.1:${port4}`,
      onebotWs: '',
      allowUsers: [10001],
      allowGroups: [111111111],
      selfUin: 2754618374,
      sessionId: 'session-x',
      promptPrefix: '【QQ】'
    })

    // 群里 @ 我带图：也存（没 @ 我的群图只留直链，不存）
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 111111111,
      message_id: 9602,
      user_id: 77002,
      sender: { nickname: '菠萝吹雪' },
      message: [
        { type: 'at', data: { qq: 2754618374 } },
        { type: 'text', data: { text: '这图你看' } },
        { type: 'image', data: { file: 'b.png', url: 'https://multimedia.nt.qq.com.cn/b?rkey=k9' } }
      ]
    })
    await TICK(150)
    ok(prompted.length === 1, '群里 @ 我带图也递进会话')
    const gLine = String(prompted[0]?.content?.[0]?.text ?? '')
    ok(gLine.includes('[图片已存]'), '群里 @ 我的图也存下来了')
    const gSaved = String(gLine.match(/\[图片已存\] ([^\r\n]+)/)?.[1] ?? '').trim()
    ok(!!gSaved && existsSync(gSaved), '群图在盘上')

    // 回话里写 [发图:路径] → 真发出图片段
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 20,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: gLine }] },
        source: { kind: 'user', rpcId: prompted[0]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 20, time: Date.now(), data: { turn: 20 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 20,
      time: Date.now(),
      data: { turn: 20, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `@菠萝吹雪 看这个 [发图:${gSaved}]` }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 21, time: Date.now(), data: { turn: 20, reason: 'completed' } })
    await TICK(600)
    const gSends = sent4.filter((s) => s.action === 'send_group_msg')
    const segs = gSends[gSends.length - 2]?.body?.message ?? [] // 文字那条
    const segsPic = gSends[gSends.length - 1]?.body?.message ?? [] // 图单独那条
    ok(segsPic.length === 1 && segsPic[0]?.type === 'image', '回话里的 [发图:路径] 单独一条发出去（v0.8.4）')
    ok(!String(segs[0]?.data?.text ?? '').includes('[发图:'), '发图标记没漏进文字')
    ok(String(segs[0]?.data?.text ?? '').startsWith('@'), '群回话还是点着名发')

    // 只有图没字：点名闸认发图标记，图照样发出去
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'group',
      group_id: 111111111,
      message_id: 9603,
      user_id: 77002,
      sender: { nickname: '菠萝吹雪' },
      message: [{ type: 'at', data: { qq: 2754618374 } }, { type: 'text', data: { text: '再来一张' } }]
    })
    await TICK(150)
    const gLine3 = String(prompted[1]?.content?.[0]?.text ?? '')
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 22,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: gLine3 }] },
        source: { kind: 'user', rpcId: prompted[1]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 22, time: Date.now(), data: { turn: 22 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 22,
      time: Date.now(),
      data: { turn: 22, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `[发图:${gSaved}]` }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 23, time: Date.now(), data: { turn: 22, reason: 'completed' } })
    await TICK(200)
    const sentOnly = sent4.filter((s) => s.action === 'send_group_msg').pop()
    const onlySegs = sentOnly?.body?.message ?? []
    ok(onlySegs.length === 1 && onlySegs[0]?.type === 'image', '只有图没字也发得出去（点名闸认发图标记）')

    bridge.dispose()
  } finally {
    globalThis.fetch = realFetch4
    http4.close()
    rmSync(dir4, { recursive: true, force: true })
  }

  // —— 表情包标记（v0.8.0）：回话里写 [表情:名字] → 真发图片段；库里没有就出声 ——
  const dir5 = join(tmpdir(), `dsh-qq-bridge-smoke5-${process.pid}`)
  rmSync(dir5, { recursive: true, force: true })
  const stickerDir5 = join(dir5, '.dsh-qq-bridge', 'stickers')
  mkdirSync(stickerDir5, { recursive: true })
  writeFileSync(join(stickerDir5, '004-touxiao.jpg'), 'fake-jpeg-bytes')
  writeFileSync(
    join(stickerDir5, 'manifest.jsonl'),
    JSON.stringify({ at: 1793600000000, name: '偷笑', file: '004-touxiao.jpg', from: 'qq', via: 'share', note: '' }) + '\n',
    'utf8'
  )
  process.env.DSH_HOME = dir5
  const sent5 = []
  const http5 = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      sent5.push({ action: req.url.replace(/^\//, ''), body: body ? JSON.parse(body) : {} })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: null }))
    })
  })
  await new Promise((r) => http5.listen(0, '127.0.0.1', r))
  const port5 = http5.address().port
  try {
    const { ctx, prompted } = makeCtx()
    const bridge = apply(ctx, {
      onebotHttp: `http://127.0.0.1:${port5}`,
      onebotWs: '',
      allowUsers: [10001],
      selfUin: 2754618374,
      sessionId: 'session-x',
      promptPrefix: '【QQ】'
    })
    ok(bridge.stickerCount === 1, '表情库启动时读到了（manifest 一张）')

    // 回话里写 [表情:偷笑] → 真图片段发出去
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 9701,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '在吗' } }]
    })
    await TICK()
    ok(prompted.length === 1, '递话挂上了（等回话）')
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 30,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: String(prompted[0]?.content?.[0]?.text ?? '') }] },
        source: { kind: 'user', rpcId: prompted[0]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 30, time: Date.now(), data: { turn: 30 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 30,
      time: Date.now(),
      data: { turn: 30, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '哼 [表情:偷笑]' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 31, time: Date.now(), data: { turn: 30, reason: 'completed' } })
    await TICK(600)
    const pSends = sent5.filter((s) => s.action === 'send_private_msg')
    const segs5 = pSends[pSends.length - 2]?.body?.message ?? [] // 文字那条
    const segs5Pic = pSends[pSends.length - 1]?.body?.message ?? [] // 表情单独那条
    ok(
      segs5Pic.some((x) => x.type === 'image' && String(x.data?.file ?? '').endsWith('004-touxiao.jpg')),
      '回话里的 [表情:名字] 单独一条发出去（file 指向库里那张，v0.8.4）'
    )
    ok(!String(segs5[0]?.data?.text ?? '').includes('[表情:'), '表情标记没漏进文字')

    // 只有表情没字：图照样发出去
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 9702,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '再来' } }]
    })
    await TICK()
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 32,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: String(prompted[1]?.content?.[0]?.text ?? '') }] },
        source: { kind: 'user', rpcId: prompted[1]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 32, time: Date.now(), data: { turn: 32 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 32,
      time: Date.now(),
      data: { turn: 32, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '[表情:偷笑]' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 33, time: Date.now(), data: { turn: 32, reason: 'completed' } })
    await TICK(200)
    const sentOnly = sent5.filter((s) => s.action === 'send_private_msg').pop()
    const onlySegs = sentOnly?.body?.message ?? []
    ok(
      onlySegs.length === 1 && onlySegs[0]?.type === 'image',
      '只有表情没字也发得出去（图片段自己出门）'
    )

    // 库里没有的名字：不静默吞掉 —— 正文里说出来
    await bridge.handleOnebotEvent({
      post_type: 'message',
      message_type: 'private',
      message_id: 9703,
      user_id: 10001,
      sender: { nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '这个表情呢' } }]
    })
    await TICK()
    ctx.__emit({ id: 'session-x' }, {
      type: 'user/message',
      seq: 34,
      time: Date.now(),
      data: {
        message: { role: 'user', content: [{ type: 'text', text: String(prompted[2]?.content?.[0]?.text ?? '') }] },
        source: { kind: 'user', rpcId: prompted[2]?.requestId }
      }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/start', seq: 34, time: Date.now(), data: { turn: 34 } })
    ctx.__emit({ id: 'session-x' }, {
      type: 'assistant/message',
      seq: 34,
      time: Date.now(),
      data: { turn: 34, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '这个 [表情:没收录的] 给你' }] } }
    })
    ctx.__emit({ id: 'session-x' }, { type: 'turn/end', seq: 35, time: Date.now(), data: { turn: 34, reason: 'completed' } })
    await TICK(200)
    const sentMiss = sent5.filter((s) => s.action === 'send_private_msg').pop()
    const missText = String((sentMiss?.body?.message ?? []).map((x) => x.data?.text ?? '').join(''))
    ok(missText.includes('表情库里没有') && missText.includes('没收录的'), '库里没有的表情出声了（不静默吞掉）')

    bridge.dispose()
  } finally {
    http5.close()
    rmSync(dir5, { recursive: true, force: true })
  }

  console.log(`dsh-qq-bridge 冒烟：${passed} 项通过`)
}

main().catch((err) => {
  console.error(`冒烟没跑完：${err?.message ?? err}`)
  try { writeFileSync('E:/示例/Plugin/dsh-qq-bridge/_smoke_stack.txt', String(err?.stack ?? err)) } catch {}
  process.exit(1)
})
