/**
 * Tomato Browser Connector - Service Worker Background Script
 *
 * Core features:
 * - Connects to Tomato Relay Server via WebSocket
 * - Controls browser tabs using chrome.debugger API
 * - Service Worker state persistence and recovery (MV3)
 * - Exponential backoff reconnection mechanism
 * - Keepalive mechanism to prevent Service Worker hibernation
 */

import { reconnectDelayMs, reattachDelays, isRestrictedUrl } from "./background-utils.js"

// ============================================
// Configuration constants
// ============================================
const DEFAULT_RELAY_PORT = 16789
const KEEPALIVE_ALARM_NAME = "relay-keepalive"
const KEEPALIVE_INTERVAL_MINUTES = 0.5 // 30s
const CDP_VERSION = "1.3"

/** Debug mode toggle (set to false in production) */
const DEBUG = false

function debugLog(...args) {
  if (DEBUG) console.log(...args)
}

// ============================================
// Runtime state (in-memory, lost after Service Worker restart)
// ============================================

/** @type {Map<number, {state: string, sessionId: string, targetId: string, attachOrder: number}>} */
const tabs = new Map()

/** @type {Map<string, number>} sessionId → tabId */
const tabBySession = new Map()

/** @type {Map<string, number>} child session → tabId */
const childSessionToTab = new Map()

/** @type {boolean} Whether auto-attach for new tabs is enabled (controlled by Relay's setAutoAttach signal) */
let autoAttachEnabled = false

/** @type {WebSocket|null} */
let relayWs = null

/** @type {number} */
let reconnectAttempt = 0

/** @type {number|null} */
let reconnectTimer = null

/** @type {number} */
let nextSession = 1

/** @type {number} */
let nextAttachOrder = 1

/** @type {number} */
let nextMessageId = 1

/** @type {object|null} Cached app info (version + user) */
let cachedAppInfo = null

/** @type {number|null} Currently connected Relay port */
let connectedPort = null

/** @type {string|null} Reason connection was blocked, for showing friendly message in popup */
let connectionBlockReason = null

/** @type {Map<number, number>} windowId → groupId, per-window Tomato tab group cache */
const tabGroupByWindow = new Map()

// ============================================
// Tab group management (Chrome Tab Groups API)
// ============================================

const TAB_GROUP_TITLE = "Tomato"
const TAB_GROUP_COLOR = "purple"

/**
 * Find existing Tomato tab group in the specified window
 * @param {number} windowId
 * @returns {Promise<number|null>} groupId or null
 */
async function findTabGroup(windowId) {
  // Use cache first
  const cachedId = tabGroupByWindow.get(windowId)
  if (cachedId != null) {
    try {
      const group = await chrome.tabGroups.get(cachedId)
      if (group && group.title === TAB_GROUP_TITLE && group.windowId === windowId) {
        return cachedId
      }
    } catch {
      // Group has been deleted, clear cache
    }
    tabGroupByWindow.delete(windowId)
  }

  // Cache miss or invalidated, query
  try {
    const groups = await chrome.tabGroups.query({ title: TAB_GROUP_TITLE, windowId })
    if (groups.length > 0) {
      tabGroupByWindow.set(windowId, groups[0].id)
      return groups[0].id
    }
  } catch {
    // Silent handling
  }
  return null
}

/**
 * Add tab to Tomato tab group
 * @param {number} tabId
 */
async function addTabToGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    const windowId = tab.windowId
    const existingGroupId = await findTabGroup(windowId)

    if (existingGroupId != null) {
      // Add to existing tab group
      await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroupId })
    } else {
      // Create new tab group
      const groupId = await chrome.tabs.group({ tabIds: [tabId] })
      await chrome.tabGroups.update(groupId, { title: TAB_GROUP_TITLE, color: TAB_GROUP_COLOR })
      tabGroupByWindow.set(windowId, groupId)
    }
  } catch (err) {
    // Tab groups are an enhancement, failure does not affect core flow
    console.warn("[Tomato Ext] Failed to add tab to group:", err.message)
  }
}

/**
 * Remove tab from Tomato tab group
 * @param {number} tabId
 */
async function removeTabFromGroup(tabId) {
  try {
    await chrome.tabs.ungroup(tabId)
  } catch {
    // Tab may already be closed or not in a group, silent handling
  }
}

// ============================================
// State persistence (chrome.storage.session)
// ============================================

async function persistState() {
  const persistedTabs = []
  for (const [tabId, info] of tabs) {
    if (info.state !== "connected") continue
    persistedTabs.push({
      tabId,
      sessionId: info.sessionId,
      targetId: info.targetId,
      attachOrder: info.attachOrder,
    })
  }
  await chrome.storage.session.set({
    persistedTabs,
    nextSession,
  })
}

