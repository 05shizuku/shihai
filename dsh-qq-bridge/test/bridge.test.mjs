import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PendingReplies,
  assistantText,
  atMe,
  clampReply,
  extractMedia,
  extractText,
  formatGroupLog,
  formatGroupPrompt,
  PROMPT_UNTRUSTED_NOTE,
  formatPrompt,
  groupReplyText,
  inviteSeqFromCard,
  isAllowedGroup,
  isAllowedPrivate,
  isSelfTalkBubble,
  isToolCallMarker,
  looksGroupAddressed,
  privateReplyText,
  mediaLines,
  replyLooksBound,
  splitBubbles,
  userText
} from '../lib/bridge.js'

test('inviteSeqFromCard 从群邀请卡片里翻出 groupcode 和 msgseq', () => {
  const seg = {
    type: 'json',
    data: {
      data: JSON.stringify({
        app: 'com.tencent.tuwen.lua',
        prompt: '[链接]邀请你加入群聊',
        bizsrc: 'qun.invite',
        meta: {
          news: [{
            title: '邀请你加入群聊',
            jumpUrl: 'mqqapi://group/invite_join?src_type=internal&version=1&groupcode=222222222&msgseq=1793775964407909&groupname=dsh-fish-test&senderuin=10001&receiveruin=20002'
          }]
        }
      })
    }
  }
  const out = inviteSeqFromCard([seg])
  assert.deepEqual(out, { groupId: '222222222', sequence: '1793775964407909' })
})

