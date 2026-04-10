/**
 * Tomato Relay Server
 *
 * Bridges HTTP requests from Tomato (via curl) to the Chrome extension
 * over WebSocket. The extension uses chrome.debugger to execute CDP commands.
 *
 * Architecture:
 *   Tomato --[HTTP/curl]--> Relay Server --[WebSocket]--> Chrome Extension
 *
 * Endpoints:
 *   GET  /                  Health check
 *   GET  /extension/status  Extension connection status
 *   GET  /app/info          Relay server info
 *   GET  /tabs              List attached tabs
 *   POST /cdp               Forward CDP command to extension
 *   POST /tab/create        Create and attach a new tab
 *   POST /tab/close         Close a target by targetId
 *   POST /auto-attach       Enable/disable auto-attach for new tabs
 */

const http = require("http")
const { WebSocketServer, WebSocket } = require("ws")

// ============================================
// Configuration
// ============================================

const PORT = parseInt(process.env.RELAY_PORT, 10) || 16789
const HOST = "127.0.0.1"
const CDP_TIMEOUT_MS = 30_000
const VERBOSE = process.argv.includes("--verbose")

function log(...args) {
  console.log(`[Tomato Relay]`, ...args)
}
function debug(...args) {
  if (VERBOSE) console.log(`[Tomato Relay DEBUG]`, ...args)
}

// ============================================
// State
// ============================================

/** @type {WebSocket|null} The single connected Chrome extension */
let extensionWs = null

/** @type {number} Incrementing message ID for request-response correlation */
let nextMessageId = 1

/** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pendingRequests = new Map()

/** @type {Array<object>} Last known attached tabs from fullSync */
let knownTabs = []

/** @type {object|null} Extension info (installType, version) */
let extensionInfo = null

/** @type {boolean} Whether auto-attach is currently enabled */
let autoAttachEnabled = false

// ============================================
// HTTP Server
// ============================================

const server = http.createServer((req, res) => {
  // CORS headers for local development
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const path = url.pathname

  // Route handling
  if (req.method === "GET" && path === "/") {
    handleHealthCheck(req, res)
  } else if (req.method === "HEAD" && path === "/") {
    res.writeHead(200)
    res.end()
  } else if (req.method === "GET" && path === "/extension/status") {
    handleExtensionStatus(req, res)
  } else if (req.method === "GET" && path === "/app/info") {
    handleAppInfo(req, res)
  } else if (req.method === "GET" && path === "/tabs") {
    handleListTabs(req, res)
  } else if (req.method === "POST" && path === "/cdp") {
    handleCdpCommand(req, res)
  } else if (req.method === "POST" && path === "/tab/create") {
    handleCreateTab(req, res)
  } else if (req.method === "POST" && path === "/tab/close") {
    handleCloseTab(req, res)
  } else if (req.method === "POST" && path === "/auto-attach") {
    handleSetAutoAttach(req, res)
  } else {
    jsonResponse(res, 404, { error: "Not found" })
  }
})

// ============================================
// WebSocket Server (for Chrome extension)
// ============================================

const wss = new WebSocketServer({ noServer: true })

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  if (url.pathname !== "/extension") {
    socket.destroy()
    return
  }

  // Only allow one extension connection at a time
  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) {
    log("Rejecting extension connection: already connected")
    socket.write("HTTP/1.1 409 Conflict\r\n\r\n")
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req)
  })
})

wss.on("connection", (ws) => {
  log("Chrome extension connected")
  extensionWs = ws
  knownTabs = []
  extensionInfo = null

  // Ping to keep alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ method: "ping" }))
    }
  }, 25_000)

  ws.on("message", (data) => {
    handleExtensionMessage(data.toString())
  })

  ws.on("close", () => {
    log("Chrome extension disconnected")
    if (extensionWs === ws) {
      extensionWs = null
      knownTabs = []
      extensionInfo = null
      autoAttachEnabled = false
    }
    clearInterval(pingInterval)
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Extension disconnected"))
      pendingRequests.delete(id)
    }
  })

  ws.on("error", (err) => {
    log("Extension WebSocket error:", err.message)
  })
})

