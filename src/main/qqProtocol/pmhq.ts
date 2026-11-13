import { deepConvertMap, deepStringifyMap } from './util'
import { selfInfo } from '@/common/globalVars'
import { randomUUID, createHash } from 'node:crypto'
import type {
  PMHQRes,
  PMHQReq,
  PMHQResSendPB,
  PMHQResLegacyCall,
  PMHQHealth,
  PBData,
  QQResourceUsage,
  ResListener,
} from './types'
import { Context } from 'cordis'
import { getPmhqTarget, usesLegacyPmhq } from '@/common/utils/environment'
import { buildSsoInfoSync } from './protocol-support/ssoInfoSync'
import { LegacyPmhqLogin } from './legacyPmhqLogin'
import { QQProtocolBase } from './base'

/**
 * PMHQ 模式实现: WS(优先) + HTTP 回退 与 PMHQ dll 通信.
 * QQ NT 早已登录, LLBot 寄生其上; 靠 /health 轮询拿 uin/uid.
 */
export class PmhqQQProtocol extends QQProtocolBase {
  private legacyLogin: LegacyPmhqLogin | undefined
  private loginError = ''
  // Application stores/config are initialized for one account; switching requires a restart.
  private activeIdentity = ''
  private probeTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  protected httpUrl: string
  protected wsUrl: string
  protected ws: WebSocket | undefined
  private resListeners: Map<string, ResListener<any>> = new Map()
  private hasConnectedOnce: boolean = false
  private hasLoggedConnectionError: boolean = false
  // 探测会话的取消令牌: 每次 WS open 启动一次新的探测, token 自增;
  // 任何 setTimeout/listener 回调发现自己的 token 不是当前 token 就什么都不做并主动清理。
  private pmhqProbeToken: number = 0

  constructor(ctx: Context) {
    super(ctx)
    const { host, port } = getPmhqTarget()
    this.httpUrl = `http://${host}:${port}/`
    this.wsUrl = `ws://${host}:${port}/ws`
    if (usesLegacyPmhq()) {
      this.legacyLogin = new LegacyPmhqLogin(async (func, args, timeout) => {
        const response = await this.wsSend<PMHQResLegacyCall>({ type: 'call', data: { func, args } }, timeout)
        if (response.type !== 'call' || !response.data) throw new Error('Invalid legacy PMHQ RPC response')
        return response.data.result
      }, listener => {
        const id = this.addResListener(listener)
        return () => this.removeResListener(id)
      })
    }
  }

  public getLoginError(): string { return this.loginError }

  protected async start(): Promise<void> {
    // 订阅 recv 事件, 转发为 qq/raw 供 dispatcher 用. (旧代码里叫 startHook, 现在归内部)
    this.addResListener((data: any) => {
      if (data?.type === 'recv' && data.data?.cmd && data.data?.pb) {
        let payload = Buffer.from(data.data.pb, 'hex')
        // PMHQ 9.x recv pb has a 4-byte big-endian length header (len = header + body).
        // Parsing it as protobuf shifts fields and the message is silently dropped (#870/#881).
        // Strip it when it matches; bare protobuf payloads are left untouched.
        if (payload.length > 4 && payload.readUInt32BE(0) === payload.length) {
          payload = payload.subarray(4)
        }
        this.ctx.parallel('qq/raw', { cmd: data.data.cmd, payload })
      }
    })
    await this.connectWebSocket()
  }

  public get_is_connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  public async sendPB(cmd: string, pb: Buffer | string, timeout = 15000): Promise<PBData> {
    const hex = Buffer.isBuffer(pb) ? pb.toString('hex') : pb
    if (this.ws?.readyState === WebSocket.OPEN) {
      return this.unwrapPmhqRes(
        await this.wsSend<PMHQResSendPB>({ type: 'send', data: { cmd, pb: hex } }, timeout),
        cmd,
      )
    }
    return this.unwrapPmhqRes(
      await this.httpSend<PMHQResSendPB>({ type: 'send', data: { cmd, pb: hex } }, timeout),
      cmd,
    )
  }

