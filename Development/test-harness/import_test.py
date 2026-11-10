import base64, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt
servers = rt.start_servers(); proc, profile = rt.launch()
try:
    s = rt.Session(rt.PORT); sw_t = rt.ext_sw(s); sw = s.attach(sw_t["targetId"]); ext_id = sw_t["url"].split("/")[2]
    time.sleep(1.5)
    st = s.evaluate(sw, "chrome.storage.local.get(null)")
    print("domains:", [e["domain"] for e in st["whitelist"]], "flag:", st.get("legacyImported"))
    # remove one, re-run init (simulates browser restart) -> must not come back
    s.evaluate(sw, "(async () => chrome.storage.local.set({whitelist: (await chrome.storage.local.get('whitelist')).whitelist.filter(e => e.domain !== 'chewy.com')}))()")
    s.evaluate(sw, "initStorage()")
    st = s.evaluate(sw, "chrome.storage.local.get('whitelist')")
    print("after removal + re-init:", [e["domain"] for e in st["whitelist"]])
    s.evaluate(sw, "(async () => chrome.storage.local.set({whitelist: (await chrome.storage.local.get('whitelist')).whitelist.concat({domain:'chewy.com', added: Date.now()})}))()")
    tid = s.call("Target.createTarget", {"url": "about:blank"})["targetId"]; sid = s.attach(tid)
    s.call("Page.enable", session=sid)
    s.call("Emulation.setDeviceMetricsOverride", {"width": 340, "height": 392, "deviceScaleFactor": 2, "mobile": False}, session=sid)
    s.call("Page.navigate", {"url": f"chrome-extension://{ext_id}/popup/popup.html"}, session=sid)
    time.sleep(1); s.evaluate(sid, "document.getElementById('btn-edit').click()"); time.sleep(0.6)
    print("popup list:", s.evaluate(sid, "[...document.querySelectorAll('#list li')].map(li => li.innerText.replace(/\\n/g,' | '))"))
    open(os.environ["SHOTS"] + "/popup-imported.png", "wb").write(base64.b64decode(s.call("Page.captureScreenshot", {"format": "png"}, session=sid)["data"]))
finally:
    proc.terminate(); [p.terminate() for p in servers]
