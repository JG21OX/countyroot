#!/usr/bin/env python3
"""Build the --meta file for scripts/migrate_v2.mjs (county-level provenance for migrated roots).

Every date comes from a file in the data workspace; nothing is estimated. For each county with a
v2 root in <root>/stage/v2-all, the v1 packet the v2 root was derived from (derived_from.packet +
packet_sha256) is looked up:

  fetched_at, in order of preference:
    1. tar member mtime   - the exact packet CSV (sha256 checked) inside a build archive
                            (tar mtimes are UTC epoch seconds). The packet is written by the same
                            build run that downloaded the source, so this is the end of that fetch.
    2. zip member time    - same, from a zip; DOS times carry no zone, so this is only used when a
                            git commit in --git-repo that adds the county's post script, minutes
                            later, pins the zone (UTC-5 build host).
  Archives of re-written packets are skipped (REWRITE_ARCHIVES): their mtimes are when an
  existing download was re-encoded (PII fix), not when the source was fetched.
  A county with neither has fetched_at null and is listed under "missing" (migrate_v2 refuses it).
  Batch notes such as "pulled 2026-10-14" give the day only: they go in fetched_on (with
  fetched_at_precision "day") and are NOT turned into a time; for a county that also has an
  archive time they are kept as corroboration.

  data_as_of: a full YYYY-MM-DD the batch file states for the source data ("published",
  "data updated", "data last edit"); month-only values are not used. Only kept if <= fetched_at.

Output: county-level fields only (label, source URL/query, dates, record count). No parcel rows,
names or addresses. Write it outside public/.

usage: python3 scripts/build_meta.py --root <data dir> --out <meta.json> [--git-repo .]
"""
import argparse, collections, datetime as dt, hashlib, json, os, re, subprocess, sys, tarfile, zipfile

UTC = dt.timezone.utc
ISO = lambda t: dt.datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
URL = re.compile(r"https://[^\s,)]+")

def sha_stream(f):
    h = hashlib.sha256()
    for ch in iter(lambda: f.read(1 << 20), b""): h.update(ch)
    return h.hexdigest()

def counties(root):
    base = os.path.join(root, "stage", "v2-all"); out = {}
    for lab in sorted(os.listdir(base)):
        rj = [f for f in os.listdir(os.path.join(base, lab)) if f.endswith(".root.json")]
        if len(rj) != 1: sys.exit(f"{lab}: expected one root.json")
        d = json.load(open(os.path.join(base, lab, rj[0])))
        out[lab] = {"key": d["label"], "fips": d["fips"], "epoch": d["epoch"], "packet": d["derived_from"]["packet"],
                    "packet_sha256": d["derived_from"]["packet_sha256"], "n_parcels": d["n_parcels"]}
    return out

REWRITE_ARCHIVES = {"cr-pii-fix.tar"}

def archives(root):
    for dp, _, fn in os.walk(root):
        if "node_modules" in dp: continue
        for f in sorted(fn):
            if f.endswith((".tar", ".tgz", ".tar.gz", ".zip")) and f not in REWRITE_ARCHIVES: yield os.path.join(dp, f)

def archive_times(root, cs, git_repo):
    want = collections.defaultdict(list)
    for lab, c in cs.items(): want[c["packet"]].append(lab)
    found = collections.defaultdict(list)
    for p in archives(root):
        rel = os.path.relpath(p, root)
        try:
            if p.endswith(".zip"):
                with zipfile.ZipFile(p) as z:
                    for i in z.infolist():
                        for lab in want.get(os.path.basename(i.filename), []):
                            with z.open(i) as f: ok = sha_stream(f) == cs[lab]["packet_sha256"]
                            if ok: found[lab].append(("zip", rel, i.filename, i.date_time))
            else:
                with tarfile.open(p) as t:
                    for m in t:
                        for lab in want.get(os.path.basename(m.name), []):
                            ok = sha_stream(t.extractfile(m)) == cs[lab]["packet_sha256"]
                            if ok: found[lab].append(("tar", rel, m.name, m.mtime))
        except (tarfile.TarError, zipfile.BadZipFile, OSError) as e:
            print(f"warn: {rel}: {e}", file=sys.stderr)
    res = {}
    for lab, hits in found.items():
        tars = sorted([h for h in hits if h[0] == "tar"], key=lambda h: h[3])
        if tars:
            k, rel, name, mt = tars[0]
            res[lab] = (ISO(mt), f"tar member mtime: {rel}!{name} (sha256 = packet_sha256)")
            continue
        for k, rel, name, d6 in hits:   # zip: need a zone from git
            naive = dt.datetime(*d6)
            commit = git_post_commit(git_repo, lab) if git_repo else None
            if not commit: continue
            ct, h = commit
            local = naive.replace(tzinfo=ct.tzinfo)
            if dt.timedelta(0) <= ct - local <= dt.timedelta(minutes=30):
                res[lab] = (local.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                            f"zip member time: {rel}!{name} (sha256 = packet_sha256), zone from git commit {h} at {ct.isoformat()}")
    return res

