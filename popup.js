/**
 * Tomato Browser Connector - Popup Script
 *
 * Displays Relay connection status and current tab status, provides connect/disconnect buttons
 */

// i18n helper function: reads from STRINGS[uiLang] first, falls back to chrome.i18n
function i18n(key) {
  const val = STRINGS[uiLang]?.[key]
  if (val) return val
  try {
    return chrome?.i18n?.getMessage(key) || ""
  } catch {
    return ""
  }
}

const relayIcon = document.getElementById("relay-icon")
const relayStatusEl = document.getElementById("relay-status")
const tabIcon = document.getElementById("tab-icon")
const tabStatusEl = document.getElementById("tab-status")
const toggleBtn = document.getElementById("toggle-btn")
const errorMsg = document.getElementById("error-msg")
const connectedSection = document.getElementById("connected-section")
const tabListEl = document.getElementById("tab-list")
const refreshBtn = document.getElementById("refresh-btn")
// Connection diagram lines (may not exist in current HTML version, null-safe logic applied)
const diagramLineLeft = document.getElementById("diagram-line-left")
const diagramLineRight = document.getElementById("diagram-line-right")
const userContainerEl = document.getElementById("popup-user")
const userAvatarEl = document.getElementById("popup-user-avatar")
const userNameEl = document.getElementById("popup-user-name")
const userEmailEl = document.getElementById("popup-user-email")
const footerEl = document.querySelector(".popup-footer")
const langSwitcherEl = document.getElementById("lang-switcher")
const langZhBtn = document.getElementById("lang-zh")
const langEnBtn = document.getElementById("lang-en")

const LANG_STORAGE_KEY = "Tomato:popup-lang"
const browserLang = (navigator.language || "").toLowerCase()
let uiLang = browserLang.startsWith("zh") ? "zh" : "en"

const STRINGS = {
  en: {
    faceTitle: "Welcome to Tomato Connector",
    faceDesc: "Connect Tomato AI to your browser in one click for intelligent automation.",
    cardTitle: "Connection status",
    cardSubtitle: "Relay & current tab",
    relayLabel: "Tomato:",
    tabLabel: "This tab:",
    connect: "Connect",
    disconnect: "Disconnect",
    refresh: "Refresh",
    connectedTabs: "Connected tabs:",
    langLabel: "Language",
    restrictedStatus: "Restricted page",
    extensionRestrictedError: "Chrome security policy prevents attaching to this tab. This happens when the tab was opened by or has content from another extension.\n\nTry:\n1) Open a new window (Cmd/Ctrl+N) and navigate manually\n2) Disable other extensions temporarily",
    alreadyConnectedError: "Another browser is already connected to Tomato. Only one browser connection is supported at a time.\n\nPlease disconnect the extension in the other browser, or restart the relay server.",
    relayDisabledError: "Tomato relay is starting up, please wait a moment...",
    // Status text (corresponds to keys in _locales)
    statusConnected: "Connected",
    statusDisconnected: "Disconnected",
    statusNotConnected: "Not connected",
    statusNoActiveTab: "No active tab",
    statusExtensionError: "Extension error",
    statusError: "Error",
    // Button text
    btnLoading: "Loading...",
    btnConnectTab: "Connect This Tab",
    btnConnectShort: "Connect",
    btnDisconnectTab: "Disconnect This Tab",
    btnCannotConnect: "Cannot connect",
    btnNoActiveTab: "No Active Tab",
    btnExtensionError: "Extension Error",
    btnError: "Error",
    notLoggedIn: "Not logged in",
    operationFailed: "Operation failed",
    retryConnection: "Retry connection",
  },
  zh: {
    faceTitle: "Welcome to Tomato Connector",
    faceDesc: "Connect Tomato AI to your browser in one click for stable, controllable automation.",
    cardTitle: "Connection Status",
    cardSubtitle: "Relay & Current Tab",
    relayLabel: "Tomato",
    tabLabel: "Current Tab",
    connect: "Connect",
    disconnect: "Disconnect",
    refresh: "Refresh",
    connectedTabs: "Connected tabs:",
    langLabel: "Language",
    restrictedStatus: "Restricted page",
    extensionRestrictedError: "Chrome security policy prevents attaching to this tab. This happens when the tab was opened by or has content from another extension.\n\nTry:\n1) Open a new window (Cmd/Ctrl+N) and navigate manually\n2) Disable other extensions temporarily",
    alreadyConnectedError: "Another browser is already connected to Tomato. Only one browser connection is supported at a time.\n\nPlease disconnect the extension in the other browser, or restart the relay server.",
    relayDisabledError: "Tomato Relay is starting up, please wait a moment...",
    // Status text (corresponds to keys in _locales)
    statusConnected: "Connected",
    statusDisconnected: "Disconnected",
    statusNotConnected: "Not connected",
    statusNoActiveTab: "No active tab",
    statusExtensionError: "Extension error",
    statusError: "Error",
    // Button text
    btnLoading: "Loading...",
    btnConnectTab: "Connect This Tab",
    btnConnectShort: "Connect",
    btnDisconnectTab: "Disconnect This Tab",
    btnCannotConnect: "Cannot connect",
    btnNoActiveTab: "No Active Tab",
    btnExtensionError: "Extension Error",
    btnError: "Error",
    notLoggedIn: "Not logged in",
    operationFailed: "Operation failed",
    retryConnection: "Retry connection",
  },
}

