import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
vi.unmock('@/common/utils/environment')
vi.mock('@/common/globalVars', () => ({
  DATA_DIR: '/tmp/test-data', TEMP_DIR: '/tmp/test-data/temp', LOG_DIR: '/tmp/test-data/logs',
  selfInfo: { uin: '', uid: '', nick: '', online: false },
  authTokenStatus: { loginError: '' },
}))
import { selfInfo } from '@/common/globalVars'
import { PmhqQQProtocol } from '@/main/qqProtocol/pmhq'

function fixture() {
  const ctx = new Context()
  const protocol = new PmhqQQProtocol(ctx)
  const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() }
  Object.assign(protocol, { ws: socket })
  return { ctx, protocol, socket }
}
let argv: string[]
beforeEach(() => {
  argv = process.argv
  process.argv = ['node', 'llbot.js']
  Object.assign(selfInfo, { uin: '', uid: '', nick: '', online: false })
})
afterEach(() => {
  process.argv = argv
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('independent PMHQ transport', () => {
  it('has no native signer import and constructs without platform credentials', () => {
    const { protocol } = fixture()
    expect(protocol.get_is_connected()).toBe(true)
    expect(protocol.getLoginError()).toBe('')
  })
  it('times out while waiting for connection (not only after send)', async () => {
    vi.useFakeTimers()
    const { protocol, socket } = fixture()
    socket.readyState = WebSocket.CLOSED
    const pending = expect(protocol.wsSend({ type: 'send', data: { cmd: 'test', pb: '00' } }, 100)).rejects.toThrow('connection timeout')
    await vi.advanceTimersByTimeAsync(101)
    await pending
    expect(socket.send).not.toHaveBeenCalled()
  })
  it('removes response listeners on a send exception', async () => {
    const { protocol, socket } = fixture()
    socket.send.mockImplementation(() => { throw new Error('send failed') })
    await expect(protocol.wsSend({ type: 'send', data: { cmd: 'test', pb: '00' } })).rejects.toThrow('send failed')
    expect(protocol['resListeners'].size).toBe(0)
  })
  it('bounds response wait and cleans up the listener', async () => {
    vi.useFakeTimers()
    const { protocol } = fixture()
    const pending = expect(protocol.wsSend({ type: 'send', data: { cmd: 'test', pb: '00' } }, 100)).rejects.toThrow('response timeout')
    await vi.advanceTimersByTimeAsync(101)
    await pending
    expect(protocol['resListeners'].size).toBe(0)
  })
  it('correlates replies and preserves business PB bytes', async () => {
    const { protocol, socket } = fixture()
    socket.send.mockImplementation(payload => {
      const req = JSON.parse(payload)
      for (const listener of protocol['resListeners'].values()) listener({ type: 'recv', code: 0, data: { ...req.data, pb: '0801' } })
    })
    await expect(protocol.sendPB('test.command', Buffer.from('00', 'hex'))).resolves.toMatchObject({ cmd: 'test.command', pb: '0801' })
    expect(protocol['resListeners'].size).toBe(0)
  })
  it('does not treat echo as success when backend reports failure', async () => {
    const { protocol } = fixture()
    vi.spyOn(protocol, 'wsSend').mockResolvedValue({ type: 'recv', code: -100, data: { cmd: 'test', pb: '' } })
    await expect(protocol.sendPB('test', '00')).rejects.toThrow('code=-100')
  })
  it('preserves an explicitly successful empty protobuf response', async () => {
    const { protocol } = fixture()
    vi.spyOn(protocol, 'wsSend').mockResolvedValue({ type: 'recv', code: 0, data: { cmd: 'test', pb: '' } })
    await expect(protocol.sendPB('test', '00')).resolves.toMatchObject({ cmd: 'test', pb: '' })
  })
  it.each([
    { cmd: 'different', pb: '00' },
    { cmd: 'test', pb: 'odd' },
    { cmd: 'test', pb: 123 },
  ])('rejects malformed backend PB data %j', async data => {
    const { protocol } = fixture()
    vi.spyOn(protocol, 'wsSend').mockResolvedValue({ type: 'recv', code: 0, data } as any)
    await expect(protocol.sendPB('test', '00')).rejects.toThrow('invalid response')
  })
  it('forwards caller timeout to HTTP fallback', async () => {
    const { protocol, socket } = fixture()
    socket.readyState = WebSocket.CLOSED
    const http = vi.spyOn(protocol, 'httpSend').mockResolvedValue({ type: 'recv', code: 0, data: { cmd: 'test', pb: '00' } })
    await protocol.sendPB('test', '00', 123)
    expect(http).toHaveBeenCalledWith({ type: 'send', data: { cmd: 'test', pb: '00' } }, 123)
  })
  it('keeps the upstream PMHQ 9 length-header fix and accepts bare protobuf', async () => {
    const { protocol, ctx } = fixture()
    vi.spyOn(protocol as any, 'connectWebSocket').mockResolvedValue(undefined)
    const dispatch = vi.spyOn(ctx, 'parallel')
    await protocol['start']()
    const pb = Buffer.from('080112026869', 'hex')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(pb.length + 4)
    const listener = [...protocol['resListeners'].values()][0]
    for (const payload of [pb, Buffer.concat([header, pb])]) listener({ type: 'recv', data: { cmd: 'push', pb: payload.toString('hex') } })
    expect(dispatch).toHaveBeenCalledTimes(2)
    for (const call of dispatch.mock.calls) expect(call[1]).toEqual({ cmd: 'push', payload: pb })
  })
  it('continuously checks real login state and notices QQ logout', async () => {
    vi.useFakeTimers()
    const { protocol } = fixture()
    const online = { uin: 123, uid: 'uid', online: true }
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => online })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...online, online: false }) })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(protocol as any, 'scheduleFetchSelfNick').mockImplementation(() => {})
    vi.spyOn(protocol as any, 'ensureQrLoop').mockImplementation(() => {})
    vi.spyOn(protocol as any, 'triggerInfoSyncPush').mockResolvedValue(undefined)
    protocol['startPmhqLoginProbe']()
    await vi.advanceTimersByTimeAsync(0)
    expect(selfInfo.online).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(selfInfo.online).toBe(false)
    expect(selfInfo.uid).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('refuses live account replacement instead of reusing another account database', async () => {
    vi.useFakeTimers()
    const { protocol } = fixture()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ uin: 123, uid: 'first' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ uin: 456, uid: 'second' }) }))
    vi.spyOn(protocol as any, 'scheduleFetchSelfNick').mockImplementation(() => {})
    vi.spyOn(protocol as any, 'triggerInfoSyncPush').mockResolvedValue(undefined)
    protocol['startPmhqLoginProbe']()
    await vi.advanceTimersByTimeAsync(0)
    expect(selfInfo.online).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(selfInfo.online).toBe(false)
    expect(protocol.getLoginError()).toContain('restart LLBot')
    expect(selfInfo.uin).toBe('')
  })
  it('invalidates a pending nickname lookup when login generation ends', async () => {
    vi.useFakeTimers()
    const { protocol } = fixture()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ uin: 123, uid: 'uid' }) })
      .mockRejectedValueOnce(new Error('health unavailable')))
    const nick = vi.spyOn(protocol as any, 'scheduleFetchSelfNick').mockImplementation(() => {})
    vi.spyOn(protocol as any, 'triggerInfoSyncPush').mockResolvedValue(undefined)
    protocol['startPmhqLoginProbe']()
    await vi.advanceTimersByTimeAsync(0)
    const guard = nick.mock.calls[0][0] as () => boolean
    expect(guard()).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(guard()).toBe(false)
    expect(selfInfo.online).toBe(false)
    expect(protocol.getLoginError()).toContain('health unavailable')
  })
  it('uses legacy RPC only when explicitly requested', async () => {
    process.argv.push('--pmhq-legacy')
    const { protocol } = fixture()
    vi.spyOn(protocol, 'wsSend').mockResolvedValue({ type: 'call', data: { result: { online: true, uin: 123, uid: 'uid' } } })
    expect(protocol['legacyLogin']).toBeDefined()
    await expect(protocol['legacyLogin']!.readSelfInfo()).resolves.toMatchObject({ uin: '123', uid: 'uid' })
    expect(await protocol.getQQResourceUsage()).toBeNull()
  })
})
