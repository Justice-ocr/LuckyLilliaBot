import { afterEach, describe, expect, it, vi } from 'vitest'
import { LegacyPmhqLogin } from '@/main/qqProtocol/legacyPmhqLogin'

const qr = { pngBase64QrcodeData: 'image', qrcodeUrl: 'qr-url', expireTime: 120, pollTimeInterval: 3 }
const event = (data: unknown = qr) => ({ type: 'nodeIKernelLoginListener', data: { sub_type: 'onQRCodeGetPicture', data } })
function fixture(call = vi.fn().mockResolvedValue({ result: 0 })) {
  const listeners = new Set<(event: unknown) => void>()
  const login = new LegacyPmhqLogin(call, listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, 100)
  return { login, call, listeners, emit: (e: unknown) => { for (const listener of listeners) listener(e) } }
}
afterEach(() => { vi.useRealTimers() })

describe('PMHQ 7 login adapter (from reviewed fork)', () => {
  it('does not trust stale identity while offline', async () => {
    const f = fixture(vi.fn().mockResolvedValue({ online: false, uin: '123', uid: 'stale' }))
    expect(await f.login.readSelfInfo()).toEqual({})
  })
  it('returns a real online identity', async () => {
    const f = fixture(vi.fn().mockResolvedValue({ online: true, uin: 123, uid: 'uid', nick: 'test' }))
    expect(await f.login.readSelfInfo()).toEqual({ uin: '123', uid: 'uid', nick: 'test' })
    expect(f.call).toHaveBeenCalledWith('getSelfInfo', [], 100)
  })
  it.each([null, {}, { online: 'true' }, { online: true, uin: '123' }, { online: true, uin: '0', uid: 'uid' }])('rejects invalid status %j', async status => {
    const f = fixture(vi.fn().mockResolvedValue(status))
    await expect(f.login.readSelfInfo()).rejects.toThrow()
  })
  it('waits for RPC acknowledgement even if callback arrives first', async () => {
    let acknowledge!: (value: unknown) => void
    const f = fixture(vi.fn().mockImplementation(() => new Promise(resolve => { acknowledge = resolve })))
    const p = f.login.fetchQr()
    f.emit(event())
    expect(f.listeners.size).toBe(1)
    acknowledge({ result: 0 })
    await expect(p).resolves.toEqual(qr)
    expect(f.listeners.size).toBe(0)
  })
  it('accepts callback after acknowledgement, ignoring malformed/unrelated events', async () => {
    const f = fixture()
    const p = f.login.fetchQr()
    await Promise.resolve()
    f.emit({ type: 'recv', data: {} })
    f.emit(event({ ...qr, expireTime: 0 }))
    f.emit(event({ ...qr, pngBase64QrcodeData: '' }))
    expect(f.listeners.size).toBe(1)
    f.emit(event())
    await expect(p).resolves.toEqual(qr)
    expect(f.listeners.size).toBe(0)
  })
  it('rejects failed RPC even when a callback arrived', async () => {
    const f = fixture(vi.fn().mockResolvedValue({ result: 1 }))
    const p = f.login.fetchQr()
    f.emit(event())
    await expect(p).rejects.toThrow('rejected')
    expect(f.listeners.size).toBe(0)
  })
  it('cleans up when RPC throws', async () => {
    const f = fixture(vi.fn().mockRejectedValue(new Error('offline')))
    await expect(f.login.fetchQr()).rejects.toThrow('failed')
    expect(f.listeners.size).toBe(0)
  })
  it('bounds the callback wait', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const result = expect(f.login.fetchQr()).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(101)
    await result
    expect(f.listeners.size).toBe(0)
  })
})
