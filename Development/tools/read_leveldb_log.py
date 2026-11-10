import sys, struct
data = open(sys.argv[1], 'rb').read()
BLOCK = 32768
# reassemble logical records
recs, buf, pos = [], b'', 0
while pos + 7 <= len(data):
    left = BLOCK - (pos % BLOCK)
    if left < 7: pos += left; continue
    crc, ln, typ = struct.unpack('<IHB', data[pos:pos+7])
    if typ == 0 and ln == 0: pos += left; continue
    frag = data[pos+7:pos+7+ln]; pos += 7 + ln
    if typ == 1: recs.append(frag)
    elif typ == 2: buf = frag
    elif typ == 3: buf += frag
    elif typ == 4: recs.append(buf + frag); buf = b''
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i
state = {}
for r in recs:
    seq, cnt = struct.unpack('<QI', r[:12]); i = 12
    for _ in range(cnt):
        t = r[i]; i += 1
        kl, i = varint(r, i); k = r[i:i+kl]; i += kl
        if t == 1:
            vl, i = varint(r, i); v = r[i:i+vl]; i += vl
            state[k.decode()] = (seq, v.decode('utf-8', 'replace'))
        else:
            state[k.decode()] = (seq, None)
for k, (seq, v) in sorted(state.items()):
    print(f"{k} (seq {seq}) = {v if v is None or len(v) < 300 else v[:300] + '...'}")
