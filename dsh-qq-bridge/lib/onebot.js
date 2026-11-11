/**
 * OneBot v11 客户端：WS 收事件 + HTTP 发动作。
 *
 * SnowLuma 侧两个口各自有 token（http/ws 不通用，别混）。
 * 断线重连 1s 起步、指数退到 30s 封顶；dispose 时一把停干净。
 */

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30000

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
  }

  connect() {
    if (this.closed || !this.wsUrl) return
    try {
      const url = this.wsToken ? `${this.wsUrl}?access_token=${encodeURIComponent(this.wsToken)}` : this.wsUrl
      const ws = new WebSocket(url)
      this.ws = ws
      ws.addEventListener('open', () => {
        this.retries = 0
        this.log('OneBot WS 连上了')
        if (this.onOpen) {
          try {
            this.onOpen()
          } catch (err) {
            this.log(`onOpen 回调出错（不影响连接）：${err?.message ?? err}`)
          }
        }
      })
      ws.addEventListener('message', (ev) => {
        try {
          const data = JSON.parse(String(ev.data))
          if (this.onEvent) this.onEvent(data)
        } catch (err) {
          this.log(`WS 收到不是 JSON 的东西，跳过：${err?.message ?? err}`)
        }
      })
      ws.addEventListener('close', () => this.scheduleReconnect('连接关了'))
      ws.addEventListener('error', (err) => {
        this.log(`WS 出错：${err?.message ?? err ?? '未知'}`)
      })
    } catch (err) {
      this.log(`WS 连不上：${err?.message ?? err}`)
      this.scheduleReconnect('连接抛错')
    }
  }

  scheduleReconnect(why) {
    if (this.closed) return
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

  /** HTTP 动作口。retcode 0 才算成。 */
  async call(action, params = {}) {
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
      },
      body: JSON.stringify(params ?? {})
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
