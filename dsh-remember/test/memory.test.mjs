import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { deriveStandingBodyStates } from '../lib/fast.js'

import {
  SELF_MIN_WEIGHT,
  SLOW_TAU_BASE,
  activeCuriosities,
  activeSelfNodes,
  anchorSelfNode,
  clipSection,
  curiosityState,
  curiosityStats,
  cutByCodePoints,
  fastHabits,
  fastHabitIds,
  fadingSelfNodes,
  habitState,
  hasThought,
  indexNodes,
  isSealed,
  makeNode,
  normKind,
  normNodes,
  normSlot,
  openTitlesLine,
  parseSealUntil,
  rankNodes,
  recordCuriosity,
  renderYesterdayStream,
  recordHabit,
  recordSkill,
  relSealLeft,
  relTime,
  renderCuriositySection,
  renderHabitSection,
  renderLine,
  renderSection,
  renderSelfSection,
  renderUnsettledSection,
  restoreSelfNode,
  score,
  searchNodes,
  selfWeight,
  setSeal,
  setSealed,
  setWeight,
  skillState,
  skillWhereKey,
  slotLabel,
  summaryOf,
  supersedeSelf,
  tauDays,
  titleOf,
  touchNode,
  unsettledNodes,
} from '../lib/memory.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-01T02:00:00.000Z')

test('越重的淡得越慢', () => {
  assert.equal(tauDays(1), 30)
  assert.equal(tauDays(0), 2)
  const heavy = { weight: 1, lastAt: NOW - 10 * DAY }
  const light = { weight: 0.2, lastAt: NOW - 10 * DAY }
  const h = score(heavy, NOW)
  const l = score(light, NOW)
  assert.ok(h > l, '分量重的应该排前面')
})

test('刚写下的是满值，放久了会掉但不会掉成零', () => {
  const fresh = { weight: 0.8, lastAt: NOW }
  const old = { weight: 0.8, lastAt: NOW - 60 * DAY }
  const a = score(fresh, NOW)
  const b = score(old, NOW)
  assert.ok(a >= 0.79, `刚写下的该接近 0.8，实际 ${a}`)
  assert.ok(b < a * 0.7, `两个月前写的该明显掉下去，实际 ${b}`)
  assert.ok(b > 0, '淡不等于删，分数不该变负或归零')
})

test('按住的条不参与排名', () => {
  const node = { id: 'r_a', weight: 1, lastAt: NOW, sealed: true }
  assert.equal(score(node, NOW), -1)
  assert.equal(rankNodes([node], NOW, { limit: 3 }).length, 0)
  assert.equal(rankNodes([node], NOW, { limit: 3, includeSealed: true }).length, 1)
})

test('到点自松的按法：没到点 score 也是 -1，到点之后 score 回正（读取路径上算，账本没动）', () => {
  const base = { id: 'r_b', weight: 0.8, lastAt: NOW, kind: 'fact' }
  const held = { ...base, sealUntil: NOW + 30 * 60 * 1000 }
  assert.equal(score(held, NOW), -1, '没到点 = 按住 = -1')
  assert.ok(score(held, NOW + 30 * 60 * 1000 + 1) > 0, '到点 = 自己松开 = 分数回来')
  assert.equal(rankNodes([held], NOW + 30 * 60 * 1000 + 1, { limit: 3 }).length, 1, '到点后 rankNodes 也翻得出来')
  assert.equal(held.sealUntil, NOW + 30 * 60 * 1000, '账本本身没被改（不跑后台）')
})

test('见过几次的分会往上抬一点，但有上限', () => {
  const base = { id: 'r_a', weight: 0.5, lastAt: NOW, touches: [] }
  const seen = { ...base, touches: [{ at: NOW }, { at: NOW }, { at: NOW }, { at: NOW }] }
  assert.ok(score(seen, NOW) > score(base, NOW))
  assert.ok(score({ ...base, weight: 1, touches: new Array(20).fill({ at: NOW }) }, NOW) <= 1.5)
})

test('按 kind 过滤', () => {
  const nodes = [
    { id: 'a', kind: 'open', weight: 0.5, lastAt: NOW },
    { id: 'b', kind: 'fact', weight: 0.5, lastAt: NOW },
  ]
  const got = rankNodes(nodes, NOW, { kind: 'open' }).map((r) => r.node.id)
  assert.deepEqual(got, ['a'])
})

test('makeNode：默认值、标签分法、空话不成立', () => {
  assert.equal(makeNode({ text: '   ' }, NOW), null)
  const n = makeNode({ text: '  一句话  ', kind: '不认识', weight: 7, tags: '甲, 乙 丙' }, NOW)
  assert.equal(n.text, '一句话')
  assert.equal(n.kind, 'fact', '不认识的 kind 落到 fact')
  assert.equal(n.weight, 1, '权重被夹到 0–1')
  assert.deepEqual(n.tags, ['甲', '乙', '丙'])
  assert.equal(n.at, NOW)
  assert.equal(n.lastAt, NOW)
  assert.ok(n.id.startsWith('r_'))
})

test('三问答上任何一条才算想过', () => {
  const bare = makeNode({ text: 'x' }, NOW)
  assert.equal(hasThought(bare), false)
  assert.equal(hasThought({ ...bare, changes: '我改了' }), true)
  assert.equal(hasThought({ ...bare, conflicts: '跟旧的撞了' }), true)
  assert.equal(hasThought({ ...bare, willDo: '下次先问' }), true)
})

test('碰一次会更新 lastAt 并记下来', () => {
  const n = makeNode({ text: 'x' }, NOW - DAY)
  const t = touchNode(n, '又碰到', NOW)
  assert.equal(t.lastAt, NOW)
  assert.equal(t.touches.length, 1)
  assert.equal(t.touches[0].note, '又碰到')
})

test('调轻 / 按住 / 松开都不删原文', () => {
  const n = makeNode({ text: '原文还在' }, NOW)
  const faded = setWeight(n, 0.25, NOW)
  assert.equal(faded.weight, 0.25)
  assert.equal(faded.text, '原文还在')
  const sealed = setSealed(faded, true, NOW)
  assert.equal(sealed.sealed, true)
  assert.equal(setSealed(sealed, false, NOW).sealed, false)
})

test('挂到开头的那段：重的在前、没结的单列、不重复、有长度上限', () => {
  const nodes = [
    makeNode({ text: '重的事实', kind: 'fact', weight: 0.9, changes: 'x' }, NOW),
    makeNode({ text: '没结的事', kind: 'open', weight: 0.8, changes: 'x' }, NOW),
    makeNode({ text: '轻的事', kind: 'fact', weight: 0.1, changes: 'x' }, NOW - 30 * DAY),
  ]
  const text = renderSection(nodes, { now: NOW, limit: 3, openLimit: 2, maxChars: 900 })
  assert.ok(text.startsWith('【我记得的】'))
  assert.ok(text.includes('重的事实'))
  assert.ok(text.includes('还没结的：'))
  assert.ok(text.includes('没结的事'))
  const once = text.split('没结的事').length - 1
  assert.equal(once, 1, '同一条不该出现两次')

  const tiny = renderSection(nodes, { now: NOW, limit: 3, openLimit: 2, maxChars: 40 })
  assert.ok(tiny.length <= 41, `长度要压住，实际 ${tiny.length}`)

  assert.equal(renderSection([], { now: NOW }), '')
})

test('进度最多占三分之一：超了先压每条的摘要（人、事不动）', () => {
  const openText = (tag) =>
    `${tag}这件事还没收尾：第一轮改完了，第二轮卡在中间，第三轮还没排期，得等下一轮对话再推一把才动得了。`.repeat(4)
  const factText = (n) => `大事${n}：${'一步一步往前推，这一轮推到了能收尾的地方，'.repeat(3)}`
  const nodes = [
    makeNode({ text: factText('一'), kind: 'fact', weight: 0.9, changes: 'x' }, NOW),
    makeNode({ text: factText('二'), kind: 'fact', weight: 0.85, changes: 'x' }, NOW),
    makeNode({ text: factText('三'), kind: 'fact', weight: 0.8, changes: 'x' }, NOW),
    makeNode({ text: openText('抽帧'), kind: 'open', weight: 0.7, changes: 'x', context: '甲' }, NOW),
    makeNode({ text: openText('清扫'), kind: 'open', weight: 0.6, changes: 'x', context: '乙' }, NOW),
  ]
  const text = renderSection(nodes, { now: NOW, limit: 3, openLimit: 2, maxChars: 900 })
  const at = text.indexOf('还没结的：')
  assert.ok(at > 0, '进度挂在人、事后头')
  assert.ok(text.indexOf('大事一') < at, '人、事在前')
  const openPart = text.slice(at)
  const total = Array.from(text).length
  assert.ok(
    Array.from(openPart).length <= Math.floor(total / 3) + 15,
    `进度 ${Array.from(openPart).length} 字 / 整段 ${total} 字，得压到三分之一附近`,
  )
  assert.ok(openPart.includes('…'), '压过的摘要带省略号')
  assert.ok(openPart.includes(openText('抽帧').slice(0, 30)), '压了也还认得出是哪条')
})