async function rehydrateState() {
  try {
    const data = await chrome.storage.session.get(["persistedTabs", "nextSession"])
    if (!data.persistedTabs || !Array.isArray(data.persistedTabs)) return

    if (typeof data.nextSession === "number" && data.nextSession > nextSession) {
      nextSession = data.nextSession
    }

    // Phase 1: quickly restore in-memory mappings
    for (const entry of data.persistedTabs) {
      tabs.set(entry.tabId, {
        state: "connected",
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        attachOrder: entry.attachOrder,
      })
      tabBySession.set(entry.sessionId, entry.tabId)
      if (entry.attachOrder >= nextAttachOrder) {
        nextAttachOrder = entry.attachOrder + 1
      }
    }

    updateBadge()

    // Phase 2: asynchronously validate whether tabs are still valid
    for (const entry of data.persistedTabs) {
      validateTab(entry.tabId)
    }
  } catch (err) {
    console.warn("[Tomato Ext] Failed to rehydrate state:", err)
  }
}

async function validateTab(tabId) {
  try {
    await chrome.tabs.get(tabId)
    // Tab exists, try ping
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true,
      })
    } catch {
      // Debugger disconnected, remove
      removeTab(tabId, "validation-failed")
    }
  } catch {
    // Tab has been closed
    removeTab(tabId, "tab-closed")
  }
}

// ============================================
// Badge management
// ============================================

function updateBadge() {
  const connectedCount = Array.from(tabs.values()).filter(
    (t) => t.state === "connected",
  ).length

  if (connectedCount > 0) {
    chrome.action.setBadgeText({ text: String(connectedCount) })
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" })
  } else if (tabs.size > 0) {
    // Tabs in connecting state
    chrome.action.setBadgeText({ text: "…" })
    chrome.action.setBadgeBackgroundColor({ color: "#FFC107" })
  } else {
    chrome.action.setBadgeText({ text: "" })
  }
}

// ============================================
// Tab management
// ============================================

function removeTab(tabId, reason) {
  const info = tabs.get(tabId)
  if (!info) return

  // Remove from tab group first (before tabs.delete, tab may already be closed so silent fail)
  removeTabFromGroup(tabId)

  tabs.delete(tabId)
  if (info.sessionId) {
    tabBySession.delete(info.sessionId)
    // Clear child session references
    for (const [childSession, childTabId] of childSessionToTab) {
      if (childTabId === tabId) {
        childSessionToTab.delete(childSession)
      }
    }
  }

  // Notify Relay that tab disconnected
  if (relayWs?.readyState === WebSocket.OPEN && info.sessionId) {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        method: "Target.detachedFromTarget",
        params: { sessionId: info.sessionId, targetId: info.targetId },
      },
    })
  }

  updateBadge()
  persistState()
  console.log(`[Tomato Ext] Tab ${tabId} removed: ${reason}`)
}

