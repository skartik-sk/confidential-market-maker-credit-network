use pinocchio::error::ProgramError;

pub type PubkeyBytes = [u8; 32];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PrivacyPolicy {
    PublicNotes = 0,
    UmbraPrivateSettlement = 1,
    ArciumPrivateRisk = 2,
    UmbraArcium = 3,
    MagicBlockPrivateEr = 4,
}

impl PrivacyPolicy {
    pub fn from_u8(value: u8) -> Result<Self, ProgramError> {
        match value {
            0 => Ok(Self::PublicNotes),
            1 => Ok(Self::UmbraPrivateSettlement),
            2 => Ok(Self::ArciumPrivateRisk),
            3 => Ok(Self::UmbraArcium),
            4 => Ok(Self::MagicBlockPrivateEr),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitializePoolArgs {
    pub bump: u8,
    pub privacy_policy: PrivacyPolicy,
    pub underwriter: PubkeyBytes,
    pub auditor: PubkeyBytes,
    pub reserve_mint: PubkeyBytes,
    pub vault: PubkeyBytes,
    pub note_size_usd: u64,
    pub total_limit_notes: u32,
    pub interest_bps: u16,
    pub maturity_slot: u64,
    pub receipt_interval_slots: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApproveCreditLineArgs {
    pub borrower: PubkeyBytes,
    pub limit_notes: u32,
    pub terms_hash: PubkeyBytes,
    pub mandate_hash: PubkeyBytes,
    pub opened_slot: u64,
    pub maturity_slot: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawTrancheArgs {
    pub notes: u32,
    pub current_slot: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RepayTrancheArgs {
    pub notes: u32,
    pub current_slot: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PostReceiptArgs {
    pub period_start_slot: u64,
    pub period_end_slot: u64,
    pub accepted_slot: u64,
    pub receipt_hash: PubkeyBytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleMaturityArgs {
    pub current_slot: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PauseLineArgs {
    pub target_status: crate::state::LineStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreditVaultInstruction {
    InitializePool(InitializePoolArgs),
    ApproveCreditLine(ApproveCreditLineArgs),
    DrawTranche(DrawTrancheArgs),
    RepayTranche(RepayTrancheArgs),
    PostReceipt(PostReceiptArgs),
    SettleMaturity(SettleMaturityArgs),
    PauseLine(PauseLineArgs),
    DelegateCreditLine,
    CommitCreditLine,
    CommitAndUndelegateCreditLine,
}

impl CreditVaultInstruction {
    pub fn unpack(input: &[u8]) -> Result<Self, ProgramError> {
        let (tag, rest) = input
            .split_first()
            .ok_or(ProgramError::InvalidInstructionData)?;
        let mut cursor = Cursor::new(rest);

        match *tag {
            0 => Ok(Self::InitializePool(InitializePoolArgs {
                bump: cursor.read_u8()?,
                privacy_policy: PrivacyPolicy::from_u8(cursor.read_u8()?)?,
                underwriter: cursor.read_pubkey()?,
                auditor: cursor.read_pubkey()?,
                reserve_mint: cursor.read_pubkey()?,
                vault: cursor.read_pubkey()?,
                note_size_usd: cursor.read_u64()?,
                total_limit_notes: cursor.read_u32()?,
                interest_bps: cursor.read_u16()?,
                maturity_slot: cursor.read_u64()?,
                receipt_interval_slots: cursor.read_u64()?,
            })),
            1 => Ok(Self::ApproveCreditLine(ApproveCreditLineArgs {
                borrower: cursor.read_pubkey()?,
                limit_notes: cursor.read_u32()?,
                terms_hash: cursor.read_pubkey()?,
                mandate_hash: cursor.read_pubkey()?,
                opened_slot: cursor.read_u64()?,
                maturity_slot: cursor.read_u64()?,
            })),
            2 => Ok(Self::DrawTranche(DrawTrancheArgs {
                notes: cursor.read_u32()?,
                current_slot: cursor.read_u64()?,
            })),
            3 => Ok(Self::RepayTranche(RepayTrancheArgs {
                notes: cursor.read_u32()?,
                current_slot: cursor.read_u64()?,
            })),
            4 => Ok(Self::PostReceipt(PostReceiptArgs {
                period_start_slot: cursor.read_u64()?,
                period_end_slot: cursor.read_u64()?,
                accepted_slot: cursor.read_u64()?,
                receipt_hash: cursor.read_pubkey()?,
            })),
            5 => Ok(Self::SettleMaturity(SettleMaturityArgs {
                current_slot: cursor.read_u64()?,
            })),
            6 => Ok(Self::PauseLine(PauseLineArgs {
                target_status: crate::state::LineStatus::from_u8(cursor.read_u8()?)?,
            })),
            7 => Ok(Self::DelegateCreditLine),
            8 => Ok(Self::CommitCreditLine),
            9 => Ok(Self::CommitAndUndelegateCreditLine),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

struct Cursor<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    const fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn read_u8(&mut self) -> Result<u8, ProgramError> {
        let value = *self
            .data
            .get(self.offset)
            .ok_or(ProgramError::InvalidInstructionData)?;
        self.offset += 1;
        Ok(value)
    }

    fn read_u16(&mut self) -> Result<u16, ProgramError> {
        let mut bytes = [0u8; 2];
        bytes.copy_from_slice(self.read_exact(2)?);
        Ok(u16::from_le_bytes(bytes))
    }

    fn read_u32(&mut self) -> Result<u32, ProgramError> {
        let mut bytes = [0u8; 4];
        bytes.copy_from_slice(self.read_exact(4)?);
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_u64(&mut self) -> Result<u64, ProgramError> {
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(self.read_exact(8)?);
        Ok(u64::from_le_bytes(bytes))
    }

    fn read_pubkey(&mut self) -> Result<PubkeyBytes, ProgramError> {
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(self.read_exact(32)?);
        Ok(bytes)
    }

    fn read_exact(&mut self, len: usize) -> Result<&'a [u8], ProgramError> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let slice = self
            .data
            .get(self.offset..end)
            .ok_or(ProgramError::InvalidInstructionData)?;
        self.offset = end;
        Ok(slice)
    }
}
