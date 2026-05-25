use crate::instruction::{PrivacyPolicy, PubkeyBytes};
use pinocchio::error::ProgramError;

const POOL_DISCRIMINATOR: u8 = 0x51;
const LINE_DISCRIMINATOR: u8 = 0x52;
const RECEIPT_DISCRIMINATOR: u8 = 0x53;
const VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PoolStatus {
    Uninitialized = 0,
    Active = 1,
    Paused = 2,
}

impl PoolStatus {
    pub fn from_u8(value: u8) -> Result<Self, ProgramError> {
        match value {
            0 => Ok(Self::Uninitialized),
            1 => Ok(Self::Active),
            2 => Ok(Self::Paused),
            _ => Err(ProgramError::InvalidAccountData),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LineStatus {
    Uninitialized = 0,
    Active = 1,
    Closed = 2,
    Delinquent = 3,
    Defaulted = 4,
    Paused = 5,
}

impl LineStatus {
    pub fn from_u8(value: u8) -> Result<Self, ProgramError> {
        match value {
            0 => Ok(Self::Uninitialized),
            1 => Ok(Self::Active),
            2 => Ok(Self::Closed),
            3 => Ok(Self::Delinquent),
            4 => Ok(Self::Defaulted),
            5 => Ok(Self::Paused),
            _ => Err(ProgramError::InvalidAccountData),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolAccount {
    pub version: u8,
    pub bump: u8,
    pub status: PoolStatus,
    pub pool_id: PubkeyBytes,
    pub admin: PubkeyBytes,
    pub underwriter: PubkeyBytes,
    pub auditor: PubkeyBytes,
    pub reserve_mint: PubkeyBytes,
    pub vault: PubkeyBytes,
    pub note_size_usd: u64,
    pub total_limit_notes: u32,
    pub allocated_limit_notes: u32,
    pub outstanding_notes: u32,
    pub total_drawn_notes: u32,
    pub total_repaid_notes: u32,
    pub total_defaulted_notes: u32,
    pub interest_bps: u16,
    pub maturity_slot: u64,
    pub receipt_interval_slots: u64,
    pub privacy_policy: PrivacyPolicy,
}

impl PoolAccount {
    pub const LEN: usize = 1 + 1 + 1 + 1 + 32 * 6 + 8 + 4 * 6 + 2 + 8 + 8 + 1 + 32;
    pub const STATUS_OFFSET: usize = 3;
    pub const POOL_ID_OFFSET: usize = 4;
    pub const UNDERWRITER_OFFSET: usize = 68;
    pub const AUDITOR_OFFSET: usize = 100;
    pub const NOTE_SIZE_USD_OFFSET: usize = 196;
    pub const TOTAL_LIMIT_NOTES_OFFSET: usize = 204;
    pub const ALLOCATED_LIMIT_NOTES_OFFSET: usize = 208;
    pub const OUTSTANDING_NOTES_OFFSET: usize = 212;
    pub const TOTAL_DRAWN_NOTES_OFFSET: usize = 216;
    pub const TOTAL_REPAID_NOTES_OFFSET: usize = 220;
    pub const TOTAL_DEFAULTED_NOTES_OFFSET: usize = 224;
    pub const INTEREST_BPS_OFFSET: usize = 228;
    pub const MATURITY_SLOT_OFFSET: usize = 230;
    pub const PRIVACY_POLICY_OFFSET: usize = 246;
    pub const RESERVED_OFFSET: usize = 247;

    pub fn pool_id(&self) -> PubkeyBytes {
        self.pool_id
    }

    pub fn is_initialized(data: &[u8]) -> bool {
        data.first().copied() == Some(POOL_DISCRIMINATOR)
    }

    pub fn pack(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let mut cursor = Writer::new(data);
        cursor.write_u8(POOL_DISCRIMINATOR)?;
        cursor.write_u8(self.version)?;
        cursor.write_u8(self.bump)?;
        cursor.write_u8(self.status as u8)?;
        cursor.write_pubkey(&self.pool_id)?;
        cursor.write_pubkey(&self.admin)?;
        cursor.write_pubkey(&self.underwriter)?;
        cursor.write_pubkey(&self.auditor)?;
        cursor.write_pubkey(&self.reserve_mint)?;
        cursor.write_pubkey(&self.vault)?;
        cursor.write_u64(self.note_size_usd)?;
        cursor.write_u32(self.total_limit_notes)?;
        cursor.write_u32(self.allocated_limit_notes)?;
        cursor.write_u32(self.outstanding_notes)?;
        cursor.write_u32(self.total_drawn_notes)?;
        cursor.write_u32(self.total_repaid_notes)?;
        cursor.write_u32(self.total_defaulted_notes)?;
        cursor.write_u16(self.interest_bps)?;
        cursor.write_u64(self.maturity_slot)?;
        cursor.write_u64(self.receipt_interval_slots)?;
        cursor.write_u8(self.privacy_policy as u8)?;
        cursor.zero_remaining();
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let mut cursor = Reader::new(data);
        if cursor.read_u8()? != POOL_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            version: cursor.read_u8()?,
            bump: cursor.read_u8()?,
            status: PoolStatus::from_u8(cursor.read_u8()?)?,
            pool_id: cursor.read_pubkey()?,
            admin: cursor.read_pubkey()?,
            underwriter: cursor.read_pubkey()?,
            auditor: cursor.read_pubkey()?,
            reserve_mint: cursor.read_pubkey()?,
            vault: cursor.read_pubkey()?,
            note_size_usd: cursor.read_u64()?,
            total_limit_notes: cursor.read_u32()?,
            allocated_limit_notes: cursor.read_u32()?,
            outstanding_notes: cursor.read_u32()?,
            total_drawn_notes: cursor.read_u32()?,
            total_repaid_notes: cursor.read_u32()?,
            total_defaulted_notes: cursor.read_u32()?,
            interest_bps: cursor.read_u16()?,
            maturity_slot: cursor.read_u64()?,
            receipt_interval_slots: cursor.read_u64()?,
            privacy_policy: PrivacyPolicy::from_u8(cursor.read_u8()?)?,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreditLineAccount {
    pub version: u8,
    pub status: LineStatus,
    pub pool: PubkeyBytes,
    pub borrower: PubkeyBytes,
    pub underwriter: PubkeyBytes,
    pub auditor: PubkeyBytes,
    pub limit_notes: u32,
    pub drawn_notes: u32,
    pub repaid_notes: u32,
    pub defaulted_notes: u32,
    pub note_size_usd: u64,
    pub interest_bps: u16,
    pub opened_slot: u64,
    pub maturity_slot: u64,
    pub last_receipt_slot: u64,
    pub terms_hash: PubkeyBytes,
    pub mandate_hash: PubkeyBytes,
    pub privacy_policy: PrivacyPolicy,
}

impl CreditLineAccount {
    pub const LEN: usize = 1 + 1 + 1 + 32 * 4 + 4 * 4 + 8 + 2 + 8 * 3 + 32 * 2 + 1 + 32;
    pub const STATUS_OFFSET: usize = 2;
    pub const POOL_OFFSET: usize = 3;
    pub const BORROWER_OFFSET: usize = 35;
    pub const UNDERWRITER_OFFSET: usize = 67;
    pub const AUDITOR_OFFSET: usize = 99;
    pub const LIMIT_NOTES_OFFSET: usize = 131;
    pub const DRAWN_NOTES_OFFSET: usize = 135;
    pub const REPAID_NOTES_OFFSET: usize = 139;
    pub const DEFAULTED_NOTES_OFFSET: usize = 143;
    pub const NOTE_SIZE_USD_OFFSET: usize = 147;
    pub const INTEREST_BPS_OFFSET: usize = 155;
    pub const MATURITY_SLOT_OFFSET: usize = 165;
    pub const LAST_RECEIPT_SLOT_OFFSET: usize = 173;
    pub const RESERVED_OFFSET: usize = 246;

    pub fn is_initialized(data: &[u8]) -> bool {
        data.first().copied() == Some(LINE_DISCRIMINATOR)
    }

    pub fn outstanding_notes(&self) -> Result<u32, ProgramError> {
        self.drawn_notes
            .checked_sub(self.repaid_notes)
            .and_then(|value| value.checked_sub(self.defaulted_notes))
            .ok_or(ProgramError::InvalidAccountData)
    }

    pub fn pack(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let mut cursor = Writer::new(data);
        cursor.write_u8(LINE_DISCRIMINATOR)?;
        cursor.write_u8(self.version)?;
        cursor.write_u8(self.status as u8)?;
        cursor.write_pubkey(&self.pool)?;
        cursor.write_pubkey(&self.borrower)?;
        cursor.write_pubkey(&self.underwriter)?;
        cursor.write_pubkey(&self.auditor)?;
        cursor.write_u32(self.limit_notes)?;
        cursor.write_u32(self.drawn_notes)?;
        cursor.write_u32(self.repaid_notes)?;
        cursor.write_u32(self.defaulted_notes)?;
        cursor.write_u64(self.note_size_usd)?;
        cursor.write_u16(self.interest_bps)?;
        cursor.write_u64(self.opened_slot)?;
        cursor.write_u64(self.maturity_slot)?;
        cursor.write_u64(self.last_receipt_slot)?;
        cursor.write_pubkey(&self.terms_hash)?;
        cursor.write_pubkey(&self.mandate_hash)?;
        cursor.write_u8(self.privacy_policy as u8)?;
        cursor.zero_remaining();
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let mut cursor = Reader::new(data);
        if cursor.read_u8()? != LINE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            version: cursor.read_u8()?,
            status: LineStatus::from_u8(cursor.read_u8()?)?,
            pool: cursor.read_pubkey()?,
            borrower: cursor.read_pubkey()?,
            underwriter: cursor.read_pubkey()?,
            auditor: cursor.read_pubkey()?,
            limit_notes: cursor.read_u32()?,
            drawn_notes: cursor.read_u32()?,
            repaid_notes: cursor.read_u32()?,
            defaulted_notes: cursor.read_u32()?,
            note_size_usd: cursor.read_u64()?,
            interest_bps: cursor.read_u16()?,
            opened_slot: cursor.read_u64()?,
            maturity_slot: cursor.read_u64()?,
            last_receipt_slot: cursor.read_u64()?,
            terms_hash: cursor.read_pubkey()?,
            mandate_hash: cursor.read_pubkey()?,
            privacy_policy: PrivacyPolicy::from_u8(cursor.read_u8()?)?,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReceiptAccount {
    pub version: u8,
    pub line: PubkeyBytes,
    pub signer: PubkeyBytes,
    pub period_start_slot: u64,
    pub period_end_slot: u64,
    pub accepted_slot: u64,
    pub receipt_hash: PubkeyBytes,
}

impl ReceiptAccount {
    pub const LEN: usize = 1 + 1 + 32 * 3 + 8 * 3 + 32;
    pub const RESERVED_OFFSET: usize = 122;

    pub fn is_initialized(data: &[u8]) -> bool {
        data.first().copied() == Some(RECEIPT_DISCRIMINATOR)
    }

    pub fn pack(&self, data: &mut [u8]) -> Result<(), ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let mut cursor = Writer::new(data);
        cursor.write_u8(RECEIPT_DISCRIMINATOR)?;
        cursor.write_u8(self.version)?;
        cursor.write_pubkey(&self.line)?;
        cursor.write_pubkey(&self.signer)?;
        cursor.write_u64(self.period_start_slot)?;
        cursor.write_u64(self.period_end_slot)?;
        cursor.write_u64(self.accepted_slot)?;
        cursor.write_pubkey(&self.receipt_hash)?;
        cursor.zero_remaining();
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        let mut cursor = Reader::new(data);
        if cursor.read_u8()? != RECEIPT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self {
            version: cursor.read_u8()?,
            line: cursor.read_pubkey()?,
            signer: cursor.read_pubkey()?,
            period_start_slot: cursor.read_u64()?,
            period_end_slot: cursor.read_u64()?,
            accepted_slot: cursor.read_u64()?,
            receipt_hash: cursor.read_pubkey()?,
        })
    }
}

pub fn derived_pool_id(
    admin: &PubkeyBytes,
    reserve_mint: &PubkeyBytes,
    vault: &PubkeyBytes,
) -> PubkeyBytes {
    let mut id = [0u8; 32];
    let mut index = 0usize;
    while index < 32 {
        id[index] = admin[index] ^ reserve_mint[index].rotate_left(1) ^ vault[index].rotate_left(2);
        index += 1;
    }
    id
}

pub(crate) fn active_pool(pool: &PoolAccount) -> Result<(), ProgramError> {
    if pool.version != VERSION || pool.status != PoolStatus::Active {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub(crate) fn active_line(line: &CreditLineAccount) -> Result<(), ProgramError> {
    if line.version != VERSION || line.status != LineStatus::Active {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub(crate) const fn version() -> u8 {
    VERSION
}

pub(crate) fn write_u8_at(data: &mut [u8], offset: usize, value: u8) -> Result<(), ProgramError> {
    let target = data
        .get_mut(offset)
        .ok_or(ProgramError::AccountDataTooSmall)?;
    *target = value;
    Ok(())
}

pub(crate) fn write_u32_at(data: &mut [u8], offset: usize, value: u32) -> Result<(), ProgramError> {
    write_exact_at(data, offset, &value.to_le_bytes())
}

pub(crate) fn write_u64_at(data: &mut [u8], offset: usize, value: u64) -> Result<(), ProgramError> {
    write_exact_at(data, offset, &value.to_le_bytes())
}

fn write_exact_at(data: &mut [u8], offset: usize, value: &[u8]) -> Result<(), ProgramError> {
    let end = offset
        .checked_add(value.len())
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let target = data
        .get_mut(offset..end)
        .ok_or(ProgramError::AccountDataTooSmall)?;
    target.copy_from_slice(value);
    Ok(())
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    const fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn read_u8(&mut self) -> Result<u8, ProgramError> {
        let value = *self
            .data
            .get(self.offset)
            .ok_or(ProgramError::InvalidAccountData)?;
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
            .ok_or(ProgramError::InvalidAccountData)?;
        self.offset = end;
        Ok(slice)
    }
}

struct Writer<'a> {
    data: &'a mut [u8],
    offset: usize,
}

impl<'a> Writer<'a> {
    fn new(data: &'a mut [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn write_u8(&mut self, value: u8) -> Result<(), ProgramError> {
        let slot = self
            .data
            .get_mut(self.offset)
            .ok_or(ProgramError::AccountDataTooSmall)?;
        *slot = value;
        self.offset += 1;
        Ok(())
    }

    fn write_u16(&mut self, value: u16) -> Result<(), ProgramError> {
        self.write_exact(&value.to_le_bytes())
    }

    fn write_u32(&mut self, value: u32) -> Result<(), ProgramError> {
        self.write_exact(&value.to_le_bytes())
    }

    fn write_u64(&mut self, value: u64) -> Result<(), ProgramError> {
        self.write_exact(&value.to_le_bytes())
    }

    fn write_pubkey(&mut self, value: &PubkeyBytes) -> Result<(), ProgramError> {
        self.write_exact(value)
    }

    fn write_exact(&mut self, value: &[u8]) -> Result<(), ProgramError> {
        let end = self
            .offset
            .checked_add(value.len())
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let target = self
            .data
            .get_mut(self.offset..end)
            .ok_or(ProgramError::AccountDataTooSmall)?;
        target.copy_from_slice(value);
        self.offset = end;
        Ok(())
    }

    fn zero_remaining(&mut self) {
        for byte in self.data.get_mut(self.offset..).unwrap_or(&mut []) {
            *byte = 0;
        }
    }
}
