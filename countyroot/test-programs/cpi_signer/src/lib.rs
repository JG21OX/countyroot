use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction}, program::invoke_signed, pubkey::Pubkey,
};

entrypoint!(process);

// accounts[0] = target program, accounts[1..] = target accounts (in order).
// data = target instruction data. The vault PDA ([b"vault"], this program) is marked signer.
fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (vault, bump) = Pubkey::find_program_address(&[b"vault"], program_id);
    let target = &accounts[0];
    let metas = accounts[1..]
        .iter()
        .map(|a| AccountMeta {
            pubkey: *a.key,
            is_signer: a.is_signer || *a.key == vault,
            is_writable: a.is_writable,
        })
        .collect();
    let ix = Instruction { program_id: *target.key, accounts: metas, data: data.to_vec() };
    invoke_signed(&ix, &accounts[1..], &[&[b"vault", &[bump]]])
}