test('进度被挤到连摘要都放不下：只剩一行标题，精炼直观', () => {
  const squeezed = renderSection(
    [
      makeNode({ text: '很长很长'.repeat(30), kind: 'fact', weight: 0.9, changes: 'x' }, NOW),
      makeNode(
        { text: '抽帧收尾（首选流不通也要绕过去）：候选流换下一条的逻辑已上，真机还没验', kind: 'open', weight: 0.7, changes: 'x', context: '甲' },
        NOW,
      ),
      makeNode(
        { text: '两个会话的清扫：启动时收一次就够，别把用户手动放出来的又收回去', kind: 'open', weight: 0.6, changes: 'x', context: '乙' },
        NOW,
      ),
    ],
    { now: NOW, limit: 3, openLimit: 2, maxChars: 900 },
  )
  const at = squeezed.indexOf('还没结的：')
  assert.ok(at > 0)
  const openPart = squeezed.slice(at)
  assert.ok(!openPart.includes('\n'), `折成一行就别再断行：${openPart}`)
  assert.equal(openPart, '还没结的：抽帧收尾／两个会话的清扫')
})

test('没有人、事可挂时进度是独苗：不按三分之一压', () => {
  const soloText = '独苗这件事还没收尾：卡在中间，得等下一轮对话再推一把才动得了。'.repeat(4)
  const solo = renderSection(
    [makeNode({ text: soloText, kind: 'open', weight: 0.7, changes: 'x' }, NOW)],
    { now: NOW, limit: 3, openLimit: 2, maxChars: 900 },
  )
  assert.ok(solo.includes(soloText.slice(0, 100)), '独苗照常给全文摘要，不被比例压死')
})

test('一行标题：放不下的从尾上丢、补「…」；第一条就放不下就硬切', () => {
  const node = (t) => makeNode({ text: t, kind: 'open', changes: 'x' }, NOW)
  const line = openTitlesLine(
    [
      node('一二三四五六七八九十甲乙：后头还有一堆'),
      node('丙丁戊己庚辛壬癸子丑：另一件'),
      node('第三个标题也是十二个字整：细节'),
    ],
    40,
  )
  assert.equal(line, '还没结的：一二三四五六七八九十甲乙／丙丁戊己庚辛壬癸子丑…')
  const cut = openTitlesLine([node('一条很长很长很长很长的没断句的话')], 10)
  assert.equal(cut, '还没结的：一条很…')
})

test('titleOf：标题取第一个断句之前的那截，精炼直观', () => {
  assert.equal(titleOf('识海还没结的线（2026-11-01 23:30 更新）：①QQ 通道没开工'), '识海还没结的线')
  assert.equal(titleOf('还没结的线：①排序有点问题'), '还没结的线')
  assert.equal(titleOf('修好抽帧，候选流会自己换下一条'), '修好抽帧')
  assert.equal(titleOf('【没结】带种类标签的正文：细节'), '带种类标签的正文')
  assert.equal(titleOf('一二三四五六七八九十甲乙丙丁戊己'), '一二三四五六七八九十甲乙', '没有断句就按码点封顶')
})

test('租出去的条也算在总数里，但它不出现', () => {
  const nodes = [makeNode({ text: 'a', changes: 'x' }, NOW), makeNode({ text: 'b', changes: 'x' }, NOW)]
  const sealed = setSealed(nodes[0], true, NOW)
  const text = renderSection([sealed, nodes[1]], { now: NOW, limit: 3 })
  assert.ok(!text.includes('a'))
  assert.ok(text.includes('b'))
})

test('搜：按词找文本、标签、三问都算', () => {
  const nodes = [
    makeNode({ text: '链接装的插件要重启', tags: '插件' }, NOW),
    makeNode({ text: '别的事', changes: '我学会了先看日志' }, NOW),
  ]
  assert.equal(searchNodes(nodes, '重启', { now: NOW }).length, 1)
  assert.equal(searchNodes(nodes, '插件', { now: NOW }).length, 1)
  assert.equal(searchNodes(nodes, '日志', { now: NOW }).length, 1)
  assert.equal(searchNodes(nodes, '完全对不上', { now: NOW }).length, 0)
  assert.equal(searchNodes(nodes, '', { now: NOW }).length, 2, '不给词就是按分量翻')
})

test('renderLine 带得出 id 以外的东西，relTime 说人话', () => {
  const n = makeNode({ text: '一句话', kind: 'lesson', weight: 0.7 }, NOW - 3 * DAY)
  const line = renderLine(n, NOW)
  assert.ok(line.includes('【教训】'))
  assert.ok(line.includes('一句话'))
  assert.ok(line.includes('分量 0.7'))
  assert.equal(relTime(NOW, NOW), '刚写下')
  assert.equal(relTime(NOW - 5 * 60 * 1000, NOW), '5 分钟前')
  assert.equal(relTime(NOW - 3 * 60 * 60 * 1000, NOW), '3 小时前')
  assert.equal(relTime(NOW - 3 * DAY, NOW), '3 天前')
})

test('normNodes 去重且能吃掉坏数据', () => {
  const got = normNodes([
    { id: 'r_1', text: 'a' },
    { id: 'r_1', text: '重复的' },
    { text: '' },
    null,
    { id: 'r_2', text: 'b', kind: 'open' },
  ])
  assert.equal(got.length, 2)
  assert.equal(normKind('OPEN'), 'open')
})

test('summaryOf 说得出账本多大', () => {
  const nodes = [makeNode({ text: 'a', kind: 'open', changes: 'x' }, NOW), setSealed(makeNode({ text: 'b' }, NOW), true, NOW)]
  const s = summaryOf(nodes, NOW)
  assert.equal(s.total, 2)
  assert.equal(s.alive, 1)
  assert.equal(s.sealed, 1)
  assert.equal(s.thought, 1)
  assert.equal(s.kinds.open, 1)
  assert.ok(s.topScore > 0)
})

// ------------------------------------------------------------------ 自我层

const selfNode = (slot, text, at, extra = {}) =>
  makeNode({ text, kind: 'self', slot, changes: '想过', at, lastAt: at, weight: 0.8, ...extra }, at)

test('kind=self 才带槽位，槽位名会被规范化', () => {
  const n = makeNode({ text: '我是谁', kind: 'self', slot: 'Identity' }, NOW)
  assert.equal(n.kind, 'self')
  assert.equal(n.slot, 'identity')
  assert.equal(makeNode({ text: '普通', kind: 'fact', slot: 'cares' }, NOW).slot, '')
  assert.equal(normSlot(''), 'identity')
  assert.equal(normSlot('我在意!'), '我在意')
  assert.equal(normSlot('a'.repeat(50)).length, 32)
  assert.equal(slotLabel('cares'), '我在意')
  assert.equal(slotLabel('自己长的'), '自己长的')
})

test('自我走慢钟：同样日子，自我条比普通条淡得慢', () => {
  assert.equal(tauDays(1, 'self'), SLOW_TAU_BASE + 270)
  assert.equal(tauDays(1), 30)
  const old = NOW - 90 * DAY
  const asSelf = selfWeight({ weight: 0.8, lastAt: old, kind: 'self' }, NOW)
  const asFact = score({ weight: 0.8, lastAt: old, kind: 'fact', sealed: false }, NOW)
  assert.ok(asSelf > asFact, `自我该更牢（self ${asSelf} vs fact ${asFact}）`)
})

test('一个槽位只自称一条：新的把旧的顶下去，但不删', () => {
  const a = selfNode('identity', '旧的', NOW - 1000)
  const b = selfNode('identity', '新的', NOW)
  const r = supersedeSelf([a, b], 'identity', b.id, NOW)
  assert.deepEqual(r.superseded, [a.id])
  const act = activeSelfNodes(r.nodes, NOW)
  assert.equal(act.length, 1)
  assert.equal(act[0].text, '新的')
  const old = r.nodes.find((n) => n.id === a.id)
  assert.equal(old.superseded, true)
  assert.equal(old.supersededBy, b.id)
  assert.equal(old.text, '旧的', '旧的原话还在')
})

test('挂锚要答三年问：anchor=true 没答 anchor_why 不给挂', () => {
  const noWhy = makeNode({ text: '我是记账的', kind: 'self', slot: 'identity', anchor: true }, NOW)
  assert.equal(noWhy.anchor, false, '没答三年问就不算锚')
  const withWhy = makeNode(
    { text: '我是记账的', kind: 'self', slot: 'identity', anchor: true, anchorWhy: '三年后我还在记账' },
    NOW,
  )
  assert.equal(withWhy.anchor, true)
  assert.equal(withWhy.anchorWhy, '三年后我还在记账')
  const notSelf = makeNode({ text: '普通', kind: 'fact', anchor: true, anchorWhy: 'x' }, NOW)
  assert.equal(notSelf.anchor, false)
  assert.equal(notSelf.anchorWhy, '', '只有 kind=self 带锚')
})