async function attachTab(tabId, options = {}) {
  const { skipAttachedEvent = false } = options
  const existingInfo = tabs.get(tabId)

  debugLog(`[Tomato Ext] attachTab called: tabId=${tabId}, existingState=${existingInfo?.state}, reattachPending=${existingInfo?.reattachPending}`)

  // Already connected, skip
  if (existingInfo?.state === "connected" && !existingInfo.reattachPending) {
    debugLog(`[Tomato Ext] attachTab: tab ${tabId} already connected, skipping`)
    return existingInfo
  }

  // Pre-check: get tab URL, check if it's a restricted page
  let tab
  try {
    tab = await chrome.tabs.get(tabId)
    debugLog(`[Tomato Ext] attachTab URL check: tabId=${tabId}, url=${tab.url}, openerTabId=${tab.openerTabId}, isRestricted=${isRestrictedUrl(tab.url)}`)
    if (isRestrictedUrl(tab.url)) {
      console.warn(`[Tomato Ext] attachTab BLOCKED: tab ${tabId} has restricted URL: ${tab.url}`)
      throw new Error(`Cannot attach to restricted URL: ${tab.url || "(empty)"}`)
    }

    // Check if opener tab is an extension page (may cause debugger attach failure)
    if (tab.openerTabId) {
      try {
        const openerTab = await chrome.tabs.get(tab.openerTabId)
        debugLog(`[Tomato Ext] attachTab opener check: openerTabId=${tab.openerTabId}, openerUrl=${openerTab?.url}`)
        if (openerTab?.url?.startsWith("chrome-extension://")) {
          console.warn(`[Tomato Ext] attachTab WARNING: tab ${tabId} was opened by extension page ${openerTab.url}, this may cause attach to fail due to Chrome security restrictions`)
        }
      } catch (e) {
        debugLog(`[Tomato Ext] attachTab opener check: could not get opener tab ${tab.openerTabId}:`, e.message)
      }
    }

    debugLog(`[Tomato Ext] attachTab URL check passed for tab ${tabId}`)
  } catch (err) {
    // If this is our thrown restricted URL error, re-throw directly
    if (err.message?.startsWith("Cannot attach to restricted URL")) {
      throw err
    }
    console.warn(`[Tomato Ext] attachTab: failed to get tab ${tabId} for URL check:`, err.message)
    // Other errors (e.g., tab already closed), continue trying to attach (will fail and clean up later)
  }

  const isReattach = !!existingInfo?.reattachPending
  const sessionId = existingInfo?.sessionId || `ag-tab-${nextSession++}`
  const attachOrder = existingInfo?.attachOrder || nextAttachOrder++

  tabs.set(tabId, {
    state: "connecting",
    sessionId,
    targetId: existingInfo?.targetId || "",
    attachOrder,
    // Preserve flag during reconnection, tryReattach needs to check this field to determine whether to continue retrying
    ...(isReattach ? { reattachPending: true } : {}),
  })
  tabBySession.set(sessionId, tabId)
  updateBadge()

  try {
    // Connect chrome.debugger
    await chrome.debugger.attach({ tabId }, CDP_VERSION)

    // Pre-enable Page domain to ensure subsequent Playwright Page.getFrameTree calls get a complete frame tree
    await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => { })

    // Get Chrome's internal real frame ID via Page.getFrameTree to use as targetId
    // Playwright internally associates session and frame through targetId (crPage._handleFrameTree uses frame.id to match),
    // using a synthetic ID (tab-${tabId}) would cause _initialize() to fail to find mainFrameSession
    let chromeTargetId = null
    try {
      const frameTreeResult = await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree")
      chromeTargetId = frameTreeResult?.frameTree?.frame?.id || null
    } catch {
      // Silent handling
    }
    const tab = await chrome.tabs.get(tabId)
    const targetId = chromeTargetId || `tab-${tabId}`

    tabs.set(tabId, {
      state: "connected",
      sessionId,
      targetId,
      attachOrder,
    })
    updateBadge()
    persistState()

    // Add tab to Tomato tab group
    addTabToGroup(tabId)

    // Notify Relay
    if (!skipAttachedEvent && relayWs?.readyState === WebSocket.OPEN) {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: {
              targetId,
              type: "page",
              title: tab.title || "",
              url: tab.url || "",
              attached: true,
            },
            waitingForDebugger: false,
          },
        },
      })
    }

    console.log(`[Tomato Ext] Tab ${tabId} attached, session=${sessionId}`)
    return tabs.get(tabId)
  } catch (err) {
    // Detect Chrome security restriction: tab.url might show HTTPS, but Chrome internally considers the tab belongs to another extension
    const isExtensionRestricted = err.message?.includes("chrome-extension://")

    if (isReattach) {
      if (isExtensionRestricted) {
        // Extension page security restriction is permanent, no need to retry
        console.warn(`[Tomato Ext] Tab ${tabId} is controlled by another extension (tab.url was normal but Chrome blocked debugger), removing`)
        tabs.delete(tabId)
        tabBySession.delete(sessionId)
        updateBadge()
        persistState()
        // Mark as non-retryable, so tryReattach won't continue
        throw new Error("EXTENSION_RESTRICTED")
      }
      // Reattach attempt failed: preserve mappings, tryReattach will continue retrying or eventually call removeTab to clean up
      console.warn(`[Tomato Ext] Reattach attempt failed for tab ${tabId}:`, err.message)
    } else {
      // First connection failed: clean up mappings
      tabs.delete(tabId)
      tabBySession.delete(sessionId)
      updateBadge()
      if (isExtensionRestricted) {
        console.warn(`[Tomato Ext] Tab ${tabId} is controlled by another extension. tab.url reports a normal URL but Chrome blocks debugger attachment to tabs owned by other extensions.`)
      } else {
        console.warn(`[Tomato Ext] Failed to attach tab ${tabId}:`, err.message)
      }
    }
    throw err
  }
}

// ============================================
// Relay WebSocket connection
// ============================================

async function getRelayPort() {
  // 1. Fast path: try default port (hits in most scenarios)
  try {
    const resp = await fetch(`http://127.0.0.1:${DEFAULT_RELAY_PORT}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(500),
    })
    if (resp.ok) {
      console.log("[Tomato Ext] Default port is available")
      return DEFAULT_RELAY_PORT
    }
  } catch {
    // Default port unavailable, continue trying
  }

  // 2. Manually configured port (via chrome.storage.local)
  try {
    const data = await chrome.storage.local.get(["relayPort"])
    if (data.relayPort && typeof data.relayPort === "number") {
      return data.relayPort
    }
  } catch {
    // Ignore
  }

  // 3. Fallback: return default port, enter reconnection loop waiting for Relay to start
  return DEFAULT_RELAY_PORT
}

/**
 * Fetch app info (version + user) from Relay Server
 * @param {number} port - Relay port
 */
async function fetchAppInfo(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/app/info`, {
      signal: AbortSignal.timeout(2000),
    })
    if (resp.ok) {
      cachedAppInfo = await resp.json()
    } else if (resp.status === 401 || resp.status === 403) {
      // User not logged in or session expired, clear cache
      cachedAppInfo = null
    }
  } catch {
    // Silent handling, preserve old cache
  }
}

