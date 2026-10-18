// countyroot.com/verify page logic. No third-party code; everything runs in the browser.
import { verifyParcel, fetchCountyRoot, lookupKey } from "./cr-verify.js";

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") e.className = v; else if (k.startsWith("data-")) e.setAttribute(k, v); else e[k] = v; }
  for (const k of kids) e.append(k);
  return e;
};
const explorer = (addr, cluster) => `https://explorer.solana.com/address/${addr}?cluster=${cluster}`;
const date = (ts) => (ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");

let cfg, counties = [];
async function getJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }

async function init() {
  [cfg, { counties }] = await Promise.all([getJson("/verify/config.json"), getJson("/verify/counties.json")]);
  const sel = $("county"); sel.textContent = "";
  sel.append(el("option", { value: "", textContent: "Choose a county…" }));
  const byState = new Map();
  for (const c of counties) { if (!byState.has(c.state)) byState.set(c.state, []); byState.get(c.state).push(c); }
  for (const st of [...byState.keys()].sort()) {
    const g = el("optgroup", { label: st });
    for (const c of byState.get(st).sort((a, b) => a.display.localeCompare(b.display)))
      g.append(el("option", { value: c.label, textContent: `${c.display} · ${c.city} · epoch ${c.epoch}` }));
    sel.append(g);
  }
  const q = new URLSearchParams(location.search);
  if (q.get("c")) sel.value = q.get("c");
  if (q.get("p")) $("parcel").value = q.get("p");
  $("go").disabled = false;
  $("f").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  if (sel.value && $("parcel").value) run();
}

function proofLoader(c) {
  const base = `${cfg.packets}/${c.label}/${c.label}.${c.epoch}.${c.month}.proofs/`;
  return async (name) => {
    const r = await fetch(base + name, name.endsWith("index.json") ? { cache: "no-cache" } : {}); // revalidate small index files
    if (r.status === 404 || r.status === 403) throw Object.assign(new Error(`missing ${name}`), { notFound: true });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    if (!name.endsWith(".json")) return { bytes: new Uint8Array(await r.arrayBuffer()) };
    const json = await r.json();
    if (name === "index.json") { lastIndex = { label: c.label, types: json.alias_types || [] }; showAliasHint(c); }
    return { json };
  };
}

function showAliasHint(c) {
  const h = $("hint"); if (!h) return;
  h.textContent = lastIndex && lastIndex.types.length ? `${c.display} also accepts: ${lastIndex.types.map((t) => t.label).join(", ")} (a lookup alias; the proof is on the parcel ID).` : "";
}

async function run() {
  const c = counties.find((x) => x.label === $("county").value), pid = $("parcel").value;
  const out = $("out"), status = $("status");
  out.textContent = ""; out.dataset.state = "running";
  if (!c || !lookupKey(pid)) { status.textContent = "Choose a county and enter a parcel ID."; out.dataset.state = "idle"; return; }
  history.replaceState(null, "", `?c=${encodeURIComponent(c.label)}&p=${encodeURIComponent(pid.trim())}`);
  $("go").disabled = true; status.textContent = "Fetching proof files and the on-chain root…";
  const t0 = performance.now();
  try {
    const res = await verifyParcel({ county: c, parcelId: pid, load: proofLoader(c), onchain: (cc) => fetchCountyRoot(cfg.rpc, cc.pda) });
    render(c, pid, res);
    status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
  } catch (e) {
    out.dataset.state = e.notFound ? "unpublished" : "error";
    out.append(el("div", { class: "banner bad", textContent: e.notFound
      ? `Proof files for ${c.display} epoch ${c.epoch} aren't published yet. You can still verify with the full parcel list and the CountyRoot SDK.`
      : `Could not verify: ${e.message}` }));
    status.textContent = "";
  } finally { $("go").disabled = false; }
}

function anchorBanner(c, a) {
  const link = el("a", { href: explorer(c.pda, cfg.cluster), textContent: "Open the account on Solana Explorer", rel: "noopener", target: "_blank" });
  if (a.kind === "onchain" && a.ok && !a.problems.length)
    return el("div", { class: "banner ok", "data-anchor": "onchain" }, `Compared with the on-chain root (Solana ${cfg.cluster}, finalized): status active, posted ${date(a.postedAt)}, ${a.nParcels.toLocaleString()} parcels. `, link);
  if (a.kind === "onchain")
    return el("div", { class: `banner ${a.ok ? "amber" : "bad"}`, "data-anchor": "onchain-problem" }, `On-chain check: ${a.problems.join("; ")}. `, link);
  if (a.kind === "onchain-missing")
    return el("div", { class: "banner bad", "data-anchor": "onchain-missing" }, "No CountyRoot account was found on-chain for this county and epoch. ", ...(c.leaf_version === 2 ? [`Epoch ${c.epoch} is this county's new format-v2 fingerprint and may not be posted yet; until it is, this result is not anchored. Earlier epochs are listed on the `, el("a", { href: `/archive/${encodeURIComponent(c.label)}.html`, textContent: "archive page" }), ". "] : []), link);
  return el("div", { class: "banner amber", "data-anchor": "published" }, `Solana could not be reached (${a.note.replace(/^on-chain check unavailable: /, "")}). Compared with the fingerprint published on this site instead. Confirm the root yourself: `, link);
}

let lastIndex = null;
const aliasLabels = (c) => (lastIndex && lastIndex.label === c.label && lastIndex.types.length ? lastIndex.types.map((t) => t.label).join(" or ") : "");