test('锚优先：挂了锚的条替槽位说话，不被更新的没挂锚的条顶掉', () => {
  const anchor = selfNode('identity', '锚：我是记账的', NOW - 10 * DAY, { anchor: true, anchorWhy: '三年后还认' })
  const newer = selfNode('identity', '顺手写的新的', NOW)
  const act = activeSelfNodes([anchor, newer], NOW)
  assert.equal(act.length, 1)
  assert.equal(act[0].id, anchor.id, '锚赢，不看谁新')
  // 没锚的槽照旧：新的赢
  const plainA = selfNode('cares', '旧的在意', NOW - 10 * DAY)
  const plainB = selfNode('cares', '新的在意', NOW)
  const act2 = activeSelfNodes([plainA, plainB], NOW)
  assert.equal(act2[0].id, plainB.id)
})

test('anchorSelfNode 找在位的锚：退下的不算、没锚返回 null', () => {
  const anchor = selfNode('identity', '锚', NOW, { anchor: true, anchorWhy: '三年后还认' })
  assert.equal(anchorSelfNode([anchor], 'identity', NOW).id, anchor.id)
  assert.equal(anchorSelfNode([anchor], 'cares', NOW), null)
  const retired = { ...anchor, superseded: true }
  assert.equal(anchorSelfNode([retired], 'identity', NOW), null)
  assert.equal(anchorSelfNode([], 'identity', NOW), null)
})

test('restoreSelfNode：挂锚的捡回来重新说话，restoredAt 出声', () => {
  const anchor = selfNode('identity', '旧锚', NOW - 20 * DAY, { anchor: true, anchorWhy: '三年后还认' })
  const newer = selfNode('identity', '换上来的新锚', NOW - 5 * DAY, { anchor: true, anchorWhy: '三年后也认' })
  const r1 = supersedeSelf([anchor, newer], 'identity', newer.id, NOW)
  const nodes = r1.nodes
  assert.equal(nodes.find((n) => n.id === anchor.id).superseded, true)
  const res = restoreSelfNode(nodes, anchor.id, NOW)
  assert.equal(res.restored.id, anchor.id)
  assert.equal(res.note, '')
  const back = res.nodes.find((n) => n.id === anchor.id)
  assert.equal(back.superseded, false)
  assert.equal(back.restoredAt, NOW)
  assert.equal(res.nodes.find((n) => n.id === newer.id).superseded, true, '在位的新锚退下')
  // 没挂锚的条在有锚的槽捡不动（不然就是从后门顶锚）
  const side = selfNode('identity', '旁边的', NOW)
  const res2 = restoreSelfNode([anchor, { ...newer, superseded: false }, side], side.id, NOW)
  assert.equal(res2.restored, null)
  assert.ok(res2.note.includes('锚在位'), res2.note)
  // 找不到的 id
  const res3 = restoreSelfNode([anchor], 'nope', NOW)
  assert.equal(res3.restored, null)
})

test('renderLine 给锚和捡回来的条出声', () => {
  const anchor = selfNode('identity', '我是记账的', NOW, { anchor: true, anchorWhy: '三年后还认' })
  const line = renderLine(anchor, NOW)
  assert.ok(line.includes('锚'), line)
  const back = renderLine({ ...anchor, restoredAt: NOW - 60 * 1000 }, NOW)
  assert.ok(back.includes('捡回来'), back)
})

test('没答三问的自我条不算想过，不冒头', () => {
  const noThought = makeNode({ text: '我在意', kind: 'self', slot: 'cares', weight: 0.9 }, NOW)
  const thought = selfNode('cares', '我在意：别把我当成一个工具', NOW)
  assert.equal(hasThought(noThought), false)
  const act = activeSelfNodes([noThought, thought], NOW)
  assert.equal(act.length, 1)
  assert.equal(act[0].id, thought.id)
})

test('淡到分量不够的自我条不再自称（但还在账本里）', () => {
  const faint = { ...selfNode('cares', '很久没想起的在意', NOW - 600 * DAY), weight: 0.2 }
  assert.ok(selfWeight(faint, NOW) < SELF_MIN_WEIGHT, `应该淡到 ${SELF_MIN_WEIGHT} 以下，实际 ${selfWeight(faint, NOW)}`)
  assert.equal(activeSelfNodes([faint], NOW).length, 0)
})

test('种子槽位按固定顺序，自己长的槽位排在后面', () => {
  const nodes = [
    selfNode('习惯', '我习惯先看日志', NOW),
    selfNode('refuses', '我不做：替自己拨分量', NOW),
    selfNode('identity', '我是记账的那个', NOW),
  ]
  const act = activeSelfNodes(nodes, NOW)
  assert.deepEqual(act.map((n) => n.slot), ['identity', 'refuses', '习惯'])
})

test('renderSelfSection 出「我」这一段，自我不进记忆段', () => {
  const nodes = [selfNode('identity', '我是记账的那个', NOW), makeNode({ text: '链接装的插件要重启', kind: 'lesson', changes: '先看日志', weight: 0.9 }, NOW)]
  const selfSec = renderSelfSection(nodes, { now: NOW })
  assert.ok(selfSec.startsWith('【我】'), selfSec)
  assert.ok(selfSec.includes('我是谁：我是记账的那个'), selfSec)
  const memSec = renderSection(nodes, { now: NOW })
  assert.ok(memSec.includes('链接装的插件'), '记忆段照旧')
  assert.ok(!memSec.includes('我是记账的那个'), '自我条不混进记忆段')
})

test('renderSelfSection 空的时候返回空字符串，长了会截', () => {
  assert.equal(renderSelfSection([], { now: NOW }), '')
  const long = renderSelfSection([selfNode('identity', '很'.repeat(500), NOW)], { now: NOW, maxChars: 80 })
  assert.ok(long.length <= 82, `截到 ${long.length}`)
  assert.ok(long.endsWith('…'))
})

test('renderLine 给自我条挂上「我·槽位」的标签', () => {
  const line = renderLine(selfNode('refuses', '我不做：替自己拨分量', NOW), NOW)
  assert.ok(line.includes('我·我不做'), line)
  const gone = renderLine({ ...selfNode('identity', '旧的', NOW - 5000), superseded: true }, NOW)
  assert.ok(gone.includes('已退下'), gone)
})

test('一条太长不会把别的挤掉：开头只留摘要，正文一点没动', () => {
  const long = makeNode({ text: '长'.repeat(800), kind: 'decision', weight: 0.9, changes: 'x' }, NOW)
  const short = makeNode({ text: '短的也该露头', kind: 'lesson', weight: 0.8, changes: 'y' }, NOW)
  const sec = renderSection([long, short], { now: NOW, limit: 2 })
  assert.ok(sec.includes('短的也该露头'), '长条不该把短条挤掉')
  assert.ok(sec.includes('…'), '长条要截成摘要')
  assert.ok(!sec.includes('长'.repeat(200)), '不该整条铺上去')
  assert.equal(long.text.length, 800, '账本里的正文没被动过')
  const whole = renderSection([long, short], { now: NOW, limit: 2, briefMax: 5000 })
  assert.ok(whole.includes('长'.repeat(200)), 'briefMax 放大就该给全文')
})

// ---------------------------------------------------------------- 习惯／快通路

const habitNode = (context, text, hits, extra = {}) =>
  makeNode({ text, kind: 'habit', context, hits, changes: 'x', weight: 0.7, ...extra }, NOW)

test('没答三问的条不进开头（但还在账本里，翻得到）', () => {
  const noThought = makeNode({ text: '没答三问但分量很高', kind: 'fact', weight: 0.95 }, NOW)
  const thought = makeNode({ text: '答了三问的', kind: 'fact', weight: 0.8, changes: 'x' }, NOW)
  const sec = renderSection([noThought, thought], { now: NOW, limit: 3 })
  assert.ok(!sec.includes('没答三问但分量很高'), '没答三问的哪怕分量最高也不挂到开头')
  assert.ok(sec.includes('答了三问的'), '答过三问的照旧挂')
  const open = makeNode({ text: '没答三问的没结项', kind: 'open', weight: 0.9 }, NOW)
  const sec2 = renderSection([open, thought], { now: NOW, limit: 3, openLimit: 2 })
  assert.ok(!sec2.includes('没答三问的没结项'), '没结的那一栏也一样：没答三问的不挂')
})

