import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
vi.unmock('@/common/utils/environment')
import { selfInfo } from '@/common/globalVars'
import { createBackendRoutes } from '@/webui/BE/routes/backend'
import { authMiddleware } from '@/webui/BE/auth'
import { hashPassword } from '@/webui/BE/passwordHash'
import { createMockContext } from '../helpers/mockContext'

function fixture(connected = false, loginError = '') {
  const ctx = createMockContext()
  ctx.qqProtocol.get_is_connected = vi.fn(() => connected)
  ctx.qqProtocol.getLoginError = vi.fn(() => loginError)
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    c.env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
    await next()
  })
  app.use('/api/*', authMiddleware)
  app.route('/api', createBackendRoutes(ctx))
  return app
}
const headers = { 'X-Webui-Token': hashPassword('test-token') }
beforeEach(() => { selfInfo.online = false })

describe('self-hosted management API', () => {
  it('retains WebUI password protection', async () => {
    const response = await fixture().request('/api/backend-status')
    expect(response.status).toBe(403)
  })
  it('reports missing external backend without demanding platform credentials', async () => {
    const response = await fixture(false, 'PMHQ unavailable').request('/api/backend-status', { headers })
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({
      mode: 'external-pmhq', connected: false, online: false,
      platformAccountRequired: false, loginError: 'PMHQ unavailable',
      capabilities: { quickLogin: false, logout: false },
    })
  })
  it('does not confuse transport connection with QQ online', async () => {
    const response = await fixture(true).request('/api/backend-status', { headers })
    expect((await response.json()).data).toMatchObject({ connected: true, online: false })
    selfInfo.online = true
    const online = await fixture(true).request('/api/backend-status', { headers })
    expect((await online.json()).data.online).toBe(true)
  })
  it.each(['/api/auth-token', '/api/auth-token/status'])('does not expose removed registration route %s', async path => {
    expect((await fixture().request(path, { headers })).status).toBe(404)
    expect((await fixture().request(path, { method: 'POST', headers })).status).toBe(404)
  })
})