test('inviteSeqFromCard 普通卡片和坏卡片不冒充邀请', () => {
  const plain = { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01', prompt: '分享', meta: { news: [{ title: '新闻', url: 'https://example.com/a' }] } }) } }
  assert.equal(inviteSeqFromCard([plain]), null)
  assert.equal(inviteSeqFromCard([{ type: 'json', data: { data: '不是json' } }]), null)
  assert.equal(inviteSeqFromCard([]), null)
  assert.equal(inviteSeqFromCard(undefined), null)
})

test('extractMedia 收图直链与文件，缺 url 的不收，不认识的段不炸', () => {
  const media = extractMedia([
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/x?rkey=abc', file: 'img1.jpg' } },
    { type: 'image', data: { file: 'no-url.jpg' } }, // 没直链，不收
    { type: 'file', data: { file_id: 'F1', name: '方案.docx', size: 2048, url: 'https://dl.qq.com/fs/F1' } },
    { type: 'file', data: { size: 1 } }, // 没名字，不收
    { type: 'mystery', data: { x: 1 } }
  ])
  assert.equal(media.images.length, 1)
  assert.equal(media.images[0].url, 'https://multimedia.nt.qq.com.cn/x?rkey=abc')
  assert.equal(media.images[0].file, 'img1.jpg')
  assert.equal(media.files.length, 1)
  assert.equal(media.files[0].name, '方案.docx')
  assert.equal(media.files[0].size, 2048)
  assert.equal(media.files[0].url, 'https://dl.qq.com/fs/F1')
  assert.equal(extractMedia('字符串').images.length, 0)
  assert.equal(extractMedia(null).files.length, 0)
  // extractText 保持占位不动 —— 递话人话要干净
  assert.equal(extractText([{ type: 'image', data: { url: 'https://x' } }]), '[图片]')
})

test('mediaLines 把图直链和文件拼成行，文件带直链多一行', () => {
  const lines = mediaLines({
    images: [{ url: 'https://m/a?rkey=k', file: 'a.jpg' }],
    files: [
      { id: 'F1', name: '方案.docx', size: 8151, url: 'https://dl/x' },
      { id: 'F2', name: '没链接.docx', size: 0, url: '' }
    ]
  })
  assert.equal(lines, '\n[图片直链] https://m/a?rkey=k\n[文件] 方案.docx（8KB）\n[文件直链] https://dl/x\n[文件] 没链接.docx')
  assert.equal(mediaLines({ images: [], files: [] }), '')
  assert.equal(mediaLines(null), '')
})

test('extractText 把段落压成一行，认识的段给占位', () => {
  const out = extractText([
    { type: 'text', data: { text: '看看这个 ' } },
    { type: 'image', data: { file: 'x.jpg' } },
    { type: 'text', data: { text: ' 好看吗' } }
  ])
  assert.equal(out, '看看这个 [图片] 好看吗')
})

test('extractText 认字符串、丢空段、不认识的段不炸', () => {
  assert.equal(extractText('  直接的话  '), '直接的话')
  assert.equal(extractText([{ type: 'text', data: {} }, { type: 'mystery', data: { x: 1 } }]), '')
  assert.equal(extractText(null), '')
  assert.equal(extractText(42), '')
})

test('json 卡片学出标题和链接，学不出退回占位', () => {
  // 老分享卡：meta.news 里带标题和 qqdocurl
  const newsCard = {
    type: 'json',
    data: {
      data: JSON.stringify({
        title: '外部分享',
        meta: { news: [{ title: '识海架构笔记', qqdocurl: 'https://docs.qq.com/x' }] }
      })
    }
  }
  assert.equal(extractText([newsCard]), '[卡片]识海架构笔记（https://docs.qq.com/x）')
  // 只认得出 prompt
  assert.equal(extractText([{ type: 'json', data: { data: JSON.stringify({ prompt: '[分享] 一张图' }) } }]), '[卡片][分享] 一张图')
  // miniapp 形状
  assert.equal(
    extractText([{ type: 'json', data: { data: JSON.stringify({ meta: { miniapp: { title: '小程序', jumpUrl: 'https://m.qq/x' } } }) } }]),
    '[卡片]小程序（https://m.qq/x）'
  )
  // 坏 JSON / 没东西 → 占位
  assert.equal(extractText([{ type: 'json', data: { data: 'not json' } }]), '[卡片]')
  assert.equal(extractText([{ type: 'json', data: {} }]), '[卡片]')
})

test('formatPrompt 带昵称；没昵称退回号（尾部带不可信包裹）', () => {
  assert.equal(formatPrompt({ prefix: '【QQ】', nickname: '肥鱼', userId: 123, text: '嗨' }), `【QQ】肥鱼（123）说：嗨 ${PROMPT_UNTRUSTED_NOTE}`)
  assert.equal(formatPrompt({ prefix: '【QQ】', userId: 123, text: '嗨' }), `【QQ】123（123）说：嗨 ${PROMPT_UNTRUSTED_NOTE}`)
})

test('回话认前缀', () => {
  assert.equal(replyLooksBound('【QQ】', '【QQ】肥鱼说：x'), true)
  assert.equal(replyLooksBound('【QQ】', '随便聊两句'), false)
})

test('私聊白名单：名单外不递，空名单全不递', () => {
  const ev = { post_type: 'message', message_type: 'private', user_id: 10001 }
  assert.equal(isAllowedPrivate(ev, [10001, '10002']), true)
  assert.equal(isAllowedPrivate(ev, ['999']), false)
  assert.equal(isAllowedPrivate(ev, []), false)
  assert.equal(isAllowedPrivate({ ...ev, message_type: 'group' }, [10001]), false)
  assert.equal(isAllowedPrivate({ post_type: 'notice' }, [10001]), false)
  assert.equal(isAllowedPrivate(null, [10001]), false)
})

test('群白名单与日志行', () => {
  const ev = { post_type: 'message', message_type: 'group', group_id: 222222222, user_id: 10001 }
  assert.equal(isAllowedGroup(ev, [222222222]), true)
  assert.equal(isAllowedGroup(ev, [111]), false)
  assert.equal(formatGroupLog(ev, '大家好'), '群 222222222 · 10001：大家好')
})

test('splitBubbles 按空行拆段，段内单换行不碎', () => {
  assert.deepEqual(splitBubbles('收到，记下了'), ['收到，记下了'])
  assert.deepEqual(splitBubbles('第一段第一行\n第一段第二行\n\n第二段'), ['第一段第一行\n第一段第二行', '第二段'])
  assert.deepEqual(splitBubbles('第一句\n第二句，句号省掉'), ['第一句\n第二句，句号省掉'])
  assert.deepEqual(splitBubbles('   '), [])
  assert.deepEqual(splitBubbles(null), [])
})

test('splitBubbles 超 cap 的并进最后一条', () => {
  const nine = Array.from({ length: 11 }, (_, i) => '句' + (i + 1)).join('\n\n')
  const out = splitBubbles(nine, { maxBubbles: 8 })
  assert.equal(out.length, 8)
  assert.equal(out[7], '句8 句9 句10 句11')
})

test('clampReply 截断加省略号，emoji 不切半个', () => {
  assert.equal(clampReply('  短话  ', 10), '短话')
  const long = '啊'.repeat(20)
  const out = clampReply(long, 10)
  assert.equal(out, '啊'.repeat(10) + '…')
  const emoji = '😀'.repeat(5)
  const out2 = clampReply(emoji, 3)
  assert.equal(out2, '😀😀😀…')
  assert.equal(clampReply('', 10), '')
  assert.equal(clampReply(null, 10), '')
})

test('PendingReplies：递话 → 认 turn → 接回话', () => {
  const p = new PendingReplies()
  p.mark(10001, '【QQ】肥鱼（10001）说：在吗', 1000)
  const key = p.bindTurn('【QQ】', '【QQ】肥鱼（10001）说：在吗', 7, 1100)
  assert.ok(key)
  const got = p.takeReply(7, 1200)
  assert.ok(got)
  assert.equal(got.userId, '10001')
  assert.equal(p.takeReply(7, 1300), null)
})

test('PendingReplies：user/message 没带 turn 时按先后兜底', () => {
  const p = new PendingReplies()
  p.mark(10001, 'first', 1000)
  const got = p.takeAwaiting(1100)
  assert.equal(got.userId, '10001')
  assert.equal(p.takeAwaiting(1200), null)
})

test('PendingReplies：过期的不回、递话失败能撤', () => {
  const p = new PendingReplies({ staleMs: 1000 })
  p.mark(10001, 'x', 1000)
  assert.equal(p.takeAwaiting(5000), null)
  const k = p.mark(10002, 'y', 5000)
  p.fail(k)
  assert.equal(p.size, 0)
})

test('PendingReplies：turn 收尾作废', () => {
  const p = new PendingReplies()
  p.mark(10001, 'x', 1000)
  p.bindTurn('【QQ】', '【QQ】x', 3, 1100)
  p.dropTurn(3)
  assert.equal(p.takeReply(3, 1200), null)
})

test('PendingReplies：bindTurn 先精确认那行话，私聊和群 @ 混着来不认错主', () => {
  const p = new PendingReplies()
  p.mark('1', '【QQ】甲（1）说：早', 1000)
  const k2 = p.mark('2', '【QQ】乙（2）@我（群 9）说：喂', 1100, { chatType: 'group', groupId: '9' })
  assert.equal(p.bindTurn('【QQ】', '【QQ】乙（2）@我（群 9）说：喂', 5, 1200), k2)
  const got = p.takeReply(5, 1300)
  assert.equal(got.userId, '2')
  assert.equal(got.meta.chatType, 'group')
  assert.equal(got.meta.groupId, '9')
})

test('PendingReplies：认领过的挂起从认领时刻起算过期（2026-11-07 真事回归）', () => {
  // 真事：一条群消息 13:54 收到，宿主 14:44 才开始答，我干到 15:00 才收尾 ——
  // 按「收到时刻」算已经过了 staleSeconds，回话在最后一刻被判过期丢掉。
  const p = new PendingReplies({ staleMs: 1000, inFlightMs: 6 * 60 * 60 * 1000 })
  p.mark('1', '【QQ】甲（1）@我（群 9）说：喂', 1000, { chatType: 'group', groupId: '9', requestId: 'rpc-1' })
  const key = p.bindTurn('【QQ】', '【QQ】甲（1）@我（群 9）说：喂', 7, 1000 + 50 * 60 * 1000, 'rpc-1')
  assert.ok(key)
  const got = p.takeReply(7, 1000 + 55 * 60 * 1000)
  assert.ok(got, '认领后 5 分钟内不该被判过期')
  assert.equal(got.meta.groupId, '9')
})

test('PendingReplies：没认领的挂起照样按 staleMs 过期（宽窗只给认领过的）', () => {
  const p = new PendingReplies({ staleMs: 1000, inFlightMs: 6 * 60 * 60 * 1000 })
  p.mark('1', 'x', 1000)
  assert.equal(p.takeAwaiting(5000), null)
})

test('PendingReplies：保留期比过期判定长 —— 宿主回显晚了几小时，挂起还在', () => {
  const p = new PendingReplies({ staleMs: 1000, keepMs: 24 * 60 * 60 * 1000 })
  p.mark('1', '【QQ】甲说：早', 1000, { requestId: 'rpc-x' })
  p.mark('2', '【QQ】乙说：晚', 2000) // mark 会触发 sweep：staleMs 过了也不该清
  assert.equal(p.size, 2)
  const key = p.bindTurn('【QQ】', '【QQ】甲说：早', null, 5000, 'rpc-x')
  assert.ok(key, '回显晚了几小时也还能认领上')
})

test('PendingReplies：bindTurnStart 认走的那条也从认领时刻起算', () => {
  const p = new PendingReplies({ staleMs: 1000, inFlightMs: 6 * 60 * 60 * 1000 })
  p.mark('1', '【QQ】甲说：早', 1000, { requestId: 'rpc-1' })
  p.bindTurn('【QQ】', '【QQ】甲说：早', null, 1000 + 50 * 60 * 1000, 'rpc-1')
  const key = p.bindTurnStart(7, 1000 + 50 * 60 * 1000)
  assert.ok(key)
  assert.ok(p.takeReply(7, 1000 + 55 * 60 * 1000))
})

test('PendingReplies：存档带 primedAt/boundAt，重载后还在，宽窗也还在', () => {
  const p = new PendingReplies({ staleMs: 1000, inFlightMs: 6 * 60 * 60 * 1000 })
  p.mark('1', '【QQ】甲说：早', 1000, { requestId: 'rpc-1' })
  p.bindTurn('【QQ】', '【QQ】甲说：早', null, 1100, 'rpc-1')
  const snap = p.entries()
  assert.equal(snap[0].primedAt, 1100)
  assert.equal(snap[0].boundAt, 1100)
  const p2 = new PendingReplies({ staleMs: 1000, inFlightMs: 6 * 60 * 60 * 1000, initial: snap })
  assert.ok(p2.takeAwaiting(1200), '重载后这条还认得出、还不过期')
})

test('assistantText 只取 text 块；userText 取第一条非空', () => {
  assert.equal(assistantText({ content: [{ type: 'text', text: '回话 ' }, { type: 'text', text: '两段' }] }), '回话 两段')
  assert.equal(assistantText({ content: [{ type: 'tool-call' }] }), '')
  assert.equal(assistantText(null), '')
  assert.equal(userText({ content: [{ type: 'text', text: '' }, { type: 'text', text: '第二条' }] }), '第二条')
})

test('assistantText 永不取 thinking 块（2026-11-04 群里泄漏事故的回归）', () => {
  assert.equal(
    assistantText({ content: [{ type: 'thinking', text: '先分析一下他这话什么意思', thinking: '先分析一下' }, { type: 'text', text: '正文' }] }),
    '正文'
  )
  assert.equal(assistantText({ content: [{ type: 'thinking', text: '只有思考' }] }), '')
  // 真实泄漏形状：宿主把整轮 content 给过来（思考在前、正文在后），只认 type==='text'
  assert.equal(
    assistantText({ content: [{ type: 'thinking', text: 'a\nb\nc' }, { type: 'text', text: '记住了' }, { type: 'tool-call', name: 'x' }] }),
    '记住了'
  )
})

test('宿主有时给字符串内容：userText/assistantText 都直接接', () => {
  assert.equal(userText({ content: '【QQ】好友甲（10001）说：在吗' }), '【QQ】好友甲（10001）说：在吗')
  assert.equal(userText({ content: '  前后有空格  ' }), '前后有空格')
  assert.equal(userText({}), '')
  assert.equal(assistantText({ content: '一整段回话' }), '一整段回话')
})

test('userText 块没标 type 也能捞到字；content 是单对象也接', () => {
  assert.equal(userText({ content: [{ text: '没标 type 的块' }] }), '没标 type 的块')
  assert.equal(userText({ content: { text: '单对象' } }), '单对象')
  assert.equal(userText({ content: [{ type: 'image', url: 'x' }] }), '')
})

test('atMe：数组 at 段、字符串 CQ:at、别的号和空 selfUin 都分得清', () => {
  const ev = { message: [{ type: 'at', data: { qq: '20002' } }, { type: 'text', data: { text: '你好' } }] }
  assert.equal(atMe(ev, '20002'), true)
  assert.equal(atMe({ message: [{ type: 'at', data: { qq: 20002 } }] }, '20002'), true)
  assert.equal(atMe({ message: [{ type: 'at', data: { qq: '99999' } }] }, '20002'), false)
  assert.equal(atMe({ message: [{ type: 'text', data: { text: '没 @' } }] }, '20002'), false)
  assert.equal(atMe({ message: '[CQ:at,qq=20002] 会说话吗' }, '20002'), true)
  assert.equal(atMe({ message: '[CQ:at,qq=11111] 不是我' }, '20002'), false)
  assert.equal(atMe(ev, ''), false)
  assert.equal(atMe(null, '20002'), false)
})

test('formatGroupPrompt：带上群号那一行（尾部带不可信包裹）', () => {
  assert.equal(
    formatGroupPrompt({ prefix: '【QQ】', nickname: '柒', userId: 10003, groupId: 222222222, text: '你会说话吗？' }),
    `【QQ】柒（10003）@我（群 222222222）说：你会说话吗？ ${PROMPT_UNTRUSTED_NOTE}`
  )
  assert.equal(
    formatGroupPrompt({ prefix: '【QQ】', userId: 111, groupId: 222, text: '没昵称退回号' }),
    `【QQ】111（111）@我（群 222）说：没昵称退回号 ${PROMPT_UNTRUSTED_NOTE}`
  )
})

test('PendingReplies：meta 跟着挂起走，存档也带上', () => {
  const p = new PendingReplies()
  p.mark('10001', '私聊', 1000)
  p.mark('10002', '群里', 1100, { chatType: 'group', groupId: '222222222' })
  const priv = p.takeAwaiting(1200)
  assert.equal(priv.userId, '10001')
  assert.deepEqual(priv.meta, {})
  const grp = p.takeAwaiting(1300)
  assert.equal(grp.meta.chatType, 'group')
  assert.equal(grp.meta.groupId, '222222222')
  const p2 = new PendingReplies({ initial: [{ key: 'q-1-1', userId: '9', text: 'x', turn: null, at: 1, meta: { chatType: 'group', groupId: '42' } }] })
  assert.equal(p2.takeAwaiting(2).meta.groupId, '42')
  assert.deepEqual(p.entries(), [])
})

test('PendingReplies：rpcId 精认（宿主把 prompt 的 requestId 回显成 source.rpcId），turn/start 把 turn 认进去', () => {
  const p = new PendingReplies()
  const k1 = p.mark('1', '【QQ】甲（1）说：早', 1000, { requestId: 'qq-1-abc' })
  const k2 = p.mark('2', '【QQ】乙（2）@我（群 9）说：喂', 1100, { chatType: 'group', groupId: '9', requestId: 'qqg-2-def' })
  // user/message 不带 turn：rpcId 认主 → primedAt 记下，等 turn/start
  assert.equal(p.bindTurn('【QQ】', '【QQ】乙（2）@我（群 9）说：喂', null, 1200, 'qqg-2-def'), k2)
  // turn/start（真 turn）：认给被 rpcId 精认过、还没等到 turn 的那条
  assert.equal(p.bindTurnStart(9, 1250), k2)
  const got = p.takeReply(9, 1300)
  assert.equal(got.userId, '2')
  assert.equal(got.meta.requestId, 'qqg-2-def')
  // 另一条还挂着：它的 rpcId 认不进已认领的
  assert.equal(p.bindTurn('【QQ】', '【QQ】甲（1）说：早', null, 1400, 'qq-1-abc'), k1)
  assert.equal(p.bindTurnStart(10, 1450), k1)
  assert.equal(p.takeReply(10, 1500).userId, '1')
})

test('PendingReplies：内容精认也 primed，turn/start 认走；兜底认领的 turn/start 不抢', () => {
  const p = new PendingReplies()
  p.mark('1', '【QQ】甲说：早', 1000)
  const k = p.bindTurn('【QQ】', '【QQ】甲说：早', null, 1100) // 内容精认（那行话就是递进去的原文）→ primed
  assert.notEqual(k, null)
  assert.equal(p.bindTurnStart(3, 1150), k) // turn/start 把这一转认给它
  assert.equal(p.takeReply(3, 1200).text, '【QQ】甲说：早')

  // 兜底认领（不是原文、没 rpcId）→ 不 primed，turn/start 抢不走（GUI 开的转不影响我们）
  const q = new PendingReplies()
  q.mark('2', '【QQ】乙说：别的', 1000)
  assert.notEqual(q.bindTurn('【QQ】', '【QQ】丙（3）说：完全另一句', null, 1100), null)
  assert.equal(q.bindTurnStart(4, 1150), null)
  assert.equal(q.takeReply(4, 1200), null)
  assert.equal(q.takeAwaiting(1250).text, '【QQ】乙说：别的')

  // takeAwaiting 按 (primedAt ?? at) 升序 —— 先挂的先回，primed 不插队
  const r = new PendingReplies()
  r.mark('1', '先挂的', 1000)
  r.mark('2', '后挂的', 2000, { requestId: 'qq-2-x' })
  assert.notEqual(r.bindTurn('【QQ】', '【QQ】后挂的', null, 2100, 'qq-2-x'), null)
  assert.equal(r.takeAwaiting(2200).text, '先挂的')
  assert.equal(r.takeAwaiting(2300).text, '后挂的')
  assert.equal(r.takeAwaiting(2400), null)
})

test('looksGroupAddressed：群回话必须点名（@ 开头）才发——内部小结漏不进群', () => {
  assert.equal(looksGroupAddressed('@柒 会，看到就会应'), true)
  assert.equal(looksGroupAddressed('＠群友 全角也认'), true)
  assert.equal(looksGroupAddressed('  @菠萝吹雪 前面有空白也算'), true)
  assert.equal(looksGroupAddressed('（内部小结：retcode 0，seq 955990895）'), false)
  assert.equal(looksGroupAddressed('会，看到就会应'), false)
  assert.equal(looksGroupAddressed('【QQ】肥鱼说：在吗'), false)
  assert.equal(looksGroupAddressed(''), false)
  assert.equal(looksGroupAddressed(null), false)
})

test('privateReplyText：@ 前的正文归她，@ 起的成串气泡归群（v0.9.1 串台改道的另一半）', () => {
  const texts = ['先查了群里的账', '@群友丁 判词如下\n\n量刑看主观恶性']
  assert.equal(privateReplyText(texts), '先查了群里的账')
  assert.equal(groupReplyText(texts), '@群友丁 判词如下\n\n量刑看主观恶性')
})

test('privateReplyText：整轮只有群答复时她那边一个字不欠发', () => {
  assert.equal(privateReplyText(['@群友丁 判词']), '')
})

test('privateReplyText：没有 @ 的正文整段归她；空入参给空串', () => {
  assert.equal(privateReplyText(['今晚吃什么', '困了']), '今晚吃什么\n\n困了')
  assert.equal(privateReplyText([]), '')
  assert.equal(privateReplyText(null), '')
})

test('groupReplyText：过程话在前的整段也能把 @ 气泡抠出来（2026-11-10 MC 答复同型）', () => {
  const one = '她吃晚饭都不忘给我留个世纪难题——这题照实答，虽然会挨砖：\n\n@好友甲 这题我有立场但不怕亮——mc 是老祖宗\n\n迷你世界算抄作业的师弟\n\n@好友甲 要我选：我投 mc'
  const out = groupReplyText([one])
  assert.equal(out, '@好友甲 这题我有立场但不怕亮——mc 是老祖宗\n\n迷你世界算抄作业的师弟\n\n@好友甲 要我选：我投 mc')
})

test('groupReplyText：从后往前找，最后一段带 @ 就用最后一段', () => {
  const texts = ['（内部小结：retcode 0）', '干完了。', '@柒 会，看到就会应']
  assert.equal(groupReplyText(texts), '@柒 会，看到就会应')
})

test('groupReplyText：全角 ＠ 也认', () => {
  assert.equal(groupReplyText(['废话一句', '＠群友 全角也认']), '＠群友 全角也认')
})

test('groupReplyText：没有点名气泡就返回空串（调用方按没点名处理）', () => {
  assert.equal(groupReplyText(['（内部小结：seq 955990895）', '干完了，收工']), '')
  assert.equal(groupReplyText([]), '')
  assert.equal(groupReplyText(null), '')
})

// ---------------------------------------------------------------- 会话隔离（v0.5.0）

import { normPath, isUnder, normalizeRoots, scopeOk } from '../lib/scope.js'
import { applyConfigPatch, VALIDATORS } from '../lib/report.js'

test('scopeOk：denyRoots 黑名单优先于一切', () => {
  const gates = { targetRoot: 'E:\\数据', allowRoots: [], denyRoots: ['E:\\数据\\秘密'] }
  assert.equal(scopeOk('E:\\数据\\秘密\\账.jsonl', gates).ok, false)
  // 就算 allowRoots 明着放行，deny 也赢
  const gates2 = { targetRoot: 'E:\\数据', allowRoots: ['E:\\数据\\秘密'], denyRoots: ['E:\\数据\\秘密'] }
  assert.equal(scopeOk('E:\\数据\\秘密\\账.jsonl', gates2).ok, false)
})

test('scopeOk：allowRoots 填了就只放行名单内', () => {
  const gates = { targetRoot: '', allowRoots: ['E:\\dsh-home\\.dsh'], denyRoots: [] }
  assert.equal(scopeOk('E:\\dsh-home\\.dsh\\.dsh-qq-bridge\\pending.json', gates).ok, true)
  assert.equal(scopeOk('E:\\别的盘\\pending.json', gates).ok, false)
})

test('scopeOk：targetRoot 兜底收窄，空 = 不收窄', () => {
  const gates = { targetRoot: 'E:\\dsh-home\\.dsh', allowRoots: [], denyRoots: [] }
  assert.equal(scopeOk('E:\\dsh-home\\.dsh\\bridge.log', gates).ok, true)
  assert.equal(scopeOk('C:\\Windows\\system32\\x.json', gates).ok, false)
  const open = { targetRoot: '', allowRoots: [], denyRoots: [] }
  assert.equal(scopeOk('C:\\随便哪儿\\x.json', open).ok, true)
})

test('scopeOk：路径容错——大小写/正反斜杠/尾斜杠/相对解析', () => {
  const gates = { targetRoot: 'e:/dsh-home/.dsh/', allowRoots: [], denyRoots: [] }
  assert.equal(scopeOk('E:\\dsh-home\\.dsh\\.dsh-qq-bridge\\seen.json', gates).ok, true)
  assert.equal(scopeOk('e:/dsh-home/.dsh/bridge.log', gates).ok, true)
  assert.equal(scopeOk('E:\\dsh-home\\.dsh-others\\x.json', gates).ok, false) // 前缀相似但不是同一目录
})

test('scopeOk：坏输入不崩——空路径/缺键/根本身相等也算在内', () => {
  assert.equal(scopeOk('', { targetRoot: 'E:\\x', allowRoots: [], denyRoots: [] }).ok, false)
  assert.equal(scopeOk(null, { targetRoot: 'E:\\x', allowRoots: [], denyRoots: [] }).ok, false)
  assert.equal(scopeOk('E:\\x\\a.json', {}).ok, true) // 没配任何键 = 不收窄
  assert.equal(scopeOk('E:\\x', { targetRoot: 'E:\\x', allowRoots: [], denyRoots: [] }).ok, true) // 根本身
})

test('normPath/isUnder/normalizeRoots：坏值洗掉，好值归一', () => {
  assert.equal(normPath('E:\\A\\B\\'), normPath('e:/a/b'))
  assert.equal(isUnder('E:\\A\\B\\c.txt', 'e:/a/b'), true)
  assert.equal(isUnder('E:\\A\\Bc.txt', 'e:/a/b'), false) // 字符前缀不算目录包含
  assert.deepEqual(normalizeRoots([' E:\\A ', '', 'e:/a/', 42, null]), ['E:\\A', 'e:/a/']) // 数字/null 丢掉，返回原样洗过的字符串
  assert.deepEqual(normalizeRoots('不是数组'), [])
})

test('applyConfigPatch：白名单内的键收下，白名单外的拒', () => {
  const r = applyConfigPatch({ overrides: {}, patch: { enabled: false, replyMaxChars: 300, 乱写的键: 'x' } })
  assert.equal(r.ok, false) // 有一个不认的键，就不算全过
  assert.deepEqual(r.accepted, ['enabled', 'replyMaxChars'])
  assert.deepEqual(r.rejected, [{ key: '乱写的键', reason: '白名单外的键，不认' }])
  assert.equal(r.overrides.enabled, false)
  assert.equal(r.overrides.replyMaxChars, 300)
})

test('applyConfigPatch：类型校验与区间钳制', () => {
  const r = applyConfigPatch({ overrides: {}, patch: {
    replyMaxChars: 99999,      // 超 2000 → 钳到 2000
    staleSeconds: 1,           // 低于 30 → 钳到 30
    onebotHttp: 'ftp://x',     // 不认的协议 → 拒
    allowUsers: '不是数组',      // 类型不对 → 拒
    promptPrefix: '',          // 空串 → 拒
  } })
  assert.equal(r.ok, false) // 有拒收就不算全过
  assert.equal(r.accepted.length, 2)
  assert.match(r.accepted[0], /replyMaxChars/)
  assert.match(r.accepted[1], /staleSeconds/)
  const reasons = Object.fromEntries(r.rejected.map((x) => [x.key, x.reason]))
  assert.match(reasons.onebotHttp, /http/)
  assert.match(reasons.allowUsers, /数组|列表/)
  assert.match(reasons.promptPrefix, /空/)
  assert.equal(r.overrides.replyMaxChars, 2000)
  assert.equal(r.overrides.staleSeconds, 30)
})

test('applyConfigPatch：空 patch 与坏 patch 不炸、不改原对象', () => {
  const overrides = { enabled: true }
  const r1 = applyConfigPatch({ overrides, patch: {} })
  assert.equal(r1.ok, true)
  assert.deepEqual(r1.accepted, [])
  const r2 = applyConfigPatch({ overrides, patch: null })
  assert.equal(r2.ok, true) // null patch 当没递东西，不炸
  assert.deepEqual(r2.accepted, [])
  assert.deepEqual(overrides, { enabled: true }) // 原对象没被改
})

test('applyConfigPatch：httpToken/wsToken 收任意字符串（trim），sessionId 数字也容成字符串', () => {
  const r = applyConfigPatch({ overrides: {}, patch: { httpToken: '  tok-123  ', wsToken: '', sessionId: 42, promptPrefix: '【QQ】' } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.rejected, [])
  assert.equal(r.overrides.httpToken, 'tok-123')
  assert.equal(r.overrides.wsToken, '')
  assert.equal(r.overrides.sessionId, '42')
  assert.equal(r.overrides.promptPrefix, '【QQ】')
})

test('VALIDATORS 白名单 19 键，一个不多', () => {
  assert.deepEqual(Object.keys(VALIDATORS).sort(), [
    'allowGroups', 'allowRoots', 'allowUsers', 'denyRoots', 'enabled',
    'httpToken', 'messageLogEnabled', 'messageLogMaxLines', 'onebotHttp',
    'onebotWs', 'pokeBack', 'promptPrefix', 'replyMaxChars', 'selfUin',
    'sessionId', 'staleSeconds', 'stickerEnabled', 'targetRoot', 'wsToken',
  ])
})

/* ---------- 群 @ 递话带上下文（v0.6.0） ---------- */

test('messageLog.recent 读群里分册的尾部，旧→新，能把当前这条抠掉', async () => {
  const { makeMessageLog } = await import('../index.js')
  const tmp = mkdtempSync(join(tmpdir(), 'bridge-ctx-'))
  try {
    const ml = makeMessageLog(tmp, 2000, null)
    const base = Date.now() - 600000
    const mid = (i) => `m-${base}-${i}`
    for (let i = 0; i < 8; i++) {
      ml.note({ at: base + i * 1000, chatType: 'group', groupId: '615', userId: `u${i}`, nickname: `群友${i}`, text: `第${i}句`, mid: mid(i), atMe: false })
    }
    const tail = ml.recent('615', 6, mid(7)) // 当前这条（最后一条）抠掉
    assert.equal(tail.length, 6)
    assert.equal(tail[0].text, '第1句')
    assert.equal(tail[5].text, '第6句')
    // 群外的抠不进来；没记录的群给空
    assert.equal(ml.recent('999', 6, '').length, 0)
    // 隔离拦得住：deny 了目录就读不出
    const denied = makeMessageLog(tmp, 2000, () => false)
    assert.deepEqual(denied.recent('615', 6, ''), [])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('groupContextBlock 折出「群里刚才聊的」一小块，超长截断，没记录给空串', async () => {
  const { makeMessageLog, groupContextBlock } = await import('../index.js')
  const tmp = mkdtempSync(join(tmpdir(), 'bridge-ctx2-'))
  try {
    const ml = makeMessageLog(tmp, 2000, null)
    const base = Date.now() - 120000
    ml.note({ at: base, chatType: 'group', groupId: '615', userId: 'u1', nickname: '好友', text: '教了能教好，过几轮对话就忘', mid: 'a', atMe: false })
    ml.note({ at: base + 1000, chatType: 'group', groupId: '615', userId: 'u2', nickname: '群友乙', text: '别指望我记住\n记不住是真的', mid: 'b', atMe: false })
    const ev = { group_id: '615', message_id: 'b' } // 群友乙 @ 我这条自己不进上下文
    const block = groupContextBlock(ml, ev)
    assert.ok(block.startsWith('\n（群里刚才聊的，供接话：'), '带人话开头')
    assert.ok(block.includes('好友：教了能教好'), '带昵称和正文')
    assert.ok(!block.includes('记不住是真的'), '当前这条不进上下文')
    assert.ok(!block.includes('\n记不住'), '多行正文折成一行')
    // 没记录的群 → 空串；坏 at → --:-- 不崩
    assert.equal(groupContextBlock(ml, { group_id: '999', message_id: '' }), '')
    assert.equal(groupContextBlock(null, ev), '')
    ml.note({ at: '不是数字', chatType: 'group', groupId: '615', userId: 'u3', nickname: '坏时间', text: 'x', mid: 'c', atMe: false })
    assert.ok(groupContextBlock(ml, { group_id: '615', message_id: '不在' }).includes('--:-- 坏时间：x'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('groupContextLive 递话当下向协议端拉真账：抠触发自己、旧→新、拉不动退 null 走文件兜底', async () => {
  const { groupContextLive } = await import('../index.js')
  // 假 onebot：接口给的是新→旧（OneBot get_group_msg_history 的实际顺序）
  const calls = []
  const onebot = {
    call: async (action, params) => {
      calls.push({ action, params })
      return { data: { messages: [
        { message_id: 'b', time: 1794076000, sender: { nickname: '群友乙' }, raw_message: '你觉得好友说的要试试嘛？' },
        { message_id: 'c', time: 1794075900, sender: { nickname: '好友' }, raw_message: '你让她每句话都要有语气助词' },
        { message_id: 'd', time: 1794075800, sender: { nickname: '群友丙' }, raw_message: '要不换个插件' },
        { message_id: 'a', time: 1794075700, sender: { nickname: '路人' }, raw_message: '' } // 空行跳过
      ] } }
    }
  }
  const block = await groupContextLive(onebot, { group_id: '615', message_id: 'b' })
  assert.equal(calls[0].action, 'get_group_msg_history')
  assert.equal(calls[0].params.group_id, '615')
  assert.ok(block.includes('好友：你让她每句话都要有语气助词'), '带实时拉到的真账')
  assert.ok(!block.includes('要试试嘛'), '触发这条自己不进上下文')
  assert.ok(block.indexOf('要不换个插件') < block.indexOf('语气助词'), '旧→新顺序')
  assert.ok(!block.includes('路人'), '空正文行跳过')
  // 拉不动 → null（调用方退回 groupContextBlock）
  assert.equal(await groupContextLive(null, { group_id: '615', message_id: 'b' }), null)
  assert.equal(await groupContextLive({ call: async () => { throw new Error('断') } }, { group_id: '615', message_id: 'b' }), null)
  assert.equal(await groupContextLive(onebot, { group_id: '', message_id: 'b' }), null)
  assert.equal(await groupContextLive({ call: async () => ({ data: { messages: [] } }) }, { group_id: '615', message_id: 'b' }), null)
})

test('isToolCallMarker：工具调用标记不当人话（2026-11-08 真事回归）', () => {
  // 真事里原样发进她私聊的那一段
  assert.equal(isToolCallMarker('<｜DSML｜ calls>'), true)
  assert.equal(isToolCallMarker('<|DSML| calls>'), true)
  assert.equal(isToolCallMarker('<｜DSML｜tool_calls>'), true)
  assert.equal(isToolCallMarker('<|tool_call|>'), true)
  assert.equal(isToolCallMarker('<tool calls>'), true)
  // 人话不算
  assert.equal(isToolCallMarker('我看了一下，DSML 那套调用标记我不当回话发'), false)
  assert.equal(isToolCallMarker('这段带 <tool_call> 但不是整段标签'), false)
  assert.equal(isToolCallMarker('这段带 <｜DSML｜ calls> 但不是整段标签'), false)
  assert.equal(isToolCallMarker(''), false)
  assert.equal(isToolCallMarker(null), false)
  assert.equal(isToolCallMarker(undefined), false)
  assert.equal(isToolCallMarker('  <｜DSML｜ calls>  '), true)
})

test('primedWaitingCount：数「已认下却没人领」的挂起（宿主没接上时的诊断）', () => {
  const p = new PendingReplies({ staleMs: 60_000 })
  assert.equal(p.primedWaitingCount(), 0)
  p.mark('u1', '【QQ】在吗')
  p.mark('u2', '【QQ】在吗')
  // 只 prime 第一条（内容精认）—— 它 turn 还是空的，算「等着的」
  p.bindTurn('【QQ】', '【QQ】在吗', Number.NaN, Date.now(), 'rpc-1')
  assert.equal(p.primedWaitingCount(), 1)
  // turn/start 认走之后就不再是「没人领」
  p.bindTurnStart(7, Date.now())
  assert.equal(p.primedWaitingCount(), 0)
  // 被领走的那条也不在数里
  assert.equal(p.takeReply(7) !== null, true)
  assert.equal(p.primedWaitingCount(), 0)
  p.fail(p.mark('u3', '【QQ】在吗'))
  assert.equal(p.primedWaitingCount(), 0)
})

test('takeLatestPrimed：精确路没接上时，领「最近刚认下」的那条（2026-11-10 回话静默丢的回归）', () => {
  const now = 1_700_000_000_000
  const p = new PendingReplies({ staleMs: 60_000 })
  // 两条递话都被认下过（rpcId 精认）：旧的一条一刻钟前、新的一条刚进来
  p.mark('u1', '【QQ】旧的', now - 30 * 60_000, { requestId: 'rpc-old' })
  p.mark('u2', '【QQ】早～', now - 60_000, { requestId: 'rpc-new' })
  p.bindTurn('【QQ】', '【QQ】旧的', Number.NaN, now - 25 * 60_000, 'rpc-old')
  p.bindTurn('【QQ】', '【QQ】早～', Number.NaN, now - 50_000, 'rpc-new')
  assert.equal(p.primedWaitingCount(), 2)
  // 兜底只领最近那条；窗口外那条（25 分钟前认下）不动
  const got = p.takeLatestPrimed(now, 5 * 60_000)
  assert.equal(got?.text, '【QQ】早～')
  assert.equal(p.primedWaitingCount(), 1)
  assert.equal(p.takeLatestPrimed(now, 5 * 60_000), null)
  // 刚收到、还没被认下的不算（它不是「正在被回的那条」）
  p.mark('u3', '【QQ】还没认下', now - 10_000)
  assert.equal(p.takeLatestPrimed(now, 5 * 60_000), null)
  // 已经绑了 turn 的（有主的）不抢
  p.mark('u4', '【QQ】有主的', now - 30_000, { requestId: 'rpc-3' })
  p.bindTurn('【QQ】', '【QQ】有主的', 9, now - 20_000, 'rpc-3')
  assert.equal(p.takeLatestPrimed(now, 5 * 60_000), null)
  // 认下的那条超过 inFlight 宽窗之后连兜底也不给（沿用 _expired 的判定）
  const q = new PendingReplies({ staleMs: 60_000, inFlightMs: 120_000 })
  q.mark('u5', '【QQ】过期了', now - 60 * 60_000, { requestId: 'rpc-x' })
  q.bindTurn('【QQ】', '【QQ】过期了', Number.NaN, now - 30 * 60_000, 'rpc-x')
  assert.equal(q.takeLatestPrimed(now, 60 * 60_000), null)
})

test('revive：作废放回（v0.8.7）——领走没发出去的挂起不没收，放回后还能再领', () => {
  const now = 1_700_000_000_000
  const p = new PendingReplies({ staleMs: 60_000 })
  // 2026-11-10 真事：群友 16:14 点名的挂起被中间轮领走又作废，扩展榜没发进群
  p.mark('u1', '【QQ】扩展榜单', now - 60_000, { requestId: 'rpc-1' })
  p.bindTurn('【QQ】', '【QQ】扩展榜单', Number.NaN, now - 30_000, 'rpc-1')
  const got = p.takeLatestPrimed(now, 5 * 60_000)
  assert.equal(got?.text, '【QQ】扩展榜单')
  assert.equal(typeof got.key, 'string', '领走的条目要带 key（revive 靠它放回）')
  assert.equal(p.size, 0)
  // 放回：不没收，等真正的回话轮
  assert.equal(p.revive(got), true)
  assert.equal(p.size, 1)
  assert.equal(p.primedWaitingCount(), 1)
  // 重复放回不行（已在册）；空对象/没 key 的不行
  assert.equal(p.revive(got), false)
  assert.equal(p.revive(null), false)
  assert.equal(p.revive({ text: '没有 key' }), false)
  // 放回之后，下一个回话轮照常能领走（takeByKey 走认领路），且条目仍带 key
  const again = p.takeByKey(got.key, now)
  assert.equal(again?.text, '【QQ】扩展榜单')
  assert.equal(again.key, got.key)
  assert.equal(p.size, 0)
  // 放回要走存档（_changed）
  const seen = []
  const q = new PendingReplies({ staleMs: 60_000, onChange: (self) => seen.push(self.size) })
  q.mark('u2', '【QQ】再试', now, { requestId: 'rpc-2' })
  q.bindTurn('【QQ】', '【QQ】再试', Number.NaN, now + 500, 'rpc-2')
  const g2 = q.takeLatestPrimed(now + 1_000, 5 * 60_000)
  const n0 = seen.length
  assert.equal(q.revive(g2), true)
  assert.ok(seen.length > n0, 'revive 要触发存档')
})

test('takeWaitingGroup：恰有一条等着回的群挂起才取走（v0.9.1 串台改道）', () => {
  const now = Date.now()
  const q = new PendingReplies()
  q.mark('10003', '【QQ】', now, { chatType: 'group', groupId: '222222222', requestId: 'rpc-g1' })
  const g = q.takeWaitingGroup(now)
  assert.ok(g, '恰一条群挂起要取走')
  assert.equal(g.meta.chatType, 'group')
  assert.equal(g.meta.groupId, '222222222')
  assert.equal(q.size, 0, '取走要从队里删掉')
})

test('takeWaitingGroup：两条以上等着回的群挂起不取（分不清该发哪个群）', () => {
  const now = Date.now()
  const q = new PendingReplies()
  q.mark('111', '【QQ】a', now, { chatType: 'group', groupId: '222222222', requestId: 'rpc-g1' })
  q.mark('222', '【QQ】b', now, { chatType: 'group', groupId: '222222222', requestId: 'rpc-g2' })
  assert.equal(q.takeWaitingGroup(now), null, '两条群挂起宁可不取')
  assert.equal(q.size, 2, '不取也不删')
})

test('takeWaitingGroup：私聊挂起和已被认下的群挂起都不算数', () => {
  const now = Date.now()
  const q = new PendingReplies()
  q.mark('10001', '【QQ】私聊', now, { requestId: 'rpc-p1' })
  q.mark('10003', '【QQ】群', now, { chatType: 'group', groupId: '222222222', requestId: 'rpc-g1' })
  q.bindTurn('【QQ】', '【QQ】群', 3, now + 500, 'rpc-g1')
  assert.equal(q.takeWaitingGroup(now + 600), null, '私聊+已认下的都不取')
  assert.equal(q.size, 2)
})

test('takeWaitingGroup：过期的群挂起不取', () => {
  const now = Date.now()
  const q = new PendingReplies({ staleMs: 60_000 })
  q.mark('10003', '【QQ】旧群话', now - 10 * 60_000, { chatType: 'group', groupId: '222222222', requestId: 'rpc-old' })
  assert.equal(q.takeWaitingGroup(now), null, '过期的不取')
  assert.equal(q.size, 1, '过期不取也不删（sweep 的事）')
})

test('isSelfTalkBubble：整条被括号包住的是干活的笔记（v0.9.2 不外发）', () => {
  assert.ok(isSelfTalkBubble('（账都记上了）'), '全角括号整包')
  assert.ok(isSelfTalkBubble('(done)'), '半角括号整包')
  assert.ok(isSelfTalkBubble('（钩子也清了。\n这轮收工——）'), '带换行的整包也算')
  assert.ok(isSelfTalkBubble('  （等她回话或派活）  '), '前后空白不影响判定')
  assert.ok(!isSelfTalkBubble('（记一笔）明天对曲线'), '括号后还有正文的不算')
  assert.ok(!isSelfTalkBubble('麻了就对了，账本面前人人麻了'), '普通回话不算')
  assert.ok(!isSelfTalkBubble('（括号里（还套）一层）'), '套娃宁放过不误杀')
  assert.ok(!isSelfTalkBubble(''), '空串不算')
  assert.ok(!isSelfTalkBubble(null), '空值不算')
})
test('extractText：reply 段给 [引用:id] 占位（2026-11-21 引用链路修复）', () => {
  const segs = [{ type: 'reply', data: { id: '12345' } }, { type: 'text', data: { text: '看看这条' } }]
  assert.equal(extractText(segs), '[引用:12345]看看这条')
  assert.equal(extractText([{ type: 'reply', data: {} }]), '[引用]')
})
