#![cfg_attr(all(target_arch = "bpf", not(test)), no_std)]

pub mod instruction;
pub mod processor;
pub mod state;

#[cfg(feature = "bpf-entrypoint")]
mod entrypoint {
    use pinocchio::{entrypoint, AccountView, Address, ProgramResult};

    entrypoint!(process_instruction);

    pub fn process_instruction(
        program_id: &Address,
        accounts: &mut [AccountView],
        instruction_data: &[u8],
    ) -> ProgramResult {
        crate::processor::process_instruction(program_id, accounts, instruction_data)
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        instruction::{
            ApproveCreditLineArgs, DrawTrancheArgs, InitializePoolArgs, PauseLineArgs,
            PostReceiptArgs, PrivacyPolicy, RepayTrancheArgs, SettleMaturityArgs,
        },
        processor::{
            approve_credit_line_state, draw_tranche_state, initialize_pool_state, pause_line_state,
            post_receipt_state, repay_tranche_state, settle_maturity_state,
        },
        state::{CreditLineAccount, LineStatus, PoolAccount, ReceiptAccount},
    };
    use pinocchio::error::ProgramError;

    const ADMIN: [u8; 32] = [1; 32];
    const BORROWER: [u8; 32] = [2; 32];
    const UNDERWRITER: [u8; 32] = [3; 32];
    const AUDITOR: [u8; 32] = [4; 32];
    const RESERVE_MINT: [u8; 32] = [5; 32];
    const VAULT: [u8; 32] = [6; 32];
    const TERMS_HASH: [u8; 32] = [7; 32];
    const MANDATE_HASH: [u8; 32] = [8; 32];
    const RECEIPT_HASH: [u8; 32] = [9; 32];

    #[test]
    fn initializes_pool_and_approves_borrower_line() {
        let mut pool_data = [0u8; PoolAccount::LEN];
        let mut line_data = [0u8; CreditLineAccount::LEN];

        initialize_pool_state(
            &mut pool_data,
            ADMIN,
            InitializePoolArgs {
                bump: 251,
                privacy_policy: PrivacyPolicy::UmbraArcium,
                underwriter: UNDERWRITER,
                auditor: AUDITOR,
                reserve_mint: RESERVE_MINT,
                vault: VAULT,
                note_size_usd: 1_000,
                total_limit_notes: 100,
                interest_bps: 75,
                maturity_slot: 50_000,
                receipt_interval_slots: 150,
            },
        )
        .unwrap();

        approve_credit_line_state(
            &mut pool_data,
            &mut line_data,
            UNDERWRITER,
            ApproveCreditLineArgs {
                borrower: BORROWER,
                limit_notes: 30,
                terms_hash: TERMS_HASH,
                mandate_hash: MANDATE_HASH,
                opened_slot: 20_000,
                maturity_slot: 45_000,
            },
        )
        .unwrap();

        let pool = PoolAccount::unpack(&pool_data).unwrap();
        let line = CreditLineAccount::unpack(&line_data).unwrap();

        assert_eq!(pool.admin, ADMIN);
        assert_eq!(pool.allocated_limit_notes, 30);
        assert_eq!(line.status, LineStatus::Active);
        assert_eq!(line.pool, pool.pool_id());
        assert_eq!(line.borrower, BORROWER);
        assert_eq!(line.limit_notes, 30);
        assert_eq!(line.note_size_usd, 1_000);
        assert_eq!(line.privacy_policy, PrivacyPolicy::UmbraArcium);
    }

