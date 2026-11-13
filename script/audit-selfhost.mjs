// Audit production output, not just whether the registration dialog was hidden.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')
const backend = await readFile(join(dist, 'llbot.js'), 'utf8')
const forbidden = [
  '/api/auth-token', 'auth_token.txt', 'auth_token.dev.txt',
  'auth.luckylillia.com', 'api-auth.luckylillia.com', 'llbot-api-auth.wumiao.wang',
  'llbot.wumiao.wang', 'validateAuthToken', 'startAuthTokenWatcher', 'getSignProxy',
]
for (const marker of forbidden) assert(!backend.includes(marker), `Platform dependency in backend: ${marker}`)
assert(!(await readdir(dist)).some(name => /sign-proxy.*\.node$/.test(name)), 'Native platform signer is still packaged')
const map = JSON.parse(await readFile(join(dist, 'llbot.js.map'), 'utf8'))
const signingSources = map.sources.filter(source => /\/(?:sign-proxy\/|direct\.ts$|direct-lib\/(?:client|sign|authTokenWatcher)\.ts$)/.test(source))
assert.deepEqual(signingSources, [], 'Platform signing code is still in runtime graph')
const frontendFiles = (await readdir(join(dist, 'webui/assets'))).filter(name => name.endsWith('.js'))
assert(frontendFiles.length > 0, 'Build WebUI first')
for (const file of frontendFiles) {
  const text = await readFile(join(dist, 'webui/assets', file), 'utf8')
  for (const marker of forbidden) assert(!text.includes(marker), `Platform dependency in frontend ${file}: ${marker}`)
}
console.log(JSON.stringify({ platformMarkers: 0, nativeSigningModules: 0, signingSources: 0, frontendFiles: frontendFiles.length, realQQTested: false }, null, 2))