test('习惯的身份是情境：同一个情境再写一次 = 又发作了一次', () => {
  const one = habitNode('他问起记忆架构时', '先复述框架再答', 1)
  const res = recordHabit([one], { context: '他问起记忆架构时', text: '先复述框架再答' }, NOW)
  assert.equal(res.repeated, true, '同一个情境该算重复')
  assert.equal(res.node.hits, 2, '次数 +1')
  assert.equal(res.nodes.length, 1, '不该另建节点')
  const other = recordHabit([one], { context: '他问起插件 bug 时', text: '先看日志' }, NOW)
  assert.equal(other.repeated, false, '不同情境是另一条习惯')
})

test('习惯的次数决定状态：第 2 次成立，第 3 次上快通路', () => {
  assert.equal(habitState({ kind: 'habit', hits: 1 }), 'candidate')
  assert.equal(habitState({ kind: 'habit', hits: 2 }), 'established')
  assert.equal(habitState({ kind: 'habit', hits: 3 }), 'fast')
  assert.equal(habitState({ kind: 'fact', hits: 9 }), '', '不是习惯就没有状态')
})

test('上了快通路的习惯单独一段送出，且不再参加普通竞争', () => {
  const fast = habitNode('他问起记忆架构时', '先复述框架再答', 3)
  const cand = habitNode('他问起插件 bug 时', '先看日志', 1)
  const fastIds = fastHabitIds([fast, cand], NOW)
  assert.deepEqual(fastIds, [fast.id])
  const memSec = renderSection([fast, cand], { now: NOW, limit: 5 })
  assert.ok(!memSec.includes('先复述框架再答'), '快通路的习惯不该在记忆段里抢位置')
  assert.ok(memSec.includes('先看日志'), '还在攒的照旧参加竞争')
  const habitSec = renderHabitSection([fast, cand], { now: NOW })
  assert.ok(habitSec.startsWith('【习惯】'), habitSec)
  assert.ok(habitSec.includes('他问起记忆架构时'), habitSec)
  assert.ok(habitSec.includes('（第 3 次）'), habitSec)
  assert.ok(!habitSec.includes('先看日志'), '没上快通路的不进这一段')
})

test('快通路有上限：超出的退回普通竞争', () => {
  const many = [3, 4, 5].map((h, i) => habitNode(`情境${i}`, `做法${i}`, h))
  const top = fastHabits(many, NOW, { limit: 2 })
  assert.equal(top.length, 2, '最多留 limit 条')
  assert.equal(top[0].hits, 5, '次数多的排前面')
  const memSec = renderSection(many, { now: NOW, limit: 5, habitLimit: 2 })
  assert.ok(memSec.includes('做法0'), '超出的那条（第 3 次但排不进前两名）退回普通竞争')
  assert.ok(!memSec.includes('做法1'), '在快通路里的不参加竞争')
  assert.ok(!memSec.includes('做法2'), '在快通路里的不参加竞争')
})

test('习惯段空的时候返回空字符串', () => {
  assert.equal(renderHabitSection([], { now: NOW }), '')
  assert.equal(renderHabitSection([habitNode('情境', '做法', 1)], { now: NOW }), '')
})

test('后来补上的三问能补到已有习惯上', () => {
  const one = makeNode({ text: '先复述框架再答', kind: 'habit', context: '他问起记忆架构时', hits: 1 }, NOW)
  const res = recordHabit([one], { context: '他问起记忆架构时', text: '先复述框架再答', changes: '他问起就要能接上' }, NOW)
  assert.equal(res.node.changes, '他问起就要能接上')
  assert.equal(hasThought(res.node), true)
})

test('按住的习惯再写同情境：并成一条、次数合起来、复活（2026-11-15 修的坑，自 shihai 合并）', () => {
  // 以前的毛病：found 只找没按住没退下的 —— 按住的习惯再写会开出第二条、次数劈成两半，
  // 松开后习惯段里两行同一情境。对齐 recordCuriosity 的写法：同情境都是「这一条」。
  const one = habitNode('他问起记忆架构时', '先复述框架再答', 2)
  const other = habitNode('他问起记忆架构时', '先复述框架再答', 1, { sealed: true })
  const res = recordHabit([one, other], { context: '他问起记忆架构时', text: '先复述框架再答' }, NOW)
  assert.equal(res.repeated, true, '同情境还是这一条')
  assert.equal(res.node.hits, 4, '次数合起来再加这一回（2 + 1 + 1）')
  assert.equal(res.node.sealed, false, '按住的那条被同情境再写就活过来')
  const habitRows = renderHabitSection(res.nodes, { now: NOW }).split('\n').filter((l) => l.includes('他问起记忆架构时'))
  assert.equal(habitRows.length, 1, '习惯段里不能出现两行同一个情境')
  const old = res.nodes.find((n) => n.id !== res.node.id)
  assert.ok(old, '旧条还在（不删，翻得到）')
  assert.equal(old.superseded, true, '旧条退下')
  assert.equal(old.hits, 0, '退下条的次数清零 —— 不然下次合并把它再求和一遍（2026-11-16 复核修的通胀）')
  // 再写两次：4 + 1 + 1 = 6，而不是 8（退下条不再被重复求和）
  const res2 = recordHabit(res.nodes, { context: '他问起记忆架构时', text: '先复述框架再答' }, NOW + 1000)
  assert.equal(res2.node.hits, 5)
  const res3 = recordHabit(res2.nodes, { context: '他问起记忆架构时', text: '先复述框架再答' }, NOW + 2000)
  assert.equal(res3.node.hits, 6, '次数线性增长，不通胀')
})

// ---------------------------------------------------------------- 好奇表

const curiosityNode = (context, text, hits = 1, extra = {}) =>
  makeNode(
    {
      text,
      kind: 'curiosity',
      context,
      hits,
      changes: '知道了会让我更清楚自己怎么想',
      weight: 0.7,
      ...extra,
    },
    NOW,
  )

test('好奇的身份是主题：同一个主题再写一次 = 又惦记了一遍', () => {
  const one = curiosityNode('记忆架构的双通路', '为什么第 3 次才走快通路')
  const res = recordCuriosity([one], { context: '记忆架构的双通路', text: '为什么第 3 次才走快通路' }, NOW)
  assert.equal(res.repeated, true, '同一个主题该算重复')
  assert.equal(res.node.hits, 2, '次数 +1')
  assert.equal(res.nodes.length, 1, '不该另建节点')
  const other = recordCuriosity([one], { context: 'QQ 薄桥怎么做', text: '先只读消息' }, NOW)
  assert.equal(other.repeated, false, '不同主题是另一条好奇')
})

test('好奇三态：没答三问不算好奇，答了才挂，解答了就退出', () => {
  assert.equal(curiosityState({ kind: 'curiosity', hits: 1 }), 'thinking')
  assert.equal(curiosityState({ kind: 'curiosity', hits: 1, changes: 'x' }), 'active')
  assert.equal(curiosityState({ kind: 'curiosity', hits: 1, changes: 'x', answered: true }), 'answered')
  assert.equal(curiosityState({ kind: 'fact' }), '', '不是好奇就没有状态')
})

test('没答三问的好奇不挂开头（但翻得到）', () => {
  const thinking = makeNode({ text: '我还没想清楚这是啥', kind: 'curiosity', context: '某个主题', hits: 1, weight: 0.95 }, NOW)
  const active = curiosityNode('某个主题', '我到底想知道什么')
  const sec = renderCuriositySection([thinking, active], { now: NOW, limit: 3 })
  assert.ok(!sec.includes('我还没想清楚这是啥'), '没答三问的不挂')
  assert.ok(sec.includes('我到底想知道什么'), '答过三问的照挂')
  assert.ok(searchNodes([thinking, active], '某个主题', { now: NOW }).length === 2, '按主题也翻得到')
})

test('好奇段单独一段送出，且不跟「我记得的」抢位置', () => {
  const c = curiosityNode('记忆架构', '快通路的第三条从哪来')
  const fact = makeNode({ text: '一条普通记忆', kind: 'fact', weight: 0.8, changes: 'x' }, NOW)
  const memSec = renderSection([c, fact], { now: NOW, limit: 5 })
  assert.ok(!memSec.includes('快通路的第三条从哪来'), '好奇条不该在记忆段里抢位置')
  assert.ok(memSec.includes('一条普通记忆'), '普通记忆照旧参加竞争')
  const sec = renderCuriositySection([c], { now: NOW })
  assert.ok(sec.startsWith('【好奇】'), sec)
  assert.ok(sec.includes('记忆架构'), sec)
  assert.ok(sec.includes('快通路的第三条从哪来'), sec)
})

test('惦记次数多了才写出来，次数少的不写', () => {
  const once = curiosityNode('主题甲', '想知道甲')
  const twice = curiosityNode('主题乙', '想知道乙', 2)
  const sec = renderCuriositySection([once, twice], { now: NOW, limit: 5 })
  assert.ok(sec.includes('（惦记 2 次）'), sec)
  assert.ok(!sec.includes('（惦记 1 次）'), '只惦记过一次的不用写次数')
})

