/**
 * OneBot v11 客户端：WS 收事件 + HTTP 发动作。
 *
 * SnowLuma 侧两个口各自有 token（http/ws 不通用，别混）。
 * 断线重连 1s 起步、指数退到 30s 封顶；dispose 时一把停干净。
 *
 * 活性看门狗（2026-11-15 补的）：close/error 只在连接真断时触发，
 * 半开连接（拔线/NAT 超时）不触发 close —— 桥会永久变聋而心跳照写「活着」。
 * 现在每 30 秒看一眼：超过 90 秒一条消息都没有，就先发一个 get_status 探测，
 * 再过 30 秒还没动静就当它死了，主动断开走既有的重连 + 回填。
 */

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30000
/** 多久看一眼活性 */
const WATCHDOG_INTERVAL_MS = 30 * 1000
/** 多久没收到任何 WS 消息算「可疑」 */
const WATCHDOG_STALE_MS = 90 * 1000
/** 探测发出后多久没回音算「死了」 */
const WATCHDOG_PROBE_MS = 30 * 1000

export class OnebotClient {
  constructor({ httpUrl = 'http://127.0.0.1:3000', httpToken = '', wsUrl = '', wsToken = '', onEvent, onOpen, log = () => {} } = {}) {
    this.httpUrl = String(httpUrl).replace(/\/$/, '')
    this.httpToken = String(httpToken)
    this.wsUrl = String(wsUrl)
    this.wsToken = String(wsToken)
    this.onEvent = typeof onEvent === 'function' ? onEvent : null
    this.onOpen = typeof onOpen === 'function' ? onOpen : null
    this.log = log
    this.ws = null
    this.closed = false
    this.retries = 0
    this.timer = null
    // 活性看门狗的账
    this.lastIncomingAt = 0
    this.watchdogTimer = null
    this.probeAt = 0
    this.probeSeq = 0
  }

  connect() {
    if (this.closed || !this.wsUrl) return
    try {
      const url = this.wsToken ? `${this.wsUrl}?access_token=${encodeURIComponent(this.wsToken)}` : this.wsUrl
      const ws = new WebSocket(url)
      this.ws = ws
      ws.addEventListener('open', () => {
        this.retries = 0
        this.lastIncomingAt = Date.now()
        this.probeAt = 0
        this.log('OneBot WS 连上了')
        this.startWatchdog()
        if (this.onOpen) {
          try {
            this.onOpen()
          } catch (err) {
            this.log(`onOpen 回调出错（不影响连接）：${err?.message ?? err}`)
          }
        }
      })
      ws.addEventListener('message', (ev) => {
        // 任何来话（事件、动作回执、探测回音）都算「活着」
        this.lastIncomingAt = Date.now()
        this.probeAt = 0
        try {
          const data = JSON.parse(String(ev.data))
          if (this.onEvent) this.onEvent(data)
        } catch (err) {
          this.log(`WS 收到不是 JSON 的东西，跳过：${err?.message ?? err}`)
        }
      })
      ws.addEventListener('close', () => {
        this.stopWatchdog()
        this.scheduleReconnect('连接关了')
      })
      ws.addEventListener('error', (err) => {
        this.log(`WS 出错：${err?.message ?? err ?? '未知'}`)
      })
    } catch (err) {
      this.log(`WS 连不上：${err?.message ?? err}`)
      this.scheduleReconnect('连接抛错')
    }
  }

  /** WS 活着吗（连接开着就算 —— 真哑由看门狗负责发现） */
  isWsAlive() {
    return Boolean(this.ws && !this.closed && this.ws.readyState === 1)
  }

  /** 多久没收到任何 WS 消息了（毫秒）；从没收到过给 null */
  wsSilentMs(now = Date.now()) {
    if (!this.lastIncomingAt) return null
    return Math.max(0, Number(now) - this.lastIncomingAt)
  }

  startWatchdog() {
    this.stopWatchdog()
    if (this.closed) return
    this.watchdogTimer = setInterval(() => {
      try {
        this.watchdogTick()
      } catch {
        /* 看门狗自己不许抛 */
      }
    }, WATCHDOG_INTERVAL_MS)
    this.watchdogTimer.unref?.()
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.probeAt = 0
  }

  watchdogTick() {
    if (this.closed || !this.ws) return
    if (this.ws.readyState !== 1) return // 没连上/正在关 —— 交给 close/reconnect 管
    const now = Date.now()
    const silent = this.wsSilentMs(now)
    if (silent == null || silent < WATCHDOG_STALE_MS) return
    if (this.probeAt) {
      // 上一发探测还没回音 —— 当它死了，主动断开走重连 + 回填
      this.log(`看门狗：${Math.round(silent / 1000)}s 没有任何消息，探测 ${Math.round((now - this.probeAt) / 1000)}s 没回音 —— 当连接死了`)
      this.probeAt = 0
      this.scheduleReconnect('看门狗：半开连接（探测无回音）')
      return
    }
    // 发一个动作探测：OneBot 服务端会回一条带 echo 的回执，message 监听里就当「活着」
    this.probeSeq += 1
    this.probeAt = now
    try {
      this.ws.send(JSON.stringify({ action: 'get_status', echo: `bridge-watchdog-${this.probeSeq}` }))
    } catch (err) {
      this.log(`看门狗探测发不出去（${err?.message ?? err}）—— 当连接死了`)
      this.probeAt = 0
      this.scheduleReconnect('看门狗：探测发送失败')
    }
  }

  scheduleReconnect(why) {
    if (this.closed) return
    this.stopWatchdog()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* 关一个已经关了的，没事 */
      }
      this.ws = null
    }
    const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.retries)
    this.retries += 1
    this.log(`重连（第 ${this.retries} 次，等 ${Math.round(wait / 1000)}s）：${why}`)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, wait)
  }

  /** HTTP 动作口。retcode 0 才算成。默认 30 秒超时 —— 挂住的 HTTP 不许把回填卡死。 */
  async call(action, params = {}, { timeoutMs = 30000 } = {}) {
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30000))
    })
    if (!res.ok) throw new Error(`OneBot ${action} HTTP ${res.status}`)
    const out = await res.json()
    if (out && typeof out === 'object' && 'retcode' in out && Number(out.retcode) !== 0) {
      throw new Error(`OneBot ${action} retcode=${out.retcode} ${out.message ?? out.wording ?? ''}`)
    }
    return out
  }

  /** 把回话发回私聊。 */
  async sendPrivate(userId, text) {
    return this.sendPrivateSegments(userId, [{ type: 'text', data: { text } }])
  }

  /** 群里 @ 我的，回进群里。 */
  async sendGroup(groupId, text) {
    return this.sendGroupSegments(groupId, [{ type: 'text', data: { text } }])
  }

  /** 私聊发消息段（文字 + 图片，v0.7.0 的照片三件套用这个）。 */
  async sendPrivateSegments(userId, segments) {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: segments ?? [],
      auto_escape: false
    })
  }

  /** 群里发消息段（文字 + 图片）。 */
  async sendGroupSegments(groupId, segments) {
    return this.call('send_group_msg', {
      group_id: Number(groupId),
      message: segments ?? [],
      auto_escape: false
    })
  }

  /** 白名单里的人邀我进群，点个头。 */
  async approveGroupInvite(flag) {
    return this.call('set_group_add_request', { flag: String(flag), sub_type: 'invite', approve: true })
  }

  close() {
    this.closed = true
    this.stopWatchdog()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* 同上 */
      }
      this.ws = null
    }
  }
}
