//! LiteSVM tests for parcel_gate: real Devnet snapshot accounts, roots posted by the real
//! CountyRoot program (devnet build), compute units and transaction sizes.
#[path = "../../../crates/countyroot-verify/tests/common/mod.rs"]
mod common;
use base64::Engine;
use common::*;
use countyroot_verify::*;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const GATE_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy/parcel_gate.so");
const CR_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot-devnet.so");
const SYS: Pubkey = Pubkey::new_from_array([0; 32]);

fn gate_id() -> Pubkey { Pubkey::new_from_array([7; 32]) }

fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(gate_id(), GATE_SO).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    (svm, payer)
}

fn args(p: &P) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend(p.fips.to_le_bytes()); d.extend(p.index.to_le_bytes()); d.extend(p.occ.to_le_bytes());
    d.extend(p.acres.to_le_bytes()); d.extend(p.sqft.to_le_bytes());
    d.extend((p.id.len() as u16).to_le_bytes()); d.extend(&p.id);
    d.push(p.sibs.len() as u8); for s in &p.sibs { d.extend(s); }
    d
}

fn gate_ix(tag: u8, p: &P, payer: &Pubkey) -> Instruction {
    let (root, _) = county_root_address(p.fips, p.epoch);
    let (head, _) = county_head_address(p.fips);
    let mut accounts = vec![AccountMeta::new_readonly(root, false), AccountMeta::new_readonly(head, false)];
    let mut data = vec![tag];
    if tag != 0 { data.extend(args(p)); }
    if tag == 2 {
        let leaf = leaf_hash(p.fips, &p.row()).unwrap();
        let (rc, _) = Pubkey::find_program_address(&[b"receipt", &p.fips.to_le_bytes(), &leaf], &gate_id());
        accounts.extend([AccountMeta::new(*payer, true), AccountMeta::new(rc, false), AccountMeta::new_readonly(SYS, false)]);
    }
    Instruction { program_id: gate_id(), accounts, data }
}

/// Returns (Ok(cu) | Err(custom code or debug string), serialized tx size).
fn run(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> (Result<u64, String>, usize) {
    svm.expire_blockhash();
    let tx = Transaction::new(&[payer], Message::new(&[ix], Some(&payer.pubkey())), svm.latest_blockhash());
    let size = bincode::serialize(&tx).unwrap().len();
    match svm.send_transaction(tx) {
        Ok(m) => (Ok(m.compute_units_consumed), size),
        Err(e) => (Err(format!("{:?}", e.err)), size),
    }
}
fn custom(e: VerifyError) -> String { format!("InstructionError(0, Custom({}))", e.code()) }

fn load_snapshot(svm: &mut LiteSVM) {
    let snap = fixture("devnet-accounts.json");
    for (k, v) in snap.as_object().unwrap() {
        if k.starts_with('_') { continue; }
        let addr: Pubkey = v["address"].as_str().unwrap().parse().unwrap();
        let data = base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap()).unwrap();
        svm.set_account(addr, Account { lamports: v["lamports"].as_u64().unwrap(), data, owner: PROGRAM_ID, executable: false, rent_epoch: 0 }).unwrap();
    }
}