    #[test]
    fn draws_repays_and_defaults_only_outstanding_notes() {
        let (mut pool_data, mut line_data) = approved_line(10);

        draw_tranche_state(
            &mut pool_data,
            &mut line_data,
            BORROWER,
            DrawTrancheArgs {
                notes: 6,
                current_slot: 20_100,
            },
        )
        .unwrap();
        repay_tranche_state(
            &mut pool_data,
            &mut line_data,
            BORROWER,
            RepayTrancheArgs {
                notes: 2,
                current_slot: 20_500,
            },
        )
        .unwrap();
        settle_maturity_state(
            &mut pool_data,
            &mut line_data,
            SettleMaturityArgs {
                current_slot: 45_001,
            },
        )
        .unwrap();

        let pool = PoolAccount::unpack(&pool_data).unwrap();
        let line = CreditLineAccount::unpack(&line_data).unwrap();

        assert_eq!(pool.total_drawn_notes, 6);
        assert_eq!(pool.total_repaid_notes, 2);
        assert_eq!(pool.total_defaulted_notes, 4);
        assert_eq!(pool.outstanding_notes, 0);
        assert_eq!(line.defaulted_notes, 4);
        assert_eq!(line.status, LineStatus::Defaulted);
    }

    #[test]
    fn rejects_overdraw_and_unauthorized_receipt_signer() {
        let (mut pool_data, mut line_data) = approved_line(5);
        let mut receipt_data = [0u8; ReceiptAccount::LEN];

        assert_eq!(
            draw_tranche_state(
                &mut pool_data,
                &mut line_data,
                BORROWER,
                DrawTrancheArgs {
                    notes: 6,
                    current_slot: 20_100,
                }
            ),
            Err(ProgramError::InsufficientFunds)
        );

        assert_eq!(
            post_receipt_state(
                &mut line_data,
                &mut receipt_data,
                BORROWER,
                PostReceiptArgs {
                    period_start_slot: 20_100,
                    period_end_slot: 20_200,
                    accepted_slot: 20_201,
                    receipt_hash: RECEIPT_HASH,
                }
            ),
            Err(ProgramError::IncorrectAuthority)
        );

        post_receipt_state(
            &mut line_data,
            &mut receipt_data,
            AUDITOR,
            PostReceiptArgs {
                period_start_slot: 20_100,
                period_end_slot: 20_200,
                accepted_slot: 20_201,
                receipt_hash: RECEIPT_HASH,
            },
        )
        .unwrap();

        let receipt = ReceiptAccount::unpack(&receipt_data).unwrap();
        assert_eq!(receipt.signer, AUDITOR);
        assert_eq!(receipt.receipt_hash, RECEIPT_HASH);
    }

    #[test]
    fn rejects_reinitializing_pool_line_or_receipt_accounts() {
        let (mut pool_data, mut line_data) = approved_line(5);
        let mut receipt_data = [0u8; ReceiptAccount::LEN];

        assert_eq!(
            initialize_pool_state(
                &mut pool_data,
                ADMIN,
                InitializePoolArgs {
                    bump: 251,
                    privacy_policy: PrivacyPolicy::UmbraArcium,
                    underwriter: UNDERWRITER,
                    auditor: AUDITOR,
                    reserve_mint: RESERVE_MINT,
                    vault: VAULT,
                    note_size_usd: 1_000,
                    total_limit_notes: 100,
                    interest_bps: 75,
                    maturity_slot: 50_000,
                    receipt_interval_slots: 150,
                },
            ),
            Err(ProgramError::AccountAlreadyInitialized)
        );
        assert_eq!(
            approve_credit_line_state(
                &mut pool_data,
                &mut line_data,
                UNDERWRITER,
                ApproveCreditLineArgs {
                    borrower: BORROWER,
                    limit_notes: 1,
                    terms_hash: TERMS_HASH,
                    mandate_hash: MANDATE_HASH,
                    opened_slot: 20_000,
                    maturity_slot: 45_000,
                },
            ),
            Err(ProgramError::AccountAlreadyInitialized)
        );

        post_receipt_state(
            &mut line_data,
            &mut receipt_data,
            AUDITOR,
            PostReceiptArgs {
                period_start_slot: 20_100,
                period_end_slot: 20_200,
                accepted_slot: 20_201,
                receipt_hash: RECEIPT_HASH,
            },
        )
        .unwrap();
        assert_eq!(
            post_receipt_state(
                &mut line_data,
                &mut receipt_data,
                AUDITOR,
                PostReceiptArgs {
                    period_start_slot: 20_201,
                    period_end_slot: 20_300,
                    accepted_slot: 20_301,
                    receipt_hash: RECEIPT_HASH,
                },
            ),
            Err(ProgramError::AccountAlreadyInitialized)
        );
    }

