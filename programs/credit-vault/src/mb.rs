use core::mem::MaybeUninit;
use pinocchio::{
    address::MAX_SEEDS,
    cpi::{invoke_signed, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_pubkey::pubkey;

pub const DELEGATION_PROGRAM_ID: Address =
    Address::new_from_array(pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMRRSaeSh"));
pub const MAGIC_PROGRAM_ID: Address =
    Address::new_from_array(pubkey!("Magic11111111111111111111111111111111111111"));
pub const MAGIC_CONTEXT_ID: Address =
    Address::new_from_array(pubkey!("MagicContext1111111111111111111111111111111"));
pub const SYSTEM_PROGRAM_ID: Address =
    Address::new_from_array(pubkey!("11111111111111111111111111111111111111111"));

pub const EXTERNAL_UNDELEGATE_DISCRIMINATOR: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];
pub const DEVNET_ER_VALIDATOR_ASIA: Address =
    Address::new_from_array(pubkey!("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"));
pub const DEVNET_ER_VALIDATOR_TEE: Address =
    Address::new_from_array(pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"));

const BUFFER: &[u8] = b"buffer";
const DELEGATION: &[u8] = b"delegation";
const DELEGATION_METADATA: &[u8] = b"delegation-metadata";

pub fn is_undelegate_callback(data: &[u8]) -> bool {
    data.len() >= 8 && data[..8] == EXTERNAL_UNDELEGATE_DISCRIMINATOR
}

pub fn delegation_record_pda(delegated: &Address) -> Address {
    let (addr, _) = Address::find_program_address(&[DELEGATION, delegated.as_array()], &DELEGATION_PROGRAM_ID);
    addr
}

pub fn delegation_metadata_pda(delegated: &Address) -> Address {
    let (addr, _) = Address::find_program_address(&[DELEGATION_METADATA, delegated.as_array()], &DELEGATION_PROGRAM_ID);
    addr
}

pub fn delegate_buffer_pda(delegated: &Address, owner: &Address) -> Address {
    let (addr, _) = Address::find_program_address(&[BUFFER, delegated.as_array()], owner);
    addr
}

fn sys_create_account(
    from: &AccountView,
    to: &AccountView,
    lamports: u64,
    space: u64,
    owner: &Address,
    signers: &[Signer<'_, '_>],
) -> ProgramResult {
    let mut data = [0u8; 52];
    data[..4].copy_from_slice(&0u32.to_le_bytes());
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&space.to_le_bytes());
    data[20..52].copy_from_slice(owner.as_array());
    let metas = [
        InstructionAccount::writable_signer(from.address()),
        InstructionAccount::writable(to.address()),
    ];
    let ix = InstructionView {
        program_id: &SYSTEM_PROGRAM_ID,
        accounts: &metas,
        data: &data,
    };
    let accs: [&AccountView; 2] = [from, to];
    invoke_signed::<2, &AccountView>(&ix, &accs, signers)
}

fn sys_assign(account: &AccountView, owner: &Address, signers: &[Signer<'_, '_>]) -> ProgramResult {
    let mut data = [0u8; 36];
    data[..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(owner.as_array());
    let metas = [InstructionAccount::writable_signer(account.address())];
    let ix = InstructionView {
        program_id: &SYSTEM_PROGRAM_ID,
        accounts: &metas,
        data: &data,
    };
    let accs: [&AccountView; 1] = [account];
    invoke_signed::<1, &AccountView>(&ix, &accs, signers)
}

fn serialize_delegate_data(seeds: &[&[u8]], validator: Option<Address>, out: &mut [u8]) -> usize {
    let mut off = 0;
    out[off..off + 4].copy_from_slice(&u32::MAX.to_le_bytes()); // commit_frequency_ms
    off += 4;
    out[off..off + 4].copy_from_slice(&(seeds.len() as u32).to_le_bytes());
    off += 4;
    for seed in seeds {
        out[off..off + 4].copy_from_slice(&(seed.len() as u32).to_le_bytes());
        off += 4;
        out[off..off + seed.len()].copy_from_slice(seed);
        off += seed.len();
    }
    match &validator {
        Some(val) => {
            out[off] = 1;
            off += 1;
            out[off..off + 32].copy_from_slice(val.as_array());
            off += 32;
        }
        None => {
            out[off] = 0;
            off += 1;
        }
    }
    off
}

pub fn delegate_account(
    accounts: &mut [AccountView],
    seeds: &[&[u8]],
    bump: u8,
    validator: Option<Address>,
) -> ProgramResult {
    let [payer, pda_acc, owner_program, buffer_acc, delegation_record, delegation_metadata, system_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let pda_key = pda_acc.address();
    let (_, buffer_bump) =
        Address::find_program_address(&[BUFFER, pda_key.as_array()], owner_program.address());
    let buffer_bump_arr = [buffer_bump];
    let buffer_seeds = [
        Seed::from(BUFFER),
        Seed::from(pda_key.as_array()),
        Seed::from(&buffer_bump_arr),
    ];
    let buffer_signer = Signer::from(&buffer_seeds);

    let data_len = pda_acc.data_len();
    sys_create_account(
        payer,
        buffer_acc,
        0,
        data_len as u64,
        owner_program.address(),
        &[buffer_signer],
    )?;

    {
        let src = pda_acc.try_borrow()?;
        let mut dst = buffer_acc.try_borrow_mut()?;
        dst.copy_from_slice(&src);
    }
    {
        let mut pda = pda_acc.try_borrow_mut()?;
        for b in pda.iter_mut().take(data_len) {
            *b = 0;
        }
    }

    let bump_arr = [bump];
    let num_seeds = seeds.len() + 1;
    if num_seeds > MAX_SEEDS {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut seed_buf: [MaybeUninit<Seed>; MAX_SEEDS] =
        unsafe { MaybeUninit::uninit().assume_init() };
    for (i, s) in seeds.iter().enumerate() {
        seed_buf[i].write(Seed::from(*s));
    }
    seed_buf[seeds.len()].write(Seed::from(&bump_arr[..]));
    let seeds_slice =
        unsafe { core::slice::from_raw_parts(seed_buf.as_ptr() as *const Seed, num_seeds) };
    let delegate_signer = Signer::from(seeds_slice);

    sys_assign(pda_acc, &SYSTEM_PROGRAM_ID, &[delegate_signer.clone()])?;
    sys_assign(
        pda_acc,
        &DELEGATION_PROGRAM_ID,
        &[delegate_signer.clone()],
    )?;

    let mut args_data = [0u8; 512];
    let args_len = serialize_delegate_data(seeds, validator, &mut args_data);

    let mut data = [0u8; 520];
    data[..8].copy_from_slice(&0u64.to_le_bytes()); // discriminator = Delegate
    data[8..8 + args_len].copy_from_slice(&args_data[..args_len]);
    let total_len = 8 + args_len;

    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable_signer(pda_acc.address()),
        InstructionAccount::readonly(owner_program.address()),
        InstructionAccount::writable(buffer_acc.address()),
        InstructionAccount::writable(delegation_record.address()),
        InstructionAccount::writable(delegation_metadata.address()),
        InstructionAccount::readonly(&SYSTEM_PROGRAM_ID),
    ];
    let ix = InstructionView {
        program_id: &DELEGATION_PROGRAM_ID,
        accounts: &metas,
        data: &data[..total_len],
    };
    let accs: [&AccountView; 7] = [
        payer,
        pda_acc,
        owner_program,
        buffer_acc,
        delegation_record,
        delegation_metadata,
        system_program,
    ];
    invoke_signed::<7, &AccountView>(&ix, &accs, &[delegate_signer])?;

    // Close buffer to reclaim lamports
    payer.set_lamports(payer.lamports() + buffer_acc.lamports());
    buffer_acc.set_lamports(0);

    Ok(())
}

pub fn commit_accounts(accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, committed_acc, magic_program, magic_context] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let data: [u8; 4] = [1, 0, 0, 0];
    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable(committed_acc.address()),
        InstructionAccount::readonly(magic_program.address()),
        InstructionAccount::writable(magic_context.address()),
    ];
    let ix = InstructionView {
        program_id: magic_program.address(),
        accounts: &metas,
        data: &data,
    };
    let accs: [&AccountView; 4] = [payer, committed_acc, magic_program, magic_context];
    invoke_signed::<4, &AccountView>(&ix, &accs, &[])
}

pub fn commit_and_undelegate(accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, committed_acc, magic_program, magic_context] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let data: [u8; 4] = [2, 0, 0, 0];
    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable(committed_acc.address()),
        InstructionAccount::readonly(magic_program.address()),
        InstructionAccount::writable(magic_context.address()),
    ];
    let ix = InstructionView {
        program_id: magic_program.address(),
        accounts: &metas,
        data: &data,
    };
    let accs: [&AccountView; 4] = [payer, committed_acc, magic_program, magic_context];
    invoke_signed::<4, &AccountView>(&ix, &accs, &[])
}