  /**
   * base 拉码钩子: 拉一张新登录二维码 (QQ 未登录时 PMHQ 注入的 JS 会主动拉码写临时文件, 这里读接口).
   * expireTimeSec 用接口返回的真实 expireTime -- base 据此做 TTL, 没过期不重拉 (修终端狂刷 bug).
   * code:1 (已登录) / 其它 (未就绪) 返回 null, base loop 静默重试.
   */
  protected async fetchFreshQrCode(): Promise<{ qrcodeUrl: string; pngBase64: string; expireTimeSec: number; sig: string } | null> {
    const res = await this.fetchPmhqQrcode()
    if (res.code === 0 && res.data) {
      return {
        qrcodeUrl: res.data.qrcodeUrl,
        pngBase64: res.data.pngBase64QrcodeData,
        expireTimeSec: res.data.expireTime,
        sig: res.data.qrcodeUrl,
      }
    }
    return null
  }

  // ---- PMHQ 内部: 登录探测 + 状态复位 ----

  /**
   * PMHQ 模式下 LLBot 是寄生在 QQ NT 上的, QQ NT 早就登录过了, 开机时的 InfoSyncPush 也早处理完.
   * LLBot 想要群最新 seq (拉历史用) 就得自己主动触发一次: 发 SsoInfoSync, server 看到注册请求就回一发 InfoSyncPush.
   * isFirstRegisterProxyOnline=0 + 派生 guid (基于 uid, 每个号固定) 尽量避免和 QQ NT 的注册项冲突.
   */
  private async triggerInfoSyncPush() {
    const seed = selfInfo.uid || selfInfo.uin || 'llbot'
    const guid: Buffer = createHash('md5').update(`llbot-${seed}`).digest().subarray(0, 16)
    const payload = buildSsoInfoSync(guid, false)
    await this.sendPB('trpc.msg.register_proxy.RegisterProxy.SsoInfoSync', payload, 5000)
    this.logger.debug('已主动触发 RegisterProxy.SsoInfoSync（PMHQ）')
  }