#[test]
fn live_snapshot_real_proofs_cu_and_size() {
    let (mut svm, payer) = setup();
    load_snapshot(&mut svm);
    let real = fixture("real-proofs.json");
    let mut worst = (0u64, 0usize);
    for (county, c) in real.as_object().unwrap() {
        for pv in c["proofs"].as_array().unwrap() {
            let p = P::from(pv);
            let (base, _) = run(&mut svm, &payer, gate_ix(0, &p, &payer.pubkey()));
            let (cu, size) = run(&mut svm, &payer, gate_ix(1, &p, &payer.pubkey()));
            let net = cu.clone().unwrap() - base.unwrap();
            println!("{county} index {} id_len {} siblings {}: verify {net} CU (tx {cu:?} total), tx {size} bytes", p.index, p.id.len(), p.sibs.len());
            assert!(net < 15_000, "{county}: {net} CU");
            worst = worst.max((net, size));
            // wrong acreage fails with RootMismatch
            let mut bad = P::from(pv); bad.acres ^= 1;
            assert_eq!(run(&mut svm, &payer, gate_ix(1, &bad, &payer.pubkey())).0, Err(custom(VerifyError::RootMismatch)));
        }
    }
    println!("worst real verify: {} CU, largest tx {} bytes", worst.0, worst.1);
    // receipt path on the largest county
    let la = P::from(&real["LosAngeles.CA"]["proofs"][0]);
    let (cu, size) = run(&mut svm, &payer, gate_ix(2, &la, &payer.pubkey()));
    println!("LA verify+receipt: {cu:?} CU total, tx {size} bytes");
    let leaf = leaf_hash(la.fips, &la.row()).unwrap();
    let (rc, _) = Pubkey::find_program_address(&[b"receipt", &la.fips.to_le_bytes(), &leaf], &gate_id());
    let acct = svm.get_account(&rc).unwrap();
    assert_eq!(acct.owner, gate_id());
    assert_eq!(&acct.data[0..4], &6037u32.to_le_bytes());
    assert_eq!(&acct.data[4..8], &2u32.to_le_bytes());
    assert_eq!(&acct.data[8..40], &leaf);
}

/// Worst case the format allows in one transaction: 256-byte id, as many siblings as fit.
#[test]
fn worst_case_size_and_cu() {
    let (mut svm, payer) = setup();
    for depth in [22usize, 24, 26, 28, 32] {
        let id = vec![b'X'; MAX_ID_LEN];
        let fips = 6037;
        let p = P { fips, epoch: 9, n: 1u64 << depth, index: (1u64 << depth) - 1, id, occ: 7, acres: 1, sqft: 2,
            sibs: (0..depth).map(|i| [i as u8 + 1; 32]).collect() };
        let leaf = leaf_hash(fips, &p.row()).unwrap();
        let top = match fold(leaf, &p.proof(), p.n) { Ok(t) => t, Err(_) => { println!("depth {depth}: n not representable, skip"); continue; } };
        let root = root_hash(fips, 9, p.n, &top);
        let (ra, rd) = root_data(fips, 9, p.n, root, STATUS_ACTIVE);
        let (ha, hd) = head_data(fips, 9, 9);
        for (a, d) in [(ra, rd), (ha, hd)] {
            svm.set_account(a, Account { lamports: 10_000_000, data: d, owner: PROGRAM_ID, executable: false, rent_epoch: 0 }).unwrap();
        }
        let ix = gate_ix(1, &p, &payer.pubkey());
        let tx = Transaction::new(&[&payer], Message::new(&[ix.clone()], Some(&payer.pubkey())), svm.latest_blockhash());
        let size = bincode::serialize(&tx).unwrap().len();
        if size > 1232 { println!("depth {depth}, id 256: tx {size} bytes > 1232, does not fit"); continue; }
        let (base, _) = run(&mut svm, &payer, gate_ix(0, &p, &payer.pubkey()));
        let (cu, _) = run(&mut svm, &payer, ix);
        let net = cu.clone().expect("verify") - base.unwrap();
        println!("depth {depth}, id 256: verify {net} CU, tx {size} bytes");
        assert!(net < 15_000);
    }
}

// ---- roots posted through the real CountyRoot program ----
fn disc(name: &str) -> [u8; 8] { solana_sha256_hasher::hashv(&[name.as_bytes()]).to_bytes()[..8].try_into().unwrap() }

