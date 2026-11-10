"""Adversarial / edge-case tests found during the code audit. Usage: audit_tests.py <ext> <test-site> [--no-ext] [filter...]"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt  # noqa: E402

A = rt.A


def all_media(s, sid, extra_sessions):
    """Every <video>/<audio> in the page and all frames (piercing closed shadow roots and OOPIFs)."""
    out = []
    for ses in [sid] + extra_sessions:
        try:
            root = s.call("DOM.getDocument", {"depth": -1, "pierce": True}, session=ses)["root"]
        except Exception:
            continue
        stack = [root]
        while stack:
            n = stack.pop()
            if n.get("nodeName") in ("VIDEO", "AUDIO"):
                try:
                    obj = s.call("DOM.resolveNode", {"backendNodeId": n["backendNodeId"]}, session=ses)["object"]
                    r = s.call("Runtime.callFunctionOn", {"objectId": obj["objectId"], "returnByValue": True,
                               "functionDeclaration": "function(){ return {paused: this.paused, t: +this.currentTime.toFixed(2), doc: String(this.ownerDocument.URL).slice(0,50)}; }"}, session=ses)
                    out.append(r["result"]["value"])
                except Exception as e:
                    out.append({"error": str(e)[:80]})
            for k in ("children", "shadowRoots"):
                stack.extend(n.get(k, []))
            if n.get("contentDocument"):
                stack.append(n["contentDocument"])
            if n.get("templateContent"):
                pass
    return out


def key(s, sid, k, code, vk, text=None):
    p = {"type": "keyDown", "key": k, "code": code, "windowsVirtualKeyCode": vk}
    if text:
        p["text"] = text
    s.call("Input.dispatchKeyEvent", p, session=sid)
    s.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": k, "code": code, "windowsVirtualKeyCode": vk}, session=sid)


def stopped(v):
    return v is not None and v.get("paused") is True and v.get("t", 0) < 0.6


def playing(v):
    return v is not None and v.get("paused") is False


TESTS = [
    # name, path, actions, expectation(check result, media list)
    ("document-level 'first click' unlock listener stays blocked", "/a-docunlock.html",
     [("wait", 0.5), ("click", 850, 610), ("wait", 1.0)], lambda r, m: stopped(r["v"]) and r["unlock"] == "NotAllowedError"),
    ("keyboard scrolling into view (Space/PageDown) stays blocked", "/a-scroll-io.html",
     [("wait", 0.5)] + [("key", " ", "Space", 32, " ")] * 3 + [("key", "PageDown", "PageDown", 34)] * 3 + [("wait", 1.0)],
     lambda r, m: r["y"] > 2000 and stopped(r["v"])),
    ("wheel scrolling into view stays blocked", "/a-scroll-io.html",
     [("wait", 0.5)] + [("wheel", 3000)] + [("wait", 1.5)], lambda r, m: r["y"] > 2000 and stopped(r["v"])),
    ("click that reveals a feed video doesn't let it autoplay", "/a-reveal.html",
     [("wait", 0.5), ("click", 100, 40), ("wait", 1.0)], lambda r, m: stopped(r["v"])),
    ("pristine play()/Audio/setAttribute via frames[i]", "/a-frames.html", [("wait", 1.0)],
     lambda r, m: stopped(r["v"]) and stopped(r["a"]) and stopped(r["v2"])),
    ("data:, sandboxed, srcdoc, javascript:, media-document, embed, object frames", "/a-frames-iframe.html", [("wait", 2.0)],
     lambda r, m: len(m) >= 6 and all(stopped(x) for x in m)),
    ("closed declarative shadow DOM", "/a-dsd.html", [("wait", 2.5)], lambda r, m: len(m) == 1 and stopped(m[0])),
    ("released video: replays itself long after it ended -> blocked; quick continuation allowed", "/a-ended.html",
     [("wait", 0.5), ("click", 240, 135), ("wait", 5.5)],
     lambda r, m: r["first"] == "resolved" and r["quick"] == "resolved" and r["late"] == "NotAllowedError" and stopped(r["v"]) is False and r["v"]["paused"] is True),
    ("player button / delegated-near / async-near still play", "/a-near.html",
     [("wait", 0.5), ("click", 50, 290), ("click", 650, 290), ("click", 50, 690), ("wait", 0.8)],
     lambda r, m: playing(r["v1"]) and playing(r["v2"]) and playing(r["v3"])),
    ("hidden 1px video doesn't ride a click on the surrounding article", "/a-tiny.html",
     [("wait", 0.5), ("click", 100, 335), ("wait", 1.5), ("click", 980, 50), ("wait", 1.0)],
     lambda r, m: stopped(r["hid"]) and r["hidden"] == "NotAllowedError" and playing(r["au"])),
    ("page can't forge a 'user clicked' relay message into its iframe", "/a-forge.html", [("wait", 2.0)],
     lambda r, m: isinstance(r["child"], dict) and r["child"]["paused"] is True),
    ("keyboard-activated click elsewhere doesn't unlock a top-left video", "/a-kbclick.html",
     [("wait", 0.5), ("key", "Enter", "Enter", 13, "\r"), ("eval", "go()"), ("wait", 1.3)],
     lambda r, m: stopped(r["v"])),
]


def main():
    only = [a for a in sys.argv[3:] if not a.startswith("--")]
    servers = rt.start_servers()
    proc, profile = rt.launch()
    passed = total = 0
    try:
        s = rt.Session(rt.PORT)
        if rt.WITH_EXT:
            sw = s.attach(rt.ext_sw(s)["targetId"])
            s.evaluate(sw, "chrome.storage.local.set({whitelist: [], tempDisabled: []})")
        for name, path, actions, expect in TESTS:
            if only and not any(o in path for o in only):
                continue
            tid = s.call("Target.createTarget", {"url": "about:blank"})["targetId"]
            sid = s.attach(tid)
            s.call("Page.enable", session=sid)
            s.call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True}, session=sid)
            s.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 860, "deviceScaleFactor": 1, "mobile": False}, session=sid)
            s.call("Page.navigate", {"url": A + path}, session=sid)
            time.sleep(1.5)
            for a in actions:
                if a[0] == "wait":
                    time.sleep(a[1])
                elif a[0] == "click":
                    for t in ("mouseMoved", "mousePressed", "mouseReleased"):
                        s.call("Input.dispatchMouseEvent", {"type": t, "x": a[1], "y": a[2], "button": "none" if t == "mouseMoved" else "left", "clickCount": 1}, session=sid)
                elif a[0] == "key":
                    key(s, sid, *a[1:])
                    time.sleep(0.15)
                elif a[0] == "wheel":
                    s.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": 400, "y": 400, "deltaX": 0, "deltaY": a[1]}, session=sid)
                elif a[0] == "eval":
                    s.evaluate(sid, a[1])
            s.drain(0.3)
            extra = [e["params"]["sessionId"] for e in s.events if e.get("method") == "Target.attachedToTarget" and e.get("sessionId") == sid]
            s.events = []
            try:
                r = s.evaluate(sid, "Promise.resolve(window.check ? window.check() : {})")
            except Exception as e:
                r = {"error": str(e)[:200]}
            m = all_media(s, sid, extra)
            try:
                ok = bool(expect(r, m))
            except Exception as e:
                ok = False
                r = {"exception": repr(e), "raw": r}
            total += 1
            passed += ok
            print(("PASS " if ok else "FAIL ") + name + ("" if ok else "\n     page: " + json.dumps(r)[:500] + "\n     media: " + json.dumps(m)[:700]), flush=True)
            s.call("Target.closeTarget", {"targetId": tid})
        print(f"\n{passed}/{total} passed")
    finally:
        proc.terminate()
        for p in servers:
            p.terminate()


if __name__ == "__main__":
    main()
