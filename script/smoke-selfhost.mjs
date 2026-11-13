// Controller integration check against a loopback-only offline PMHQ stub. Never logs into QQ.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '..')
const legacy = process.argv.includes('--legacy')
const directory = await mkdtemp(join(tmpdir(), 'llbot-selfhost-smoke-'))
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(req.url === '/health' ? {} : { code: -1, message: 'Offline test backend' }))
})
const wss = new WebSocketServer({ server })
wss.on('connection', ws => ws.on('message', raw => {
  const req = JSON.parse(String(raw))
  if (req.type === 'call') ws.send(JSON.stringify({ type: 'call', data: {
    echo: req.data.echo,
    result: req.data.func === 'getSelfInfo' ? { online: false } : { result: 1 },
  } }))
}))
let child
let output = ''
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const pmhqPort = server.address().port
  const reservation = net.createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const config = JSON.parse(await readFile(join(root, 'src/main/config/default_config.json'), 'utf8'))
  config.webui = { enable: true, host: '127.0.0.1', port }
  config.ob11.enable = config.milky.enable = config.satori.enable = false
  await mkdir(join(directory, 'data'))
  await writeFile(join(directory, 'data/config_10001.json'), JSON.stringify(config))
  await writeFile(join(directory, 'data/webui_token.txt'), 'smoke-local-password')
  const env = { ...process.env }
  delete env.AUTH_TOKEN
  delete env.PMHQ_AUTH_TOKEN
  child = spawn(process.execPath, [join(root, 'dist/llbot.js'), '--qq=10001', `--pmhq-port=${pmhqPort}`, ...(legacy ? ['--pmhq-legacy'] : [])], {
    cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const url = `http://127.0.0.1:${port}`
  const headers = { 'X-Webui-Token': createHash('sha256').update('smoke-local-password').digest('hex') }
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Controller exited: ${child.exitCode}\n${output}`)
    try {
      const response = await fetch(`${url}/api/backend-status`, { headers, signal: AbortSignal.timeout(500) })
      const body = await response.json()
      if (response.ok && body.data.connected) { ready = true; break }
    } catch { /* bounded startup wait */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(ready, `Controller did not become ready\n${output}`)
  assert.equal((await fetch(`${url}/`)).status, 200)
  assert.equal((await fetch(`${url}/api/backend-status`)).status, 403)
  const status = await (await fetch(`${url}/api/backend-status`, { headers })).json()
  assert.equal(status.data.platformAccountRequired, false)
  assert.equal(status.data.online, false)
  assert.equal(status.data.legacy, legacy)
  for (const path of ['/api/auth-token', '/api/auth-token/status']) {
    assert.equal((await fetch(url + path, { headers })).status, 404)
    assert.equal((await fetch(url + path, { method: 'POST', headers })).status, 404)
  }
  assert(!(await readdir(join(directory, 'data'))).some(name => /^auth_token/.test(name)))
  const invalid = spawnSync(process.execPath, [join(root, 'dist/llbot.js'), '--pmhq-port=invalid'], {
    cwd: directory, env, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(invalid.status, 1, `Malformed flags must fail before service startup: ${invalid.stdout}${invalid.stderr}`)
  for (const client of wss.clients) client.terminate()
  await new Promise(resolve => wss.close(resolve))
  await new Promise(resolve => server.close(resolve))
  let disconnected = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = await (await fetch(`${url}/api/backend-status`, { headers })).json()
    if (!state.data.connected && !state.data.online) { disconnected = true; break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(disconnected, 'Backend disconnection was not reported')
  console.log(JSON.stringify({ mode: legacy ? 'legacy' : 'modern', webui: 200, unauthenticated: 403,
    registrationRoutes: 404, connected: true, online: false, disconnectDetected: true,
    invalidArgumentsExit: invalid.status, tokenFileCreated: false, realQQTested: false }, null, 2))
} finally {
  if (child && child.exitCode === null) {
    const closed = once(child, 'close')
    child.kill()
    await closed
  }
  for (const client of wss.clients) client.terminate()
  await new Promise(resolve => wss.close(resolve))
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
