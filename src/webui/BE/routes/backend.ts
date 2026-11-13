import { Hono } from 'hono'
import type { Context } from 'cordis'
import { selfInfo } from '@/common/globalVars'
import { usesLegacyPmhq } from '@/common/utils/environment'

/** Registered behind the same WebUI password middleware as other management APIs. */
export function createBackendRoutes(ctx: Context): Hono {
  const router = new Hono()
  router.get('/backend-status', c => c.json({
    success: true,
    data: {
      mode: 'external-pmhq',
      legacy: usesLegacyPmhq(),
      connected: ctx.qqProtocol.get_is_connected(),
      online: selfInfo.online,
      platformAccountRequired: false,
      loginError: ctx.qqProtocol.getLoginError(),
      capabilities: { quickLogin: false, logout: false },
    },
  }))
  return router
}