async function ensureRelayConnection() {
  if (relayWs?.readyState === WebSocket.OPEN) return
  if (relayWs?.readyState === WebSocket.CONNECTING) return

  const port = await getRelayPort()
  const url = `ws://127.0.0.1:${port}/extension`

  // HTTP HEAD pre-check: avoid browser-level ERR_CONNECTION_REFUSED errors from direct WebSocket connections
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    })
    if (!resp.ok) {
      connectionBlockReason = null
      scheduleReconnect()
      return
    }
  } catch {
    // Relay not started, silently wait for reconnection
    connectionBlockReason = null
    scheduleReconnect()
    return
  }

  // Pre-check: query Relay status, avoid WebSocket upgrade rejection producing console errors
  // - enabled=false → 503 (Relay not enabled, e.g., during app startup)
  // - connected=true → 409 (another extension instance already connected)
  try {
    const statusResp = await fetch(`http://127.0.0.1:${port}/extension/status`, {
      signal: AbortSignal.timeout(2000),
    })
    if (statusResp.ok) {
      const status = await statusResp.json()
      if (status.enabled === false) {
        connectionBlockReason = "relay_disabled"
        scheduleReconnect()
        return
      }
      if (status.connected) {
        connectionBlockReason = "already_connected"
        scheduleReconnect()
        return
      }
      // No conflict, clear previous block reason
      connectionBlockReason = null
    }
  } catch {
    // Status endpoint unavailable, continue trying to connect
  }

  try {
    relayWs = new WebSocket(url)

    relayWs.onopen = () => {
      console.log("[Tomato Ext] Connected to Relay")
      reconnectAttempt = 0
      connectedPort = port
      connectionBlockReason = null
      // Fetch app info
      fetchAppInfo(port)
      // [IMPORTANT] As the data source, send full sync on connection
      // Ensure Relay treats Extension's state as the source of truth
      sendFullSync()
      // Report extension install type (store or development)
      const manifest = chrome.runtime.getManifest()
      sendToRelay({
        method: "extensionInfo",
        params: {
          installType: manifest.update_url ? "store" : "development",
          version: manifest.version,
        },
      })
    }

    relayWs.onmessage = (event) => {
      handleRelayMessage(event.data)
    }

    relayWs.onerror = () => {
      // Silent handling, onclose will trigger reconnection
    }

    relayWs.onclose = () => {
      relayWs = null
      connectedPort = null
      autoAttachEnabled = false
      scheduleReconnect()
    }
  } catch {
    relayWs = null
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return
  const delay = reconnectDelayMs(reconnectAttempt++)
  if (reconnectAttempt <= 3) {
    console.log(`[Tomato Ext] Waiting for Relay... (attempt ${reconnectAttempt})`)
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensureRelayConnection()
  }, delay)
}

function sendToRelay(data) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
  relayWs.send(JSON.stringify(data))
}

// ============================================
// Relay message handling
// ============================================

function handleRelayMessage(raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }

  // Ping/Pong
  if (msg.method === "ping") {
    sendToRelay({ method: "pong" })
    return
  }

  // auto-attach control signal
  if (msg.method === "setAutoAttach") {
    autoAttachEnabled = !!msg.params?.enabled
    console.log(`[Tomato Ext] Auto-attach ${autoAttachEnabled ? "enabled" : "disabled"}`)
    // When enabled, carries id; reply with ack to confirm Extension is ready
    if (msg.params?.enabled && typeof msg.id === "number") {
      sendToRelay({ id: msg.id, method: "setAutoAttachAck" })
    }
    return
  }

  // Forward CDP command
  if (msg.method === "forwardCDPCommand" && typeof msg.id === "number") {
    handleForwardCommand(msg)
    return
  }
}

