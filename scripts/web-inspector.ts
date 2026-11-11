// Evaluates JavaScript in the web view of the iOS app that runs in a booted
// simulator. It keeps one Web Inspector connection open and serves an HTTP
// endpoint on localhost: the request body is a JavaScript expression, and the
// response is JSON with the awaited `value` or an `error`.
//
//   pnpm web-inspector [--udid <udid>] [--port <port>] [--timeout <ms>]
//
//   --udid      The simulator. Default: the only booted simulator.
//   --port      Default: 9229
//   --timeout   Milliseconds to wait for a promise. Default: 30000
//
//   curl -d 'document.title' http://127.0.0.1:9229
//
// The web view must be inspectable (`WKWebView.isInspectable`).

import { createServer } from 'node:http'
import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import { createRemoteDebugger, type RemoteDebugger } from 'appium-remote-debugger'
import { exec } from 'tinyexec'

const { values } = parseArgs({
  options: {
    udid: { type: 'string' },
    port: { type: 'string', default: '9229' },
    timeout: { type: 'string', default: '30000' },
  },
})

interface SimulatorDevice {
  udid: string
  name: string
}

/** Returns the udid of the only booted simulator. */
async function findBootedSimulator(): Promise<string> {
  const { stdout } = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
    throwOnError: true,
  })
  const parsed = JSON.parse(stdout) as { devices: Record<string, SimulatorDevice[]> }
  const devices = Object.values(parsed.devices).flat()
  const [device] = devices
  if (!device) {
    throw new Error('No booted simulator. Boot one with `xcrun simctl boot <udid>`.')
  }
  if (devices.length > 1) {
    const list = devices.map((item) => `${item.udid} (${item.name})`).join(', ')
    throw new Error(`More than one booted simulator, pass --udid: ${list}`)
  }
  return device.udid
}

/** Returns the Web Inspector socket of a booted simulator. */
async function findSocketPath(udid: string): Promise<string> {
  const { stdout } = await exec('xcrun', ['simctl', 'getenv', udid, 'RWI_LISTEN_SOCKET'], {
    throwOnError: true,
  })
  return stdout.trim()
}

interface Target {
  debugger: RemoteDebugger
  appIdKey: string
  pageIdKey: number
  url: string
}

/** Connects to the Web Inspector and selects the first page that is not blank. */
async function connect(socketPath: string): Promise<Target> {
  const remoteDebugger = createRemoteDebugger(
    {
      // An app registers its pages under its process name, not its bundle id.
      additionalBundleIds: ['*'],
      socketPath,
      isSafari: false,
      logAllCommunication: false,
    },
    false,
  )
  await remoteDebugger.connect(5000)
  const pages = await remoteDebugger.selectApp(null, 5, true)
  const [page] = pages
  if (!page) {
    await remoteDebugger.disconnect()
    throw new Error('No inspectable page. Launch the app first.')
  }
  // A page id is `<pid>.<page>`.
  const [pid, pageId] = String(page.id).split('.')
  const appIdKey = `PID:${pid}`
  const pageIdKey = Number(pageId)
  await remoteDebugger.selectPage(appIdKey, pageIdKey, true)
  return { debugger: remoteDebugger, appIdKey, pageIdKey, url: page.url }
}

/** Rejects when a promise takes longer than the given time. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Evaluates source text in the page and returns the string it produces. */
async function evaluateString(target: Target, source: string): Promise<string> {
  const send = target.debugger.requireRpcClient(true).send('Runtime.evaluate', {
    expression: source,
    returnByValue: true,
    appIdKey: target.appIdKey,
    pageIdKey: target.pageIdKey,
  })
  const result: unknown = await withTimeout(send, 5000, 'The page did not answer')
  // The client parses a string result that holds JSON.
  return typeof result === 'string' ? result : JSON.stringify(result)
}

type Settlement =
  | { state: 'pending' }
  | { state: 'done'; json?: string }
  | { state: 'error'; message: string }

const STORE = 'window.__reflectWebInspector'
let nextId = 0

/**
 * Evaluates an expression in the page and awaits a returned promise.
 *
 * WebKit's `Runtime.evaluate` returns before a promise settles, so the page
 * stores the settled value and this function polls for it.
 */
async function evaluate(target: Target, expression: string, timeoutMs: number): Promise<unknown> {
  const id = `${process.pid}-${nextId++}`
  const key = JSON.stringify(id)
  await evaluateString(
    target,
    `(${STORE} ??= new Map()).set(${key}, { state: 'pending' });
    (async () => (\n${expression}\n))().then(
      (value) => ${STORE}.set(${key}, { state: 'done', json: JSON.stringify(value) }),
      (error) => ${STORE}.set(${key}, { state: 'error', message: String(error) }),
    );
    'started'`,
  )
  const deadline = Date.now() + timeoutMs
  while (true) {
    const text = await evaluateString(target, `JSON.stringify(${STORE}.get(${key}) ?? null)`)
    const settlement = JSON.parse(text) as Settlement | null
    if (!settlement) {
      throw new Error('The page reloaded before the expression settled')
    }
    if (settlement.state !== 'pending') {
      await evaluateString(target, `String(${STORE}.delete(${key}))`)
      if (settlement.state === 'error') {
        throw new Error(settlement.message)
      }
      return settlement.json === undefined ? undefined : JSON.parse(settlement.json)
    }
    if (Date.now() > deadline) {
      throw new Error(`The expression did not settle in ${timeoutMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const udid = values.udid ?? (await findBootedSimulator())
const socketPath = await findSocketPath(udid)
const timeoutMs = Number(values.timeout)
let target: Target | undefined

/** Closes a connection and ignores a failure to close it. */
async function disconnect(remoteDebugger: RemoteDebugger): Promise<void> {
  try {
    await withTimeout(remoteDebugger.disconnect(), 2000, 'The connection did not close')
  } catch {
    // The connection is already closed.
  }
}

/** Evaluates on the open connection, and opens a new one when it is dead. */
async function evaluateWithReconnect(expression: string): Promise<unknown> {
  if (target) {
    try {
      // A cheap probe tells a dead connection from an expression that throws.
      await evaluateString(target, `'alive'`)
    } catch {
      await disconnect(target.debugger)
      target = undefined
    }
  }
  target ??= await connect(socketPath)
  return await evaluate(target, expression, timeoutMs)
}

let queue: Promise<unknown> = Promise.resolve()

const server = createServer((request, response) => {
  const run = async (): Promise<void> => {
    let body: { value: unknown } | { error: string }
    try {
      const expression = await text(request)
      body = { value: (await evaluateWithReconnect(expression)) ?? null }
    } catch (error) {
      body = { error: error instanceof Error ? error.message : String(error) }
    }
    response.writeHead('error' in body ? 500 : 200, { 'content-type': 'application/json' })
    response.end(`${JSON.stringify(body)}\n`)
  }
  // One evaluation at a time: the connection is a single ordered channel.
  queue = queue.then(run)
})

server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(`Simulator ${udid}`)
  console.log(`Listening on http://127.0.0.1:${values.port}`)
})
