"""Visit real sites with/without the extension and report media playback state in every frame."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt  # noqa: E402

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
URLS = [a for a in sys.argv[3:] if not a.startswith("--")]
WAIT = 10

COLLECT = r"""
(() => {
  const out = [];
  const seen = new Set();
  function walk(root) {
    for (const m of root.querySelectorAll('video, audio')) {
      if (seen.has(m)) continue; seen.add(m);
      const r = m.getBoundingClientRect();
      out.push({tag: m.localName, paused: m.paused, t: +m.currentTime.toFixed(1), muted: m.muted,
                size: Math.round(r.width) + 'x' + Math.round(r.height), src: String(m.currentSrc || m.src || (m.srcObject ? 'stream' : '')).slice(0, 60)});
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  }
  walk(document);
  return {url: location.href.slice(0, 80), media: out};
})()
"""


def main():
    servers = rt.start_servers()
    proc, profile = rt.launch()
    try:
        s = rt.Session(rt.PORT)
        if rt.WITH_EXT:
            rt.ext_sw(s)
        for url in URLS:
            pg = rt.Page.__new__(rt.Page)
            pg.s = s
            pg.tid = s.call("Target.createTarget", {"url": "about:blank"})["targetId"]
            pg.sid = s.attach(pg.tid)
            s.call("Network.setUserAgentOverride", {"userAgent": UA}, session=pg.sid)
            s.call("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True}, session=pg.sid)
            s.call("Page.enable", session=pg.sid)
            s.call("Page.navigate", {"url": url}, session=pg.sid)
            time.sleep(WAIT)
            s.drain(0.5)
            # collect sessions for out-of-process iframes
            child_sessions = []
            for e in s.events:
                if e.get("method") == "Target.attachedToTarget" and e["params"]["targetInfo"]["type"] == "iframe":
                    child_sessions.append(e["params"]["sessionId"])
            s.events = []
            frames = []
            for sid in [pg.sid] + child_sessions:
                try:
                    frames.append(s.evaluate(sid, COLLECT, await_promise=False, timeout=10))
                except Exception as ex:
                    pass
            total = sum(len(f["media"]) for f in frames if f)
            playing = [(f["url"], m) for f in frames if f for m in f["media"] if not m["paused"]]
            print(f"\n=== {url}  media={total}  playing={len(playing)}")
            for f in frames:
                if f and f["media"]:
                    print("  frame", f["url"])
                    for m in f["media"]:
                        print("    ", json.dumps(m))
            pg.close()
    finally:
        proc.terminate()
        for p in servers:
            p.terminate()


if __name__ == "__main__":
    main()