function render(c, pid, res) {
  const out = $("out");
  out.append(anchorBanner(c, res.anchor));
  if (!res.found) {
    out.dataset.state = "notfound";
    const box = el("div", { class: "result bad", "data-ok": "false" }, el("div", { class: "verdict", textContent: "Not found" }),
      el("p", { textContent: `No parcel with ID "${pid.trim()}" is in ${c.display} epoch ${c.epoch} (${c.n_parcels.toLocaleString()} parcels), even ignoring case, spaces, dashes, dots and leading zeros${res.resolution && aliasLabels(c) ? `, or as a ${aliasLabels(c)}` : ""}.` }));
    const ab = res.absence;
    if (ab) {
      // v2 only: the fingerprint is sorted by normalized ID, so two adjacent verified leaves prove the gap.
      const nb = (r) => (r ? `${r.parcel_id} (leaf ${(r.index + 1).toLocaleString()})` : null);
      const around = [nb(ab.left), nb(ab.right)].filter(Boolean).join(" and ");
      box.append(el("p", { class: "note", "data-absence": ab.ok ? "proven" : "unproven", textContent: ab.ok
        ? `${res.anchor.kind === "published" ? "Absence matches the published fingerprint" : "Absence proven on-chain"}: the fingerprint is sorted by normalized parcel ID, and ${around} are adjacent in it and both verify, so no parcel ID normalizing to "${ab.key}" is in this epoch.`
        : `Absence could not be proven: ${ab.reason}.` }));
    }
    const sug = res.suggestions || [];
    if (sug.length) {
      const ul = el("ul", { class: "sugg", "data-suggestions": String(sug.length) });
      for (const id of sug) ul.append(el("li", {}, el("a", { href: `?c=${encodeURIComponent(c.label)}&p=${encodeURIComponent(id)}`, textContent: id, "data-sugg": id })));
      box.append(el("p", { class: "note", textContent: `Parcel IDs in this county that start with what you typed${sug.length >= 10 ? " (first 10)" : ""}:` }), ul);
    }
    out.append(box);
    return;
  }
  const rz = res.resolution;
  if (rz && rz.mode !== "exact") {
    const ids = [...new Set(rz.matches.map((m) => m.id))];
    const how = rz.matches.map((m) => (m.via === "normalized" ? `${m.id} (same ID written without case, spaces, dashes, dots or leading zeros)` : `${m.id} (${m.via} ${rz.typed} → parcel ID ${m.id})`));
    out.append(el("div", { class: "banner amber", "data-resolved": rz.mode, "data-matched": ids.join(" ") },
      `You typed ${rz.typed}; matched ${how.join("; ")}.` + (ids.length > 1 ? " More than one parcel matches, so each is shown." : "") +
      (rz.mode === "alias" ? " Aliases are a lookup convenience from the county's public records; they are NOT part of the on-chain fingerprint. The proof below is on the parcel ID." : "")));
  }
  const allOk = res.rows.every((r) => r.ok);
  out.dataset.state = allOk ? "verified" : res.rows.some((r) => r.ok) ? "partial" : "failed";
  if (res.rows.length > 1) out.append(el("p", { class: "note", textContent: `This ID appears on ${res.rows.length} rows of the packet (the county lists it more than once). Each row is checked separately.` }));
  for (const r of res.rows) {
    const dl = el("dl");
    const add = (k, v) => dl.append(el("dt", { textContent: k }), el("dd", { textContent: v }));
    add("Parcel ID", r.parcel_id);
    if (r.via) add("Found via", r.via === "normalized" ? "normalized ID (not part of the fingerprint)" : `${r.via} (lookup alias, not part of the fingerprint)`); add("Acres", r.acres); add("Lot sq ft", r.lot_sqft);
    if (res.leafVersion === 2) {
      add("Leaf", `${(r.index + 1).toLocaleString()} of ${c.n_parcels.toLocaleString()} (fingerprint format v2: sorted by parcel ID, bound to FIPS ${c.fips} and epoch ${c.epoch})`);
      if (r.occ) add("Repeat", `row ${r.occ + 1} with this exact ID (the county lists it more than once)`);
    } else add("CSV line", `${r.row.toLocaleString()} (header is line 1) · leaf ${(r.index + 1).toLocaleString()} of ${c.n_parcels.toLocaleString()}`);
    if (r.leaf) add(res.leafVersion === 2 ? "Leaf hash" : "Leaf", r.leaf);
    if (r.computed) add("Computed root", r.computed);
    add(res.anchor.kind === "published" ? "Published root" : "On-chain root", res.anchor.root ?? c.merkle_root);
    add("County / epoch", `${c.display} (FIPS ${c.fips}) · epoch ${c.epoch} · ${c.month}`);
    const box = el("div", { class: `result ${r.ok ? "ok" : "bad"}`, "data-ok": String(r.ok), "data-row": String(r.row ?? r.index + 1) },
      el("div", { class: "verdict", textContent: r.ok ? (res.anchor.kind === "published" ? "✓ Matches the published fingerprint" : "✓ Verified on-chain") : "✗ Not verified" }));
    if (!r.ok) box.append(el("p", { class: "note", textContent: r.reason }));
    box.append(dl);
    if (r.ok) {
      const proof = res.leafVersion === 2 ? r.proof : { parcel_id: r.parcel_id, acres: r.acres, lot_sqft: r.lot_sqft, ...r.proof };
      const blob = new Blob([JSON.stringify(proof, null, 2) + "\n"], { type: "application/json" });
      box.append(el("p", { class: "note" }, el("a", { href: URL.createObjectURL(blob), download: `${c.label}.${c.epoch}.${res.leafVersion === 2 ? `leaf${r.index + 1}` : `row${r.row}`}.proof.json`, textContent: "Download this proof" }),
        " (works with the SDK: ", el("code", { textContent: "countyroot verify --root <root.json> --proof <file>" }), ")"));
    }
    out.append(box);
  }
}

init().catch((e) => { $("status").textContent = `Could not load the county list: ${e.message}`; });