pub fn undelegate_callback(
    accounts: &mut [AccountView],
    owner_program: &Address,
    mut callback_args: &[u8],
) -> ProgramResult {
    let [delegated_account, buffer, payer, _system_program] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !buffer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let read_u32 = |args: &mut &[u8]| -> Result<u32, ProgramError> {
        if args.len() < 4 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let val = u32::from_le_bytes([args[0], args[1], args[2], args[3]]);
        *args = &args[4..];
        Ok(val)
    };

    let seeds_len = read_u32(&mut callback_args)? as usize;
    if seeds_len == 0 || seeds_len > 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut seed_refs: [&[u8]; 16] = [&[]; 16];
    for i in 0..seeds_len {
        let len = read_u32(&mut callback_args)? as usize;
        if callback_args.len() < len {
            return Err(ProgramError::InvalidInstructionData);
        }
        seed_refs[i] = &callback_args[..len];
        callback_args = &callback_args[len..];
    }

    let (_, bump) = Address::find_program_address(&seed_refs[..seeds_len], owner_program);
    let bump_arr = [bump];
    let mut seed_buf: [MaybeUninit<Seed>; MAX_SEEDS] =
        unsafe { MaybeUninit::uninit().assume_init() };
    for (i, s) in seed_refs[..seeds_len].iter().enumerate() {
        seed_buf[i].write(Seed::from(*s));
    }
    seed_buf[seeds_len].write(Seed::from(&bump_arr[..]));
    let seeds_slice = unsafe {
        core::slice::from_raw_parts(seed_buf.as_ptr() as *const Seed, seeds_len + 1)
    };
    let signer = Signer::from(seeds_slice);

    let space = buffer.data_len() as u64;
    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(space as usize)?;
    sys_create_account(payer, delegated_account, lamports, space, owner_program, &[signer])?;

    let mut data = delegated_account.try_borrow_mut()?;
    let buf_data = buffer.try_borrow()?;
    data.copy_from_slice(&buf_data);
    Ok(())
}
