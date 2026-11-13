import { describe, it, expect, vi } from 'vitest'
vi.unmock('@/common/utils/environment')
import { getPmhqTarget, isPmhqMode, usesLegacyPmhq } from '@/common/utils/environment'
const argv = (...args: string[]) => ['node', 'main.ts', ...args]

describe('self-hosted backend selection', () => {
  it('defaults to external loopback PMHQ without any platform token', () => {
    expect(getPmhqTarget(argv())).toEqual({ host: '127.0.0.1', port: '13000' })
    expect(isPmhqMode()).toBe(true)
    expect(getPmhqTarget(argv('--pmhq-host=pmhq'))).toEqual({ host: 'pmhq', port: '13000' })
  })
  it('accepts space/equal forms and normalizes the port', () => {
    expect(getPmhqTarget(argv('--pmhq-host', '10.0.0.2', '--pmhq-port', '013001'))).toEqual({ host: '10.0.0.2', port: '13001' })
    expect(getPmhqTarget(argv('--qq', '10001', '--pmhq-port=13001', '--pmhq-legacy'))).toEqual({ host: '127.0.0.1', port: '13001' })
  })
  it.each(['::1', '[::1]'])('supports IPv6 %s', host => {
    expect(getPmhqTarget(argv('--pmhq-host', host)).host).toBe('[::1]')
  })
  it.each(['--pmhq-port', '--pmhq-port=', '--pmhq-host', '--pmhq-host='])('rejects missing %s', arg => {
    expect(() => getPmhqTarget(argv(arg))).toThrow('requires a value')
    expect(() => getPmhqTarget(argv(arg, '--pmhq-legacy'))).toThrow()
  })
  it.each(['0', '-1', '65536', 'abc', '1.5', ' 13000'])('rejects port %s', port => {
    expect(() => getPmhqTarget(argv(`--pmhq-port=${port}`))).toThrow()
  })
  it.each(['http://localhost', 'a/b', 'user@host', 'localhost:13000', '[::1', 'a b'])('rejects host %s', host => {
    expect(() => getPmhqTarget(argv(`--pmhq-host=${host}`))).toThrow()
  })
  it.each(['--direct', '--direct=true', '--cdn', '--cdn=china', '--dev'])('rejects retired platform flag %s', arg => {
    expect(() => getPmhqTarget(argv(arg))).toThrow('not available')
  })
  it('only enables legacy RPC when explicitly requested', () => {
    expect(usesLegacyPmhq(argv())).toBe(false)
    expect(usesLegacyPmhq(argv('--pmhq-legacy'))).toBe(true)
  })
})
