"""Launch Chromium with/without the extension, run the local test pages, report results."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Session, http_json  # noqa: E402

CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium"
EXT = sys.argv[1]
SITE = sys.argv[2]
WITH_EXT = "--no-ext" not in sys.argv
ONLY = [a for a in sys.argv[3:] if not a.startswith("--")]
PORT = 9333
A = "http://site-a.test:8765"


def start_servers():
    procs = []
    for port in (8765, 8766):
        procs.append(
            subprocess.Popen(
                [sys.executable, "-I", "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", SITE],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )
    time.sleep(0.8)
    return procs


def launch():
    profile = tempfile.mkdtemp(prefix="aps-profile-")
    # Keep test downloads inside the throwaway profile, never in the real ~/Downloads.
    downloads = os.path.join(profile, "Downloads")
    os.makedirs(os.path.join(profile, "Default"), exist_ok=True)
    os.makedirs(downloads, exist_ok=True)
    with open(os.path.join(profile, "Default", "Preferences"), "w") as f:
        json.dump({"download": {"default_directory": downloads, "prompt_for_download": False, "directory_upgrade": True},
                   "savefile": {"default_directory": downloads}}, f)
    launch.downloads = downloads
    args = [
        CHROMIUM,
        f"--user-data-dir={profile}",
        f"--remote-debugging-port={PORT}",
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--autoplay-policy=no-user-gesture-required",
        "--host-resolver-rules=MAP *.test 127.0.0.1",
        "--window-size=1280,900",
        "--mute-audio",
    ]
    if WITH_EXT:
        args += [f"--load-extension={EXT}", f"--disable-extensions-except={EXT}"]
    args.append("about:blank")
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(100):
        try:
            http_json(PORT, "/json/version")
            break
        except Exception:
            time.sleep(0.1)
    return proc, profile


def ext_sw(s):
    for _ in range(50):
        for t in s.targets():
            if t["type"] == "service_worker" and t["url"].startswith("chrome-extension://"):
                return t
        time.sleep(0.2)
    return None


class Page:
    def __init__(self, s, url):
        self.s = s
        self.tid = s.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.sid = s.attach(self.tid)
        s.call("Page.enable", session=self.sid)
        s.call("Runtime.enable", session=self.sid)
        s.call("Page.navigate", {"url": url}, session=self.sid)

    def click(self, x, y):
        for t in ("mouseMoved", "mousePressed", "mouseReleased"):
            p = {"type": t, "x": x, "y": y, "button": "left" if t != "mouseMoved" else "none", "clickCount": 1}
            self.s.call("Input.dispatchMouseEvent", p, session=self.sid)

    def eval(self, expr):
        return self.s.evaluate(self.sid, expr)

    def close(self):
        self.s.call("Target.closeTarget", {"targetId": self.tid})


def playing(v):
    return v is not None and v.get("paused") is False


def stopped(v):
    return v is not None and v.get("paused") is True and v.get("t", 0) < 0.6


TESTS = [
    ("autoplay attribute (muted)", "/t-attr.html", [], lambda r: stopped(r["v"]) and not r["hasAttr"]),
    ("autoplay attribute (unmuted)", "/t-attr-unmuted.html", [], lambda r: stopped(r["v"])),
    ("inline play()", "/t-inline.html", [], lambda r: stopped(r["v"]) and r["p"] == "NotAllowedError"),
    ("play() in <head> before config", "/t-head.html", [], lambda r: stopped(r["a"]) and r["p"] == "NotAllowedError" and stopped(r["v2"])),
    ("delayed play()", "/t-timeout.html", [("wait", 1.5)], lambda r: stopped(r["v"]) and r["p"] == "NotAllowedError"),
    ("detached new Audio().play()", "/t-audio.html", [], lambda r: stopped(r["a"]) and r["p"] == "NotAllowedError"),
    ("closed shadow DOM", "/t-shadow.html", [], lambda r: stopped(r["v1"]) and stopped(r["v2"]) and r["p"] == "NotAllowedError"),
    ("about:blank iframe + pristine play() bypass", "/t-blank.html", [],
     lambda r: stopped(r["v"]) and r["p"] == "NotAllowedError" and stopped(r["iv"]) and stopped(r["v3"]) and r["p3"] == "NotAllowedError"),
    ("autoplay via property/setAttribute/attrNode/innerHTML/toggle", "/t-prop.html", [],
     lambda r: all(stopped(r[k]) for k in ("v", "v2", "v3", "v4", "v5"))),
    ("MediaStream srcObject autoplay", "/t-stream.html", [], lambda r: r["v"]["paused"] is True),
    ("click handlers / positional gesture", "/t-click.html",
     [("wait", 0.5), ("click", 660, 70), ("wait", 0.3), ("click", 660, 430), ("wait", 1.5), ("click", 240, 485), ("wait", 2.6)],
     lambda r: r["buttonPlay"] == "resolved" and playing(r["v"]) and r["elsewherePlay"] == "NotAllowedError" and r["latePlay"] == "resolved" and playing(r["v2"])),
    ("cross-origin iframe autoplay", "/t-xorigin.html", [("wait", 1.0)], lambda r: r["child"] and r["child"]["paused"] is True),
    ("click-to-load facade -> iframe plays", "/t-facade.html", [("wait", 0.5), ("click", 240, 135), ("wait", 2.5)],
     lambda r: isinstance(r["child"], dict) and r["child"]["paused"] is False),
    ("unrelated click -> iframe still blocked", "/t-facade-control.html", [("wait", 0.5), ("click", 700, 50), ("wait", 2.5)],
     lambda r: isinstance(r["child"], dict) and r["child"]["paused"] is True and r["child"]["res"] == "NotAllowedError"),
    ("overlay over iframe -> postMessage play", "/t-overlay.html", [("wait", 1.5), ("click", 240, 135), ("wait", 1.0)],
     lambda r: isinstance(r["child"], dict) and r["child"]["paused"] is False),
    ("muted fallback, then user click unmutes", "/t-muted.html", [("wait", 1.0), ("click", 240, 135), ("wait", 0.8)],
     lambda r: r["fallbackRejected"] is True and playing(r["v"]) and r["v"]["muted"] is False),
    ("released element can be resumed by script later", "/t-release.html", [("wait", 0.5), ("click", 240, 135), ("wait", 8.0)],
     lambda r: r["first"] == "resolved" and r["second"] == "resolved" and playing(r["v"])),
    ("retry loop: 4 rejections then fake play/pause", "/t-retry.html", [("wait", 2.0)],
     lambda r: r["results"][:4] == ["NotAllowedError"] * 4 and r["results"][4:] == ["ok", "ok"] and stopped(r["v"])),
    ("same-origin real-URL iframe (window reuse)", "/t-sameorigin.html", [("wait", 1.0)], lambda r: stopped(r["v"])),
    ("declarative shadow DOM autoplay", "/t-dsd.html", [("wait", 0.5)], lambda r: stopped(r["v"])),
    ("detached media from fragment parsing / template import", "/t-detached.html", [("wait", 1.0)],
     lambda r: all(stopped(v) for v in r.values())),
    ("detached media from cloneNode / importNode / adoption paths", "/t-detached2.html", [("wait", 1.0)],
     lambda r: all(stopped(v) for v in r.values())),
    ("pristine play()/autoplay via window[n] frame", "/t-frames.html", [("wait", 0.5)],
     lambda r: stopped(r["a"]) and r["p"] == "NotAllowedError" and stopped(r["a2"])),
    ("media file loaded as iframe/object document", "/t-mediadoc.html", [("wait", 1.0)],
     lambda r: stopped(r["iframe"]) and stopped(r["object"])),
    ("sandboxed srcdoc / blob: frames", "/t-sandbox.html", [("wait", 1.0)],
     lambda r: stopped(r["sameOriginSandbox"]) and stopped(r["blob"])),
    ("retry-until-playing player doesn't spin (backoff)", "/s-retry-catch.html", [("wait", 3.0)],
     lambda r: r["calls"] < 40 and r["play"] <= 2),
    ("natives look native", "/t-tostring.html", [],
     lambda r: "[native code]" in r["play"] and "[native code]" in r["fts"] and "[native code]" in r["setter"] and "[native code]" in r["sa"] and r["name"] == "play"),
]

WL_TESTS = [
    ("WL: autoplay attribute plays", "/t-attr.html", [], lambda r: playing(r["v"])),
    ("WL: play() in <head> plays", "/t-head.html", [], lambda r: playing(r["a"]) and r["p"] == "resolved" and playing(r["v2"])),
    ("WL: cross-origin child of whitelisted site plays", "/t-xorigin.html", [("wait", 1.0)], lambda r: r["child"] and r["child"]["paused"] is False),
    ("WL: closed shadow DOM plays", "/t-shadow.html", [], lambda r: playing(r["v1"]) and playing(r["v2"])),
    ("WL: about:blank + document.open frames play", "/t-blank.html", [], lambda r: playing(r["v"]) and playing(r["iv"]) and playing(r["v3"])),
    ("WL: same-origin real-URL iframe plays", "/t-sameorigin.html", [("wait", 1.0)], lambda r: playing(r["v"])),
]


def special_tests(s, sw):
    out = []
    # No badge on the toolbar icon; the blocked count (t-shadow blocks 2 elements) is pulled from the
    # page's frames over a port, the way the popover asks for it.
    pg = Page(s, A + "/t-shadow.html")
    time.sleep(2.0)
    res = s.evaluate(sw, """chrome.tabs.query({}).then(ts => new Promise(done => {
        const t = ts.find(t => (t.url||'').includes('t-shadow'));
        const counts = new Map();
        const p = chrome.tabs.connect(t.id, {name: 'aps-count'});
        p.onMessage.addListener(m => counts.set(m.id, m.count));
        setTimeout(async () => {
          p.disconnect();
          done({badge: await chrome.action.getBadgeText({tabId: t.id}), total: [...counts.values()].reduce((a, b) => a + b, 0)});
        }, 500);
    }))""")
    ok = res["badge"] == "" and res["total"] == 2
    out.append((ok, "no badge; frames report blocked count on request", res))
    print(("PASS " if ok else "FAIL ") + "no badge; frames report blocked count on request (" + repr(res) + ")", flush=True)
    pg.close()

    # Context menu: right-press over an overlay that covers a blocked video, then "Play Media".
    pg = Page(s, A + "/t-ctx.html")
    time.sleep(1.5)
    s.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 240, "y": 135}, session=pg.sid)
    s.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": 240, "y": 135, "button": "right", "clickCount": 1}, session=pg.sid)
    s.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": 240, "y": 135, "button": "right", "clickCount": 1}, session=pg.sid)
    time.sleep(0.3)
    s.evaluate(sw, "chrome.tabs.query({}).then(ts => { const t = ts.find(t => (t.url||'').includes('t-ctx')); return chrome.tabs.sendMessage(t.id, {type: 'toggleMedia'}, {frameId: 0}); })")
    time.sleep(0.8)
    r1 = pg.eval("window.check()")
    s.evaluate(sw, "chrome.tabs.query({}).then(ts => { const t = ts.find(t => (t.url||'').includes('t-ctx')); return chrome.tabs.sendMessage(t.id, {type: 'toggleMedia'}, {frameId: 0}); })")
    time.sleep(0.5)
    r2 = pg.eval("window.check()")
    ok = r1["p"] == "NotAllowedError" and playing(r1["v"]) and r2["v"]["paused"] is True
    out.append((ok, "context menu Play/Pause through overlay", [r1, r2]))
    print(("PASS " if ok else "FAIL ") + "context menu Play/Pause through overlay" + ("" if ok else " " + json.dumps([r1, r2])), flush=True)
    pg.close()
    return out


def run(s, tests, base=A, settle=1.5):
    results = []
    for name, path, actions, expect in tests:
        if ONLY and not any(o in path for o in ONLY):
            continue
        pg = Page(s, base + path)
        time.sleep(settle)
        for a in actions:
            if a[0] == "wait":
                time.sleep(a[1])
            elif a[0] == "click":
                pg.click(a[1], a[2])
        try:
            r = pg.eval("Promise.resolve(window.check && window.check())")
        except Exception as e:
            r = {"error": str(e)}
        try:
            ok = bool(expect(r))
        except Exception as e:
            ok = False
            r = {"exception": repr(e), "raw": r}
        results.append((ok, name, r))
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + json.dumps(r)[:700]), flush=True)
        pg.close()
    return results


def main():
    servers = start_servers()
    proc, profile = launch()
    try:
        s = Session(PORT)
        sw = None
        if WITH_EXT:
            sw_t = ext_sw(s)
            print("extension SW:", sw_t and sw_t["url"])
            sw = s.attach(sw_t["targetId"])
            s.call("Runtime.enable", session=sw)
            s.evaluate(sw, "chrome.storage.local.set({whitelist: [], tempDisabled: []})")
        res = run(s, TESTS)
        if WITH_EXT and not ONLY:
            res += special_tests(s, sw)
            s.evaluate(sw, "chrome.storage.local.set({whitelist: [{domain: 'site-a.test', added: Date.now()}]})")
            time.sleep(0.3)
            res += run(s, WL_TESTS)
            s.evaluate(sw, "chrome.storage.local.set({whitelist: [], tempDisabled: ['site-a.test']})")
            time.sleep(0.3)
            res += run(s, [(n.replace("WL", "TEMP"), p, a, e) for n, p, a, e in WL_TESTS[:2]])
            s.evaluate(sw, "chrome.storage.local.set({whitelist: [], tempDisabled: []})")
            time.sleep(0.3)
            res += run(s, [("re-enabled: autoplay blocked again", "/t-attr.html", [], TESTS[0][3])])
        if WITH_EXT:
            s.drain(0.5)
            errs = [e for e in s.events if e.get("method") in ("Runtime.exceptionThrown",) or (e.get("method") == "Runtime.consoleAPICalled" and e["params"]["type"] == "error")]
            ext_errs = [e for e in errs if "chrome-extension://" in json.dumps(e) or e.get("sessionId") == sw]
            print("extension errors/exceptions seen:", len(ext_errs))
            for e in ext_errs[:5]:
                print("   ", json.dumps(e["params"])[:400])
        failed = [r for r in res if not r[0]]
        print(f"\n{len(res) - len(failed)}/{len(res)} passed")
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()
        for p in servers:
            p.terminate()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