async function handleForwardCommand(msg) {
  const { method, params, sessionId } = msg.params || {}
  const messageId = msg.id

  debugLog(`[Tomato Ext] CDP cmd received: ${method}, session=${sessionId || "(none)"}, id=${messageId}`)

  try {
    // Target.createTarget special handling:
    // Relay locally intercepts Target.setAutoAttach (returns {}), Chrome won't auto-attach new targets,
    // so we need to use chrome.tabs.create to create a tab and manually attach, ensuring Playwright receives Target.attachedToTarget
    if (method === "Target.createTarget") {
      let url = params?.url || "about:blank"
      // Tolerance: auto-complete protocol prefix
      if (url !== "about:blank" && !/^https?:\/\//i.test(url)) {
        url = `https://${url}`
      }
      const newTab = await chrome.tabs.create({ url, active: false })

      // Check if new tab was intercepted by another extension (e.g., new tab extension)
      const createdTab = await chrome.tabs.get(newTab.id)
      debugLog(`[Tomato Ext] Target.createTarget: created tab ${newTab.id}, requested URL=${url}, actual URL=${createdTab.url}`)

      if (isRestrictedUrl(createdTab.url)) {
        console.warn(`[Tomato Ext] Target.createTarget: new tab ${newTab.id} was intercepted by extension, URL=${createdTab.url}`)
        // Close useless tab
        await chrome.tabs.remove(newTab.id).catch(() => { })
        sendToRelay({ id: messageId, error: `EXTENSION_CONFLICT: Tab was intercepted by another extension. Please disable new-tab extensions (e.g., Quark AI) or use incognito mode.` })
        return
      }

      // Try to attach, may fail due to extension restrictions
      try {
        const info = await attachTab(newTab.id)
        debugLog(`[Tomato Ext] Target.createTarget → new tab=${newTab.id}, targetId=${info.targetId}`)
        sendToRelay({ id: messageId, result: { targetId: info.targetId } })
      } catch (attachErr) {
        // Attach failed, may be extension restriction
        console.warn(`[Tomato Ext] Target.createTarget: failed to attach tab ${newTab.id}:`, attachErr.message)
        // Close useless tab
        await chrome.tabs.remove(newTab.id).catch(() => { })
        if (attachErr.message?.includes("chrome-extension://") || attachErr.message === "EXTENSION_RESTRICTED") {
          sendToRelay({ id: messageId, error: `EXTENSION_CONFLICT: Tab is controlled by another extension. Please disable new-tab extensions (e.g., Quark AI) or use incognito mode.` })
        } else {
          sendToRelay({ id: messageId, error: attachErr.message || String(attachErr) })
        }
      }
      return
    }

    // Target.closeTarget special handling: close the tab directly
    if (method === "Target.closeTarget") {
      const closeTargetId = params?.targetId
      if (closeTargetId) {
        for (const [tid, info] of tabs) {
          if (info.targetId === closeTargetId) {
            await chrome.tabs.remove(tid)
            sendToRelay({ id: messageId, result: { success: true } })
            return
          }
        }
      }
      sendToRelay({ id: messageId, error: "Target not found" })
      return
    }

    // Find tab by sessionId
    let tabId = null
    if (sessionId) {
      tabId = tabBySession.get(sessionId) ?? childSessionToTab.get(sessionId) ?? null
    }

    // When no session is specified, use the first connected tab
    if (tabId === null) {
      for (const [tid, info] of tabs) {
        if (info.state === "connected") {
          tabId = tid
          break
        }
      }
    }

    if (tabId === null) {
      console.warn(`[Tomato Ext] CDP cmd ${method}: no attached tab for session=${sessionId}`)
      sendToRelay({ id: messageId, error: "No attached tab" })
      return
    }

    // Tab is reconnecting (debugger detach triggered by navigation, auto reattach), wait for recovery
    const tabInfo = tabs.get(tabId)
    if (tabInfo && tabInfo.state === "connecting") {
      debugLog(`[Tomato Ext] CDP cmd ${method}: tab ${tabId} is reconnecting, waiting...`)
      const maxWait = 5000
      const pollInterval = 100
      let waited = 0
      while (waited < maxWait) {
        await new Promise((r) => setTimeout(r, pollInterval))
        waited += pollInterval
        const info = tabs.get(tabId)
        if (!info) break
        if (info.state === "connected") break
      }
      const reconnectedInfo = tabs.get(tabId)
      if (!reconnectedInfo || reconnectedInfo.state !== "connected") {
        console.warn(`[Tomato Ext] CDP cmd ${method}: tab ${tabId} reattach timed out`)
        sendToRelay({ id: messageId, error: "Tab is reconnecting, reattach timed out" })
        return
      }
      debugLog(`[Tomato Ext] CDP cmd ${method}: tab ${tabId} reconnected, proceeding`)
    }

    // Build debugger target
    const debuggerTarget = { tabId }
    // Child sessions need to specify sessionId
    if (sessionId && childSessionToTab.has(sessionId)) {
      debuggerTarget.sessionId = sessionId
    }

    debugLog(`[Tomato Ext] CDP cmd ${method} → tab=${tabId}, debuggerTarget=`, JSON.stringify(debuggerTarget))

    const result = await chrome.debugger.sendCommand(
      debuggerTarget,
      method,
      params || {},
    )

    // Target.attachToTarget returns child session
    if (method === "Target.attachToTarget" && result?.sessionId) {
      childSessionToTab.set(result.sessionId, tabId)
    }

    debugLog(`[Tomato Ext] CDP cmd ${method} → ok, id=${messageId}, hasResult=${result != null}`)

    sendToRelay({ id: messageId, result: result || {} })
  } catch (err) {
    console.error(`[Tomato Ext] CDP cmd ${method} → error:`, err.message || String(err))
    sendToRelay({ id: messageId, error: err.message || String(err) })
  }
}