#[test]
fn real_program_post_supersede_retract() {
    let (mut svm, payer) = setup();
    svm.add_program_from_file(PROGRAM_ID, CR_SO).unwrap();
    let attestor = &payer;
    let (config, _) = Pubkey::find_program_address(&[b"config"], &PROGRAM_ID);
    let mut d = disc("global:init_config").to_vec(); d.extend(attestor.pubkey().to_bytes());
    let ix = Instruction { program_id: PROGRAM_ID, data: d, accounts: vec![
        AccountMeta::new(config, false), AccountMeta::new(payer.pubkey(), true), AccountMeta::new_readonly(SYS, false)] };
    run(&mut svm, &payer, ix).0.expect("init_config");

    let fips = 90001u32; // test-only county code
    let ids: Vec<String> = (0..37).map(|i| format!("P-{i:04}")).collect();
    let mk_tree = |epoch_salt: u64| {
        let rows: Vec<(Vec<u8>, u64)> = ids.iter().enumerate().map(|(i, s)| (s.as_bytes().to_vec(), i as u64 * 1000 + epoch_salt)).collect();
        let leaves: Vec<[u8; 32]> = rows.iter().map(|(id, a)| leaf_hash(fips, &ParcelRow { id, occ: 1, acres_micro: *a, sqft_centi: 0 }).unwrap()).collect();
        (rows, tree(&leaves))
    };
    let post = |svm: &mut LiteSVM, epoch: u32, top: [u8; 32], prev: Option<u32>| {
        let n = ids.len() as u64;
        let mut d = disc("global:post_root_v2").to_vec();
        d.extend(fips.to_le_bytes()); d.extend(epoch.to_le_bytes()); d.extend(n.to_le_bytes());
        d.extend(root_hash(fips, epoch, n, &top)); d.extend(SCHEMA_V2);
        d.extend([1u8; 32]); d.extend([2u8; 32]); d.extend([3u8; 32]);
        d.extend(1_760_000_000i64.to_le_bytes()); d.extend(1_760_100_000i64.to_le_bytes()); d.push(2);
        let prev_meta = match prev { Some(e) => AccountMeta::new(county_root_address(fips, e).0, false), None => AccountMeta::new_readonly(PROGRAM_ID, false) };
        let ix = Instruction { program_id: PROGRAM_ID, data: d, accounts: vec![
            AccountMeta::new_readonly(config, false), AccountMeta::new(county_head_address(fips).0, false),
            AccountMeta::new(county_root_address(fips, epoch).0, false), prev_meta,
            AccountMeta::new(payer.pubkey(), true), AccountMeta::new_readonly(SYS, false)] };
        run(svm, &payer, ix).0.expect("post_root_v2");
    };
    let proof_for = |rows: &Vec<(Vec<u8>, u64)>, lv: &Vec<Vec<[u8; 32]>>, epoch: u32, i: usize| P {
        fips, epoch, n: ids.len() as u64, index: i as u64, id: rows[i].0.clone(), occ: 1, acres: rows[i].1, sqft: 0, sibs: proof_of(lv, i) };

    let (r1, t1) = mk_tree(0);
    post(&mut svm, 1, t1.last().unwrap()[0], None);
    let p1 = proof_for(&r1, &t1, 1, 36);
    assert!(run(&mut svm, &payer, gate_ix(1, &p1, &payer.pubkey())).0.is_ok(), "e1 active");

    let (r2, t2) = mk_tree(5);
    post(&mut svm, 2, t2.last().unwrap()[0], Some(1));
    let p2 = proof_for(&r2, &t2, 2, 17);
    assert!(run(&mut svm, &payer, gate_ix(1, &p2, &payer.pubkey())).0.is_ok(), "e2 active");
    assert_eq!(run(&mut svm, &payer, gate_ix(1, &p1, &payer.pubkey())).0, Err(custom(VerifyError::Superseded)));

    let mut d = disc("global:retract_root_v2").to_vec(); d.push(3); // REASON_SOURCE_ERROR
    let ix = Instruction { program_id: PROGRAM_ID, data: d, accounts: vec![
        AccountMeta::new_readonly(config, false), AccountMeta::new(county_root_address(fips, 2).0, false),
        AccountMeta::new(county_head_address(fips).0, false), AccountMeta::new_readonly(payer.pubkey(), true)] };
    run(&mut svm, &payer, ix).0.expect("retract_root_v2");
    assert_eq!(run(&mut svm, &payer, gate_ix(1, &p2, &payer.pubkey())).0, Err(custom(VerifyError::Retracted)));
    let r = run(&mut svm, &payer, gate_ix(1, &p1, &payer.pubkey())).0;
    // e1 is SUPERSEDED and the head now has no active epoch.
    assert_eq!(r, Err(custom(VerifyError::NoActiveRoot)));
    // Receipt not written on failure
    assert!(run(&mut svm, &payer, gate_ix(2, &p2, &payer.pubkey())).0.is_err());
}
