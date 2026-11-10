/*
 * Autoplay Stopper — service worker.
 *
 * - Clears "temporarily disabled" sites each time the browser starts.
 * - Shows a gray toolbar icon on pages where blocking is not active (whitelisted, temporarily
 *   disabled, or pages extensions can't run on). There is deliberately no badge: the popover asks
 *   the page's frames for their blocked counts directly when it opens.
 * - Provides the "Play Media" / "Pause Media" context-menu item.
 */
"use strict";

importScripts("shared/sites.js", "shared/format.js");
const SITES = self.APS_SITES;
const FORMAT = self.APS_FORMAT;

const MENU_ID = "aps-toggle-media";
const ICONS_ON = { 16: "icons/icon16.png", 32: "icons/icon32.png" };
const ICONS_OFF = { 16: "icons/icon16-off.png", 32: "icons/icon32-off.png" };

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------
function setupMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: "Play Media",
        contexts: ["all"],
        visible: false,
        documentUrlPatterns: ["http://*/*", "https://*/*"],
      },
      () => void chrome.runtime.lastError
    );
  });
}

async function initStorage() {
  const { whitelist, tempDisabled, legacyImported, relayKey } = await chrome.storage.local.get([
    "whitelist",
    "tempDisabled",
    "legacyImported",
    "relayKey",
  ]);
  const patch = {};
  // Secret that signs click relays between frames, so a page can't forge "the user clicked here".
  // Pages can't read extension storage, and the messages carrying it are intercepted before page code.
  if (typeof relayKey !== "string" || relayKey.length < 32) {
    patch.relayKey = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  const list = Array.isArray(whitelist) ? whitelist : [];
  if (!Array.isArray(whitelist)) patch.whitelist = list;
  if (!Array.isArray(tempDisabled)) patch.tempDisabled = [];

  // One-time import of the whitelist carried over from the original AutoplayStopper extension.
  if (!legacyImported) {
    try {
      const res = await fetch(chrome.runtime.getURL("defaults/imported-whitelist.json"));
      const { domains } = await res.json();
      const now = Date.now();
      const merged = [...list];
      for (const raw of domains || []) {
        const domain = SITES.normalizeHost(raw);
        if (domain && !merged.some((e) => e.domain === domain)) merged.push({ domain, added: now });
      }
      patch.whitelist = merged;
      patch.legacyImported = true;
    } catch (e) {
      // No import file, or it couldn't be read; try again next startup.
    }
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

chrome.runtime.onInstalled.addListener(async () => {
  setupMenu();
  await initStorage();
  enqueue(refreshAllTabs);
});

chrome.runtime.onStartup.addListener(async () => {
  setupMenu();
  // "Temporarily" disabled means until the browser is restarted.
  await chrome.storage.local.set({ tempDisabled: [] });
  await initStorage();
  enqueue(refreshAllTabs);
});

// ---------------------------------------------------------------------------------------------
// Toolbar icon / tooltip per tab
// ---------------------------------------------------------------------------------------------
// Settings are cached for the life of the service worker (kept current by storage.onChanged), so a
// navigation doesn't cost a storage read. `stateVersion` discards a read that a change overtook.
let stateCache = null;
let stateVersion = 0;

function normalizeState(s) {
  return {
    whitelist: Array.isArray(s && s.whitelist) ? s.whitelist : [],
    tempDisabled: Array.isArray(s && s.tempDisabled) ? s.tempDisabled : [],
  };
}

async function getState() {
  while (!stateCache) {
    const v = stateVersion;
    const s = await chrome.storage.local.get(["whitelist", "tempDisabled"]);
    if (v === stateVersion) stateCache = normalizeState(s);
  }
  return stateCache;
}

// Icon updates run one at a time, in event order, so an older update can never land after a newer one.
let iconQueue = Promise.resolve();
function enqueue(job) {
  iconQueue = iconQueue.then(job).catch(() => {});
}

// The toolbar icons, decoded once per service-worker lifetime (and only the variant in use), instead of
// having chrome.action.setIcon fetch and decode the PNG files again on every navigation.
const iconData = {};
async function decodeIcons(paths) {
  try {
    const out = {};
    for (const [size, path] of Object.entries(paths)) {
      const bitmap = await createImageBitmap(await (await fetch(chrome.runtime.getURL(path))).blob());
      const canvas = new OffscreenCanvas(+size, +size);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, +size, +size);
      out[size] = ctx.getImageData(0, 0, +size, +size);
    }
    return { imageData: out };
  } catch (e) {
    return { path: paths }; // let setIcon load the files itself
  }
}
function iconFor(active) {
  const key = active ? "on" : "off";
  if (!iconData[key]) iconData[key] = decodeIcons(active ? ICONS_ON : ICONS_OFF);
  return iconData[key];
}

function describe(state, url) {
  const u = SITES.eligibleUrl(url);
  if (!u) return { active: false, title: "Autoplay Stopper (not available on this page)" };
  const host = SITES.normalizeHost(u.hostname);
  if (SITES.findWhitelistEntry(state.whitelist, u.hostname)) {
    return { active: false, title: `Autoplay Stopper (${host} is whitelisted)` };
  }
  if (SITES.findTempDisabled(state.tempDisabled, u.hostname)) {
    return { active: false, title: `Autoplay Stopper (temporarily disabled on ${host})` };
  }
  return { active: true, title: `Autoplay Stopper (blocking autoplay on ${host})` };
}

// The callback forms (reading chrome.runtime.lastError) are used on purpose: setIcon's custom bindings can
// report "Unchecked runtime.lastError: No tab with id" for a tab that closed mid-call even when the
// returned promise is caught.
function actionCall(fn, details) {
  return new Promise((resolve) => {
    try {
      fn.call(chrome.action, details, () => resolve(!chrome.runtime.lastError));
    } catch (e) {
      resolve(false);
    }
  });
}

async function applyTab(tab, d) {
  const icon = await iconFor(d.active);
  // Stop if the tab closed in the meantime.
  if (await actionCall(chrome.action.setIcon, { tabId: tab.id, ...icon })) {
    await actionCall(chrome.action.setTitle, { tabId: tab.id, title: d.title });
  }
}

async function refreshTab(tab) {
  if (!tab || tab.id === undefined || tab.id < 0) return;
  await applyTab(tab, describe(await getState(), tab.url || tab.pendingUrl));
}

async function refreshAllTabs() {
  const state = await getState();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => t.id !== undefined && t.id >= 0 && applyTab(t, describe(state, t.url || t.pendingUrl))));
}