// ============================================
// Full sync: Extension as data source, syncs all tab states to Relay on connection
// ============================================

/**
 * Send full tab sync
 * Extension as data source, syncs all connected tabs to Relay on connection
 * This ensures state consistency regardless of which side restarts
 * 
 * Uses concurrent Promise.allSettled to avoid Service Worker timeout
 */
async function sendFullSync() {
  const connectedTabs = []

  // First collect all connected tab info (without awaiting)
  for (const [tabId, info] of tabs) {
    if (info.state !== "connected") continue
    connectedTabs.push({ tabId, info })
  }

  // Concurrently fetch all tab info
  const results = await Promise.allSettled(
    connectedTabs.map(async ({ tabId, info }) => {
      try {
        const tab = await chrome.tabs.get(tabId)
        return {
          sessionId: info.sessionId,
          targetId: info.targetId,
          targetInfo: {
            targetId: info.targetId,
            type: "page",
            title: tab.title || "",
            url: tab.url || "",
            attached: true,
          },
          success: true
        }
      } catch (err) {
        // Tab has been closed, needs cleanup
        console.warn(`[Tomato Ext] FullSync: tab ${tabId} no longer exists, will remove`)
        return { tabId, success: false, error: err.message }
      }
    })
  )

  // Separate successful and failed results
  const syncTargets = []
  const tabsToRemove = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const originalTab = connectedTabs[i]

    if (result.status === 'fulfilled' && result.value.success) {
      syncTargets.push(result.value)
    } else if (result.status === 'fulfilled' && !result.value.success) {
      tabsToRemove.push(originalTab.tabId)
    } else {
      // rejected promise
      tabsToRemove.push(originalTab.tabId)
    }
  }

  // Clean up closed tabs
  for (const tabId of tabsToRemove) {
    removeTab(tabId, "sync-cleanup")
  }

  console.log(`[Tomato Ext] Sending full sync: ${syncTargets.length} tabs, ${tabsToRemove.length} removed`)

  sendToRelay({
    method: "fullSync",
    params: {
      targets: syncTargets,
      timestamp: Date.now(),
    },
  })
}

// ============================================
// Re-announce attached tabs (deprecated, use sendFullSync instead)
// This method is preserved for compatibility, but no longer called in onopen
// ============================================

function reannounceAttachedTabs() {
  for (const [tabId, info] of tabs) {
    if (info.state !== "connected") continue

    chrome.tabs.get(tabId).then((tab) => {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: info.sessionId,
            targetInfo: {
              targetId: info.targetId,
              type: "page",
              title: tab?.title || "",
              url: tab?.url || "",
              attached: true,
            },
            waitingForDebugger: false,
          },
        },
      })
    }).catch(() => {
      removeTab(tabId, "tab-not-found-on-reannounce")
    })
  }
}

// ============================================
// chrome.debugger event listeners
// ============================================

chrome.debugger.onEvent.addListener((source, method, params) => {
  const { tabId, sessionId: childSessionId } = source

  // Find the corresponding tab session
  const tabInfo = tabs.get(tabId)
  if (!tabInfo) return

  // Forward CDP event to Relay
  sendToRelay({
    method: "forwardCDPEvent",
    params: {
      method,
      params,
      sessionId: childSessionId || tabInfo.sessionId,
    },
  })
})

