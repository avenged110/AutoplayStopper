"""Load a real site with the extension, screenshot, click the main video (or a selector), screenshot again."""
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt  # noqa: E402
from realsites import UA, COLLECT  # noqa: E402

OUTDIR = os.environ["SHOTS"]
jobs = json.loads(sys.argv[3])  # [{"name","url","selector"}]


def shot(s, sid, path):
    data = s.call("Page.captureScreenshot", {"format": "png"}, session=sid)["data"]
    with open(path, "wb") as f:
        f.write(base64.b64decode(data))


def media_state(s, sid):
    r = s.evaluate(sid, COLLECT, await_promise=False)
    return [(m["paused"], m["t"], m["size"]) for m in r["media"]]


servers = rt.start_servers()
proc, profile = rt.launch()
try:
    s = rt.Session(rt.PORT)
    if rt.WITH_EXT:
        rt.ext_sw(s)
    for job in jobs:
        tid = s.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sid = s.attach(tid)
        s.call("Network.setUserAgentOverride", {"userAgent": UA}, session=sid)
        s.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 860, "deviceScaleFactor": 1, "mobile": False}, session=sid)
        s.call("Page.enable", session=sid)
        s.call("Page.navigate", {"url": job["url"]}, session=sid)
        time.sleep(job.get("wait", 9))
        print(f"=== {job['name']} before click:", media_state(s, sid))
        shot(s, sid, f"{OUTDIR}/{job['name']}-1-before.png")
        rect = s.evaluate(sid, f"""(() => {{ const el = document.querySelector({json.dumps(job['selector'])});
            if (!el) return null; el.scrollIntoView({{block: 'center'}}); const r = el.getBoundingClientRect();
            return {{x: r.left + r.width / 2, y: r.top + r.height / 2}}; }})()""", await_promise=False)
        if not rect:
            print("   selector not found")
            continue
        time.sleep(0.5)
        rect = s.evaluate(sid, f"""(() => {{ const r = document.querySelector({json.dumps(job['selector'])}).getBoundingClientRect();
            return {{x: r.left + r.width / 2, y: r.top + r.height / 2}}; }})()""", await_promise=False)
        x, y = rect["x"] + job.get("dx", 0), rect["y"] + job.get("dy", 0)
        for t in ("mouseMoved", "mousePressed", "mouseReleased"):
            s.call("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y, "button": "none" if t == "mouseMoved" else "left", "clickCount": 1}, session=sid)
        time.sleep(job.get("after", 5))
        print(f"    after click at ({x:.0f},{y:.0f}):", media_state(s, sid))
        shot(s, sid, f"{OUTDIR}/{job['name']}-2-after.png")
        s.call("Target.closeTarget", {"targetId": tid})
finally:
    proc.terminate()
    for p in servers:
        p.terminate()