/** After a settings change, update only the tabs whose icon or tooltip actually changes. */
async function refreshChangedTabs(before, after) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) => {
      if (t.id === undefined || t.id < 0) return;
      const url = t.url || t.pendingUrl;
      const a = describe(before, url);
      const b = describe(after, url);
      if (a.active !== b.active || a.title !== b.title) return applyTab(t, b);
    })
  );
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url) enqueue(() => refreshTab(tab));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.whitelist || changes.tempDisabled)) return;
  stateVersion++;
  const before = stateCache;
  if (!before) return void enqueue(refreshAllTabs); // nothing cached to compare against
  const after = normalizeState({
    whitelist: changes.whitelist ? changes.whitelist.newValue : before.whitelist,
    tempDisabled: changes.tempDisabled ? changes.tempDisabled.newValue : before.tempDisabled,
  });
  stateCache = after;
  enqueue(() => refreshChangedTabs(before, after));
});

// ---------------------------------------------------------------------------------------------
// Messages from content scripts
// ---------------------------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "menu") {
    const visible = msg.state === "play" || msg.state === "pause";
    chrome.contextMenus.update(
      MENU_ID,
      { visible, title: msg.state === "pause" ? "Pause Media" : "Play Media" },
      () => void chrome.runtime.lastError
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Whitelist export (saved straight to the default download folder, like TabBackup)
// ---------------------------------------------------------------------------------------------

/** Resolves with the final file path once the download completes; rejects if it's interrupted. */
function download(filename, text) {
  return new Promise((resolve, reject) => {
    let id = null;
    const pending = [];
    const settle = (item) => {
      if (item.state === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.downloads.search({ id }).then(([d]) => resolve(d ? d.filename : filename));
      } else if (item.state === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error(`Download interrupted (${item.error || "unknown"})`));
      }
    };
    const onChanged = (delta) => {
      if (!delta.state) return;
      const item = { state: delta.state.current, error: delta.error && delta.error.current };
      if (id === null) pending.push([delta.id, item]);
      else if (delta.id === id) settle(item);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads
      .download({
        url: "data:text/plain;charset=utf-8," + encodeURIComponent(text),
        filename,
        conflictAction: "uniquify",
        saveAs: false,
      })
      .then(async (newId) => {
        id = newId;
        // Catch a state change that fired before we knew our id.
        for (const [pid, item] of pending) if (pid === id) return settle(item);
        const [d] = await chrome.downloads.search({ id });
        if (d) settle(d);
      })
      .catch((e) => {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(e);
      });
  });
}

async function exportWhitelist() {
  const now = new Date();
  try {
    const { whitelist } = await chrome.storage.local.get("whitelist");
    const list = Array.isArray(whitelist) ? whitelist : [];
    if (!list.length) return { ok: false, error: "The whitelist is empty." };
    const path = await download(`Autoplay Stopper Whitelist ${FORMAT.stamp(now)}.txt`, FORMAT.buildText(list, now));
    return { ok: true, path, count: list.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Extension pages only (the popover and the import window), never content scripts.
  if (!msg || typeof msg !== "object" || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) return;
  if (msg.type === "export") {
    exportWhitelist().then(reply);
    return true;
  }
  if (msg.type === "show-popup") {
    // Sent by the import window as it closes, so you land back on the popover.
    setTimeout(() => chrome.action.openPopup().catch(() => {}), 300);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { type: "toggleMedia" }, { frameId: info.frameId || 0 }, () => void chrome.runtime.lastError);
});