chrome.debugger.onDetach.addListener((source, reason) => {
  const { tabId } = source
  console.log(`[Tomato Ext] Debugger detached from tab ${tabId}: ${reason}`)

  if (reason === "canceled_by_user" || reason === "replaced_with_devtools") {
    removeTab(tabId, reason)
    return
  }

  // Disconnected due to navigation or other reasons, try to reconnect
  const info = tabs.get(tabId)
  if (!info) return

  info.reattachPending = true
  info.state = "connecting"
  updateBadge()

  const delays = reattachDelays()
  let attempt = 0

  async function tryReattach() {
    debugLog(`[Tomato Ext] tryReattach: tabId=${tabId}, attempt=${attempt}/${delays.length}`)
    if (attempt >= delays.length) {
      debugLog(`[Tomato Ext] tryReattach: max attempts reached for tab ${tabId}`)
      removeTab(tabId, "reattach-failed")
      return
    }

    const delay = delays[attempt++]
    await new Promise((r) => setTimeout(r, delay))

    // Check if tab still exists and if URL is a restricted page
    let tab
    try {
      tab = await chrome.tabs.get(tabId)
      debugLog(`[Tomato Ext] tryReattach: tab ${tabId} exists, url=${tab.url}`)
    } catch {
      debugLog(`[Tomato Ext] tryReattach: tab ${tabId} no longer exists`)
      removeTab(tabId, "tab-closed-during-reattach")
      return
    }

    // Tab navigated to restricted URL (e.g., new tab extension), abort reconnection
    if (isRestrictedUrl(tab.url)) {
      debugLog(`[Tomato Ext] tryReattach: tab ${tabId} navigated to restricted URL: ${tab.url}, aborting`)
      removeTab(tabId, "navigated-to-restricted-url")
      return
    }

    const currentInfo = tabs.get(tabId)
    if (!currentInfo || !currentInfo.reattachPending) {
      debugLog(`[Tomato Ext] tryReattach: tab ${tabId} no longer pending reattach`)
      return
    }

    try {
      debugLog(`[Tomato Ext] tryReattach: attempting to attach tab ${tabId}`)
      const skipAttachedEvent = !relayWs || relayWs.readyState !== WebSocket.OPEN
      await attachTab(tabId, { skipAttachedEvent })
      delete currentInfo.reattachPending
      debugLog(`[Tomato Ext] tryReattach: tab ${tabId} reattached successfully`)
    } catch (err) {
      // Extension security restriction is permanent, stop retrying
      if (err.message === "EXTENSION_RESTRICTED") {
        debugLog(`[Tomato Ext] tryReattach: tab ${tabId} is extension-restricted, aborting retries`)
        return
      }
      debugLog(`[Tomato Ext] tryReattach: attach failed for tab ${tabId}:`, err.message)
      tryReattach()
    }
  }

  tryReattach()
})

// ============================================
// Extension Action (click icon to connect/disconnect current tab)
// ============================================

// Popup sends requests via runtime.sendMessage
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getState") {
    // Return current state to popup (wait for all tabs.get to complete before responding, avoiding race condition that causes empty attachedTabs)
    const entries = []
    for (const [tabId, info] of tabs) {
      if (info.state !== "connected") continue
      entries.push(
        chrome.tabs.get(tabId).then((tab) => ({
          tabId,
          sessionId: info.sessionId,
          title: tab?.title || "",
          url: tab?.url || "",
        })).catch(() => ({
          tabId,
          sessionId: info.sessionId,
          title: "",
          url: "",
        })),
      )
    }
    Promise.all(entries).then((attachedTabs) => {
      sendResponse({
        relayConnected: relayWs?.readyState === WebSocket.OPEN,
        attachedTabs,
        appInfo: cachedAppInfo,
        connectionBlockReason,
      })
    })
    return true // Async response
  }

  if (msg.type === "retryRelay") {
    // User manually triggered reconnection: clear backoff state, try immediately
    reconnectAttempt = 0
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    ensureRelayConnection()
    sendResponse({ success: true })
    return false
  }

  if (msg.type === "startAggressivePolling") {
    // After deeplink opens Tomato and starts Relay, extension enters aggressive polling to wait for Relay to come online
    startAggressivePolling()
    sendResponse({ success: true })
    return false
  }

  if (msg.type === "attachTab" && msg.tabId) {
    attachTab(msg.tabId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        // Detect extension restriction error, return special identifier for popup to show friendly message
        if (err.message?.includes("chrome-extension://") || err.message === "EXTENSION_RESTRICTED") {
          sendResponse({ error: "EXTENSION_RESTRICTED" })
        } else {
          sendResponse({ error: err.message || String(err) })
        }
      })
    return true
  }

  if (msg.type === "detachTab" && msg.tabId) {
    chrome.debugger.detach({ tabId: msg.tabId })
      .then(() => {
        removeTab(msg.tabId, "user-toggle")
        sendResponse({ success: true })
      })
      .catch((err) => {
        removeTab(msg.tabId, "user-toggle")
        sendResponse({ error: err.message || String(err) })
      })
    return true
  }
})

// ============================================
// Tab creation/close listeners
// ============================================

