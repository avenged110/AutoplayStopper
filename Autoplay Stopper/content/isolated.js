/*
 * Autoplay Stopper — isolated-world content script.
 *
 * - Decides whether blocking is active for this frame (based on the TOP-level site, so whitelisting a
 *   site also allows the players embedded in it) and tells the page-world engine over a private channel.
 * - Relays recent clicks from a parent frame into child frames (e.g. clicking a "play" placeholder that
 *   loads or reveals an embedded player), with coordinates translated into the child's viewport.
 * - Counts how many media elements were blocked, and reports it only when the popover asks (no
 *   messages, and no service-worker wake-ups, while pages load).
 * - Powers the "Play Media" / "Pause Media" context-menu item, which finds media under the cursor even
 *   through overlays and closed shadow roots.
 */
(() => {
  "use strict";

  if (window.__autoplayStopperIsolated) return;
  window.__autoplayStopperIsolated = true;

  const SITES = globalThis.APS_SITES;
  // crypto.randomUUID() is unavailable on insecure (http:) pages; getRandomValues works everywhere.
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const isTop = window === window.top;
  const RELAY_WINDOW_MS = 5000;

  // -------------------------------------------------------------------------------------------
  // Private channel with the page-world engine
  // -------------------------------------------------------------------------------------------
  // Private channel: a detached element both worlds hold a reference to. Its listeners survive
  // document.open() (which wipes listeners on document and window), and the page never sees it.
  const port = document.createElement("span");

  function sendMain(msg) {
    try {
      port.dispatchEvent(new CustomEvent("aps:" + token, { detail: JSON.stringify(msg) }));
    } catch (e) {}
  }

  let mainReady = false;
  const queued = [];
  function sendMainWhenReady(msg) {
    if (mainReady) sendMain(msg);
    else queued.push(msg);
  }

  function announce() {
    // Attach the port just long enough for the hello to bubble to the page-world listener on document,
    // which learns the port from event.target. This only happens before any page script has run.
    const parent = document.documentElement || document;
    try {
      parent.appendChild(port);
      port.dispatchEvent(new CustomEvent("aps-iso-hello", { detail: token, bubbles: true }));
    } catch (e) {
    } finally {
      port.remove();
    }
  }
  function onMainHello() {
    document.removeEventListener("aps-main-hello", onMainHello, true);
    announce();
  }
  port.addEventListener(
    "aps:" + token + ":m",
    (e) => {
      let msg;
      try {
        msg = JSON.parse(e.detail);
      } catch (err) {
        return;
      }
      if (!msg) return;
      if (msg.type === "ready") {
        mainReady = true;
        document.removeEventListener("aps-main-hello", onMainHello, true);
        for (const m of queued.splice(0)) sendMain(m);
      } else if (msg.type === "blocked") {
        addBlocked(+msg.count || 1);
      }
    },
    false
  );
  document.addEventListener("aps-main-hello", onMainHello, true);
  announce();

  // -------------------------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------------------------
  function topLevelHost() {
    if (isTop) {
      if (location.hostname) return location.hostname;
      // about:blank / about:srcdoc popups inherit their opener's origin.
      try {
        return new URL(self.origin).hostname;
      } catch (e) {
        return "";
      }
    }
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) {
        const origin = ao[ao.length - 1];
        if (origin && origin !== "null") return new URL(origin).hostname;
      }
    } catch (e) {}
    try {
      return window.top.location.hostname;
    } catch (e) {}
    try {
      if (document.referrer) return new URL(document.referrer).hostname;
    } catch (e) {}
    return "";
  }

  const host = topLevelHost();
  let lastMode = null;

  function applyState(state) {
    const mode = SITES.isBlockingActive(state, host) ? "block" : "allow";
    if (mode === lastMode) return;
    lastMode = mode;
    sendMainWhenReady({ type: "config", mode });
    if (mode === "block") scheduleClosedScan(document);
  }

  let relayKey = "";
  // The settings this frame last read. Once loaded, changes are applied straight from the change event,
  // so a settings change doesn't make every frame of every open tab read storage again.
  let settings = null;
  let loadSeq = 0;
  let reading = false;

  function loadState() {
    const seq = ++loadSeq;
    reading = true;
    try {
      chrome.storage.local.get(["whitelist", "tempDisabled", "relayKey"], (state) => {
        if (seq !== loadSeq) return; // a newer read superseded this one
        reading = false;
        if (chrome.runtime.lastError || !state) return applyState(settings || {});
        if (typeof state.relayKey === "string") relayKey = state.relayKey;
        settings = { whitelist: state.whitelist, tempDisabled: state.tempDisabled };
        applyState(settings);
      });
    } catch (e) {
      reading = false;
      applyState(settings || {});
    }
  }
  loadState();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(changes.whitelist || changes.tempDisabled || changes.relayKey)) return;
      // Nothing loaded yet, or a read is in flight that this change may have overtaken: read again.
      if (!settings || reading) return void loadState();
      if (changes.relayKey && typeof changes.relayKey.newValue === "string") relayKey = changes.relayKey.newValue;
      if (changes.whitelist) settings.whitelist = changes.whitelist.newValue;
      if (changes.tempDisabled) settings.tempDisabled = changes.tempDisabled.newValue;
      applyState(settings);
    });
  } catch (e) {}

  // -------------------------------------------------------------------------------------------
  // Blocked count (pulled by the popover over a port; nothing is sent unless it's open)
  // -------------------------------------------------------------------------------------------
  let blockedCount = 0;
  let countTimer = 0;
  const countPorts = new Set();

  function postCount(count) {
    for (const p of countPorts) {
      try {
        p.postMessage({ id: token, count });
      } catch (e) {
        countPorts.delete(p);
      }
    }
  }
  function addBlocked(n) {
    blockedCount += n;
    if (countPorts.size && !countTimer) {
      countTimer = setTimeout(() => {
        countTimer = 0;
        postCount(blockedCount);
      }, 100);
    }
  }
  try {
    chrome.runtime.onConnect.addListener((p) => {
      if (p.name !== "aps-count" || document.prerendering) return;
      countPorts.add(p);
      p.onDisconnect.addListener(() => countPorts.delete(p));
      try {
        p.postMessage({ id: token, count: blockedCount });
      } catch (e) {
        countPorts.delete(p);
      }
    });
  } catch (e) {}
  // This document is going away (or into the back/forward cache): take its count off an open popover.
  window.addEventListener("pagehide", () => {
    if (countPorts.size) postCount(0);
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) loadState(); // settings may have changed while the page sat in the back/forward cache
  });

  // -------------------------------------------------------------------------------------------
  // Click relay between frames
  // -------------------------------------------------------------------------------------------
  let lastInput = null; // { pageX, pageY, time } in this frame's page coordinates

  function frameElements() {
    try {
      return document.querySelectorAll("iframe, frame");
    } catch (e) {
      return [];
    }
  }

  /** Point (client coords, this frame) -> coords inside `frame`'s viewport, or null if outside it. */
  function pointInFrame(frame, cx, cy) {
    let r;
    try {
      r = frame.getBoundingClientRect();
    } catch (e) {
      return null;
    }
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
    return { x: cx - r.left - (frame.clientLeft || 0), y: cy - r.top - (frame.clientTop || 0) };
  }

  function relayTo(frame, input) {
    if (!input || !relayKey) return;
    const cx = input.pageX - window.scrollX;
    const cy = input.pageY - window.scrollY;
    const p = pointInFrame(frame, cx, cy);
    if (!p) return;
    try {
      frame.contentWindow.postMessage({ __autoplayStopper: "input", x: p.x, y: p.y, time: input.time, key: relayKey }, "*");
    } catch (e) {}
  }

  function recordInput(pageX, pageY, time, broadcast) {
    lastInput = { pageX, pageY, time };
    if (broadcast) for (const f of frameElements()) relayTo(f, lastInput);
  }

  function onPointer(e) {
    if (!e.isTrusted) return;
    if (e.type === "touchend") {
      const t = e.changedTouches && e.changedTouches[0];
      if (t) recordInput(t.clientX + window.scrollX, t.clientY + window.scrollY, Date.now(), true);
      return;
    }
    if (e.button !== 0) return;
    if (e.type === "click" && e.detail === 0) return; // keyboard-activated click: no real pointer position
    // Only broadcast on the first event of a press to keep relays cheap: the pointerdown, and the mousedown
    // only when it isn't the compatibility twin of that pointerdown (both carry the same timestamp).
    let broadcast = false;
    if (e.type === "pointerdown") {
      broadcast = true;
      lastPointerdownStamp = e.timeStamp;
    } else if (e.type === "mousedown") {
      broadcast = e.timeStamp !== lastPointerdownStamp;
    }
    recordInput(e.clientX + window.scrollX, e.clientY + window.scrollY, Date.now(), broadcast);
  }
  let lastPointerdownStamp = -1;
  for (const type of ["pointerdown", "mousedown", "click", "touchend"]) {
    window.addEventListener(type, onPointer, { capture: true, passive: true });
  }

  window.addEventListener(
    "message",
    (e) => {
      const d = e.data;
      if (!d || typeof d !== "object" || typeof d.__autoplayStopper !== "string") return;
      const kind = d.__autoplayStopper;

      if (kind === "request") {
        // A child frame just loaded and asks whether the user recently clicked where it now sits.
        e.stopImmediatePropagation();
        if (!lastInput || Date.now() - lastInput.time > RELAY_WINDOW_MS) return;
        for (const f of frameElements()) {
          let w = null;
          try {
            w = f.contentWindow;
          } catch (err) {}
          if (w && w === e.source) relayTo(f, lastInput);
        }
        return;
      }

      if (kind === "input" && e.source === window.parent && window !== window.parent) {
        e.stopImmediatePropagation();
        if (!relayKey || d.key !== relayKey) return; // forged by a page, not relayed by Autoplay Stopper
        const x = +d.x;
        const y = +d.y;
        const time = +d.time;
        if (!(x === x && y === y && time === time)) return;
        if (Date.now() - time > RELAY_WINDOW_MS) return;
        const pageX = x + window.scrollX;
        const pageY = y + window.scrollY;
        sendMainWhenReady({ type: "input", pageX, pageY, time });
        recordInput(pageX, pageY, time, true); // pass it on to our own children, if any sit there
      }
    },
    true
  );

  if (!isTop) {
    try {
      window.parent.postMessage({ __autoplayStopper: "request" }, "*");
    } catch (e) {}
  }

  // -------------------------------------------------------------------------------------------
  // Closed declarative shadow roots
  // -------------------------------------------------------------------------------------------
  // Shadow roots written directly in HTML (<template shadowrootmode="closed">) never pass through
  // attachShadow, so the page-world engine can't see into them. Only this world can (chrome.dom).
  // Media found there has its autoplay attribute removed and is paused if it plays without a click on it.
  const closedRoots = new WeakSet();
  const releasedClosed = new WeakSet();

  function clickedOn(el) {
    if (!lastInput || Date.now() - lastInput.time > RELAY_WINDOW_MS) return false;
    const x = lastInput.pageX - window.scrollX;
    const y = lastInput.pageY - window.scrollY;
    for (let n = el, i = 0; n && i < 3; i++) {
      const r = n.getBoundingClientRect();
      if (r.width * r.height > 250000 && n !== el) break;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      n = n.parentElement || (n.getRootNode() && n.getRootNode().host) || null;
    }
    return false;
  }

  function guardClosedMedia(m) {
    if (lastMode !== "block" || releasedClosed.has(m)) return;
    if (m.hasAttribute("autoplay")) {
      if (clickedOn(m)) return void releasedClosed.add(m);
      m.removeAttribute("autoplay");
      addBlocked(1);
    }
    if (!m.paused) {
      if (clickedOn(m)) return void releasedClosed.add(m);
      HTMLMediaElement.prototype.pause.call(m);
    }
  }

  function onClosedPlay(e) {
    if (!e.isTrusted || !(e.target instanceof HTMLMediaElement)) return;
    guardClosedMedia(e.target);
  }

  // Only these elements (plus autonomous custom elements, whose names contain "-") can host a shadow root
  // (DOM Standard, "valid shadow host name"); skipping the rest avoids an extension-API call per element.
  const SHADOW_HOSTS = new Set([
    "article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "main", "nav", "p", "section", "span",
  ]);

  function scanForClosedRoots(root) {
    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    } catch (e) {
      return;
    }
    for (let n = walker.currentNode, budget = 50000; n && budget > 0; n = walker.nextNode(), budget--) {
      if (n.nodeType !== 1) continue;
      const ln = n.localName;
      if (!SHADOW_HOSTS.has(ln) && ln.indexOf("-") < 0) continue;
      let sr = null;
      try {
        sr = chrome.dom.openOrClosedShadowRoot(n);
      } catch (e) {}
      if (!sr) continue;
      if (sr.mode === "closed" && !closedRoots.has(sr)) {
        closedRoots.add(sr);
        sr.addEventListener("play", onClosedPlay, true);
        new MutationObserver((records) => {
          for (const r of records) for (const a of r.addedNodes) if (a.nodeType === 1) scheduleClosedScan(a);
          scanMedia(sr);
        }).observe(sr, { childList: true, subtree: true, attributes: true, attributeFilter: ["autoplay"] });
      }
      if (sr.mode === "closed") scanMedia(sr);
      scanForClosedRoots(sr);
    }
  }

  function scanMedia(root) {
    for (const m of root.querySelectorAll("video, audio")) guardClosedMedia(m);
  }

  let pendingScan = new Set();
  let scanTimer = 0;
  let fullScanCost = 0; // ms the last whole-document pass took
  function scheduleClosedScan(node) {
    if (pendingScan.has(document) && scanTimer) return; // a whole-document pass is already coming
    pendingScan.add(node);
    if (scanTimer) return;
    let delay = 30;
    if (document.readyState === "loading") {
      // While the parser runs, the whole document is re-scanned repeatedly. Space those passes out by
      // at least 20x their own cost (capped at 2 s) so that on very large pages they never take more than
      // ~5% of the main thread; on ordinary pages a pass takes well under 7 ms and the delay stays 150 ms.
      delay = Math.max(150, Math.min(2000, fullScanCost * 20));
    }
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      const whole = pendingScan.has(document);
      const nodes = whole ? [document] : pendingScan;
      pendingScan = new Set();
      if (lastMode !== "block") return;
      const t0 = performance.now();
      for (const n of nodes) if (n === document || n.isConnected) scanForClosedRoots(n);
      if (whole) fullScanCost = performance.now() - t0;
    }, delay);
  }

  // One whole-document pass once parsing ends. (No second pass at "load": after DOMContentLoaded the
  // parser is done, so declarative roots can only arrive in inserted nodes, which the observer below
  // already scans.)
  document.addEventListener("DOMContentLoaded", () => scheduleClosedScan(document), { once: true });
  // Content added later (e.g. setHTMLUnsafe with a declarative closed root): scan just the new subtrees.
  try {
    new MutationObserver((records) => {
      if (lastMode !== "block") return;
      // While the parser is still running, one throttled whole-document pass is far cheaper than
      // scanning every inserted node.
      if (document.readyState === "loading") return void scheduleClosedScan(document);
      for (const r of records) for (const a of r.addedNodes) if (a.nodeType === 1) scheduleClosedScan(a);
    }).observe(document, { childList: true, subtree: true });
  } catch (e) {}

  // -------------------------------------------------------------------------------------------
  // Context menu: Play / Pause the media under the cursor
  // -------------------------------------------------------------------------------------------
  function shadowRootOf(el) {
    // Most elements under the pointer (links, images, list items, …) can't host a shadow root at all;
    // skip the extension-API call for them.
    const ln = el.localName;
    if (!ln || (!SHADOW_HOSTS.has(ln) && ln.indexOf("-") < 0)) return null;
    try {
      return (chrome.dom && chrome.dom.openOrClosedShadowRoot(el)) || el.shadowRoot || null;
    } catch (e) {
      return el.shadowRoot || null;
    }
  }

  function inRect(x, y, el) {
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  }

  function isMediaEl(el) {
    return el instanceof HTMLMediaElement;
  }

  function matchDeep(el, x, y, depth) {
    if (isMediaEl(el)) return el;
    const root = shadowRootOf(el);
    if (!root || depth > 8) return null;
    let hits = [];
    try {
      hits = root.elementsFromPoint(x, y);
    } catch (e) {}
    for (const n of hits) {
      if (n === el) continue;
      if (n.getRootNode() !== root) continue;
      const m = matchDeep(n, x, y, depth + 1);
      if (m) return m;
    }
    for (const v of root.querySelectorAll("video, audio")) if (inRect(x, y, v)) return v;
    return null;
  }

  function findMediaAt(x, y) {
    let hits = [];
    try {
      hits = document.elementsFromPoint(x, y);
    } catch (e) {}
    for (const n of hits) {
      const m = matchDeep(n, x, y, 0);
      if (m) return m;
    }
    // A live collection: cached by the engine, so this doesn't re-walk the document on every call.
    for (const v of document.getElementsByTagName("video")) if (inRect(x, y, v)) return v;
    return null;
  }

  let contextMedia = null;
  let lastMenuState = null;

  function reportMenuState(state) {
    if (state === lastMenuState) return;
    lastMenuState = state;
    try {
      chrome.runtime.sendMessage({ type: "menu", state }, () => void chrome.runtime.lastError);
    } catch (e) {}
  }

  function menuStateFor(m) {
    return m ? (m.paused ? "play" : "pause") : "none";
  }

  // Chromium builds the context menu as soon as the button goes down (immediately on macOS), so the
  // menu item is kept current while the pointer moves, and refreshed once more on right-button down.
  let moveTimer = 0;
  let lastMove = null;
  window.addEventListener(
    "mousemove",
    (e) => {
      if (!e.isTrusted) return;
      lastMove = [e.clientX, e.clientY];
      if (moveTimer) return;
      moveTimer = setTimeout(() => {
        moveTimer = 0;
        if (lastMove) reportMenuState(menuStateFor(findMediaAt(lastMove[0], lastMove[1])));
      }, 120);
    },
    { capture: true, passive: true }
  );
  document.addEventListener(
    "mouseout",
    (e) => {
      if (!e.relatedTarget) lastMenuState = null; // pointer left this frame; re-report on return
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    "mousedown",
    (e) => {
      if (!e.isTrusted || e.button !== 2) return;
      contextMedia = findMediaAt(e.clientX, e.clientY);
      reportMenuState(menuStateFor(contextMedia));
      if (contextMedia && (e.ctrlKey || e.altKey)) {
        // Like the original: holding Ctrl/Alt bypasses sites that replace the context menu.
        window.addEventListener("contextmenu", (ev) => ev.stopImmediatePropagation(), { capture: true, once: true });
      }
    },
    true
  );

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== "toggleMedia") return;
      const m = contextMedia;
      if (!m || !m.isConnected) return;
      if (m.paused) {
        // Tell the engine the user chose to play this element (counts as a click on it), then play.
        const r = m.getBoundingClientRect();
        sendMain({
          type: "input",
          pageX: r.left + r.width / 2 + window.scrollX,
          pageY: r.top + r.height / 2 + window.scrollY,
          time: Date.now(),
        });
        try {
          const p = HTMLMediaElement.prototype.play.call(m);
          if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      } else {
        HTMLMediaElement.prototype.pause.call(m);
      }
      lastMenuState = null;
      sendResponse(true);
    });
  } catch (e) {}
})();