  private resetPmhqState() {
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = undefined }
    const wasOnline = this.onlineEmitted
    selfInfo.online = false
    selfInfo.uid = ''
    selfInfo.uin = ''
    selfInfo.nick = ''
    this.pmhqProbeToken++
    this.onlineEmitted = false
    this.resetQrState()
    if (wasOnline) {
      this.ctx.parallel('protocol/disconnect')
    }
  }

  /**
   * PMHQ 模式: 轮询 /health 拿 self uin/uid (DLL 从 QQ 内存直接读 uin,
   * injector 侧扫 recv pb 抠 uid, 都写到 /health). 拿到 uin+uid 立即 emit online,
   * nick 通过 scheduleFetchSelfNick 异步等 ntUserApi 服务 ready 后再拉.
   * 重连后会被 onopen 再次调用, 所以必须先 reset 旧状态再启动新一轮.
   */
  private startPmhqLoginProbe() {
    this.resetPmhqState()
    let myToken = ++this.pmhqProbeToken

    let warnedNotLoggedIn = false
    const probe = async () => {
      if (this.pmhqProbeToken !== myToken) return
      try {
        let health: { uin?: number | string | null; uid?: string | null; nick?: string; online?: boolean }
        if (this.legacyLogin) health = await this.legacyLogin.readSelfInfo()
        else {
          const resp = await fetch(`${this.httpUrl}health`, { signal: AbortSignal.timeout(5000) })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          health = await resp.json() as PMHQHealth
        }
        if (this.pmhqProbeToken !== myToken) return
        this.loginError = ''

        if (health.online !== false && /^[1-9]\d*$/.test(String(health.uin ?? '')) && typeof health.uid === 'string' && health.uid.length > 0) {
          const identity = `${health.uin}:${health.uid}`
          if (this.activeIdentity && this.activeIdentity !== identity) {
            throw new Error('PMHQ account changed; restart LLBot before using a different QQ account')
          }
          this.activeIdentity = identity
          selfInfo.uid = health.uid
          selfInfo.uin = String(health.uin)
          if (health.nick) selfInfo.nick = health.nick
          const firstOnline = !selfInfo.online
          selfInfo.online = true
          this.maybeEmitOnline()
          if (firstOnline) {
            this.logger.info('QQ 登录成功: %s (%s)', selfInfo.nick || '<pending>', selfInfo.uin)
            const generation = this.pmhqProbeToken
            this.scheduleFetchSelfNick(() => selfInfo.online && this.pmhqProbeToken === generation)
            void this.triggerInfoSyncPush().catch(e => this.logger.debug('InfoSync: %s', (e as Error).message))
          }
        } else {
          if (selfInfo.online) { this.resetPmhqState(); myToken = this.pmhqProbeToken }
          // QQ 未登录: 此时才启动终端扫码 loop (幂等). 已登录则永不进拉码路径,
          // 避免对已登录的 QQ 拉码 -> get_login_qrcode 返回已登录 -> QR code unavailable 刷屏。
          this.ensureQrLoop()
          if (!warnedNotLoggedIn) {
            this.logger.info('QQ 未登录，等待登录中...')
            warnedNotLoggedIn = true
          }
        }
      } catch (e) {
        if (this.pmhqProbeToken !== myToken) return
        this.loginError = (e as Error).message
        if (selfInfo.online) { this.resetPmhqState(); myToken = this.pmhqProbeToken }
        if (!warnedNotLoggedIn) {
          this.logger.info('PMHQ login probe failed, continuing: %s', this.loginError)
          warnedNotLoggedIn = true
        }
      }
      if (this.pmhqProbeToken !== myToken) return
      this.probeTimer = setTimeout(probe, selfInfo.online ? 5000 : 600)
    }
    probe()
  }

  /**
   * 打一次 PMHQ /get_login_qrcode. 响应约定 (见 pmhq_get_login_qrcode 文档):
   * code:0 拿到码; code:1 已登录; code:-1 未就绪/已过期 (稍后重试会返回新码)。
   */
  private async fetchPmhqQrcode(): Promise<{
    code: number
    message?: string
    data?: { pngBase64QrcodeData: string; qrcodeUrl: string; expireTime: number; pollTimeInterval: number }
  }> {
    if (this.legacyLogin) return { code: 0, data: await this.legacyLogin.fetchQr() }
    const resp = await fetch(`${this.httpUrl}get_login_qrcode`, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.json()
  }

  /**
   * QQ 进程资源占用: PMHQ /health 的 memory (字节) + cpu (整机占比小数)。
   * cpu 是 PMHQ 按相邻两次 /health 的增量算的, 所以第一次调恒为 0, 之后的值覆盖
   * "上次有人打 /health 到现在" 这段窗口 (WebUI 5s 一轮 -> 就是 5s 均值)。
   * 老 PMHQ 不返这两个字段 -> null, WebUI 不渲染 "QQ 资源" 卡。
   */
  public async getQQResourceUsage(): Promise<QQResourceUsage | null> {
    if (this.legacyLogin) return null
    try {
      const resp = await fetch(`${this.httpUrl}health`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const { memory, cpu, qq_full_version } = (await resp.json()) as PMHQHealth
      if (!memory || !cpu) return null
      return {
        memory: memory.qq_using,
        totalMemory: memory.total,
        memoryPercent: memory.total > 0 ? (memory.qq_using / memory.total) * 100 : 0,
        cpu: Math.min(100, Math.max(0, (cpu.qq_using / (cpu.total || 1)) * 100)),
        version: qq_full_version || undefined,
      }
    } catch (e) {
      this.logger.debug('PMHQ /health 取资源占用失败: %s', (e as Error).message)
      return null
    }
  }

  // ---- PMHQ 内部: 传输层 (WS / HTTP) ----

  public addResListener<R extends PMHQRes>(listener: ResListener<R>) {
    const listenerId = randomUUID()
    this.resListeners.set(listenerId, listener)
    return listenerId
  }

  public removeResListener(listenerId: string) {
    this.resListeners.delete(listenerId)
  }

  private async connectWebSocket() {
    const reconnect = () => {
      const old = this.ws
      this.ws = undefined
      if (old) {
        old.onopen = old.onclose = old.onerror = old.onmessage = null
        old.close()
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = undefined
      }
      this.reconnectTimer = setTimeout(() => {
        this.connectWebSocket()
      }, 1000)
    }

    try {
      this.ws = new WebSocket(this.wsUrl)
    } catch (e) {
      return reconnect()
    }

    this.ws.onmessage = async (event) => {
      let data: PMHQRes
      try {
        data = JSON.parse(event.data.toString())
      } catch (e) {
        this.logger.error('解析 PMHQ 消息失败', event.data, e)
        return
      }
      data = deepConvertMap(data)
      for (const func of this.resListeners.values()) {
        setImmediate(() => {
          try {
            func(data)
          } catch (e) {
            this.logger.error('PMHQ res listener error', e)
          }
        })
      }
    }

    this.ws.onerror = () => {
      this.loginError = 'PMHQ connection error; waiting for the external QQ backend'
      this.resetPmhqState()

      if (!this.hasLoggedConnectionError) {
        this.logger.error('PMHQ WebSocket 连接错误，可能 QQ 未启动，正在等待 QQ 启动进行重连...')
        this.hasLoggedConnectionError = true
      }

      reconnect()
    }

    this.ws.onclose = () => {
      this.loginError = 'PMHQ disconnected; reconnecting'
      this.resetPmhqState()

      if (!this.hasLoggedConnectionError) {
        this.logger.info('PMHQ WebSocket 连接关闭，准备重连...')
        this.hasLoggedConnectionError = true
      }

      reconnect()
    }

    this.ws.onopen = () => {
      this.logger.info('PMHQ WebSocket 连接成功')
      this.hasLoggedConnectionError = false
      if (!this.hasConnectedOnce) {
        this.hasConnectedOnce = true
        this.lastConnectedTime = Date.now()
      }
      // 每次(重)连成功后重新走一遍登录探测
      this.startPmhqLoginProbe()
    }
  }

  public async waitConnected(timeout = 15000): Promise<boolean> {
    const deadline = Date.now() + timeout
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.get_is_connected()) return resolve(true)
        const remaining = deadline - Date.now()
        if (remaining <= 0) return reject(new Error('PMHQ connection timeout'))
        setTimeout(check, Math.min(100, remaining))
      }
      check()
    })
  }

  public async wsSend<R extends PMHQRes>(data: PMHQReq, timeout = 15000): Promise<R> {
    const deadline = Date.now() + timeout
    await this.waitConnected(timeout)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('PMHQ request timeout before send')
    const echo = data.data.echo ?? randomUUID()
    data.data.echo = echo
    const payload = JSON.stringify(deepStringifyMap(data))
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeResListener(id)
        reject(new Error('PMHQ response timeout'))
      }, remaining)
      const id = this.addResListener<R>(res => {
        if (res.data?.echo !== echo) return
        clearTimeout(timer)
        this.removeResListener(id)
        resolve(res)
      })
      try {
        if (!this.get_is_connected()) throw new Error('PMHQ disconnected before send')
        this.ws!.send(payload)
      } catch (error) {
        clearTimeout(timer)
        this.removeResListener(id)
        reject(error)
      }
    })
  }

  public async httpSend<R extends PMHQRes>(data: PMHQReq, timeout = 15000): Promise<R> {
    const payload = JSON.stringify(deepStringifyMap(data))
    const response = await fetch(this.httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`PMHQ请求失败，请检查发包器PMHQ设置 ${response.status} - ${errorBody}`)
    }
    let result = await response.json()
    result = deepConvertMap(result)
    return result
  }

  /**
   * 解包 PMHQ active-send 响应. echo 只用于关联请求, 不能"echo 匹配就算成功":
   * PMHQ 即使发包失败 / QQ 未登录, 也会回一条 echo 匹配但 code 非 0 的响应.
   * 成败一律看 code: 0 = QQ 真回包 (已登录); 非 0 (-100 未登录/KernelMsgService 缺失/管道未连,
   * 或 QQ app error) 一律抛错, 不让上层拿空 pb 去 decode.
   */
  private unwrapPmhqRes(res: PMHQResSendPB, cmd: string): PBData {
    if (res.code != null && res.code !== 0) {
      const pb = res.data?.pb ?? ''
      const detail = pb ? ` pb=${pb.slice(0, 160)}` : ' pb=<empty>'
      throw new Error(`PMHQ send failed: cmd=${cmd} code=${res.code} ${res.message ?? ''}${detail}`.trim())
    }
    if (!res.data || typeof res.data.cmd !== 'string' || res.data.cmd !== cmd || typeof res.data.pb !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(res.data.pb)) {
      throw new Error(`PMHQ returned an invalid response for ${cmd}`)
    }
    return res.data
  }
}
