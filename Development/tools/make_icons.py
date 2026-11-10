#!/usr/bin/env python3
"""Render the Autoplay Stopper icon (play symbol inside a red prohibition sign) to PNGs.

Pure stdlib: analytic shapes + supersampling, written with zlib/struct.
"""
import math
import struct
import sys
import zlib

OUT = sys.argv[1]

R_OUT = 0.48      # outer radius of ring
RING = 0.095      # ring thickness
R_IN = R_OUT - RING
SLASH = 0.085      # slash thickness
GAP = 0.03       # white knockout around slash where it crosses the triangle
TRI = [(0.355, 0.245), (0.355, 0.755), (0.79, 0.50)]
TRI_ROUND = 0.025

PALETTES = {
    "": {"ring": (0xE0, 0x35, 0x2B), "fill": (0xFF, 0xFF, 0xFF), "tri": (0x2B, 0x2B, 0x2E)},
    "-off": {"ring": (0x9A, 0x9A, 0x9E), "fill": (0xF4, 0xF4, 0xF5), "tri": (0x8A, 0x8A, 0x8E)},
}


def tri_sdf(px, py):
    """Signed distance to the (rounded) triangle; negative inside."""
    # shrink triangle by TRI_ROUND toward centroid, then subtract radius for rounded corners
    cx = sum(p[0] for p in TRI) / 3
    cy = sum(p[1] for p in TRI) / 3
    pts = []
    for (x, y) in TRI:
        dx, dy = x - cx, y - cy
        d = math.hypot(dx, dy)
        k = (d - TRI_ROUND * 2) / d
        pts.append((cx + dx * k, cy + dy * k))
    d_min = float("inf")
    inside = True
    for i in range(3):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % 3]
        ex, ey = bx - ax, by - ay
        wx, wy = px - ax, py - ay
        t = max(0.0, min(1.0, (wx * ex + wy * ey) / (ex * ex + ey * ey)))
        qx, qy = ax + ex * t - px, ay + ey * t - py
        d_min = min(d_min, math.hypot(qx, qy))
        cross = ex * wy - ey * wx
        if cross > 0:
            inside = False
    # winding: our points go top-left, bottom-left, right => counter-clockwise on screen (y down)
    return (-d_min if inside else d_min) - TRI_ROUND * 2 * 0.5


def sample(x, y, pal):
    dx, dy = x - 0.5, y - 0.5
    d = math.hypot(dx, dy)
    if d > R_OUT:
        return None
    if d > R_IN:
        return pal["ring"]
    # distance to the "\" diagonal through center: line direction (1,1)/sqrt2
    ld = abs(dx - dy) / math.sqrt(2)
    if ld < SLASH / 2:
        return pal["ring"]
    if tri_sdf(x, y) < 0:
        if ld < SLASH / 2 + GAP:
            return pal["fill"]
        return pal["tri"]
    return pal["fill"]


def render(size, pal):
    global RING, SLASH, GAP, R_IN
    if size <= 16:
        RING, SLASH, GAP = 0.125, 0.115, 0.0
    elif size <= 32:
        RING, SLASH, GAP = 0.105, 0.095, 0.03
    else:
        RING, SLASH, GAP = 0.095, 0.085, 0.03
    R_IN = R_OUT - RING
    ss = 8 if size <= 32 else 4
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            r = g = b = a = 0.0
            for sj in range(ss):
                for si in range(ss):
                    x = (i + (si + 0.5) / ss) / size
                    y = (j + (sj + 0.5) / ss) / size
                    c = sample(x, y, pal)
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            n = ss * ss
            if a:
                row += bytes([round(r / a), round(g / a), round(b / a), round(255 * a / n)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(t, data):
        c = struct.pack(">I", len(data)) + t + data
        return c + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return png


for suffix, pal in PALETTES.items():
    sizes = [16, 32, 48, 128] if suffix == "" else [16, 32]
    for s in sizes:
        with open(f"{OUT}/icon{s}{suffix}.png", "wb") as f:
            f.write(render(s, pal))
print("ok")