    #[test]
    fn hot_paths_preserve_reserved_bytes_instead_of_repacking_whole_accounts() {
        let (mut pool_data, mut line_data) = approved_line(10);
        pool_data[PoolAccount::RESERVED_OFFSET..PoolAccount::LEN].fill(0xaa);
        line_data[CreditLineAccount::RESERVED_OFFSET..CreditLineAccount::LEN].fill(0xbb);

        draw_tranche_state(
            &mut pool_data,
            &mut line_data,
            BORROWER,
            DrawTrancheArgs {
                notes: 6,
                current_slot: 20_100,
            },
        )
        .unwrap();
        repay_tranche_state(
            &mut pool_data,
            &mut line_data,
            BORROWER,
            RepayTrancheArgs {
                notes: 2,
                current_slot: 20_500,
            },
        )
        .unwrap();
        post_receipt_state(
            &mut line_data,
            &mut [0u8; ReceiptAccount::LEN],
            AUDITOR,
            PostReceiptArgs {
                period_start_slot: 20_100,
                period_end_slot: 20_200,
                accepted_slot: 20_201,
                receipt_hash: RECEIPT_HASH,
            },
        )
        .unwrap();
        settle_maturity_state(
            &mut pool_data,
            &mut line_data,
            SettleMaturityArgs {
                current_slot: 45_001,
            },
        )
        .unwrap();

        assert!(pool_data[PoolAccount::RESERVED_OFFSET..PoolAccount::LEN]
            .iter()
            .all(|byte| *byte == 0xaa));
        assert!(
            line_data[CreditLineAccount::RESERVED_OFFSET..CreditLineAccount::LEN]
                .iter()
                .all(|byte| *byte == 0xbb)
        );
    }

    #[test]
    fn pause_blocks_draw_until_underwriter_reactivates() {
        let (mut pool_data, mut line_data) = approved_line(5);

        pause_line_state(
            &mut line_data,
            UNDERWRITER,
            PauseLineArgs {
                target_status: LineStatus::Paused,
            },
        )
        .unwrap();

        assert_eq!(
            draw_tranche_state(
                &mut pool_data,
                &mut line_data,
                BORROWER,
                DrawTrancheArgs {
                    notes: 1,
                    current_slot: 20_100,
                }
            ),
            Err(ProgramError::InvalidAccountData)
        );

        pause_line_state(
            &mut line_data,
            UNDERWRITER,
            PauseLineArgs {
                target_status: LineStatus::Active,
            },
        )
        .unwrap();
        draw_tranche_state(
            &mut pool_data,
            &mut line_data,
            BORROWER,
            DrawTrancheArgs {
                notes: 1,
                current_slot: 20_101,
            },
        )
        .unwrap();
    }

    fn approved_line(limit_notes: u32) -> ([u8; PoolAccount::LEN], [u8; CreditLineAccount::LEN]) {
        let mut pool_data = [0u8; PoolAccount::LEN];
        let mut line_data = [0u8; CreditLineAccount::LEN];
        initialize_pool_state(
            &mut pool_data,
            ADMIN,
            InitializePoolArgs {
                bump: 251,
                privacy_policy: PrivacyPolicy::UmbraArcium,
                underwriter: UNDERWRITER,
                auditor: AUDITOR,
                reserve_mint: RESERVE_MINT,
                vault: VAULT,
                note_size_usd: 1_000,
                total_limit_notes: 100,
                interest_bps: 75,
                maturity_slot: 50_000,
                receipt_interval_slots: 150,
            },
        )
        .unwrap();
        approve_credit_line_state(
            &mut pool_data,
            &mut line_data,
            UNDERWRITER,
            ApproveCreditLineArgs {
                borrower: BORROWER,
                limit_notes,
                terms_hash: TERMS_HASH,
                mandate_hash: MANDATE_HASH,
                opened_slot: 20_000,
                maturity_slot: 45_000,
            },
        )
        .unwrap();
        (pool_data, line_data)
    }
}
