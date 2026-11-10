/*
 * Autoplay Stopper — page-world engine.
 *
 * Runs in the page's MAIN world at document_start in every frame, before any page script.
 * It gates every way a page can start media playback:
 *
 *   - HTMLMediaElement.prototype.play()           (covers detached elements, closed shadow roots, new Audio())
 *   - the autoplay property / attribute           (setter, setAttribute, setAttributeNS, toggleAttribute,
 *                                                  and a MutationObserver for parser/innerHTML insertions)
 *   - media created outside the document by cloning or fragment parsing (cloneNode, importNode,
 *     Range.createContextualFragment): Chromium autoplays these while detached, where no observer sees them
 *   - any trusted "play" event that slips through (paused immediately)
 *
 * Playback is allowed only when it follows a genuine user gesture aimed at that player:
 *   - play() called while handling a trusted click / key press that targeted the player (or was handled by
 *     a control-sized element such as a button), never a page-wide "first interaction" listener;
 *   - a promise continuation right after such an input (ended before the next rendering step, so
 *     scroll- or layout-driven autoplay never qualifies); or
 *   - a trusted click within the last 5 seconds that landed on the player itself.
 * Once the user starts an element, it is released and behaves natively - except a <video> that ends and
 * later tries to start itself again ("autoplay next"), which needs a new gesture.
 *
 * Same-origin child frames (about:blank ad frames, etc.) are patched as soon as the page can reach them,
 * so a page can't borrow a pristine play() from a fresh iframe.
 *
 * Whether blocking is active (whitelist / temporary disable) is decided by the isolated-world content
 * script, which talks to this script over a private, per-frame DOM event channel.
 */