// ============================================
// Extension Message Handling
// ============================================

function handleExtensionMessage(raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }

  debug("← Extension:", JSON.stringify(msg).slice(0, 200))

  // Pong response
  if (msg.method === "pong") {
    return
  }

  // Extension info (sent on connect)
  if (msg.method === "extensionInfo") {
    extensionInfo = msg.params
    log("Extension info:", JSON.stringify(extensionInfo))
    return
  }

  // setAutoAttach acknowledgement
  if (msg.method === "setAutoAttachAck" && typeof msg.id === "number") {
    const pending = pendingRequests.get(msg.id)
    if (pending) {
      clearTimeout(pending.timer)
      pending.resolve({})
      pendingRequests.delete(msg.id)
    }
    return
  }

  // Full sync (extension sends all attached tabs on connect)
  if (msg.method === "fullSync") {
    const targets = msg.params?.targets || []
    knownTabs = targets.map((t) => ({
      sessionId: t.sessionId,
      targetId: t.targetId,
      title: t.targetInfo?.title || "",
      url: t.targetInfo?.url || "",
    }))
    log(`Full sync received: ${knownTabs.length} tabs`)
    return
  }

  // CDP event forwarded from extension
  if (msg.method === "forwardCDPEvent") {
    const { method, params } = msg.params || {}

    // Track tab attach/detach for our local tab list
    if (method === "Target.attachedToTarget") {
      const { sessionId: tabSession, targetInfo } = params || {}
      if (tabSession && targetInfo) {
        knownTabs = knownTabs.filter((t) => t.sessionId !== tabSession)
        knownTabs.push({
          sessionId: tabSession,
          targetId: targetInfo.targetId,
          title: targetInfo.title || "",
          url: targetInfo.url || "",
        })
        log(`Tab attached: session=${tabSession}, url=${targetInfo.url}`)
      }
    } else if (method === "Target.detachedFromTarget") {
      const { sessionId: tabSession } = params || {}
      if (tabSession) {
        knownTabs = knownTabs.filter((t) => t.sessionId !== tabSession)
        log(`Tab detached: session=${tabSession}`)
      }
    }

    debug(`CDP event: ${method}`)
    return
  }

  // Response to a forwarded CDP command (has numeric id)
  if (typeof msg.id === "number") {
    const pending = pendingRequests.get(msg.id)
    if (pending) {
      clearTimeout(pending.timer)
      if (msg.error) {
        pending.reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)))
      } else {
        pending.resolve(msg.result || {})
      }
      pendingRequests.delete(msg.id)
    }
    return
  }
}

// ============================================
// Send to Extension with Response Waiting
// ============================================