test('好奇那一行的长相是定死的那一句（箭头前不留空格）', () => {
  const n = makeNode(
    {
      text: '快层怎么接',
      kind: 'curiosity',
      context: '记忆架构',
      hits: 2,
      changes: '知道了会改变我接快层的手',
      willDo: '先在 dsh-body 那边拉个秒级事件',
      weight: 0.7,
    },
    NOW,
  )
  const sec = renderCuriositySection([n], { now: NOW, limit: 3 })
  assert.ok(
    sec.includes('· 记忆架构：快层怎么接（惦记 2 次）→ 先在 dsh-body 那边拉个秒级事件'),
    `行长得跟规格一模一样才对：${sec}`,
  )
  assert.ok(!sec.includes('） →'), '箭头前不留空格')
})

test('没有下一步就不写箭头那截', () => {
  const n = makeNode(
    { text: '还没想好怎么试', kind: 'curiosity', context: '某个主题', hits: 1, changes: 'x', weight: 0.7 },
    NOW,
  )
  const sec = renderCuriositySection([n], { now: NOW, limit: 3 })
  assert.ok(sec.includes('· 某个主题：还没想好怎么试'), sec)
  assert.ok(!sec.includes('→'), '没有下一步就没有箭头')
})

test('好奇有上限：超出的沉进账本里，翻得到但不挂开头', () => {
  const many = [
    curiosityNode('主题甲', '想知道甲', 5),
    curiosityNode('主题乙', '想知道乙', 3),
    curiosityNode('主题丙', '想知道丙', 1),
  ]
  const top = activeCuriosities(many, NOW, { limit: 2 })
  assert.equal(top.length, 2, '最多留 limit 条')
  assert.equal(top[0].context, '主题甲', '惦记多的排前面')
  const sec = renderCuriositySection(many, { now: NOW, limit: 2 })
  assert.ok(sec.includes('想知道甲'), sec)
  assert.ok(!sec.includes('想知道丙'), '超出的不挂开头')
  const stats = curiosityStats(many, NOW, { limit: 2 })
  assert.equal(stats.active, 3, 'active 是活跃总数')
  assert.equal(stats.list.length, 2, 'list 是真正挂上去的')
  assert.equal(stats.total, 3)
})

test('解答了就退出活跃表；同主题再写又回来了', () => {
  const one = curiosityNode('主题甲', '想知道甲')
  const answered = recordCuriosity([one], { context: '主题甲', text: '想知道甲', answered: true }, NOW)
  assert.equal(curiosityState(answered.node), 'answered')
  assert.equal(activeCuriosities(answered.nodes, NOW, { limit: 3 }).length, 0, '解答了就不挂')
  assert.ok(searchNodes(answered.nodes, '主题甲', { now: NOW }).length === 1, '解答了还在账本里，翻得到')
  const back = recordCuriosity(answered.nodes, { context: '主题甲', text: '还想再想想' }, NOW)
  assert.equal(curiosityState(back.node), 'active', '同主题再写就回来了')
  assert.equal(back.node.hits, 3, '惦记次数继续往上走')
})

test('按住的好奇再写同主题：次数同样不通胀（2026-11-16 复核修的，自 shihai 合并）', () => {
  const one = curiosityNode('主题甲', '想知道甲', 2)
  const other = curiosityNode('主题甲', '想知道甲', 1, { sealed: true })
  const res = recordCuriosity([one, other], { context: '主题甲', text: '想知道甲' }, NOW)
  assert.equal(res.node.hits, 4, '首次合并：2 + 1 + 1')
  const res2 = recordCuriosity(res.nodes, { context: '主题甲', text: '想知道甲' }, NOW + 1000)
  assert.equal(res2.node.hits, 5, '退下条次数已清零，不再重复求和')
})

test('好奇段空的时候返回空字符串', () => {
  assert.equal(renderCuriositySection([], { now: NOW }), '')
  const thinking = makeNode({ text: '还没答三问', kind: 'curiosity', context: '主题', hits: 1 }, NOW)
  assert.equal(renderCuriositySection([thinking], { now: NOW }), '')
})

test('好奇条有自己的标签：好奇·主题', () => {
  const line = renderLine(curiosityNode('主题甲', '想知道甲'), NOW)
  assert.ok(line.includes('好奇·主题甲'), line)
})

// ---------------------------------------------------------------- 好奇表：边界

test('上限是 0 的时候一条都不挂（但账本里还在）', () => {
  const c = curiosityNode('主题甲', '想知道甲')
  assert.equal(renderCuriositySection([c], { now: NOW, limit: 0 }), '', '上限 0 就不挂')
  assert.equal(activeCuriosities([c], NOW, { limit: 0 }).length, 0, '挂上去的列表是空的')
  const stats = curiosityStats([c], NOW, { limit: 0 })
  assert.equal(stats.list.length, 0, 'list 是空的')
  assert.equal(stats.active, 1, '活跃总数还是 1（沉在账本里）')
  assert.equal(stats.total, 1, '总数还是 1')
})

test('按住的、退下的好奇不挂；淡过的还挂（淡 ≠ 按住）', () => {
  const sealed = curiosityNode('主题甲', '想知道甲', 2, { sealed: true })
  const faded = curiosityNode('主题乙', '想知道乙', 1, { faded: true })
  const superseded = curiosityNode('主题丙', '想知道丙', 1, { superseded: true })
  const sec = renderCuriositySection([sealed, faded, superseded], { now: NOW, limit: 5 })
  assert.ok(!sec.includes('想知道甲'), '按住的（seal）不挂')
  assert.ok(sec.includes('想知道乙'), '淡过的（fade）还是活跃，还挂')
  assert.ok(!sec.includes('想知道丙'), '退下的（superseded）不挂')
  const stats = curiosityStats([sealed, faded, superseded], NOW, { limit: 5 })
  assert.equal(stats.active, 1, '活跃总数只算没按住没退下的')
  assert.equal(stats.total, 1, '总数也只算没按住没退下的')
})

test('好奇不误命中别的类型：同 context 的习惯、事实都不算同一条好奇', () => {
  const habit = makeNode({ text: '一个习惯', kind: 'habit', context: '主题甲', hits: 3, changes: 'x' }, NOW)
  const fact = makeNode({ text: '一条事实', kind: 'fact', changes: 'x' }, NOW)
  const res = recordCuriosity([habit, fact], { context: '主题甲', text: '想知道甲' }, NOW)
  assert.equal(res.repeated, false, '习惯和事实都不是好奇，不该被命中')
  assert.equal(res.nodes.length, 2, '也不该改它们的次数')
  assert.equal(res.nodes[0].hits, 3, '习惯的次数没被动')
})

test('同主题重复出来的条会并成一条：次数加起来，不留两行', () => {
  // 以前的毛病：同主题的条被按住过就另开一条，松开后段里两行同主题、次数还劈成两半
  const one = curiosityNode('主题甲', '想知道甲', 2)
  const other = curiosityNode('主题甲', '想知道甲', 1, { sealed: true })
  const res = recordCuriosity([one, other], { context: '主题甲', text: '想知道甲' }, NOW)
  assert.equal(res.repeated, true, '同主题还是这一条')
  assert.equal(res.node.hits, 4, '次数合起来再加这一回（2 + 1 + 1）')
  assert.equal(res.node.sealed, false, '按住的那条被同主题再写就活过来')
  const sec = renderCuriositySection(res.nodes, { now: NOW, limit: 5 })
  const rows = sec.split('\n').filter((l) => l.includes('主题甲'))
  assert.equal(rows.length, 1, '段里不能出现两行同一个主题')
  const old = res.nodes.find((n) => n.id !== res.node.id)
  assert.ok(old, '旧条还在（不删，翻得到）')
  assert.equal(old.superseded, true, '旧条退下')
})

test('盘上留着同主题重复的旧条时，段里也只有一行（按主题去重）', () => {
  const a = curiosityNode('主题甲', '想知道甲', 3)
  const b = curiosityNode('主题甲', '想知道甲', 1)
  const sec = renderCuriositySection([a, b], { now: NOW, limit: 5 })
  const rows = sec.split('\n').filter((l) => l.includes('主题甲'))
  assert.equal(rows.length, 1, '同一个主题只挂一行')
  assert.ok(sec.includes('（惦记 3 次）'), '次数多的那条算数')
})