(() => {
  "use strict";

  const W = window;
  const MARK = Symbol.for("autoplay-stopper.realm");
  try {
    if (W[MARK]) return; // This realm is already governed by a same-origin parent frame's instance.
  } catch (e) {
    return;
  }

  // ---------------------------------------------------------------------------------------------
  // Captured natives (page scripts may tamper with globals later; we never depend on them).
  // ---------------------------------------------------------------------------------------------
  const ObjectRef = Object;
  const defineProperty = ObjectRef.defineProperty;
  const getOwnPropertyDescriptor = ObjectRef.getOwnPropertyDescriptor;
  const ReflectApply = Reflect.apply;
  const DateNow = Date.now;
  const JSONStringify = JSON.stringify;
  const JSONParse = JSON.parse;
  const StringRef = String;
  const toLowerCase = StringRef.prototype.toLowerCase;
  const PromiseThen = Promise.prototype.then;
  const setTimeoutN = W.setTimeout;
  const MO = W.MutationObserver;
  const moObserve = MO.prototype.observe;
  const CustomEventRef = W.CustomEvent;
  const WeakMapRef = WeakMap;
  const WeakSetRef = WeakSet;
  const wmGet = WeakMapRef.prototype.get;
  const wmSet = WeakMapRef.prototype.set;
  const wsHas = WeakSetRef.prototype.has;
  const wsAdd = WeakSetRef.prototype.add;
  const wsDelete = WeakSetRef.prototype.delete;

  const ETp = W.EventTarget.prototype;
  const addEL = ETp.addEventListener;
  const removeEL = ETp.removeEventListener;
  const dispatchEv = ETp.dispatchEvent;

  const Ep = W.Element.prototype;
  const nSetAttribute = Ep.setAttribute;
  const nSetAttributeNS = Ep.setAttributeNS;
  const nRemoveAttribute = Ep.removeAttribute;
  const nToggleAttribute = Ep.toggleAttribute;
  const nHasAttribute = Ep.hasAttribute;
  const nGetBCR = Ep.getBoundingClientRect;
  const nAttachShadow = Ep.attachShadow;
  const nQSA = Ep.querySelectorAll;
  const nDocQSA = W.Document.prototype.querySelectorAll;
  const nDocOpen = W.Document.prototype.open;
  const nImportNode = W.Document.prototype.importNode;
  const nFragQSA = W.DocumentFragment.prototype.querySelectorAll;
  const nCreateContextualFragment = W.Range.prototype.createContextualFragment;

  const getter = (proto, name) => {
    const d = getOwnPropertyDescriptor(proto, name);
    return d && d.get;
  };
  const Np = W.Node.prototype;
  const nCloneNode = Np.cloneNode;
  const gParentNode = getter(Np, "parentNode");
  const gNodeType = getter(Np, "nodeType");
  const gOwnerDocument = getter(Np, "ownerDocument");
  const gIsConnected = getter(Np, "isConnected");
  const gFirstElementChild = getter(Ep, "firstElementChild") || getter(W.DocumentFragment.prototype, "firstElementChild");
  const gLocalName = getter(Ep, "localName");
  const gHost = getter(W.ShadowRoot.prototype, "host");
  const gShadowRoot = getter(Ep, "shadowRoot");
  const gDefaultView = getter(W.Document.prototype, "defaultView");
  const gClientLeft = getter(Ep, "clientLeft");
  const gClientTop = getter(Ep, "clientTop");

  const HMEp = W.HTMLMediaElement.prototype;
  const nPlay = HMEp.play;
  const nPause = HMEp.pause;
  const dAutoplay = getOwnPropertyDescriptor(HMEp, "autoplay");
  const dPreload = getOwnPropertyDescriptor(HMEp, "preload");
  const dMuted = getOwnPropertyDescriptor(HMEp, "muted");
  const gPaused = getter(HMEp, "paused");
  const gReadyState = getter(HMEp, "readyState");

  const MEp = W.MouseEvent.prototype;
  const gClientX = getter(MEp, "clientX");
  const gClientY = getter(MEp, "clientY");
  const gButton = getter(MEp, "button");
  const gKey = getter(W.KeyboardEvent.prototype, "key");
  const gIsTrusted = (e) => e.isTrusted; // [LegacyUnforgeable] own property — cannot be faked by pages.
  const gTarget = getter(W.Event.prototype, "target");
  const gDetail = getter(W.UIEvent.prototype, "detail");
  const gType = getter(W.Event.prototype, "type");
  const gCurrentTarget = getter(W.Event.prototype, "currentTarget");
  const gWindowEvent = getter(W, "event") || (() => undefined);
  const rafN = W.requestAnimationFrame;
  const nComposedPath = W.Event.prototype.composedPath;

  const gFrameContentWindow = getter(W.HTMLIFrameElement.prototype, "contentWindow");

  const call = (fn, self, ...args) => ReflectApply(fn, self, args);
  const noop = () => {};
  const swallow = (p) => {
    try {
      call(PromiseThen, p, undefined, noop);
    } catch (e) {}
  };

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  let mode = "pending"; // "pending" until the isolated script answers; then "block" or "allow".
  let token = null;

  const HANDLING_WINDOW_MS = 100; // play() during dispatch of a trusted click/key counts as user-initiated
  const POSITION_WINDOW_MS = 5000; // a click on the element within this window counts as user-initiated
  const CONTROL_AREA_MAX = 250000; // px²: bigger than any button/thumbnail/player widget; page containers are bigger
  const RELEASE_AFTER_END_MS = 1500; // a video that ended may chain straight into the next item, not later
  const MAX_REJECTIONS = 4; // like the original: after 4 rejections, fake a play/pause cycle and resolve
  const MAX_SIM_CYCLES = 2; // fake play/pause cycles per element; more only feed players that retry on "pause"
  const MAX_BACKOFF_MS = 4000; // later resolutions are spaced out so retry-until-playing loops can't spin

  let lastInput = null; // { win, pageX, pageY, time }

  const media = new WeakMapRef(); // element -> per-element state
  const governedWindows = new WeakSetRef();
  const listenedWindows = new WeakSetRef();
  const observedRoots = new WeakSetRef();
  const loadHookedFrames = new WeakSetRef();
  const scannedDocs = new WeakSetRef();
  const masks = new WeakMapRef(); // wrapper function -> native-looking source string

  const pendingPlays = [];
  const pendingTouched = [];
  let pendingBlockedCount = 0;

  function stateOf(el) {
    let st = call(wmGet, media, el);
    if (!st) {
      st = {
        released: false,
        attempts: 0,
        counted: false,
        wantsAutoplay: false,
        requestedPreload: null,
        mutedAtBlock: null,
        simScheduled: false,
        simCycles: 0,
        simUntil: 0,
        backoff: null,
        pausedByUs: false,
        listening: false,
        touchedWhilePending: false,
      };
      call(wmSet, media, el, st);
    }
    return st;
  }

  function isMedia(o) {
    if (o === null || (typeof o !== "object" && typeof o !== "function")) return false;
    try {
      call(gPaused, o);
      return true;
    } catch (e) {
      return false;
    }
  }

  function viewOf(node) {
    try {
      const doc = call(gOwnerDocument, node);
      return (doc && call(gDefaultView, doc)) || null;
    } catch (e) {
      return null;
    }
  }

  /** Construct DOMException / Promise / Event objects in the element's own realm. */
  function realmOf(el) {
    return viewOf(el) || W;
  }

  function lower(s) {
    return call(toLowerCase, StringRef(s));
  }

  function nativePlay(el) {
    return call(nPlay, el);
  }

  function nativePause(el) {
    try {
      call(nPause, el);
    } catch (e) {}
  }

  function isPaused(el) {
    try {
      return call(gPaused, el);
    } catch (e) {
      return true;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Messaging with the isolated-world content script
  // ---------------------------------------------------------------------------------------------
  // The channel lives on a private, detached element shared by both worlds (never exposed to the page).
  // Unlike document/window, it keeps its listeners when a frame calls document.open().
  let port = null;

  function postToIsolated(msg) {
    if (!token || !port) return;
    try {
      const ev = new CustomEventRef("aps:" + token + ":m", { detail: call(JSONStringify, JSON, msg) });
      call(dispatchEv, port, ev);
    } catch (e) {}
  }

  function onIsolatedMessage(e) {
    let msg;
    try {
      msg = call(JSONParse, JSON, e.detail);
    } catch (err) {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "config") {
      setMode(msg.mode === "allow" ? "allow" : "block");
    } else if (msg.type === "input") {
      // A click relayed from an ancestor frame (already translated into our coordinates),
      // or the context-menu "Play Media" command.
      const t = +msg.time;
      const x = +msg.pageX;
      const y = +msg.pageY;
      if (t === t && x === x && y === y && (!lastInput || t >= lastInput.time)) {
        lastInput = { win: W, pageX: x, pageY: y, time: t };
      }
    }
  }

  function onIsolatedHello(e) {
    if (token) return;
    const d = e.detail;
    if (typeof d !== "string" || d.length < 32) return;
    let target;
    try {
      target = call(gTarget, e);
    } catch (err) {
      return;
    }
    if (!target || target === document) return;
    token = d;
    port = target;
    call(removeEL, document, "aps-iso-hello", onIsolatedHello, true);
    call(addEL, port, "aps:" + token, onIsolatedMessage, false);
    postToIsolated({ type: "ready" });
  }

  // ---------------------------------------------------------------------------------------------
  // Mode handling
  // ---------------------------------------------------------------------------------------------
  function setMode(next) {
    const prev = mode;
    mode = next;
    if (prev !== "pending") return;

    const plays = pendingPlays.splice(0);
    const touched = pendingTouched.splice(0);

    if (next === "allow") {
      pendingBlockedCount = 0;
      for (const el of touched) {
        const st = stateOf(el);
        st.counted = false;
        st.attempts = 0;
        st.simCycles = 0;
        if (st.requestedPreload !== null) {
          try {
            call(dPreload.set, el, st.requestedPreload);
          } catch (e) {}
          st.requestedPreload = null;
        }
        if (st.wantsAutoplay) {
          try {
            call(nSetAttribute, el, "autoplay", "");
          } catch (e) {}
        }
        if ((st.wantsAutoplay || st.pausedByUs) && isPaused(el)) {
          try {
            swallow(nativePlay(el));
          } catch (e) {}
        }
        st.pausedByUs = false;
      }
      for (const p of plays) {
        try {
          call(PromiseThen, nativePlay(p.el), p.resolve, p.reject);
        } catch (e) {
          p.reject(e);
        }
      }
    } else {
      if (pendingBlockedCount) postToIsolated({ type: "blocked", count: pendingBlockedCount });
      pendingBlockedCount = 0;
      for (const el of touched) {
        const st = stateOf(el);
        if (st.wantsAutoplay && !isReleased(st)) swallow(decidePlay(el, st, false));
      }
      for (const p of plays) {
        const st = stateOf(p.el);
        try {
          call(PromiseThen, decidePlay(p.el, st, p.allowed || gestureAllows(p.el)), p.resolve, p.reject);
        } catch (e) {
          p.reject(e);
        }
      }
    }
  }

  function touchWhilePending(el, st) {
    if (mode !== "pending" || st.touchedWhilePending) return;
    st.touchedWhilePending = true;
    pendingTouched[pendingTouched.length] = el;
  }

  // ---------------------------------------------------------------------------------------------
  // User-gesture detection
  // ---------------------------------------------------------------------------------------------
  const IGNORED_KEYS = {
    Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1, Tab: 1, Escape: 1, Fn: 1, FnLock: 1,
    NumLock: 1, ScrollLock: 1, OS: 1, Hyper: 1, Super: 1, AltGraph: 1, Dead: 1, Unidentified: 1,
  };

  function scrollOf(win) {
    try {
      return [win.scrollX || 0, win.scrollY || 0];
    } catch (e) {
      return [0, 0];
    }
  }

  const GESTURE_TYPES = {
    click: 1, dblclick: 1, mousedown: 1, mouseup: 1, pointerdown: 1, pointerup: 1, touchend: 1, keydown: 1, keyup: 1,
  };

  /** Element the event really started on (inside open shadow trees; closed ones are retargeted to the host). */
  function originOf(e) {
    try {
      const path = call(nComposedPath, e);
      if (path && path.length) return path[0];
    } catch (err) {}
    try {
      return call(gTarget, e);
    } catch (err) {
      return null;
    }
  }

  function keyOf(e) {
    try {
      return call(gKey, e);
    } catch (err) {
      return "";
    }
  }

  /** A large, page-level element (or the document/window): clicks on these aren't aimed at any one player. */
  function isPageLevel(node) {
    if (!node) return true;
    let t;
    try {
      t = call(gNodeType, node);
    } catch (e) {
      return true; // a Window
    }
    if (t === 9) return true;
    if (t === 11) {
      let host = null;
      try {
        host = call(gHost, node);
      } catch (e) {}
      return host ? isPageLevel(host) : true;
    }
    if (t !== 1) return true;
    const ln = call(gLocalName, node);
    if (ln === "html" || ln === "body") return true;
    try {
      const r = call(nGetBCR, node);
      return r.width * r.height > CONTROL_AREA_MAX;
    } catch (e) {
      return true;
    }
  }

  function onTrustedInput(e) {
    // Gestures only matter while blocking (or until the mode is known): on whitelisted / temporarily
    // disabled sites, typing and clicking cost nothing extra.
    if (mode === "allow" || !gIsTrusted(e)) return;
    const type = call(gType, e);
    const isKey = type === "keydown" || type === "keyup";
    const key = isKey ? keyOf(e) : "";
    if (isKey && IGNORED_KEYS[key] === 1) return;
    if (!isKey && type !== "touchend") {
      // Only the primary button counts (checked before any other work: right/middle clicks are ignored).
      let button = 0;
      try {
        button = call(gButton, e);
      } catch (err) {}
      if (button !== 0) return;
    }
    const now = DateNow();
    let win = W;
    try {
      win = viewOf(call(gTarget, e)) || e.view || W;
      if (call(gNodeType, call(gTarget, e)) === 9) win = call(gDefaultView, call(gTarget, e)) || win;
    } catch (err) {}
    const origin = originOf(e);

    if (isKey) {
      setGesture(origin, now);
      // Enter/Space on a focused control: record the control's center as the "click" position. Never for
      // page-level targets (Space on the page just scrolls it).
      if (type === "keydown" && (key === "Enter" || key === " ") && !isPageLevel(origin)) recordAt(win, origin, now);
      return;
    }

    let x;
    let y;
    if (type === "touchend") {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      x = t.clientX;
      y = t.clientY;
    } else {
      setGesture(origin, now);
      // A click produced by the keyboard (Enter/Space on a button) has no real pointer position.
      if (type === "click" && call(gDetail, e) === 0) {
        if (!isPageLevel(origin)) recordAt(win, origin, now);
        return;
      }
      try {
        x = call(gClientX, e);
        y = call(gClientY, e);
      } catch (err) {
        return;
      }
    }
    if (type === "touchend") setGesture(origin, now);
    const [sx, sy] = scrollOf(win);
    lastInput = { win, pageX: x + sx, pageY: y + sy, time: now };
  }

  function recordAt(win, node, now) {
    try {
      const r = call(nGetBCR, node);
      const [sx, sy] = scrollOf(win);
      lastInput = { win, pageX: r.left + r.width / 2 + sx, pageY: r.top + r.height / 2 + sy, time: now };
    } catch (err) {}
  }

  // The element a trusted click/key press is aimed at, valid while that input is being handled and for
  // promise continuations right after it. It ends before the next rendering step (requestAnimationFrame
  // runs before IntersectionObserver/ResizeObserver callbacks), so scroll- or layout-driven autoplay that
  // happens to follow an input never counts as user-initiated.
  let gesture = null; // { origin, until }
  function setGesture(origin, now) {
    const g = { origin, until: now + HANDLING_WINDOW_MS };
    gesture = g;
    const clear = () => {
      if (gesture === g) gesture = null;
    };
    try {
      call(setTimeoutN, W, clear, 0);
    } catch (e) {}
    try {
      call(rafN, W, clear);
    } catch (e) {}
  }

  function parentOf(node) {
    try {
      const p = call(gParentNode, node);
      if (!p) return null;
      if (call(gNodeType, p) === 11) {
        try {
          return call(gHost, p) || null;
        } catch (e) {
          return null;
        }
      }
      return call(gNodeType, p) === 1 ? p : null;
    } catch (e) {
      return null;
    }
  }

  /** Map a point/rect from `win`'s viewport into the viewport of the outermost same-origin governed window. */
  function toGoverningViewport(win, x, y) {
    let w = win;
    for (let i = 0; i < 16 && w && w !== W; i++) {
      let fe = null;
      try {
        fe = w.frameElement;
      } catch (e) {
        fe = null;
      }
      if (!fe) break;
      try {
        const r = call(nGetBCR, fe);
        x += r.left + (call(gClientLeft, fe) || 0);
        y += r.top + (call(gClientTop, fe) || 0);
        w = w.parent;
      } catch (e) {
        break;
      }
    }
    return { win: w, x, y };
  }

  function candidateRects(el) {
    const out = [];
    let r;
    try {
      r = call(nGetBCR, el);
    } catch (e) {
      return out;
    }
    out[out.length] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    const win = viewOf(el) || W;
    const [sx, sy] = scrollOf(win);
    const width = r.width;
    const height = r.height;

    // Original heuristic: if the element is tiny or off-page (e.g. a hidden <audio> driven by a custom
    // player), walk up to 5 ancestors to find the visible player box.
    let node = el;
    let rr = r;
    for (let i = 0; i < 5 && (rr.top + sy < 0 || rr.left + sx < 0 || rr.width < 10 || rr.height < 10); i++) {
      const p = parentOf(node);
      if (!p) break;
      node = p;
      try {
        rr = call(nGetBCR, node);
      } catch (e) {
        break;
      }
    }
    // Only accept a player-sized box: a hidden 1px ad video must not "own" the whole article around it.
    if (node !== el && rr.width * rr.height <= CONTROL_AREA_MAX) {
      out[out.length] = {
        left: rr.left,
        top: rr.top,
        right: rr.left + Math.max(rr.width, width),
        bottom: rr.top + Math.max(rr.height, height),
      };
    }

    // Improvement: players often draw their control bar just outside the <video> box. Accept clicks in
    // close ancestors that are not much larger than the video itself.
    const area = width * height;
    if (area >= 400) {
      node = el;
      for (let i = 0; i < 4; i++) {
        node = parentOf(node);
        if (!node) break;
        let a;
        try {
          a = call(nGetBCR, node);
        } catch (e) {
          break;
        }
        if (a.width * a.height > area * 1.5) break;
        out[out.length] = { left: a.left, top: a.top, right: a.right, bottom: a.bottom };
      }
    }
    return out;
  }

  function clickLandedOn(el, input) {
    const elWin = viewOf(el);
    if (!elWin) return false;
    let connected = false;
    try {
      connected = call(gIsConnected, el);
    } catch (e) {}
    if (!connected) return false;

    const [isx, isy] = scrollOf(input.win);
    const p = toGoverningViewport(input.win, input.pageX - isx, input.pageY - isy);
    const rects = candidateRects(el);
    for (const r of rects) {
      const a = toGoverningViewport(elWin, r.left, r.top);
      if (a.win !== p.win) continue;
      const w = r.right - r.left;
      const h = r.bottom - r.top;
      if (p.x >= a.x && p.x <= a.x + w && p.y >= a.y && p.y <= a.y + h) return true;
    }
    return false;
  }

  /** True when `origin` is inside `el`'s own player: their closest common ancestor is a small box. */
  function nearMedia(origin, el) {
    if (!origin || !el) return false;
    if (origin === el) return true;
    let elArea = 0;
    try {
      const r = call(nGetBCR, el);
      elArea = r.width * r.height;
    } catch (e) {}
    const limit = Math.max(elArea * 2.5, CONTROL_AREA_MAX);
    const chain = [];
    let n = el;
    for (let i = 0; i < 8 && n; i++) {
      chain[chain.length] = n;
      n = parentOf(n);
    }
    let m = origin;
    for (let j = 0; j < 40 && m; j++) {
      for (let k = 0; k < chain.length; k++) {
        if (chain[k] !== m) continue;
        if (k === 0) return true; // the input landed inside the media element itself
        const ln = call(gLocalName, m);
        if (ln === "html" || ln === "body") return false;
        try {
          const a = call(nGetBCR, m);
          return a.width * a.height <= limit;
        } catch (e) {
          return false;
        }
      }
      m = parentOf(m);
    }
    return false;
  }

  function currentEventOf(win) {
    try {
      const ev = call(gWindowEvent, win);
      if (!ev || !gIsTrusted(ev)) return null;
      const type = call(gType, ev);
      if (GESTURE_TYPES[type] === 1) {
        if ((type === "keydown" || type === "keyup") && IGNORED_KEYS[keyOf(ev)] === 1) return null;
        return ev;
      }
    } catch (e) {}
    return null;
  }

  function gestureAllows(el) {
    const now = DateNow();
    // 1. play() is being called by a handler of a trusted click/key press that's aimed at this player,
    //    or by a handler attached to a control-sized element (a button, link, or thumbnail) - never by a
    //    page-wide "unlock on first interaction" listener on document/window/body.
    const ev = currentEventOf(realmOf(el)) || currentEventOf(W);
    if (ev) {
      if (nearMedia(originOf(ev), el)) return true;
      let ct = null;
      try {
        ct = call(gCurrentTarget, ev);
      } catch (e) {}
      if (ct && !isPageLevel(ct)) return true;
    }
    // 2. Right after such an input (promise continuations), if it was aimed at this player.
    if (gesture && now < gesture.until && nearMedia(gesture.origin, el)) return true;
    // 3. The user clicked on the player itself within the last few seconds.
    if (!lastInput || now - lastInput.time > POSITION_WINDOW_MS || now < lastInput.time - 1000) return false;
    try {
      return clickLandedOn(el, lastInput);
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Blocking primitives
  // ---------------------------------------------------------------------------------------------
  const SIMPLAY_RULES = [
    { host: /(^|\.)cnn\.com$/, val: true },
    { host: /(^|\.)twitch\.tv$/, val: false },
    { host: /(^|\.)yastatic\.net$/, val: false },
    { host: /(^|\.)bbc\.(com|co\.uk)$/, val: false },
    { host: /(^|\.)(yahoo|yimg)\.com$/, cls: /\bhtml5-video\b/, val: true },
    { host: /(^|\.)youtube(-nocookie)?\.com$/, val: false },
    { cls: /\b(video-js|vjs-tech)\b/, val: false },
  ];

  function simPlayEnabled(el) {
    let host = "";
    let cls = "";
    try {
      host = realmOf(el).location.hostname;
    } catch (e) {}
    try {
      cls = StringRef(el.className || "");
    } catch (e) {}
    let enabled = true;
    for (const rule of SIMPLAY_RULES) {
      if (rule.host && !rule.host.test(host)) continue;
      if (rule.cls && !rule.cls.test(cls)) continue;
      enabled = rule.val;
    }
    return enabled;
  }

  /** Make the player believe playback started and was then paused, so it shows its "paused" UI. */
  function simPlay(el, st) {
    // One cycle at a time, and only a couple per element: a player that answers "pause" (or a resolved
    // play() that left it paused) with another play() would otherwise loop on our events forever.
    const now = DateNow();
    if (st.simCycles >= MAX_SIM_CYCLES || now < st.simUntil) return;
    if (!simPlayEnabled(el) || !isPaused(el)) return;
    st.simCycles++;
    st.simUntil = now + 400;
    const R = realmOf(el);
    const steps = [["play", 0], ["playing", 50], ["pause", 350]];
    for (const [type, delay] of steps) {
      call(setTimeoutN, W, () => {
        if (st.released || mode === "allow") return;
        try {
          call(dispatchEv, el, new R.Event(type));
        } catch (e) {}
      }, delay);
    }
  }

  function scheduleSimPlay(el, st) {
    if (st.simScheduled) return;
    st.simScheduled = true;
    let ready = 0;
    try {
      ready = call(gReadyState, el);
    } catch (e) {}
    if (ready >= 2) {
      simPlay(el, st);
    } else {
      const once = () => {
        call(removeEL, el, "loadeddata", once, true);
        if (!st.released) simPlay(el, st);
      };
      call(addEL, el, "loadeddata", once, true);
    }
  }

  function limitPreload(el, st) {
    try {
      const cur = call(dPreload.get, el);
      if (cur !== "none" && cur !== "metadata") {
        if (st.requestedPreload === null) st.requestedPreload = cur;
        call(dPreload.set, el, "metadata");
      }
    } catch (e) {}
  }

  function noteBlocked(el, st) {
    if (st.mutedAtBlock === null) {
      try {
        st.mutedAtBlock = !!call(dMuted.get, el);
      } catch (e) {
        st.mutedAtBlock = false;
      }
    }
    if (st.counted) return;
    st.counted = true;
    if (mode === "pending") pendingBlockedCount++;
    else postToIsolated({ type: "blocked", count: 1 });
  }

  function release(el, st) {
    st.endedAt = 0;
    if (st.released) return;
    st.released = true;
    st.pausedByUs = false;
    if (st.backoff) settleBackoff(st, st.backoff);
    if (st.requestedPreload !== null) {
      try {
        call(dPreload.set, el, st.requestedPreload);
      } catch (e) {}
      st.requestedPreload = null;
    }
    // The page muted the element as its "muted autoplay" fallback after we blocked it; the user has now
    // explicitly started it, so restore sound (only when the frame has a live user activation, otherwise
    // Chromium would pause the element for unmuting without a gesture).
    if (st.mutedAtBlock === false) {
      try {
        const R = realmOf(el);
        const ua = R.navigator && R.navigator.userActivation;
        if (call(dMuted.get, el) && ua && ua.isActive) call(dMuted.set, el, false);
      } catch (e) {}
    }
  }

  function blockPlay(el, st) {
    noteBlocked(el, st);
    st.attempts++;
    if (st.attempts === 1) {
      limitPreload(el, st);
      scheduleSimPlay(el, st);
    }
    if (!isPaused(el)) {
      st.pausedByUs = true;
      nativePause(el);
    }
    const R = realmOf(el);
    if (st.attempts <= MAX_REJECTIONS) {
      return R.Promise.reject(
        new R.DOMException("play() failed because the user didn't interact with the document first.", "NotAllowedError")
      );
    }
    // Some players retry forever; after several rejections, pretend it worked (like the original).
    simPlay(el, st);
    // Players that keep calling play() until the element is really playing (on rejection, on "pause", or
    // every frame) would spin the CPU indefinitely. Calls after the first resolved one share one promise
    // that settles after a growing delay (0.2 s, 0.4 s, ... up to 4 s), so such loops slow to a crawl.
    const extra = st.attempts - MAX_REJECTIONS;
    if (extra <= 1) return R.Promise.resolve();
    if (st.backoff) return st.backoff.promise;
    const b = { promise: null, resolve: null };
    b.promise = new R.Promise((resolve) => {
      b.resolve = resolve;
    });
    st.backoff = b;
    call(setTimeoutN, W, () => settleBackoff(st, b), extra >= 7 ? MAX_BACKOFF_MS : 50 << extra);
    return b.promise;
  }

  function settleBackoff(st, b) {
    if (st.backoff === b) st.backoff = null;
    b.resolve();
  }

  /** Released for good - except a <video> that finished and then tries to start again on its own later
   *  (YouTube-style "autoplay next"); an immediate chain into the next item (ad -> content) still works. */
  function isReleased(st) {
    if (!st.released) return false;
    if (st.endedAt && DateNow() - st.endedAt > RELEASE_AFTER_END_MS) {
      st.released = false;
      st.endedAt = 0;
      st.attempts = 0;
      st.counted = false;
      st.simScheduled = false;
      st.simCycles = 0;
      return false;
    }
    return true;
  }

  function onEnded(e) {
    if (!gIsTrusted(e)) return;
    let el;
    try {
      el = call(gTarget, e);
    } catch (err) {
      return;
    }
    if (!isMedia(el) || call(gLocalName, el) !== "video") return;
    const st = call(wmGet, media, el);
    if (st && st.released) st.endedAt = DateNow();
  }

  function decidePlay(el, st, allowed) {
    if (isReleased(st) || allowed) {
      st.endedAt = 0;
      release(el, st);
      return nativePlay(el);
    }
    return blockPlay(el, st);
  }

  function ensureListening(el, st) {
    if (st.listening) return;
    st.listening = true;
    try {
      call(addEL, el, "play", onPlayEvent, true);
      call(addEL, el, "ended", onEnded, true);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------------------------
  // Hooks (installed on every governed realm)
  // ---------------------------------------------------------------------------------------------
  const hooks = {
    play() {
      if (!isMedia(this) || mode === "allow") return nativePlay(this);
      const el = this;
      const st = stateOf(el);
      ensureListening(el, st);
      if (mode === "pending") {
        const allowed = isReleased(st) || gestureAllows(el);
        const R = realmOf(el);
        return new R.Promise((resolve, reject) => {
          pendingPlays[pendingPlays.length] = { el, resolve, reject, allowed };
        });
      }
      return decidePlay(el, st, gestureAllows(el));
    },

    setAutoplay(value) {
      if (mode === "allow" || !isMedia(this)) return call(dAutoplay.set, this, value);
      const el = this;
      const st = stateOf(el);
      ensureListening(el, st);
      if (isReleased(st) || !value) {
        if (!value) st.wantsAutoplay = false;
        return call(dAutoplay.set, el, value);
      }
      requestAutoplay(el, st);
    },

    setPreload(value) {
      if (mode === "allow" || !isMedia(this)) return call(dPreload.set, this, value);
      const st = stateOf(this);
      if (isReleased(st)) return call(dPreload.set, this, value);
      const v = lower(value);
      if (v === "none" || v === "metadata") {
        st.requestedPreload = null;
        return call(dPreload.set, this, value);
      }
      st.requestedPreload = StringRef(value);
      return call(dPreload.set, this, "metadata");
    },

    setAttribute(name, value) {
      if (mode !== "allow" && interceptAttribute(this, name, value)) return undefined;
      return ReflectApply(nSetAttribute, this, arguments);
    },

    setAttributeNS(ns, name, value) {
      if (mode !== "allow" && (ns === null || ns === undefined || ns === "") && interceptAttribute(this, name, value)) {
        return undefined;
      }
      return ReflectApply(nSetAttributeNS, this, arguments);
    },

    toggleAttribute(name, force) {
      if (mode !== "allow" && force !== false && arguments.length > 0) {
        const n = typeof name === "string" && name.length === 8 ? lower(name) : "";
        if (n === "autoplay" && isMedia(this) && !call(nHasAttribute, this, "autoplay")) {
          if (interceptAttribute(this, name, "")) return false;
        }
      }
      return ReflectApply(nToggleAttribute, this, arguments);
    },

    removeAttribute(name) {
      // Keep the poster visible while a blocked player believes it is "playing".
      if (mode !== "allow" && typeof name === "string" && name.length === 6 && lower(name) === "poster" && isMedia(this)) {
        const st = call(wmGet, media, this);
        if (st && !isReleased(st) && st.attempts > 0) return undefined;
      }
      return ReflectApply(nRemoveAttribute, this, arguments);
    },

    attachShadow(init) {
      const root = ReflectApply(nAttachShadow, this, arguments);
      try {
        observeRoot(root, viewOf(this) || W);
      } catch (e) {}
      return root;
    },

    // Clones and parsed fragments carry markup attributes (autoplay) without going through any setter, and
    // Chromium starts loading - and autoplaying - them even if they are never inserted.
    cloneNode() {
      const result = ReflectApply(nCloneNode, this, arguments);
      if (mode !== "allow") governCreated(result);
      return result;
    },

    importNode() {
      const result = ReflectApply(nImportNode, this, arguments);
      if (mode !== "allow") governCreated(result);
      return result;
    },

    createContextualFragment() {
      const result = ReflectApply(nCreateContextualFragment, this, arguments);
      if (mode !== "allow") governCreated(result);
      return result;
    },

    open() {
      const result = ReflectApply(nDocOpen, this, arguments);
      // document.open() erases event listeners on the document and its window; re-install ours.
      try {
        const win = call(gDefaultView, this);
        if (win) {
          call(wsDelete, listenedWindows, win);
          listenWindow(win);
        }
      } catch (e) {}
      return result;
    },
  };

  function interceptAttribute(el, name, value) {
    if (typeof name !== "string" || (name.length !== 8 && name.length !== 7)) return false;
    const n = lower(name);
    if (n !== "autoplay" && n !== "preload") return false;
    if (!isMedia(el)) return false;
    const st = stateOf(el);
    if (isReleased(st)) return false;
    if (n === "autoplay") {
      ensureListening(el, st);
      requestAutoplay(el, st);
      return true;
    }
    const v = lower(value);
    if (v === "none" || v === "metadata") {
      st.requestedPreload = null;
      return false;
    }
    st.requestedPreload = StringRef(value);
    call(nSetAttribute, el, "preload", "metadata");
    return true;
  }

  /** The page asked for autoplay (property, attribute, or markup). */
  function requestAutoplay(el, st) {
    st.wantsAutoplay = true;
    if (mode === "block" && gestureAllows(el)) {
      // e.g. the user clicked a "play" placeholder that swapped in an autoplaying player.
      release(el, st);
      call(dAutoplay.set, el, true);
      return;
    }
    if (call(nHasAttribute, el, "autoplay")) call(nRemoveAttribute, el, "autoplay");
    limitPreload(el, st);
    if (mode === "pending") {
      touchWhilePending(el, st);
      return;
    }
    // Same as the original: convert the autoplay request into a (gated) play() call.
    swallow(decidePlay(el, st, false));
  }

  // ---------------------------------------------------------------------------------------------
  // Backstop: anything that still starts playing without a gesture is paused immediately.
  // ---------------------------------------------------------------------------------------------
  function onPlayEvent(e) {
    if (!gIsTrusted(e) || mode === "allow") return;
    let el;
    try {
      el = call(gTarget, e);
    } catch (err) {
      return;
    }
    if (!isMedia(el)) return;
    const st = stateOf(el);
    ensureListening(el, st);
    if (isReleased(st) || isPaused(el)) return;
    if (mode === "block" && gestureAllows(el)) {
      release(el, st);
      return;
    }
    noteBlocked(el, st);
    st.pausedByUs = true;
    touchWhilePending(el, st);
    if (st.attempts === 0) {
      st.attempts = 1;
      limitPreload(el, st);
    }
    nativePause(el);
  }

  // ---------------------------------------------------------------------------------------------
  // DOM observation
  // ---------------------------------------------------------------------------------------------
  function processMedia(el) {
    if (mode === "allow") return;
    const st = stateOf(el);
    ensureListening(el, st);
    if (isReleased(st)) return;
    let hasAutoplay = false;
    try {
      hasAutoplay = call(nHasAttribute, el, "autoplay");
    } catch (e) {}
    if (hasAutoplay) {
      requestAutoplay(el, st);
    } else if (!st.seen) {
      limitPreload(el, st);
    }
    st.seen = true;
    if (!isPaused(el) && !st.released && !(mode === "block" && gestureAllows(el))) {
      noteBlocked(el, st);
      st.pausedByUs = true;
      touchWhilePending(el, st);
      nativePause(el);
    }
  }

  function hookFrame(frame) {
    try {
      const win = call(gFrameContentWindow, frame);
      if (win) governRealm(win);
    } catch (e) {}
    try {
      if (!call(wsHas, loadHookedFrames, frame)) {
        call(wsAdd, loadHookedFrames, frame);
        call(addEL, frame, "load", () => hookFrame(frame), true);
      }
    } catch (e) {}
  }

  const SELECTOR = "video,audio,iframe,frame";

  function handleNode(node) {
    let ln;
    try {
      if (call(gNodeType, node) !== 1) return;
      ln = call(gLocalName, node);
    } catch (e) {
      return;
    }
    if (ln === "video" || ln === "audio") processMedia(node);
    else if (ln === "iframe" || ln === "frame") hookFrame(node);
    let hasChildren = false;
    try {
      hasChildren = !!call(gFirstElementChild, node);
    } catch (e) {}
    if (!hasChildren) return;
    let list;
    try {
      list = call(nQSA, node, SELECTOR);
    } catch (e) {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const l = call(gLocalName, n);
      if (l === "video" || l === "audio") processMedia(n);
      else hookFrame(n);
    }
  }

  /** A node tree just created detached (clone / parsed fragment): gate its media like inserted media.
   *  Frames are left to the observer: a detached frame has no window yet. */
  function governCreated(node) {
    try {
      const t = call(gNodeType, node);
      let list;
      if (t === 1) {
        const ln = call(gLocalName, node);
        if (ln === "video" || ln === "audio") processMedia(node);
        if (!call(gFirstElementChild, node)) return;
        list = call(nQSA, node, "video,audio");
      } else if (t === 11) {
        list = call(nFragQSA, node, "video,audio");
      } else {
        return;
      }
      for (let i = 0; i < list.length; i++) processMedia(list[i]);
    } catch (e) {}
  }

  function onMutations(records) {
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.type === "childList") {
        const added = rec.addedNodes;
        for (let j = 0; j < added.length; j++) handleNode(added[j]);
      } else if (rec.type === "attributes") {
        const t = rec.target;
        if (isMedia(t)) processMedia(t);
      }
    }
  }

  function scanRoot(root) {
    let list;
    try {
      list = call(gNodeType, root) === 9 ? call(nDocQSA, root, SELECTOR) : root.querySelectorAll(SELECTOR);
    } catch (e) {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const l = call(gLocalName, n);
      if (l === "video" || l === "audio") processMedia(n);
      else hookFrame(n);
    }
  }

  function observeRoot(root, win) {
    if (!root || call(wsHas, observedRoots, root)) return;
    call(wsAdd, observedRoots, root);
    try {
      const mo = new MO(onMutations);
      call(moObserve, mo, root, { childList: true, subtree: true, attributes: true, attributeFilter: ["autoplay"] });
    } catch (e) {}
    if (call(gNodeType, root) === 11) {
      // Shadow roots: "play" doesn't cross the shadow boundary, so listen on the root itself.
      try {
        call(addEL, root, "play", onPlayEvent, true);
      } catch (e) {}
    }
    scanRoot(root);
  }

  /** Find shadow roots created declaratively by the parser (never pass through attachShadow). */
  function scanForOpenShadowRoots(doc, win) {
    try {
      const walker = doc.createTreeWalker(doc, 1 /* SHOW_ELEMENT */);
      let n = walker.nextNode();
      let budget = 20000;
      while (n && budget-- > 0) {
        const sr = call(gShadowRoot, n);
        if (sr && !call(wsHas, observedRoots, sr)) {
          observeRoot(sr, win);
          scanForOpenShadowRoots(sr, win);
        }
        n = walker.nextNode();
      }
    } catch (e) {}
  }

  const INPUT_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "touchend", "keydown", "keyup"];

  function listenWindow(win) {
    if (call(wsHas, listenedWindows, win)) return;
    call(wsAdd, listenedWindows, win);
    for (const type of INPUT_EVENTS) {
      try {
        call(addEL, win, type, onTrustedInput, { capture: true, passive: true });
      } catch (e) {}
    }
    try {
      call(addEL, win, "play", onPlayEvent, true);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------------------------
  // Realm patching
  // ---------------------------------------------------------------------------------------------
  function mask(fn, nativeFn, name) {
    let src;
    try {
      src = call(nFnToString, nativeFn);
    } catch (e) {
      src = "function " + name + "() { [native code] }";
    }
    call(wmSet, masks, fn, src);
    try {
      defineProperty(fn, "name", { value: name, configurable: true });
    } catch (e) {}
    try {
      defineProperty(fn, "length", { value: nativeFn.length, configurable: true });
    } catch (e) {}
    return fn;
  }

  const nFnToString = Function.prototype.toString;
  const toStringHook = {
    toString() {
      const m = call(wmGet, masks, this);
      if (m !== undefined) return m;
      return ReflectApply(nFnToString, this, arguments);
    },
  }.toString;
  mask(toStringHook, nFnToString, "toString");

  const wrapped = {
    play: mask(hooks.play, nPlay, "play"),
    setAutoplay: mask(hooks.setAutoplay, dAutoplay.set, "set autoplay"),
    setPreload: mask(hooks.setPreload, dPreload.set, "set preload"),
    setAttribute: mask(hooks.setAttribute, nSetAttribute, "setAttribute"),
    setAttributeNS: mask(hooks.setAttributeNS, nSetAttributeNS, "setAttributeNS"),
    toggleAttribute: mask(hooks.toggleAttribute, nToggleAttribute, "toggleAttribute"),
    removeAttribute: mask(hooks.removeAttribute, nRemoveAttribute, "removeAttribute"),
    attachShadow: mask(hooks.attachShadow, nAttachShadow, "attachShadow"),
    open: mask(hooks.open, nDocOpen, "open"),
    cloneNode: mask(hooks.cloneNode, nCloneNode, "cloneNode"),
    importNode: mask(hooks.importNode, nImportNode, "importNode"),
    createContextualFragment: mask(hooks.createContextualFragment, nCreateContextualFragment, "createContextualFragment"),
  };

  function replaceMethod(proto, name, fn) {
    const d = getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== "function") return;
    defineProperty(proto, name, { value: fn, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
  }

  function replaceSetter(proto, name, setFn) {
    const d = getOwnPropertyDescriptor(proto, name);
    if (!d || !d.set) return;
    defineProperty(proto, name, { get: d.get, set: setFn, enumerable: d.enumerable, configurable: d.configurable });
  }

  function makeFrameGetter(nativeGet, name, isDocument) {
    const fn = {
      get [name]() {
        const result = ReflectApply(nativeGet, this, []);
        if (result) {
          try {
            governRealm(isDocument ? call(gDefaultView, result) : result);
          } catch (e) {}
        }
        return result;
      },
    };
    const g = getOwnPropertyDescriptor(fn, name).get;
    return mask(g, nativeGet, "get " + name);
  }

  const frameGetterCache = new WeakMapRef();
  function replaceFrameGetters(proto) {
    for (const [name, isDocument] of [["contentWindow", false], ["contentDocument", true]]) {
      const d = getOwnPropertyDescriptor(proto, name);
      if (!d || !d.get) continue;
      let g = call(wmGet, frameGetterCache, d.get);
      if (!g) {
        g = makeFrameGetter(d.get, name, isDocument);
        call(wmSet, frameGetterCache, d.get, g);
      }
      defineProperty(proto, name, { get: g, set: d.set, enumerable: d.enumerable, configurable: d.configurable });
    }
  }

  /** Make sure the window's *current* document is observed (Chromium may reuse a Window across a
   *  same-origin navigation from the initial about:blank document, keeping our prototype patches). */
  function ensureDocumentGoverned(win) {
    listenWindow(win);
    try {
      const doc = win.document;
      if (!doc || call(wsHas, scannedDocs, doc)) return;
      call(wsAdd, scannedDocs, doc);
      observeRoot(doc, win);
      const deepScan = () => scanForOpenShadowRoots(doc, win);
      call(addEL, doc, "DOMContentLoaded", deepScan, true);
      call(addEL, win, "load", deepScan, { capture: true, once: true });
    } catch (e) {}
  }

  function governRealm(win) {
    if (!win) return;
    if (call(wsHas, governedWindows, win)) {
      ensureDocumentGoverned(win);
      return;
    }
    try {
      if (win[MARK]) return; // governed by another instance (its own content script got there first)
      if (!win.HTMLMediaElement) return;
    } catch (e) {
      return; // cross-origin
    }
    call(wsAdd, governedWindows, win);
    try {
      // A later instance in this realm (e.g. its own content script after a same-origin navigation that
      // reused the Window) asks this getter; we adopt the new document instead of double-patching.
      const markGetter = getOwnPropertyDescriptor(
        { get mark() { ensureDocumentGoverned(win); return true; } },
        "mark"
      ).get;
      defineProperty(win, MARK, { get: markGetter, enumerable: false, configurable: false });
    } catch (e) {}

    try {
      replaceMethod(win.Function.prototype, "toString", toStringHook);
    } catch (e) {}
    try {
      const hp = win.HTMLMediaElement.prototype;
      replaceMethod(hp, "play", wrapped.play);
      replaceSetter(hp, "autoplay", wrapped.setAutoplay);
      replaceSetter(hp, "preload", wrapped.setPreload);
    } catch (e) {}
    try {
      const ep = win.Element.prototype;
      replaceMethod(ep, "setAttribute", wrapped.setAttribute);
      replaceMethod(ep, "setAttributeNS", wrapped.setAttributeNS);
      replaceMethod(ep, "toggleAttribute", wrapped.toggleAttribute);
      replaceMethod(ep, "removeAttribute", wrapped.removeAttribute);
      replaceMethod(ep, "attachShadow", wrapped.attachShadow);
    } catch (e) {}
    try {
      replaceMethod(win.Document.prototype, "open", wrapped.open);
      replaceMethod(win.Document.prototype, "importNode", wrapped.importNode);
      replaceMethod(win.Node.prototype, "cloneNode", wrapped.cloneNode);
      replaceMethod(win.Range.prototype, "createContextualFragment", wrapped.createContextualFragment);
    } catch (e) {}
    for (const ctor of ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement"]) {
      try {
        if (win[ctor]) replaceFrameGetters(win[ctor].prototype);
      } catch (e) {}
    }

    ensureDocumentGoverned(win);
  }

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------
  governRealm(W);

  // Handshake with the isolated-world script (works regardless of which script was injected first).
  call(addEL, document, "aps-iso-hello", onIsolatedHello, true);
  try {
    call(dispatchEv, document, new CustomEventRef("aps-main-hello"));
  } catch (e) {}

  // If the isolated script never answers (e.g. the extension was reloaded), default to blocking.
  call(setTimeoutN, W, () => {
    if (mode === "pending") setMode("block");
  }, 3000);
})();
