use crate::{
    instruction::{
        ApproveCreditLineArgs, CreditVaultInstruction, DrawTrancheArgs, InitializePoolArgs,
        PauseLineArgs, PostReceiptArgs, PubkeyBytes, RepayTrancheArgs, SettleMaturityArgs,
    },
    state::{
        active_line, active_pool, derived_pool_id, version, write_u32_at, write_u64_at,
        write_u8_at, CreditLineAccount, LineStatus, PoolAccount, PoolStatus, ReceiptAccount,
    },
};
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    match CreditVaultInstruction::unpack(instruction_data)? {
        CreditVaultInstruction::InitializePool(args) => {
            let admin_key = signer_key(accounts, 0)?;
            let pool_id = account_key(accounts, 1)?;
            let pool = account_mut(accounts, 1)?;
            require_owned_writable(pool, program_id)?;
            let mut pool_data = pool.try_borrow_mut()?;
            initialize_pool_with_id(&mut pool_data, admin_key, pool_id, args)
        }
        CreditVaultInstruction::ApproveCreditLine(args) => {
            let signer_key = signer_key(accounts, 0)?;
            let (pool, line) = two_accounts_mut(accounts, 1, 2)?;
            reject_duplicate(pool, line)?;
            require_owned_writable(pool, program_id)?;
            require_owned_writable(line, program_id)?;
            let mut pool_data = pool.try_borrow_mut()?;
            let mut line_data = line.try_borrow_mut()?;
            approve_credit_line_state(&mut pool_data, &mut line_data, signer_key, args)
        }
        CreditVaultInstruction::DrawTranche(args) => {
            let signer_key = signer_key(accounts, 0)?;
            let (pool, line) = two_accounts_mut(accounts, 1, 2)?;
            reject_duplicate(pool, line)?;
            require_owned_writable(pool, program_id)?;
            require_owned_writable(line, program_id)?;
            let mut pool_data = pool.try_borrow_mut()?;
            let mut line_data = line.try_borrow_mut()?;
            draw_tranche_state(&mut pool_data, &mut line_data, signer_key, args)
        }
        CreditVaultInstruction::RepayTranche(args) => {
            let signer_key = signer_key(accounts, 0)?;
            let (pool, line) = two_accounts_mut(accounts, 1, 2)?;
            reject_duplicate(pool, line)?;
            require_owned_writable(pool, program_id)?;
            require_owned_writable(line, program_id)?;
            let mut pool_data = pool.try_borrow_mut()?;
            let mut line_data = line.try_borrow_mut()?;
            repay_tranche_state(&mut pool_data, &mut line_data, signer_key, args)
        }
        CreditVaultInstruction::PostReceipt(args) => {
            let signer_key = signer_key(accounts, 0)?;
            let (line, receipt) = two_accounts_mut(accounts, 1, 2)?;
            reject_duplicate(line, receipt)?;
            require_owned_writable(line, program_id)?;
            require_owned_writable(receipt, program_id)?;
            let line_key = key(line);
            let mut line_data = line.try_borrow_mut()?;
            let mut receipt_data = receipt.try_borrow_mut()?;
            post_receipt_with_line_id(
                &mut line_data,
                &mut receipt_data,
                signer_key,
                line_key,
                args,
            )
        }
        CreditVaultInstruction::SettleMaturity(args) => {
            let (pool, line) = two_accounts_mut(accounts, 0, 1)?;
            reject_duplicate(pool, line)?;
            require_owned_writable(pool, program_id)?;
            require_owned_writable(line, program_id)?;
            let mut pool_data = pool.try_borrow_mut()?;
            let mut line_data = line.try_borrow_mut()?;
            settle_maturity_state(&mut pool_data, &mut line_data, args)
        }
        CreditVaultInstruction::PauseLine(args) => {
            let signer_key = signer_key(accounts, 0)?;
            let line = account_mut(accounts, 1)?;
            require_owned_writable(line, program_id)?;
            let mut line_data = line.try_borrow_mut()?;
            pause_line_state(&mut line_data, signer_key, args)
        }
    }
}

pub fn initialize_pool_state(
    pool_data: &mut [u8],
    admin: PubkeyBytes,
    args: InitializePoolArgs,
) -> ProgramResult {
    let pool_id = derived_pool_id(&admin, &args.reserve_mint, &args.vault);
    initialize_pool_with_id(pool_data, admin, pool_id, args)
}

