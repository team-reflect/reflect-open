#if DEBUG
import Foundation

/// The `reflect-app://localhost/__host/selfcheck` page of debug builds. It
/// checks the web platform and the shell's wire contract from inside the web
/// view and stores each result in `window.__selfcheck[name] = {ok, detail}`.
/// `window.__selfcheckDone` turns true after the last check.
@MainActor
final class SelfCheckRoute: SchemeRoute {
  let pathPrefix = "/__host/selfcheck"

  func start(_ task: SchemeTask) {
    let isScript = task.request.url?.pathExtension == "js"
    let body = Data((isScript ? SelfCheck.script : SelfCheck.page).utf8)
    task.reply(
      SchemeReply(
        statusCode: 200,
        headers: [
          "Content-Type": isScript ? "text/javascript" : "text/html; charset=utf-8",
          "Content-Length": String(body.count),
          "Cache-Control": "no-store",
        ],
        body: body))
  }
}

@MainActor
enum SelfCheck {
  /// The commands that the page calls: `host.selfcheck_echo` answers the
  /// request body as bytes, and `host.selfcheck_emit {name, payload}` emits
  /// that event.
  static func commands(bridge: HostBridge) -> [String: ShellCommand] {
    [
      "host.selfcheck_echo": { request in .bytes(request.body) },
      "host.selfcheck_emit": { request in
        guard
          let args = try? JSONSerialization.jsonObject(with: request.args) as? [String: Any],
          let name = args["name"] as? String,
          let payload = try? JSONSerialization.data(
            withJSONObject: args["payload"] ?? NSNull(), options: .fragmentsAllowed)
        else {
          return .error(kind: "parse", message: "host.selfcheck_emit takes {name, payload}")
        }
        bridge.emit(name, payload: payload)
        return .json(Data("null".utf8))
      },
    ]
  }

  fileprivate static let page = """
    <!doctype html>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Reflect shell self-check</title>
    <style>
      body { font: 14px ui-monospace, monospace; padding: 16px; padding-top: 64px; }
      .ok { color: green; }
      .fail { color: red; }
    </style>
    <pre id="out">running…</pre>
    <script type="module" src="/__host/selfcheck.js"></script>
    """

  fileprivate static let script = """
    const IPC = 'reflect-app://localhost/__ipc/'
    const results = {}
    window.__selfcheck = results
    window.__selfcheckDone = false

    function render() {
      const out = document.getElementById('out')
      out.replaceChildren()
      for (const [name, { ok, detail }] of Object.entries(results)) {
        const line = document.createElement('div')
        line.className = ok ? 'ok' : 'fail'
        line.textContent = `${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`
        out.append(line)
      }
    }

    function assert(condition, detail) {
      if (!condition) {
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
      }
      return detail
    }

    async function check(name, run) {
      try {
        results[name] = { ok: true, detail: await run() }
      } catch (error) {
        results[name] = { ok: false, detail: String(error) }
      }
      render()
    }

    function invoke(command, args) {
      return fetch(IPC + encodeURIComponent(command), {
        method: 'POST',
        body: JSON.stringify(args),
        headers: { 'content-type': 'application/json' },
      })
    }

    await check('secureContext', () => assert(window.isSecureContext === true, 'not secure') && true)

    await check('cryptoSubtle', async () => {
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]))
      return assert(digest.byteLength === 32, { byteLength: digest.byteLength }) && 32
    })

    await check('localStorage', () => {
      const value = String(Date.now())
      localStorage.setItem('selfcheck', value)
      const read = localStorage.getItem('selfcheck')
      localStorage.removeItem('selfcheck')
      return assert(read === value, { read, value }) && true
    })

    await check('ipcSuccess', async () => {
      const response = await invoke('settings_load', {})
      const flagged = response.headers.get('x-reflect-response')
      assert(response.status === 200 && flagged === null, { status: response.status, flagged })
      return typeof (await response.json())
    })

    await check('ipcError', async () => {
      const response = await invoke('selfcheck_no_such_command', {})
      const flagged = response.headers.get('x-reflect-response')
      const error = await response.json()
      assert(response.status === 200 && flagged === 'error', { status: response.status, flagged })
      return assert(error.kind === 'notFound' && typeof error.message === 'string', error)
    })

    await check('binaryEcho', async () => {
      const bytes = new Uint8Array(1024 * 1024)
      for (let i = 0; i < bytes.length; i += 4096) {
        bytes[i] = i % 251
      }
      const response = await fetch(IPC + encodeURIComponent('host.selfcheck_echo'), {
        method: 'POST',
        body: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-upload-id': 'selfcheck' },
      })
      const echoed = new Uint8Array(await response.arrayBuffer())
      const same = echoed.length === bytes.length && echoed.every((byte, i) => byte === bytes[i])
      const type = response.headers.get('content-type')
      return assert(same && type.startsWith('application/octet-stream'), {
        length: echoed.length,
        type,
      })
    })

    await check('event', async () => {
      const payload = { text: 'ping \\u2028 "quoted"', n: 1 }
      const received = new Promise((resolve, reject) => {
        const unlisten = window.__reflectHost.on('selfcheck:ping', (value) => {
          unlisten()
          resolve(value)
        })
        setTimeout(() => reject(new Error('no event within 3 s')), 3000)
      })
      await invoke('host.selfcheck_emit', { name: 'selfcheck:ping', payload })
      const value = await received
      return assert(JSON.stringify(value) === JSON.stringify(payload), value)
    })

    window.__selfcheckDone = true
    """
}
#endif