function sendAndWait(message, timeoutMs = CDP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
      reject(new Error("Extension not connected"))
      return
    }

    const id = nextMessageId++
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error(`Timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    pendingRequests.set(id, { resolve, reject, timer })

    const payload = { ...message, id }
    debug("→ Extension:", JSON.stringify(payload).slice(0, 200))
    extensionWs.send(JSON.stringify(payload))
  })
}

function sendToExtension(message) {
  if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) return
  extensionWs.send(JSON.stringify(message))
}

// ============================================
// HTTP Handlers
// ============================================

function handleHealthCheck(_req, res) {
  jsonResponse(res, 200, {
    status: "ok",
    server: "Tomato-relay",
    extensionConnected: extensionWs?.readyState === WebSocket.OPEN,
    attachedTabs: knownTabs.length,
  })
}

function handleExtensionStatus(_req, res) {
  const connected = extensionWs?.readyState === WebSocket.OPEN
  jsonResponse(res, 200, {
    enabled: true,
    connected,
    autoAttachEnabled,
  })
}

function handleAppInfo(_req, res) {
  jsonResponse(res, 200, {
    version: "1.0.0",
    name: "Tomato Relay",
    extensionInfo,
  })
}

function handleListTabs(_req, res) {
  jsonResponse(res, 200, {
    tabs: knownTabs,
    count: knownTabs.length,
  })
}

async function handleCdpCommand(req, res) {
  const body = await readBody(req)
  if (!body) {
    jsonResponse(res, 400, { error: "Invalid JSON body" })
    return
  }

  const { method, params, sessionId } = body
  if (!method) {
    jsonResponse(res, 400, { error: "Missing 'method' field" })
    return
  }

  try {
    const result = await sendAndWait({
      method: "forwardCDPCommand",
      params: {
        method,
        params: params || {},
        sessionId: sessionId || undefined,
      },
    })
    jsonResponse(res, 200, { result })
  } catch (err) {
    jsonResponse(res, 502, { error: err.message })
  }
}

async function handleCreateTab(req, res) {
  const body = await readBody(req)
  if (!body) {
    jsonResponse(res, 400, { error: "Invalid JSON body" })
    return
  }

  const { url } = body
  if (!url) {
    jsonResponse(res, 400, { error: "Missing 'url' field" })
    return
  }

  try {
    const result = await sendAndWait({
      method: "forwardCDPCommand",
      params: {
        method: "Target.createTarget",
        params: { url },
      },
    })
    jsonResponse(res, 200, { result })
  } catch (err) {
    jsonResponse(res, 502, { error: err.message })
  }
}

async function handleCloseTab(req, res) {
  const body = await readBody(req)
  if (!body) {
    jsonResponse(res, 400, { error: "Invalid JSON body" })
    return
  }

  const { targetId } = body
  if (!targetId) {
    jsonResponse(res, 400, { error: "Missing 'targetId' field" })
    return
  }

  try {
    const result = await sendAndWait({
      method: "forwardCDPCommand",
      params: {
        method: "Target.closeTarget",
        params: { targetId },
      },
    })
    jsonResponse(res, 200, { result })
  } catch (err) {
    jsonResponse(res, 502, { error: err.message })
  }
}

async function handleSetAutoAttach(req, res) {
  const body = await readBody(req)
  if (!body) {
    jsonResponse(res, 400, { error: "Invalid JSON body" })
    return
  }

  const enabled = !!body.enabled
  try {
    if (enabled) {
      await sendAndWait({
        method: "setAutoAttach",
        params: { enabled: true },
      })
    } else {
      sendToExtension({
        method: "setAutoAttach",
        params: { enabled: false },
      })
    }
    autoAttachEnabled = enabled
    jsonResponse(res, 200, { autoAttachEnabled })
  } catch (err) {
    jsonResponse(res, 502, { error: err.message })
  }
}

// ============================================
// Utility
// ============================================

function jsonResponse(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data, null, 2))
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve(null)
      }
    })
    req.on("error", () => resolve(null))
  })
}

// ============================================
// Start
// ============================================

server.listen(PORT, HOST, () => {
  log(`Server listening on http://${HOST}:${PORT}`)
  log(`Extension WebSocket: ws://${HOST}:${PORT}/extension`)
  log("")
  log("Waiting for Chrome extension to connect...")
  log("")
  log("API Endpoints:")
  log(`  GET  http://${HOST}:${PORT}/           Health check`)
  log(`  GET  http://${HOST}:${PORT}/tabs        List attached tabs`)
  log(`  POST http://${HOST}:${PORT}/cdp         Send CDP command`)
  log(`  POST http://${HOST}:${PORT}/tab/create  Create new tab`)
  log(`  POST http://${HOST}:${PORT}/tab/close   Close tab`)
})

process.on("SIGINT", () => {
  log("Shutting down...")
  if (extensionWs) extensionWs.close()
  server.close()
  process.exit(0)
})

process.on("SIGTERM", () => {
  log("Shutting down...")
  if (extensionWs) extensionWs.close()
  server.close()
  process.exit(0)
})