def git_post_commit(repo, lab):
    name = "post_" + re.sub(r"(?<=[a-z])(?=[A-Z])", "_", lab.split(".")[0]).lower() + "_" + lab.split(".")[1].lower() + ".mjs"
    try:
        out = subprocess.run(["git", "-C", repo, "log", "--all", "--diff-filter=A", "--format=%h %aI", "--", name],
                             capture_output=True, text=True, check=True).stdout.split()
    except (subprocess.CalledProcessError, FileNotFoundError): return None
    return (dt.datetime.fromisoformat(out[-1]), out[-2]) if out else None

def batch_info(root):
    info = {}
    b = json.load(open(os.path.join(root, "batch_51_285.json")))
    for c in b["counties"]:
        info[c["label"]] = {"file": "batch_51_285.json", "url": c.get("source"), "published": c.get("published"), "raw_rows": c.get("raw_rows")}
    b = json.load(open(os.path.join(root, "batch_11_50_tx.json")))
    for c in b["counties"]:
        info[c["label"]] = {"file": "batch_11_50_tx.json", "url": c.get("source_url"), "published": c.get("source_date"),
                            "raw_rows": (c.get("drops") or {}).get("raw_rows")}
    b = json.load(open(os.path.join(root, "batch_11_50_other.json")))
    for lab, c in b["counties"].items():
        info[lab] = {"file": "batch_11_50_other.json", "url": c.get("source"), "published": c.get("source"), "raw_rows": None}
    return info

def data_as_of(text):
    if not text: return None
    for pat in (r"(?:data updated|data last edit|data last edited|service updated|edited) (\d{4}-\d{2}-\d{2})(?!-)", r"published (\d{4}-\d{2}-\d{2})", r"^(\d{4}-\d{2}-\d{2}) \("):
        m = re.search(pat, text)
        if m: return m.group(1) + "T00:00:00Z", m.group(0)
    return None

def split_url(s):
    if not s: return None, None
    m = URL.search(s)
    if not m: return None, None
    q = re.search(r"\(([^)]*)\)\s*$", s[m.end():].strip() or "")
    return m.group(0), (q.group(1) if q and re.search(r"=|1=1", q.group(1)) else None)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--root", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--git-repo", default=None); a = ap.parse_args()
    root = os.path.abspath(a.root); out = os.path.abspath(a.out)
    if f"{os.sep}public{os.sep}" in out + os.sep: sys.exit("refusing to write meta.json under public/")
    cs = counties(root); times = archive_times(root, cs, a.git_repo); bi = batch_info(root)
    meta, missing, src_count = {}, [], collections.Counter()
    for lab, c in cs.items():
        b = bi.get(lab, {}); url, query = split_url(b.get("url"))
        v1 = os.path.join(root, "packets", lab, c["packet"].replace(".csv", ".root.json"))
        if os.path.exists(v1) and isinstance(json.load(open(v1)).get("source"), str):   # rebuilt packets name their own source
            url, query = split_url(json.load(open(v1))["source"])
        e = {"county_label": lab, "fips": c["fips"], "epoch": c["epoch"], "source_url": url, "source_query": query,
             "source_format": None, "fetched_at": None, "fetched_at_source": None, "data_as_of": None, "data_as_of_source": None,
             "source_record_count": b.get("raw_rows")}
        pulled = re.search(r"pulled (\d{4}-\d{2}-\d{2})", (b.get("url") or "") + " " + (b.get("published") or ""))
        e["fetched_on"] = pulled.group(1) if pulled else None
        e["fetched_at_precision"] = None
        if lab in times:
            e["fetched_at"], e["fetched_at_source"] = times[lab]
            src_count[e["fetched_at_source"].split(":")[0]] += 1; e["fetched_at_precision"] = "second"
            if pulled: e["fetched_at_source"] += f"; corroborated by {b['file']} \"{pulled.group(0)}\""
        elif pulled:
            missing.append(lab); src_count["batch note, day only (fetched_on)"] += 1; e["fetched_at_precision"] = "day"
            e["fetched_at_source"] = f"{b['file']}: \"{pulled.group(0)}\" (day only; no time recorded, so fetched_at stays null)"
        else:
            missing.append(lab); src_count["none"] += 1
        d = data_as_of(b.get("published"))
        bound = e["fetched_at"] or (e["fetched_on"] + "T23:59:59Z" if e["fetched_on"] else None)
        if d and (bound is None or d[0] <= bound):
            e["data_as_of"], e["data_as_of_source"] = d[0], f"{b['file']}: \"{d[1]}\" (day precision)"
        meta[c["key"]] = e
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump({"generated_by": "scripts/build_meta.py", "counties": len(meta), "fetched_at_sources": dict(src_count),
               "missing_fetched_at": missing}, open(out.replace(".json", ".summary.json"), "w"), indent=1)
    json.dump(meta, open(out, "w"), indent=1, sort_keys=True)
    print(json.dumps({"counties": len(meta), "fetched_at_sources": dict(src_count), "missing": len(missing),
                      "data_as_of": sum(1 for e in meta.values() if e["data_as_of"])}))

if __name__ == "__main__": main()