let currentTabId = null
let currentTabAttached = false
let currentTabUrl = null

function applyLanguage(lang) {
  uiLang = lang
  const t = STRINGS[lang]

  const faceTitleEl = document.getElementById("face-title")
  const faceDescEl = document.getElementById("face-desc")
  if (faceTitleEl) faceTitleEl.textContent = t.faceTitle
  if (faceDescEl) faceDescEl.textContent = t.faceDesc

  const cardTitleEl = document.getElementById("card-title")
  const cardSubtitleEl = document.getElementById("card-subtitle")
  const relayLabelEl = document.getElementById("relay-label")
  const tabLabelEl = document.getElementById("tab-label")
  const connectedTabsLabelEl = document.getElementById("connected-tabs-label")
  if (cardTitleEl) cardTitleEl.textContent = t.cardTitle
  if (cardSubtitleEl) cardSubtitleEl.textContent = t.cardSubtitle
  if (relayLabelEl) relayLabelEl.textContent = t.relayLabel
  if (tabLabelEl) tabLabelEl.textContent = t.tabLabel
  if (connectedTabsLabelEl) connectedTabsLabelEl.textContent = t.connectedTabs

  // Initial button text (specific connect/disconnect text is overridden in updateButton)
  toggleBtn.textContent = t.connect
  toggleBtn.className = "btn btn-secondary btn-inline"
  refreshBtn.textContent = t.connect
  refreshBtn.className = "btn btn-secondary btn-inline refresh-btn"

  chrome.storage?.local?.set({ [LANG_STORAGE_KEY]: lang }).catch(() => { })

  // Update language switcher button state
  updateLangSwitcherUI(lang)

  // Refresh dynamic status text (connected, restricted page, etc.)
  refreshState()
}

/** Update language switcher UI state */
function updateLangSwitcherUI(lang) {
  if (!langZhBtn || !langEnBtn) return
  langZhBtn.classList.toggle("active", lang === "zh")
  langEnBtn.classList.toggle("active", lang === "en")
}
// Initialize language (read from storage)
try {
  chrome.storage?.local?.get(LANG_STORAGE_KEY, (res) => {
    const saved = res?.[LANG_STORAGE_KEY]
    if (saved === "en" || saved === "zh") {
      uiLang = saved
    }
    applyLanguage(uiLang)
  })
} catch {
  applyLanguage(uiLang)
}

// Top cartoon eyes animation: follow mouse + periodic blinking
; (function setupFaceAnimation() {
  const eyes = Array.from(document.querySelectorAll(".face-eye"))
  const pupils = Array.from(document.querySelectorAll(".face-pupil"))
  if (!eyes.length || !pupils.length) return

  // Initial state: pupils slightly to the right for a more lively look
  pupils.forEach((pupil) => {
    pupil.style.transform = "translate(3px, 0px)"
  })

  function handleMouse(e) {
    const { innerWidth, innerHeight } = window
    const offsetX = ((e.clientX / innerWidth) - 0.5) * 10
    const clampedX = Math.max(-3, Math.min(3, offsetX))
    pupils.forEach((pupil) => {
      pupil.style.transform = `translate(${clampedX}px, 0px)`
    })
  }

  window.addEventListener("mousemove", handleMouse)

  const blinkInterval = setInterval(() => {
    eyes.forEach((eye) => eye.classList.add("blink"))
    setTimeout(() => {
      eyes.forEach((eye) => eye.classList.remove("blink"))
    }, 200)
  }, 3000)

  window.addEventListener("unload", () => {
    window.removeEventListener("mousemove", handleMouse)
    clearInterval(blinkInterval)
  })
})()

