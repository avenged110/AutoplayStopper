"""Open one page with the extension and evaluate expressions in main + isolated worlds."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt  # noqa: E402

url = sys.argv[3]
exprs_main = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
exprs_iso = json.loads(sys.argv[5]) if len(sys.argv) > 5 else []

servers = rt.start_servers()
proc, profile = rt.launch()
try:
    s = rt.Session(rt.PORT)
    sw_t = rt.ext_sw(s)
    pg = rt.Page(s, url)
    time.sleep(2)
    pg.eval('1')
    ctxs = [e["params"]["context"] for e in s.events if e.get("method") == "Runtime.executionContextCreated" and e.get("sessionId") == pg.sid]
    for c in ctxs:
        print("ctx", c["id"], c.get("name"), c.get("origin"), c.get("auxData"))
    for e in s.events:
        if e.get("method") in ("Runtime.consoleAPICalled", "Runtime.exceptionThrown") and e.get("sessionId") == pg.sid:
            print("console:", json.dumps(e["params"])[:600])
    for x in exprs_main:
        try:
            print("MAIN", x, "=>", pg.eval(x))
        except Exception as ex:
            print("MAIN", x, "!!", ex)
    iso = [c for c in ctxs if c.get("auxData", {}).get("type") == "isolated"]
    for x in exprs_iso:
        for c in iso:
            r = s.call("Runtime.evaluate", {"expression": x, "contextId": c["id"], "returnByValue": True, "awaitPromise": True}, session=pg.sid)
            print("ISO", c["id"], x, "=>", json.dumps(r)[:400])
finally:
    proc.terminate()
    for p in servers:
        p.terminate()