// When auto-attach is enabled, new tabs opened via window.open / target="_blank" from already attached tabs will be auto-attached
chrome.tabs.onCreated.addListener((tab) => {
  // Diagnostic log: record all new tab creation events
  debugLog(`[Tomato Ext] Tab created: id=${tab.id}, openerTabId=${tab.openerTabId}, windowId=${tab.windowId}, url=${tab.url}, autoAttachEnabled=${autoAttachEnabled}`)

  // Only active when Relay sends setAutoAttach(true)
  if (!autoAttachEnabled) {
    debugLog(`[Tomato Ext] Tab ${tab.id} NOT auto-attached: autoAttachEnabled is false`)
    return
  }

  // Check if should auto-attach:
  // 1. If opener is an already attached tab, attach directly
  // 2. If any attached tab exists in the same window, also try to attach (handles complex page navigation scenarios)
  if (tab.openerTabId && tabs.has(tab.openerTabId)) {
    // Case 1: opener is an already attached tab
    debugLog(`[Tomato Ext] Tab ${tab.id} will be auto-attached: opened by attached tab ${tab.openerTabId}`)
    tryAutoAttach(tab.id, `opened by attached tab ${tab.openerTabId}`)
    return
  }

  // Case 2: collect all connected tabs in the same window, check window ownership in parallel
  const windowId = tab.windowId
  if (windowId) {
    const connectedTabIds = []
    for (const [attachedTabId, info] of tabs) {
      if (info.state === "connected") {
        connectedTabIds.push(attachedTabId)
      }
    }

    if (connectedTabIds.length > 0) {
      // Query all connected tabs in parallel, auto-attach if any match the same window
      Promise.all(
        connectedTabIds.map((attachedTabId) =>
          chrome.tabs.get(attachedTabId)
            .then((attachedTab) => ({ attachedTabId, windowId: attachedTab?.windowId }))
            .catch(() => ({ attachedTabId, windowId: null }))
        )
      ).then((results) => {
        const match = results.find((r) => r.windowId === windowId)
        if (match) {
          debugLog(`[Tomato Ext] Tab ${tab.id} will be auto-attached: same window as attached tab ${match.attachedTabId}`)
          tryAutoAttach(tab.id, `same window as attached tab ${match.attachedTabId}`)
        } else {
          debugLog(`[Tomato Ext] Tab ${tab.id} NOT auto-attached: no attached tab in window ${windowId}`)
        }
      })
      return
    }
  }

  debugLog(`[Tomato Ext] Tab ${tab.id} NOT auto-attached: no attached tab in window ${windowId}`)
})

async function tryAutoAttach(tabId, reason) {
  debugLog(`[Tomato Ext] tryAutoAttach scheduled: tabId=${tabId}, reason=${reason}`)
  // Brief delay before attaching, wait for tab initialization
  setTimeout(async () => {
    try {
      // Confirm tab still exists and not already attached
      const tab = await chrome.tabs.get(tabId)
      debugLog(`[Tomato Ext] tryAutoAttach: tab ${tabId} exists, url=${tab.url}, alreadyAttached=${tabs.has(tabId)}`)
      if (tabs.has(tabId)) return // Already attached

      // Check if URL is restricted (e.g., new tab extension)
      if (isRestrictedUrl(tab.url)) {
        debugLog(`[Tomato Ext] tryAutoAttach: skipped for tab ${tabId}, restricted URL: ${tab.url}`)
        return
      }

      debugLog(`[Tomato Ext] tryAutoAttach: calling attachTab for tab ${tabId}`)
      await attachTab(tabId)
      debugLog(`[Tomato Ext] Auto-attached new tab ${tabId} (${reason})`)
    } catch (err) {
      console.warn(`[Tomato Ext] Failed to auto-attach new tab ${tabId}:`, err.message)
    }
  }, 200)
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) {
    removeTab(tabId, "tab-closed")
  }
})

// ============================================
// Keepalive mechanism
// ============================================

chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
  periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return

  // Refresh Badge (Badge is temporary in MV3)
  updateBadge()

  // Check Relay connection
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (reconnectTimer === null) {
      ensureRelayConnection()
    }
  } else if (connectedPort) {
    // Relay connected, periodically refresh app info (capture user login/logout changes)
    fetchAppInfo(connectedPort)
  }
})

/** @type {number|null} Aggressive polling timer (tries once per second while waiting for Relay to start) */
let aggressivePollTimer = null
/** @type {number} Aggressive polling attempt count */
let aggressivePollCount = 0
/** Maximum aggressive polling attempts (try once per second for 15 seconds) */
const MAX_AGGRESSIVE_POLLS = 15

/**
 * Start aggressive polling: called after deeplink triggers relay startup
 * Tries to connect once per second, up to MAX_AGGRESSIVE_POLLS times
 */
function startAggressivePolling() {
  if (aggressivePollTimer !== null) return // Already polling, skip
  aggressivePollCount = 0
  doAggressivePoll()
}

function doAggressivePoll() {
  // Already connected, stop polling
  if (relayWs?.readyState === WebSocket.OPEN) {
    aggressivePollTimer = null
    aggressivePollCount = 0
    return
  }

  // Exceeded max attempts, stop
  if (aggressivePollCount >= MAX_AGGRESSIVE_POLLS) {
    aggressivePollTimer = null
    aggressivePollCount = 0
    return
  }

  aggressivePollCount++
  // Clear existing backoff reconnection timer, ensure this attempt runs immediately
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
  ensureRelayConnection()

  aggressivePollTimer = setTimeout(() => {
    aggressivePollTimer = null
    doAggressivePoll()
  }, 1000)
}

// ============================================
// Startup initialization
// ============================================

async function initialize() {
  console.log("[Tomato Ext] Service Worker starting...")
  await rehydrateState()
  ensureRelayConnection()
}

initialize()