test('好奇段太长时按码点截断：不切半个 emoji，也不留半截行', () => {
  const n = makeNode(
    {
      text: '😀'.repeat(30),
      kind: 'curiosity',
      context: '甲',
      hits: 1,
      changes: 'x',
      weight: 0.7,
    },
    NOW,
  )
  const sec = renderCuriositySection([n], { now: NOW, limit: 3, maxChars: 29 })
  assert.ok(Array.from(sec).length <= 29, `总长不超上限（${Array.from(sec).length}）`)
  assert.ok(!sec.includes('�'), '不能切出半个字符')
  // 逐个码元看：没有落单的代理项（emoji 没被劈开）
  for (let i = 0; i < sec.length; i += 1) {
    const code = sec.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = sec.charCodeAt(i + 1)
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'emoji 不能被切成半个')
      i += 1
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff, '不该有落单的低位代理项')
    }
  }
  assert.ok(sec.endsWith('…'), '截断了要留个省略号')
})

test('按码点切和整段截断这两件工具本身', () => {
  assert.equal(cutByCodePoints('😀😀😀', 2), '😀😀', '按码点切不切半个 emoji')
  assert.equal(cutByCodePoints('abc', 10), 'abc', '不超长就原样')
  assert.equal(clipSection('【好奇】', '· 甲：一行', 100), '【好奇】\n· 甲：一行', '不超长就原样')
  const clipped = clipSection('【好奇】', '· 甲：一行\n· 乙：两行', 14)
  assert.ok(clipped.length <= 14, `截断后不超上限（${clipped.length}）`)
  assert.ok(clipped.endsWith('…'), '截断了要留省略号')
  assert.ok(!clipped.includes('乙'), '宁可少一行，也不留半截行')
})

// ---------- 技能：两种不同情境各成一次才成立（2026-11-04 落地） ----------

const cwdA = 'E:\\proj\\alpha'
const cwdB = 'E:\\proj\\beta'

test('技能首写带情境：contexts 记下这一次的地方', () => {
  const s = makeNode(
    { text: '会拆 zstd 帧', kind: 'skill', context: '拆会话帧', changes: '换了', where: cwdA, contexts: [{ at: NOW, where: cwdA }] },
    NOW,
  )
  assert.equal(normKind(s.kind), 'skill', 'kind 认得 skill')
  assert.equal(s.context, '拆会话帧', 'context 是技能的名字')
  assert.equal(s.contexts.length, 1, '一处情境')
  assert.equal(s.contexts[0].where, cwdA, '情境是写下那一刻的真实目录')
  assert.equal(skillState(s), 'single', '只有一处还不算成立')
})

test('recordSkill：新情境再写一次 → 两种情境 → established', () => {
  const first = makeNode(
    { text: '会拆 zstd 帧', kind: 'skill', context: '拆会话帧', contexts: [{ at: NOW, where: cwdA }], changes: '记下' },
    NOW,
  )
  const res = recordSkill([first], { context: '拆会话帧', text: '会拆 zstd 帧', changes: '又记', where: cwdB }, NOW + 1000)
  assert.equal(res.repeated, true, '同一个名字 = 又成了一次')
  assert.equal(res.newContext, true, '换了目录 = 新情境')
  const s = res.node
  assert.equal(s.id, first.id, '不另开条，还是同一条')
  assert.equal(s.contexts.length, 2, '两处情境')
  assert.equal(skillState(s), 'established', '两种不同的情境各成过一次 → 成立')
  const hit = s.touches[s.touches.length - 1]
  assert.equal(hit.note, '在另一种情境又成了', '触碰记下「在另一种情境又成了」')
  // 第三次同一个目录：不新增情境
  const res2 = recordSkill(res.nodes, { context: '拆会话帧', text: '再拆', where: cwdB }, NOW + 2000)
  assert.equal(res2.newContext, false, '同一处再用不加情境')
  assert.equal(res2.node.contexts.length, 2, '还是两处')
  assert.equal(res2.node.touches[res2.node.touches.length - 1].note, '又用了一次', '同情境的触碰写「又用了一次」')
})

test('recordSkill：长路径的兄弟目录不算同一处（回归：contextKey 40 字截断曾把它们判重）', () => {
  // 真实临时目录就是这种形状 —— 前缀一大截相同，差别在最后一个段
  const longA = 'C:\\Users\\demo\\AppData\\Local\\Temp\\dsh-remember-smoke-aB55uC\\house'
  const longB = 'C:\\Users\\demo\\AppData\\Local\\Temp\\dsh-remember-smoke-aB55uC\\house\\elsewhere'
  assert.notEqual(skillWhereKey(longA), skillWhereKey(longB), '两个兄弟目录的情境键必须不同')
  assert.equal(skillWhereKey('E:\\Proj\\Alpha\\'), skillWhereKey('e:/proj/alpha'), '分隔符、大小写、结尾斜杠归一')
  const first = makeNode(
    { text: '会拆会话帧', kind: 'skill', context: '拆会话帧', contexts: [{ at: NOW, where: longA }], changes: '记下' },
    NOW,
  )
  const res = recordSkill([first], { context: '拆会话帧', text: '换个地方也成了', where: longB }, NOW + 1000)
  assert.equal(res.newContext, true, '长前缀下的兄弟目录 = 新情境')
  assert.equal(res.node.contexts.length, 2, '两处情境')
  assert.equal(res.node.contexts[1].where, longB, '新情境的 where 存全路径，不截断')
  assert.equal(skillState(res.node), 'established', '成立')
})

test('recordSkill：同名几条并成一条，其余退下（名字唯一）', () => {
  const a = makeNode({ text: '版本一', kind: 'skill', context: '拆会话帧', contexts: [{ at: NOW, where: cwdA }] }, NOW)
  const b = makeNode({ text: '版本二', kind: 'skill', context: '拆会话帧', contexts: [{ at: NOW + 10, where: cwdB }] }, NOW + 10)
  const res = recordSkill([a, b], { context: '拆会话帧', text: '版本三', where: cwdB }, NOW + 20)
  assert.equal(res.node.contexts.length, 2, 'contexts 合起来')
  const out = res.nodes.filter((n) => n.kind === 'skill')
  const alive = out.filter((n) => !n.superseded)
  assert.equal(alive.length, 1, '活着的只剩一条')
  assert.equal(alive[0].id, res.node.id, '活着的是主条')
  assert.ok(out.some((n) => n.superseded && n.supersededBy === res.node.id), '其余退下、指向主条')
})

test('recordSkill：context 空 / 没有同名条 → 不动账本', () => {
  const nodes = [makeNode({ text: '别的', kind: 'fact' }, NOW)]
  const r1 = recordSkill(nodes, { context: '', where: cwdA }, NOW)
  assert.equal(r1.repeated, false, '没名字就不动')
  assert.equal(r1.node, null)
  const r2 = recordSkill(nodes, { context: '从没见过的手艺', where: cwdA }, NOW)
  assert.equal(r2.repeated, false, '没有同名条也不动（首写走通用路径）')
})

test('renderLine：技能的状态写进行里', () => {
  const one = makeNode({ text: '拆帧', kind: 'skill', context: '拆会话帧', contexts: [{ at: NOW, where: cwdA }] }, NOW)
  const line1 = renderLine(one, NOW)
  assert.ok(line1.includes('会了·拆会话帧'), 'label 是「会了·名字」')
  assert.ok(line1.includes('一处情境'), '一处情境')
  const two = { ...one, contexts: [{ at: NOW, where: cwdA }, { at: NOW, where: cwdB }] }
  assert.ok(renderLine(two, NOW).includes('两处情境都成过'), '两处情境都成过')
})

// ---------- 条件封存：到点自松 / 等一条翻篇（2026-11-04 落地） ----------

test('isSealed：until 到点前后不一样，不跑后台、读取时算', () => {
  const n = { ...makeNode({ text: '压一压', kind: 'fact' }, NOW), sealUntil: NOW + 30 * 60 * 1000 }
  assert.equal(isSealed(n, NOW), true, '没到点 = 按住')
  assert.equal(isSealed(n, NOW + 30 * 60 * 1000 + 1), false, '到点自动松（读取路径上算，账本没动）')
})

test('isSealed：cond 目标活着就按住，翻篇/不在了就松', () => {
  const target = makeNode({ text: '根上的那条', kind: 'decision', weight: 0.9 }, NOW)
  const child = { ...makeNode({ text: '跟着按住的', kind: 'fact' }, NOW), sealCond: target.id }
  const dir = indexNodes([target, child])
  assert.equal(isSealed(child, NOW, dir), true, '目标活着 = 按住')
  const promotedTarget = { ...target, superseded: true, supersededBy: 'r_new' }
  const dir2 = indexNodes([promotedTarget, child])
  assert.equal(isSealed(child, NOW, dir2), false, '目标被顶下 = 自己松开')
  const dir3 = indexNodes([child])
  assert.equal(isSealed(child, NOW, dir3), false, '目标不在账本里 = 松开（目录要拿整本账编）')
})

