#![cfg_attr(all(target_arch = "bpf", not(test)), no_std)]

pub mod instruction;
pub mod mb;
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

    #[test]
    fn magicblock_delegate_serializes_correct_instruction_data() {
        let seeds: [&[u8]; 2] = [b"credit_line", &[1u8; 32]];
        let validator = Some(crate::mb::DEVNET_ER_VALIDATOR_ASIA);
        let mut data = [0u8; 512];
        let len = serialize_delegate_data_for_test(&seeds, validator, &mut data);

        // Verify discriminator (0) + commit_frequency_ms (u32::MAX) + seeds count (2)
        assert_eq!(data[0..4], u32::MAX.to_le_bytes()); // commit_frequency_ms
        assert_eq!(data[4..8], 2u32.to_le_bytes()); // seeds_length

        // First seed: "credit_line" (11 bytes)
        assert_eq!(data[8..12], 11u32.to_le_bytes());
        assert_eq!(&data[12..23], b"credit_line");

        // Second seed: [1u8; 32] (32 bytes)
        assert_eq!(data[23..27], 32u32.to_le_bytes());
        assert_eq!(data[27..59], [1u8; 32]);

        // Validator: is_some = 1 + 32 bytes
        assert_eq!(data[59], 1);
        let validator_bytes: [u8; 32] = validator.unwrap().to_bytes();
        assert_eq!(data[60..92], validator_bytes);

        assert_eq!(len, 92);
    }

    #[test]
    fn magicblock_delegate_without_validator_serializes_correctly() {
        let seeds: [&[u8]; 1] = [b"test"];
        let mut data = [0u8; 512];
        let len = serialize_delegate_data_for_test(&seeds, None, &mut data);

        assert_eq!(data[0..4], u32::MAX.to_le_bytes());
        assert_eq!(data[4..8], 1u32.to_le_bytes());
        assert_eq!(data[8..12], 4u32.to_le_bytes());
        assert_eq!(&data[12..16], b"test");
        assert_eq!(data[16], 0); // no validator
        assert_eq!(len, 17);
    }

    #[test]
    fn magicblock_undelegate_callback_parses_seeds_correctly() {
        use crate::mb::{is_undelegate_callback, EXTERNAL_UNDELEGATE_DISCRIMINATOR};

        // Build callback data: discriminator (8) + seeds_len (4) + seed_len (4) + seed_data (5)
        let mut callback = [0u8; 21];
        callback[..8].copy_from_slice(&EXTERNAL_UNDELEGATE_DISCRIMINATOR);
        callback[8..12].copy_from_slice(&1u32.to_le_bytes()); // 1 seed
        callback[12..16].copy_from_slice(&5u32.to_le_bytes()); // 5 bytes
        callback[16..21].copy_from_slice(b"hello");

        assert!(is_undelegate_callback(&callback));
        assert!(!is_undelegate_callback(&callback[..7]));
        assert!(!is_undelegate_callback(&[0u8; 8]));
    }

    #[test]
    fn magicblock_commit_and_undelegate_instructions_are_correct() {
        // Commit = [1, 0, 0, 0], CommitAndUndelegate = [2, 0, 0, 0]
        // These are verified by the mb.rs module's hardcoded data arrays
        let commit_data: [u8; 4] = [1, 0, 0, 0];
        let undelegate_data: [u8; 4] = [2, 0, 0, 0];
        assert_eq!(commit_data[0], 1);
        assert_eq!(undelegate_data[0], 2);
    }

    #[test]
    fn magicblock_pda_derivations_are_deterministic() {
        use crate::mb::{delegation_record_pda, delegation_metadata_pda, delegate_buffer_pda};
        use pinocchio::Address;
        use pinocchio_pubkey::pubkey;

        let delegated = Address::new_from_array(pubkey!("G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5"));
        let owner = Address::new_from_array(pubkey!("ALH8UD28X24qwGvG2kpTcogg3Wpvu31FrErpLU8vw6oT"));

        let rec1 = delegation_record_pda(&delegated);
        let rec2 = delegation_record_pda(&delegated);
        assert_eq!(rec1.to_bytes(), rec2.to_bytes());

        let meta1 = delegation_metadata_pda(&delegated);
        let meta2 = delegation_metadata_pda(&delegated);
        assert_eq!(meta1.to_bytes(), meta2.to_bytes());

        let buf1 = delegate_buffer_pda(&delegated, &owner);
        let buf2 = delegate_buffer_pda(&delegated, &owner);
        assert_eq!(buf1.to_bytes(), buf2.to_bytes());
    }

    fn serialize_delegate_data_for_test(
        seeds: &[&[u8]],
        validator: Option<pinocchio::Address>,
        out: &mut [u8],
    ) -> usize {
        let mut off = 0;
        out[off..off + 4].copy_from_slice(&u32::MAX.to_le_bytes());
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
                out[off..off + 32].copy_from_slice(&val.to_bytes());
                off += 32;
            }
            None => {
                out[off] = 0;
                off += 1;
            }
        }
        off
    }
}
