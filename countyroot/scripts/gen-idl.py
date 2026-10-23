#!/usr/bin/env python3
"""Generate sdk/idl/countyroot.json without the anchor CLI.

Runs the same IDL-build tests the anchor CLI runs (`cargo test --features idl-build
__anchor_private_print_idl`) and assembles their output the way `anchor idl build` does.
Usage: scripts/gen-idl.py [--check]   (--check: exit 1 if the committed IDL differs)
"""
import json, os, re, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROG = os.path.join(ROOT, "programs", "countyroot")
OUT = os.path.join(ROOT, "sdk", "idl", "countyroot.json")

def run():
    env = dict(os.environ, ANCHOR_IDL_BUILD_PROGRAM_PATH=PROG,
               ANCHOR_IDL_BUILD_RESOLUTION="TRUE", ANCHOR_IDL_BUILD_SKIP_LINT="TRUE")
    r = subprocess.run(["cargo", "test", "--features", "idl-build", "__anchor_private_print_idl", "--lib",
                        "--", "--show-output", "--quiet", "--test-threads", "1"], cwd=PROG, env=env,
                       capture_output=True, text=True)
    if r.returncode: sys.stderr.write(r.stderr); sys.exit(r.returncode)
    return r.stdout

def strip(o):
    if isinstance(o, dict): return {k: strip(v) for k, v in o.items()}
    if isinstance(o, list): return [strip(v) for v in o]
    if isinstance(o, str): return re.sub(r"^countyroot::", "", o)
    return o

def assemble(out):
    secs = re.findall(r"--- IDL begin (\w+) ---\n(.*?)\n--- IDL end \1 ---", out, re.S)
    prog, events, types, errors, address = None, [], {}, [], None
    for kind, body in secs:
        if kind == "address":
            address = body.strip()
            while address.startswith('"'): address = json.loads(address)
        elif kind == "errors": errors = json.loads(body)
        elif kind == "program": prog = json.loads(body)
        elif kind == "event":
            e = json.loads(body); events.append(e["event"])
            for t in e["types"]: types[t["name"]] = t
    for t in prog.get("types", []): types[t["name"]] = t
    idl = {"address": address, "metadata": prog["metadata"], "instructions": prog["instructions"]}
    if prog.get("accounts"): idl["accounts"] = prog["accounts"]
    idl["events"] = sorted(events, key=lambda e: e["name"])
    idl["errors"] = errors
    idl["types"] = sorted(types.values(), key=lambda t: t["name"])
    if prog.get("constants"): idl["constants"] = prog["constants"]
    return strip(idl)

if __name__ == "__main__":
    idl = assemble(run())
    try: old = json.load(open(OUT))
    except Exception: old = {}
    idl["metadata"] = {**idl["metadata"], **{k: v for k, v in old.get("metadata", {}).items() if k in ("description", "repository")}}
    text = json.dumps(idl, indent=2) + "\n"
    if "--check" in sys.argv:
        same = json.load(open(OUT)) == json.loads(text)
        print("IDL up to date" if same else "IDL differs"); sys.exit(0 if same else 1)
    open(OUT, "w").write(text); print("wrote", OUT)