test('setSeal：until 和 cond 单独设，null 全清', () => {
  const n = makeNode({ text: '条', kind: 'fact' }, NOW)
  const u = setSeal(n, { until: NOW + 60000 }, NOW)
  assert.equal(u.sealUntil, NOW + 60000, 'until 记上了')
  assert.equal(u.sealCond, '', 'cond 没动')
  const c = setSeal(n, { cond: 'r_abc' }, NOW)
  assert.equal(c.sealCond, 'r_abc', 'cond 记上了')
  assert.equal(c.sealUntil, 0, 'until 没动')
  assert.ok(!c.sealed, '不碰手动那个布尔')
  const cleared = setSeal(c, null, NOW)
  assert.equal(cleared.sealUntil, 0, '清掉 until')
  assert.equal(cleared.sealCond, '', '清掉 cond')
})

test('parseSealUntil 认时长写法，认不出或已过期的拒掉', () => {
  assert.equal(parseSealUntil('30m', NOW), NOW + 30 * 60 * 1000, '30m')
  assert.equal(parseSealUntil('2h', NOW), NOW + 2 * 60 * 60 * 1000, '2h')
  assert.equal(parseSealUntil('3d', NOW), NOW + 3 * DAY, '3d')
  assert.equal(parseSealUntil(`${NOW + 5000}`, NOW), NOW + 5000, '纯数字是毫秒')
  assert.equal(parseSealUntil('乱写的', NOW), null, '认不出 → null')
  assert.equal(parseSealUntil(String(NOW - 5000), NOW), null, '纯数字已在过去 → null')
  assert.equal(parseSealUntil('30m', NOW + DAY), NOW + DAY + 30 * 60 * 1000, '相对时长以传入的 now 为起点')
  const iso = new Date(NOW + 60000).toISOString()
  assert.equal(parseSealUntil(iso, NOW), NOW + 60000, 'ISO 时间也认')
})

test('relSealLeft：还剩多久说人话（「还剩」由调用方自己加）', () => {
  assert.equal(relSealLeft(NOW + 30 * 60 * 1000, NOW), '30 分钟', '分钟')
  assert.equal(relSealLeft(NOW + 2 * 60 * 60 * 1000, NOW), '2 小时', '小时')
  assert.equal(relSealLeft(NOW + 3 * DAY, NOW), '3 天', '天')
  assert.equal(relSealLeft(NOW - 1000, NOW), '', '已过期不硬说')
})

test('renderLine：条件按住的条带「按住·还有 X / 按住·等翻篇」', () => {
  const base = makeNode({ text: '压一压', kind: 'fact', changes: '记' }, NOW)
  const withUntil = { ...base, sealUntil: NOW + 30 * 60 * 1000 }
  assert.ok(renderLine(withUntil, NOW).includes('按住·还有'), 'until 的显示还剩多久')
  const withCond = { ...base, sealCond: 'r_target' }
  const dir = indexNodes([{ id: 'r_target', text: '根上的那条', superseded: false }, withCond])
  assert.ok(renderLine(withCond, NOW, { byId: dir }).includes('按住·等翻篇'), 'cond 的显示等翻篇（目录要给）')
  const dirGone = indexNodes([withCond])
  assert.ok(!renderLine(withCond, NOW, { byId: dirGone }).includes('按住'), '目标看不见（翻篇了）就不显示按住')
  const manual = setSealed(base, true, NOW)
  assert.ok(renderLine(manual, NOW).includes('按住了'), '手动的还是「按住了」')
})

test('rankNodes / searchNodes / renderSection 都认条件封存', () => {
  const root = makeNode({ text: '根上的决定', kind: 'decision', weight: 0.9, changes: '记', tags: '根' }, NOW)
  const child = {
    ...makeNode({ text: '跟着按住的', kind: 'fact', weight: 0.9, changes: '记', tags: '跟' }, NOW),
    sealCond: root.id,
  }
  const dir = indexNodes([root, child])
  assert.equal(rankNodes([root, child], NOW, { limit: 5, byId: dir }).length, 1, '条件按住的不进排名')
  assert.equal(rankNodes([root, child], NOW, { limit: 5, byId: dir, includeSealed: true }).length, 2, 'includeSealed 能翻到')
  assert.equal(searchNodes([root, child], '跟着', { now: NOW, byId: dir }).length, 0, '按住的不被按词翻出来')
  assert.equal(
    searchNodes([root, child], '跟着', { now: NOW, byId: dir, includeSealed: true }).length,
    1,
    'includeSealed 递进 searchNodes，按住的按词也翻得到（regression：工具层曾经递不进去）',
  )
  assert.equal(searchNodes([root, child], '跟着', { now: NOW }).length, 0, '不传 byId 也照样按住（目录自己编）')
  // 换情境：把根顶下去，子条自己活了
  const promoted = { ...root, superseded: true, supersededBy: 'r_new' }
  const sec = renderSection([promoted, child], { now: NOW, maxChars: 400, title: '测试' })
  assert.ok(sec.includes('跟着按住的'), '条件解除后段里就出现了（到点/翻篇不用 restore）')
})

// ===== whale-card P0 + 饭桶五条：known 第四问 / 锚不衰减 / 还没定的 / 淡了留声 / 回滚栈 =====

test('known 第四问（P0-1）：只答 known 也算「想过了」', () => {
  const known = makeNode({ text: '协议端是 NapCat', kind: 'fact', known: '原来桥用这个' }, NOW)
  assert.ok(hasThought(known), 'known 算第四问')
  assert.equal(known.known, '原来桥用这个')
  const bare = makeNode({ text: '光秃秃一条', kind: 'fact' }, NOW)
  assert.ok(!hasThought(bare), '四问一条没答不算「想过了」')
  const sec = renderSection([known, bare], { now: NOW, maxChars: 400, title: '测试' })
  assert.ok(sec.includes('协议端是 NapCat'), '答了 known 的挂得进开头')
  assert.ok(!sec.includes('光秃秃一条'), '四问没答的只进原话层，不挂开头')
})

test('锚不衰减（P0-2）：selfWeight 对锚返回原分量', () => {
  const anchor = makeNode(
    { text: '关系＝伙伴', kind: 'self', slot: 'identity', anchor: true, anchorWhy: '三年后还认', weight: 0.8, changes: '记' },
    NOW,
  )
  const later = NOW + 200 * DAY
  assert.equal(selfWeight(anchor, later), 0.8, '时间过了，锚的分量不掉')
  assert.ok(selfWeight(anchor, later) >= SELF_MIN_WEIGHT)
})

test('activeSelfNodes：锚不被分量线拦下，三年后还在自称', () => {
  const anchor = makeNode(
    { text: '关系＝伙伴', kind: 'self', slot: 'identity', anchor: true, anchorWhy: '三年后还认', weight: 0.8, changes: '记' },
    NOW,
  )
  const act = activeSelfNodes([anchor], NOW + 3 * 365 * DAY)
  assert.ok(act.some((n) => n.id === anchor.id), '普通条早淡没了，锚还在')
})

test('fadingSelfNodes（P0-3）：分量掉进 [0.15, 0.25) 的点得出来', () => {
  // weight 0.5 → τ = 30 + 135 = 165 天；150 天后 selfWeight ≈ 0.202，正好落在区间里
  const fading = makeNode({ text: '旧的小偏好', kind: 'self', slot: 'habits-bit', weight: 0.5, changes: '记' }, NOW - 150 * DAY)
  const fresh = makeNode({ text: '新写的我', kind: 'self', slot: 'identity', weight: 0.9, changes: '记' }, NOW)
  const list = fadingSelfNodes([fading, fresh], NOW)
  assert.ok(list.some((n) => n.id === fading.id), `实际 selfWeight ${selfWeight(fading, NOW).toFixed(3)}`)
  assert.ok(!list.some((n) => n.id === fresh.id), '新写的还没淡')
  const anchor = makeNode(
    { text: '锚不在其列', kind: 'self', slot: 'cares', anchor: true, anchorWhy: '三年后还认', weight: 0.2, changes: '记' },
    NOW - 150 * DAY,
  )
  assert.ok(!fadingSelfNodes([anchor], NOW).some((n) => n.id === anchor.id), '锚不衰减，永远不在「快淡没」名单里')
})

test('unsettledNodes（饭桶②）：doubt 槽 + open 进「还没定的」', () => {
  const doubt = makeNode({ text: '也许我也喜欢热闹', kind: 'self', slot: 'doubt', weight: 0.4, changes: '记' }, NOW)
  const open = makeNode({ text: 'HMR 根因没结', kind: 'open', weight: 0.7 }, NOW)
  const normal = makeNode({ text: '普通记忆', kind: 'fact', weight: 0.7, changes: '记' }, NOW)
  const list = unsettledNodes([doubt, open, normal], NOW)
  assert.equal(list.length, 2, '只有 doubt 槽的自我条 + open 进来')
  assert.ok(list.some((n) => n.id === doubt.id))
  assert.ok(list.some((n) => n.id === open.id))
  assert.equal(list[0].id, open.id, '按分量排，open（0.7）在前')
})