// Refresh Relay connection
// When disconnected: enter polling to wait for Relay startup
// When connected: retain existing retryRelay refresh behavior
refreshBtn.addEventListener("click", async () => {
  try {
    const state = await chrome.runtime.sendMessage({ type: "getState" })
    if (!state?.relayConnected) {
      // Disconnected: notify background to enter aggressive polling (try every second, max 15 times)
      chrome.runtime.sendMessage({ type: "startAggressivePolling" }).catch(() => { })

      // Popup-side sync polling to refresh status display
      refreshBtn.disabled = true
      let pollCount = 0
      const MAX_POLLS = 15
      const pollInterval = setInterval(async () => {
        pollCount++
        await refreshState()
        try {
          const currentState = await chrome.runtime.sendMessage({ type: "getState" })
          if (currentState?.relayConnected || pollCount >= MAX_POLLS) {
            clearInterval(pollInterval)
            refreshBtn.disabled = false
          }
        } catch {
          if (pollCount >= MAX_POLLS) {
            clearInterval(pollInterval)
            refreshBtn.disabled = false
          }
        }
      }, 1000)
      return
    }
  } catch {
    // Failed to get state, try aggressive polling
    chrome.runtime.sendMessage({ type: "startAggressivePolling" }).catch(() => { })
    return
  }

  // Connected: retain existing retryRelay refresh behavior
  refreshBtn.classList.add("spinning")
  refreshBtn.disabled = true
  try {
    await chrome.runtime.sendMessage({ type: "retryRelay" })
  } catch {
    // Ignore
  }
  // Wait for background reconnection attempt then refresh state
  setTimeout(async () => {
    await refreshState()
    refreshBtn.classList.remove("spinning")
    refreshBtn.disabled = false
  }, 500)
})

// Check if URL is a restricted page (does not support debugger attach)
// Note: this logic is kept in sync with isRestrictedUrl in background-utils.js
function isRestrictedUrl(url) {
  // Empty string or about:blank is a normal loading/blank state, can attach normally
  if (!url || url === "about:blank") return false
  const restricted = ["chrome://", "chrome-extension://", "edge://", "about:", "devtools://", "chrome-search://", "view-source:"]
  return restricted.some((prefix) => url.startsWith(prefix))
}

// Get current tab
async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab) {
      currentTabId = tab.id
      currentTabUrl = tab.url || null
    }
  } catch (e) {
    console.warn("Failed to get current tab:", e)
  }

  await refreshState()
}

// Get state from background
async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "getState" })
    if (!response) {
      showRelayStatus(false)
      showTabStatus(false, i18n("statusExtensionError"))
      toggleBtn.disabled = true
      toggleBtn.textContent = i18n("btnExtensionError")
      return
    }

    const { relayConnected, attachedTabs, appInfo, connectionBlockReason: blockReason } = response

    // Relay status
    showRelayStatus(relayConnected)
    // Tomato action text: show "Connect" when disconnected, "Refresh" when connected
    const t = STRINGS[uiLang]
    refreshBtn.textContent = relayConnected ? t.refresh : t.connect

    // Footer area: toggle display mode based on Tomato connection status
    if (footerEl) {
      if (!relayConnected) {
        footerEl.classList.add("popup-footer-minimal")
      } else {
        footerEl.classList.remove("popup-footer-minimal")
      }
    }

    // Footer user info + version (version appended after username)
    if (userContainerEl) {
      const user = appInfo?.user
      if (user && user.email) {
        const name = user.name || user.email
        const email = user.email
        const imageUrl = user.imageUrl
        const version = appInfo?.version

        userContainerEl.style.display = "flex"

        // Append version number after username
        if (userNameEl) {
          userNameEl.innerHTML = ""
          const nameSpan = document.createElement("span")
          nameSpan.textContent = name || ""
          userNameEl.appendChild(nameSpan)

          if (version) {
            const versionSpan = document.createElement("span")
            versionSpan.className = "popup-user-version"
            versionSpan.textContent = `v${version}`
            userNameEl.appendChild(versionSpan)
          }
        }

        if (userEmailEl) {
          userEmailEl.textContent = email
        }

        if (userAvatarEl) {
          if (imageUrl) {
            userAvatarEl.style.backgroundImage = `url(${imageUrl})`
            userAvatarEl.textContent = ""
          } else {
            userAvatarEl.style.backgroundImage = "none"
            const base = (name || email || "").trim()
            const initial = base ? base[0].toUpperCase() : "U"
            userAvatarEl.textContent = initial
          }
        }
      } else {
        userContainerEl.style.display = "none"
      }
    }

    // Current tab status
    currentTabAttached = false
    if (currentTabId !== null) {
      const attached = attachedTabs.find((t) => t.tabId === currentTabId)
      if (attached) {
        currentTabAttached = true
        showTabStatus(true, i18n("statusConnected"))
      } else {
        showTabStatus(false, i18n("statusNotConnected"))
      }
    } else {
      showTabStatus(false, i18n("statusNoActiveTab"))
    }

    // Connection diagram: left line = Relay, right line = current tab
    if (diagramLineLeft) {
      diagramLineLeft.classList.toggle("disconnected", !relayConnected)
    }
    if (diagramLineRight) {
      diagramLineRight.classList.toggle("disconnected", !currentTabAttached)
    }

    // Update button
    updateButton()

    // If connection is blocked, show friendly message
    if (!relayConnected && blockReason === "already_connected") {
      errorMsg.textContent = STRINGS[uiLang].alreadyConnectedError
      errorMsg.style.display = "block"
    } else if (!relayConnected && blockReason === "relay_disabled") {
      errorMsg.textContent = STRINGS[uiLang].relayDisabledError
      errorMsg.style.display = "block"
    }

    // Connected tabs list
    if (attachedTabs.length > 0) {
      connectedSection.style.display = "block"
      tabListEl.innerHTML = ""
      for (const t of attachedTabs) {
        const item = document.createElement("div")
        item.className = "tab-item"

        const dot = document.createElement("span")
        dot.className = "dot green"

        const title = document.createElement("span")
        title.className = "title"
        title.textContent = t.title || t.url || `Tab ${t.tabId}`
        title.title = t.url || ""

        item.appendChild(dot)
        item.appendChild(title)
        tabListEl.appendChild(item)
      }
    } else {
      connectedSection.style.display = "none"
    }
  } catch (e) {
    console.warn("Failed to get state:", e)
    showRelayStatus(false)
    showTabStatus(false, i18n("statusError"))
    if (diagramLineLeft) diagramLineLeft.classList.add("disconnected")
    if (diagramLineRight) diagramLineRight.classList.add("disconnected")
    toggleBtn.disabled = true
    toggleBtn.textContent = i18n("btnError")
  }
}

