#!/usr/bin/env python3
"""NOID: a stable, non-personal parcel ID for rows whose source parcel number is unusable (blank, or personal names).

    NOID-<first 16 hex of sha256(b"countyroot/geom/v1" || 0x00 || u32le fips || canonical_geometry)>

canonical_geometry (UTF-8 text), from the source's PUBLIC parcel outline only (never names, owners or addresses):
  1. Request the feature's geometry from the official source in WGS84 (outSR=4326).
  2. Every vertex -> integers (round-half-even(lon * 1e7), round-half-even(lat * 1e7)), i.e. 1e-7 degree (~1 cm).
  3. Each ring: drop consecutive duplicate vertices and the closing vertex; orient (shoelace on the integers)
     exterior rings counter-clockwise and holes clockwise; rotate to start at the smallest (x, y).
  4. Group rings into polygons (an exterior ring followed by the holes inside it, as the source lists them);
     sort holes within a polygon, then sort polygons, by their ring text.
  5. Ring text = "x y,x y,..."; polygon = rings joined by "/" (exterior first); geometry = polygons joined by ";".
Stable while the outline is unchanged; a resurvey gives a new NOID (arguably a new parcel). 64 bits: collision
chance within the largest county (2.4M parcels) ~1.6e-7; the builder still refuses duplicates.

Usage (packet builder step for rows that need a NOID):
    noid.py --layer <FeatureServer/MapServer layer URL> --field <id field> --fips N --oid <objectid> ...
Or from Python: noid(fips, esri_geometry_json_in_4326) -> (noid, canonical_text).
"""
import hashlib, json, struct, sys, urllib.request, urllib.parse

TAG = b"countyroot/geom/v1"

def _ring(pts):
    q = [(round(x * 1e7), round(y * 1e7)) for x, y in pts]
    out = []
    for p in q:
        if not out or out[-1] != p: out.append(p)
    if len(out) > 1 and out[0] == out[-1]: out.pop()
    return out

def _area2(r):
    return sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r)))

def _orient(r, ccw):
    if (_area2(r) > 0) != ccw: r = r[::-1]
    i = min(range(len(r)), key=lambda k: r[k])
    return r[i:] + r[:i]

def canonical(esri_geom):
    """esri_geom: {'rings': [[[lon, lat], ...], ...]} in EPSG:4326. Esri: exterior rings clockwise, holes counter-clockwise."""
    rings = [r for r in (_ring(x) for x in esri_geom.get("rings") or []) if len(r) >= 3]
    if not rings: raise ValueError("no polygon geometry")
    polys = []
    for r in rings:
        if _area2(r) < 0 or not polys:   # Esri exterior = clockwise = negative shoelace (y up)
            polys.append([_orient(r, True)])
        else:
            polys[-1].append(_orient(r, False))
    txt = lambda r: ",".join(f"{x} {y}" for x, y in r)
    polys = [[txt(p[0])] + sorted(txt(h) for h in p[1:]) for p in polys]
    return ";".join(sorted("/".join(p) for p in polys))

def noid(fips, esri_geom):
    c = canonical(esri_geom)
    h = hashlib.sha256(TAG + b"\x00" + struct.pack("<I", int(fips)) + c.encode()).hexdigest()
    return "NOID-" + h[:16].upper(), c

def fetch(layer, where=None, oid=None, oid_field="OBJECTID"):
    p = {"where": where or f"{oid_field}={int(oid)}", "outFields": oid_field, "returnGeometry": "true", "outSR": "4326", "f": "json"}
    req = urllib.request.Request(layer + "/query", urllib.parse.urlencode(p).encode(), headers={"User-Agent": "countyroot-noid"})
    d = json.load(urllib.request.urlopen(req, timeout=60))
    if "error" in d: raise RuntimeError(str(d["error"])[:200])
    return d["features"]

if __name__ == "__main__":
    import argparse
    a = argparse.ArgumentParser(); a.add_argument("--layer", required=True); a.add_argument("--fips", required=True, type=int)
    a.add_argument("--oid", type=int, nargs="+", required=True); a.add_argument("--oid-field", default="OBJECTID")
    o = a.parse_args()
    for oid in o.oid:
        for f in fetch(o.layer, oid=oid, oid_field=o.oid_field):
            n, c = noid(o.fips, f["geometry"]); print(oid, n, len(c))