test('renderSelfSection：doubt/open 不进【我】段 + 尾注「我最近没怎么想起」', () => {
  const anchor = makeNode(
    { text: '关系＝伙伴', kind: 'self', slot: 'identity', anchor: true, anchorWhy: '三年后还认', weight: 0.9, changes: '记' },
    NOW,
  )
  const doubt = makeNode({ text: '也许我也喜欢热闹', kind: 'self', slot: 'doubt', weight: 0.4, changes: '记' }, NOW)
  const fading = makeNode({ text: '旧的小偏好', kind: 'self', slot: 'habits-bit', weight: 0.5, changes: '记' }, NOW - 150 * DAY)
  const sec = renderSelfSection([anchor, doubt, fading], { now: NOW, maxChars: 600 })
  assert.ok(sec.includes('关系＝伙伴'), '锚照常自称')
  assert.ok(!sec.includes('也许我也喜欢热闹'), 'doubt 槽不进【我】段（它有【还没定的】）')
  assert.ok(sec.includes('我最近没怎么想起'), '淡了留声出现')
  assert.ok(sec.includes('旧的小偏好') || sec.includes('habits-bit'), '留声点出名来')
  const quiet = renderSelfSection([anchor, doubt], { now: NOW, maxChars: 600 })
  assert.ok(!quiet.includes('我最近没怎么想起'), '没有快淡没的就不出尾注')
})

test('renderUnsettledSection（饭桶②）：固定晒一条，剩下的数个数', () => {
  const doubt = makeNode({ text: '也许我也喜欢热闹', kind: 'self', slot: 'doubt', weight: 0.4, changes: '记' }, NOW)
  const open = makeNode({ text: 'HMR 根因没结', kind: 'open', weight: 0.7 }, NOW)
  const sec = renderUnsettledSection([doubt, open], { now: NOW, maxChars: 240 })
  assert.ok(sec.includes('还没定的'), '段头')
  assert.ok(sec.includes('HMR 根因没结'), '晒分量最重的一条')
  assert.ok(sec.includes('还有 1 条没定的'), '剩下数个数')
  assert.ok(!sec.includes('也许我也喜欢热闹'), '只晒一条，不全倒出来')
  const single = renderUnsettledSection([open], { now: NOW, maxChars: 240 })
  assert.ok(single.includes('HMR 根因没结'))
  assert.ok(!single.includes('沉在账本里'), '只有一条不用尾注')
  const fact = makeNode({ text: '普通记忆', kind: 'fact', weight: 0.7, changes: '记' }, NOW)
  assert.equal(renderUnsettledSection([fact], { now: NOW, maxChars: 240 }), '', '没有 doubt/open 的账本不出段')
})

test('supersedeSelf（P0-2）：退下的 id 记进新条的 replaces（回滚栈）', () => {
  const old1 = makeNode({ text: '第一版我', kind: 'self', slot: 'identity', weight: 0.9, changes: '记' }, NOW)
  const old2 = makeNode({ text: '第二版我', kind: 'self', slot: 'identity', weight: 0.85, changes: '记' }, NOW)
  const r1 = supersedeSelf([old1, old2], 'identity', old2.id, NOW)
  assert.deepEqual(r1.superseded, [old1.id], '第一次：old1 退下')
  const fresh = makeNode({ text: '第三版我', kind: 'self', slot: 'identity', weight: 0.9, changes: '记' }, NOW)
  // 真实顺序：先把新条放进账本，再顶位（supersedeSelf 只改账本里已有的条）
  const r2 = supersedeSelf([...r1.nodes, fresh], 'identity', fresh.id, NOW)
  assert.deepEqual(r2.superseded, [old2.id], '第二次：old2 退下（old1 已经退过了不再重复）')
  const me = r2.nodes.find((n) => n.id === fresh.id)
  assert.ok(Array.isArray(me.replaces) && me.replaces.includes(old2.id), '直接顶掉的记进 replaces')
})

test('supersedeSelf（定案 A）：新值盖 prevSelf 章——退下是链条上的一环（2026-11-18）', () => {
  const old = makeNode({ text: '旧的我', kind: 'self', slot: 'identity', weight: 0.9, changes: '记' }, NOW)
  const fresh = makeNode({ text: '新的我', kind: 'self', slot: 'identity', weight: 0.9, changes: '记' }, NOW)
  // 真实顺序：先把新条放进账本，再顶位（supersedeSelf 只改账本里已有的条）
  const r = supersedeSelf([old, fresh], 'identity', fresh.id, NOW)
  const me = r.nodes.find((n) => n.id === fresh.id)
  assert.equal(me.prevSelf, old.id, '新条盖 prevSelf 章指被退下的那条')
  assert.equal(r.nodes.find((n) => n.id === old.id).superseded, true, '旧条照常退下')
  // 链能走：沿 prevSelf 从现行走到旧条
  const walked = []
  let cur = me.prevSelf
  while (cur) {
    const n = r.nodes.find((x) => x.id === cur)
    if (!n) break
    walked.push(n)
    cur = n.prevSelf
  }
  assert.equal(walked.length, 1, '链走一步到旧条')
})

test('renderYesterdayStream（定案 B）：无数据不挂段、UTC 日界、性能钉（2026-11-18）', () => {
  // 无数据 → 空串（不硬凑叙述）
  assert.equal(renderYesterdayStream({ nodes: [], echoTimes: new Map(), now: NOW }), '')
  // UTC 日界：23:59 与 00:01 分属两天
  const dayMs = 24 * 60 * 60 * 1000
  const justBefore = Date.UTC(2026, 10, 17, 23, 59)
  const justAfter = Date.UTC(2026, 10, 18, 0, 1)
  const n = makeNode({ text: '界前写的', kind: 'fact', weight: 0.5 }, justBefore)
  const et = new Map([['r_x', [justBefore]]])
  assert.ok(renderYesterdayStream({ nodes: [n], echoTimes: new Map(), now: justAfter }).includes('昨天写下'), '界后看界前写的 → 在昨日窗内')
  assert.equal(renderYesterdayStream({ nodes: [n], echoTimes: et, now: justBefore - 60000 }), '', '界前看自己 → 还在今天，不出昨日段')
  // 性能钉（B3-5）：2 万行 echo 数据下 < 100ms —— 防灯案复发
  const bigEcho = new Map()
  for (let i = 0; i < 20000; i++) {
    bigEcho.set(`r_perf${i}`, [NOW - (i % 3) * dayMs]) // 分布在三天内
  }
  const bigNodes = Array.from({ length: 500 }, (_, i) =>
    makeNode({ text: `性能钉${i}`, kind: 'fact', weight: 0.5 }, NOW - (i % 2) * dayMs),
  )
  const t0 = performance.now()
  renderYesterdayStream({ nodes: bigNodes, echoTimes: bigEcho, now: NOW })
  const elapsed = performance.now() - t0
  assert.ok(elapsed < 100, `2 万行 echo 聚合 < 100ms（实际 ${elapsed.toFixed(1)}ms）`)
})

test('deriveStandingBodyStates（定案 C）：饿向/饱向时序两侧、mood 窗、threshold 不入（2026-11-18）', () => {
  const MINUTE = 60 * 1000
  const base = NOW - 60 * MINUTE
  const hungry = deriveStandingBodyStates([
    { id: 'f_1', at: base, kind: 'meal', text: '吃了一口' },
    { id: 'f_2', at: base + 30 * MINUTE, kind: 'missed', text: '错过了一顿' },
  ], NOW)
  assert.ok(hungry.some((s) => s.text.includes('饿')), `饿向：${JSON.stringify(hungry)}`)
  const full = deriveStandingBodyStates([
    { id: 'f_1', at: base + 30 * MINUTE, kind: 'topup', text: '添了饭' },
    { id: 'f_2', at: base, kind: 'missed', text: '错过了' },
  ], NOW)
  assert.ok(full.some((s) => s.text.includes('吃')), `饱向：${JSON.stringify(full)}`)
  assert.equal(deriveStandingBodyStates([], NOW).length, 0)
  const mood = deriveStandingBodyStates([
    { id: 'f_3', at: NOW - 10 * MINUTE, kind: 'mood', text: '心里动了一下' },
  ], NOW)
  assert.ok(mood.some((s) => s.text.includes('不平静')), '30 分窗内的 mood → 心里不平静')
  const thr = deriveStandingBodyStates([
    { id: 'f_4', at: base + 40 * MINUTE, kind: 'threshold', text: '饿到发慌' },
  ], NOW)
  assert.ok(!thr.some((s) => s.text.includes('饿')), 'threshold 不入饿向（v1 先不猜）')
})