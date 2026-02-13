//! Address balance index (script hash -> balance + collateral counts).

use fluxd_consensus::Hash256;
use fluxd_storage::{Column, KeyValueStore, StoreError, WriteBatch};

const SCRIPT_HASH_LEN: usize = 32;
const FIXED_LEN: usize = 8 + 6 * 4 + 2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddressBalanceEntry {
    pub address: String,
    pub balance: i64,
    pub v1_cumulus: u32,
    pub v1_nimbus: u32,
    pub v1_stratus: u32,
    pub v2_cumulus: u32,
    pub v2_nimbus: u32,
    pub v2_stratus: u32,
}

impl AddressBalanceEntry {
    pub fn new(address: String) -> Self {
        Self {
            address,
            balance: 0,
            v1_cumulus: 0,
            v1_nimbus: 0,
            v1_stratus: 0,
            v2_cumulus: 0,
            v2_nimbus: 0,
            v2_stratus: 0,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let addr = self.address.as_bytes();
        let addr_len = u16::try_from(addr.len()).unwrap_or(u16::MAX);
        let mut out = Vec::with_capacity(FIXED_LEN + addr_len as usize);
        out.extend_from_slice(&self.balance.to_le_bytes());
        out.extend_from_slice(&self.v1_cumulus.to_le_bytes());
        out.extend_from_slice(&self.v1_nimbus.to_le_bytes());
        out.extend_from_slice(&self.v1_stratus.to_le_bytes());
        out.extend_from_slice(&self.v2_cumulus.to_le_bytes());
        out.extend_from_slice(&self.v2_nimbus.to_le_bytes());
        out.extend_from_slice(&self.v2_stratus.to_le_bytes());
        out.extend_from_slice(&addr_len.to_le_bytes());
        out.extend_from_slice(&addr[..addr_len as usize]);
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < FIXED_LEN {
            return None;
        }
        let balance = i64::from_le_bytes(bytes[0..8].try_into().ok()?);
        let v1_cumulus = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
        let v1_nimbus = u32::from_le_bytes(bytes[12..16].try_into().ok()?);
        let v1_stratus = u32::from_le_bytes(bytes[16..20].try_into().ok()?);
        let v2_cumulus = u32::from_le_bytes(bytes[20..24].try_into().ok()?);
        let v2_nimbus = u32::from_le_bytes(bytes[24..28].try_into().ok()?);
        let v2_stratus = u32::from_le_bytes(bytes[28..32].try_into().ok()?);
        let addr_len = u16::from_le_bytes(bytes[32..34].try_into().ok()?) as usize;
        if bytes.len() < FIXED_LEN + addr_len {
            return None;
        }
        let address = String::from_utf8(bytes[34..34 + addr_len].to_vec()).ok()?;
        Some(Self {
            address,
            balance,
            v1_cumulus,
            v1_nimbus,
            v1_stratus,
            v2_cumulus,
            v2_nimbus,
            v2_stratus,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.balance == 0
            && self.v1_cumulus == 0
            && self.v1_nimbus == 0
            && self.v1_stratus == 0
            && self.v2_cumulus == 0
            && self.v2_nimbus == 0
            && self.v2_stratus == 0
    }
}

pub struct AddressBalanceIndex<S> {
    store: S,
}

impl<S> AddressBalanceIndex<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }
}

impl<S: KeyValueStore> AddressBalanceIndex<S> {
    pub fn get(&self, script_hash: &Hash256) -> Result<Option<AddressBalanceEntry>, StoreError> {
        let bytes = match self.store.get(Column::AddressBalance, script_hash)? {
            Some(bytes) => bytes,
            None => return Ok(None),
        };
        Ok(AddressBalanceEntry::decode(&bytes))
    }

    pub fn put(
        &self,
        batch: &mut WriteBatch,
        script_hash: &Hash256,
        entry: &AddressBalanceEntry,
    ) {
        batch.put(Column::AddressBalance, *script_hash, entry.encode());
    }

    pub fn delete(&self, batch: &mut WriteBatch, script_hash: &Hash256) {
        batch.delete(Column::AddressBalance, *script_hash);
    }

    pub fn for_each<'a>(
        &self,
        visitor: &mut dyn FnMut(Hash256, AddressBalanceEntry) -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        let start = [0u8; SCRIPT_HASH_LEN];
        let end = [0xffu8; SCRIPT_HASH_LEN];
        let mut adapter = |key: &[u8], value: &[u8]| {
            if key.len() != SCRIPT_HASH_LEN {
                return Ok(());
            }
            let Some(entry) = AddressBalanceEntry::decode(value) else {
                return Ok(());
            };
            let script_hash: Hash256 = match key.try_into() {
                Ok(hash) => hash,
                Err(_) => return Ok(()),
            };
            visitor(script_hash, entry)
        };
        self.store
            .for_each_range(Column::AddressBalance, &start, &end, &mut adapter)
    }

    pub fn scan_keys(&self) -> Result<Vec<Hash256>, StoreError> {
        let start = [0u8; SCRIPT_HASH_LEN];
        let end = [0xffu8; SCRIPT_HASH_LEN];
        let entries = self
            .store
            .scan_range(Column::AddressBalance, &start, &end)?;
        let mut out = Vec::with_capacity(entries.len());
        for (key, _) in entries {
            if key.len() != SCRIPT_HASH_LEN {
                continue;
            }
            if let Ok(hash) = <Hash256>::try_from(key.as_slice()) {
                out.push(hash);
            }
        }
        Ok(out)
    }
}