function showRelayStatus(connected) {
  relayIcon.classList.toggle("connected", connected)
  relayStatusEl.textContent = connected ? i18n("statusConnected") : i18n("statusDisconnected")
}

function showTabStatus(connected, text) {
  tabIcon.classList.toggle("connected", connected)
  tabStatusEl.textContent = text
}

function updateButton() {
  toggleBtn.disabled = false
  errorMsg.style.display = "none"

  if (currentTabId === null) {
    toggleBtn.disabled = true
    toggleBtn.textContent = i18n("btnNoActiveTab")
    toggleBtn.className = "btn btn-secondary btn-inline"
    return
  }

  if (currentTabAttached) {
    toggleBtn.textContent = STRINGS[uiLang].disconnect
    toggleBtn.className = "btn btn-danger btn-inline"
    return
  }

  // Restricted page cannot connect - button shown as disabled "Connect" button
  if (isRestrictedUrl(currentTabUrl)) {
    toggleBtn.disabled = true
    toggleBtn.textContent = STRINGS[uiLang].connect
    toggleBtn.className = "btn btn-secondary btn-inline"
    showTabStatus(false, STRINGS[uiLang].restrictedStatus)
    return
  }

  toggleBtn.textContent = STRINGS[uiLang].connect
  toggleBtn.className = "btn btn-secondary btn-inline"
}

// Click connect/disconnect
toggleBtn.addEventListener("click", async () => {
  if (currentTabId === null) return

  toggleBtn.disabled = true
  errorMsg.style.display = "none"

  try {
    const action = currentTabAttached ? "detachTab" : "attachTab"
    const response = await chrome.runtime.sendMessage({
      type: action,
      tabId: currentTabId,
    })

    if (response?.error) {
      // Detect extension restriction error, show friendly message
      if (response.error === "EXTENSION_RESTRICTED" || response.error?.includes("chrome-extension://")) {
        errorMsg.textContent = STRINGS[uiLang].extensionRestrictedError
      } else {
        errorMsg.textContent = response.error
      }
      errorMsg.style.display = "block"
    }
  } catch (e) {
    errorMsg.textContent = e.message || i18n("operationFailed")
    errorMsg.style.display = "block"
  }

  // Brief delay then refresh state (extend display time if there's an error)
  const delay = errorMsg.style.display === "block" ? 5000 : 300
  setTimeout(refreshState, delay)
})

// Language switch button event listeners
if (langZhBtn) {
  langZhBtn.addEventListener("click", () => {
    applyLanguage("zh")
  })
}
if (langEnBtn) {
  langEnBtn.addEventListener("click", () => {
    applyLanguage("en")
  })
}

init()