pub fn initialize_pool_with_id(
    pool_data: &mut [u8],
    admin: PubkeyBytes,
    pool_id: PubkeyBytes,
    args: InitializePoolArgs,
) -> ProgramResult {
    if PoolAccount::is_initialized(pool_data) {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    require_nonzero_key(&admin)?;
    require_nonzero_key(&args.underwriter)?;
    require_nonzero_key(&args.auditor)?;
    require_nonzero_key(&args.reserve_mint)?;
    require_nonzero_key(&args.vault)?;
    require_positive_u64(args.note_size_usd)?;
    require_positive_u32(args.total_limit_notes)?;
    require_bps(args.interest_bps)?;
    if args.maturity_slot == 0 || args.receipt_interval_slots == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    PoolAccount {
        version: version(),
        bump: args.bump,
        status: PoolStatus::Active,
        pool_id,
        admin,
        underwriter: args.underwriter,
        auditor: args.auditor,
        reserve_mint: args.reserve_mint,
        vault: args.vault,
        note_size_usd: args.note_size_usd,
        total_limit_notes: args.total_limit_notes,
        allocated_limit_notes: 0,
        outstanding_notes: 0,
        total_drawn_notes: 0,
        total_repaid_notes: 0,
        total_defaulted_notes: 0,
        interest_bps: args.interest_bps,
        maturity_slot: args.maturity_slot,
        receipt_interval_slots: args.receipt_interval_slots,
        privacy_policy: args.privacy_policy,
    }
    .pack(pool_data)
}

pub fn approve_credit_line_state(
    pool_data: &mut [u8],
    line_data: &mut [u8],
    signer: PubkeyBytes,
    args: ApproveCreditLineArgs,
) -> ProgramResult {
    if CreditLineAccount::is_initialized(line_data) {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    require_nonzero_key(&args.borrower)?;
    require_positive_u32(args.limit_notes)?;
    let pool = PoolAccount::unpack(pool_data)?;
    active_pool(&pool)?;
    if signer != pool.underwriter {
        return Err(ProgramError::IncorrectAuthority);
    }
    if args.opened_slot >= args.maturity_slot || args.maturity_slot > pool.maturity_slot {
        return Err(ProgramError::InvalidInstructionData);
    }
    let next_allocated = pool
        .allocated_limit_notes
        .checked_add(args.limit_notes)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if next_allocated > pool.total_limit_notes {
        return Err(ProgramError::InsufficientFunds);
    }
    write_u32_at(
        pool_data,
        PoolAccount::ALLOCATED_LIMIT_NOTES_OFFSET,
        next_allocated,
    )?;

    CreditLineAccount {
        version: version(),
        status: LineStatus::Active,
        pool: pool.pool_id,
        borrower: args.borrower,
        underwriter: pool.underwriter,
        auditor: pool.auditor,
        limit_notes: args.limit_notes,
        drawn_notes: 0,
        repaid_notes: 0,
        defaulted_notes: 0,
        note_size_usd: pool.note_size_usd,
        interest_bps: pool.interest_bps,
        opened_slot: args.opened_slot,
        maturity_slot: args.maturity_slot,
        last_receipt_slot: args.opened_slot,
        terms_hash: args.terms_hash,
        mandate_hash: args.mandate_hash,
        privacy_policy: pool.privacy_policy,
    }
    .pack(line_data)
}

pub fn draw_tranche_state(
    pool_data: &mut [u8],
    line_data: &mut [u8],
    signer: PubkeyBytes,
    args: DrawTrancheArgs,
) -> ProgramResult {
    require_positive_u32(args.notes)?;
    let pool = PoolAccount::unpack(pool_data)?;
    let line = CreditLineAccount::unpack(line_data)?;
    active_pool(&pool)?;
    active_line(&line)?;
    ensure_line_in_pool(&pool, &line)?;
    if signer != line.borrower {
        return Err(ProgramError::IncorrectAuthority);
    }
    if args.current_slot >= line.maturity_slot {
        return Err(ProgramError::InvalidInstructionData);
    }
    let next_drawn = line
        .drawn_notes
        .checked_add(args.notes)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if next_drawn > line.limit_notes {
        return Err(ProgramError::InsufficientFunds);
    }
    let next_total_drawn = pool
        .total_drawn_notes
        .checked_add(args.notes)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let next_outstanding = pool
        .outstanding_notes
        .checked_add(args.notes)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    write_u32_at(line_data, CreditLineAccount::DRAWN_NOTES_OFFSET, next_drawn)?;
    write_u32_at(
        pool_data,
        PoolAccount::TOTAL_DRAWN_NOTES_OFFSET,
        next_total_drawn,
    )?;
    write_u32_at(
        pool_data,
        PoolAccount::OUTSTANDING_NOTES_OFFSET,
        next_outstanding,
    )
}

pub fn repay_tranche_state(
    pool_data: &mut [u8],
    line_data: &mut [u8],
    signer: PubkeyBytes,
    args: RepayTrancheArgs,
) -> ProgramResult {
    require_positive_u32(args.notes)?;
    let pool = PoolAccount::unpack(pool_data)?;
    let line = CreditLineAccount::unpack(line_data)?;
    active_pool(&pool)?;
    active_line(&line)?;
    ensure_line_in_pool(&pool, &line)?;
    if signer != line.borrower {
        return Err(ProgramError::IncorrectAuthority);
    }
    let outstanding = line.outstanding_notes()?;
    if args.notes > outstanding {
        return Err(ProgramError::InsufficientFunds);
    }
    let next_repaid = line
        .repaid_notes
        .checked_add(args.notes)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let next_total_repaid = pool
        .total_repaid_notes
        .checked_add(args.notes)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let next_pool_outstanding = pool
        .outstanding_notes
        .checked_sub(args.notes)
        .ok_or(ProgramError::InvalidAccountData)?;
    let next_line_outstanding = line
        .drawn_notes
        .checked_sub(next_repaid)
        .and_then(|value| value.checked_sub(line.defaulted_notes))
        .ok_or(ProgramError::InvalidAccountData)?;

    write_u32_at(
        line_data,
        CreditLineAccount::REPAID_NOTES_OFFSET,
        next_repaid,
    )?;
    if next_line_outstanding == 0 {
        write_u8_at(
            line_data,
            CreditLineAccount::STATUS_OFFSET,
            LineStatus::Closed as u8,
        )?;
    }
    write_u32_at(
        pool_data,
        PoolAccount::TOTAL_REPAID_NOTES_OFFSET,
        next_total_repaid,
    )?;
    write_u32_at(
        pool_data,
        PoolAccount::OUTSTANDING_NOTES_OFFSET,
        next_pool_outstanding,
    )
}

pub fn post_receipt_state(
    line_data: &mut [u8],
    receipt_data: &mut [u8],
    signer: PubkeyBytes,
    args: PostReceiptArgs,
) -> ProgramResult {
    let line_id = CreditLineAccount::unpack(line_data)?.pool;
    post_receipt_with_line_id(line_data, receipt_data, signer, line_id, args)
}

pub fn post_receipt_with_line_id(
    line_data: &mut [u8],
    receipt_data: &mut [u8],
    signer: PubkeyBytes,
    line_id: PubkeyBytes,
    args: PostReceiptArgs,
) -> ProgramResult {
    if ReceiptAccount::is_initialized(receipt_data) {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    require_nonzero_key(&args.receipt_hash)?;
    let line = CreditLineAccount::unpack(line_data)?;
    if signer != line.auditor && signer != line.underwriter {
        return Err(ProgramError::IncorrectAuthority);
    }
    if args.period_start_slot == 0
        || args.period_end_slot < args.period_start_slot
        || args.accepted_slot < args.period_end_slot
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    ReceiptAccount {
        version: version(),
        line: line_id,
        signer,
        period_start_slot: args.period_start_slot,
        period_end_slot: args.period_end_slot,
        accepted_slot: args.accepted_slot,
        receipt_hash: args.receipt_hash,
    }
    .pack(receipt_data)?;
    write_u64_at(
        line_data,
        CreditLineAccount::LAST_RECEIPT_SLOT_OFFSET,
        args.accepted_slot,
    )
}

pub fn settle_maturity_state(
    pool_data: &mut [u8],
    line_data: &mut [u8],
    args: SettleMaturityArgs,
) -> ProgramResult {
    let pool = PoolAccount::unpack(pool_data)?;
    let line = CreditLineAccount::unpack(line_data)?;
    active_pool(&pool)?;
    ensure_line_in_pool(&pool, &line)?;
    if args.current_slot <= line.maturity_slot {
        return Ok(());
    }
    let outstanding = line.outstanding_notes()?;
    if outstanding == 0 {
        return write_u8_at(
            line_data,
            CreditLineAccount::STATUS_OFFSET,
            LineStatus::Closed as u8,
        );
    }
    let next_defaulted_notes = line
        .defaulted_notes
        .checked_add(outstanding)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let next_total_defaulted = pool
        .total_defaulted_notes
        .checked_add(outstanding)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let next_pool_outstanding = pool
        .outstanding_notes
        .checked_sub(outstanding)
        .ok_or(ProgramError::InvalidAccountData)?;

    write_u32_at(
        line_data,
        CreditLineAccount::DEFAULTED_NOTES_OFFSET,
        next_defaulted_notes,
    )?;
    write_u8_at(
        line_data,
        CreditLineAccount::STATUS_OFFSET,
        LineStatus::Defaulted as u8,
    )?;
    write_u32_at(
        pool_data,
        PoolAccount::TOTAL_DEFAULTED_NOTES_OFFSET,
        next_total_defaulted,
    )?;
    write_u32_at(
        pool_data,
        PoolAccount::OUTSTANDING_NOTES_OFFSET,
        next_pool_outstanding,
    )
}

pub fn pause_line_state(
    line_data: &mut [u8],
    signer: PubkeyBytes,
    args: PauseLineArgs,
) -> ProgramResult {
    let line = CreditLineAccount::unpack(line_data)?;
    if signer != line.underwriter {
        return Err(ProgramError::IncorrectAuthority);
    }
    match args.target_status {
        LineStatus::Paused => {
            if line.status != LineStatus::Active {
                return Err(ProgramError::InvalidAccountData);
            }
            write_u8_at(
                line_data,
                CreditLineAccount::STATUS_OFFSET,
                LineStatus::Paused as u8,
            )
        }
        LineStatus::Active => {
            if line.status != LineStatus::Paused {
                return Err(ProgramError::InvalidAccountData);
            }
            write_u8_at(
                line_data,
                CreditLineAccount::STATUS_OFFSET,
                LineStatus::Active as u8,
            )
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    }
}

fn account(accounts: &mut [AccountView], index: usize) -> Result<&AccountView, ProgramError> {
    accounts
        .get(index)
        .ok_or(ProgramError::NotEnoughAccountKeys)
}

fn account_mut(
    accounts: &mut [AccountView],
    index: usize,
) -> Result<&mut AccountView, ProgramError> {
    accounts
        .get_mut(index)
        .ok_or(ProgramError::NotEnoughAccountKeys)
}

fn two_accounts_mut(
    accounts: &mut [AccountView],
    left_index: usize,
    right_index: usize,
) -> Result<(&mut AccountView, &mut AccountView), ProgramError> {
    if left_index == right_index {
        return Err(ProgramError::InvalidArgument);
    }
    let max_index = core::cmp::max(left_index, right_index);
    if accounts.len() <= max_index {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    if left_index < right_index {
        let (left_slice, right_slice) = accounts.split_at_mut(right_index);
        Ok((&mut left_slice[left_index], &mut right_slice[0]))
    } else {
        let (right_slice, left_slice) = accounts.split_at_mut(left_index);
        Ok((&mut left_slice[0], &mut right_slice[right_index]))
    }
}

fn require_owned_writable(account: &AccountView, program_id: &Address) -> ProgramResult {
    if !account.is_writable() {
        return Err(ProgramError::InvalidArgument);
    }
    if !account.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    Ok(())
}

fn reject_duplicate(left: &AccountView, right: &AccountView) -> ProgramResult {
    if left.address() == right.address() {
        return Err(ProgramError::InvalidArgument);
    }
    Ok(())
}

fn signer_key(accounts: &mut [AccountView], index: usize) -> Result<PubkeyBytes, ProgramError> {
    let account = account(accounts, index)?;
    if !account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(key(account))
}

fn account_key(accounts: &mut [AccountView], index: usize) -> Result<PubkeyBytes, ProgramError> {
    Ok(key(account(accounts, index)?))
}

fn key(account: &AccountView) -> PubkeyBytes {
    account.address().to_bytes()
}

fn require_nonzero_key(value: &PubkeyBytes) -> ProgramResult {
    if value.iter().all(|byte| *byte == 0) {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn require_positive_u32(value: u32) -> ProgramResult {
    if value == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn require_positive_u64(value: u64) -> ProgramResult {
    if value == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn require_bps(value: u16) -> ProgramResult {
    if value > 10_000 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn ensure_line_in_pool(pool: &PoolAccount, line: &CreditLineAccount) -> ProgramResult {
    if pool.pool_id != line.pool
        || pool.underwriter != line.underwriter
        || pool.auditor != line.auditor
        || pool.note_size_usd != line.note_size_usd
        || pool.interest_bps != line.interest_bps
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}
