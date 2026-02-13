//! Address-to-address neighbor index backed by the storage trait.
//!
//! The index stores aggregated inbound/outbound transaction counts and value totals for
//! address pairs. Keys are directional by (A,B) so callers can query all neighbors for
//! a given A via prefix scans.

use fluxd_storage::{Column, KeyValueStore, StoreError, WriteBatch};

const GEN_LEN: usize = 2;
const ADDRESS_ID_LEN: usize = 1 + 20;
const TX_VALUE_LEN: usize = 8;
const SCORE_KEY_LEN: usize = 8 + 8;

const NEIGHBOR_KEY_LEN: usize = GEN_LEN + ADDRESS_ID_LEN + ADDRESS_ID_LEN;
const NEIGHBOR_RANK_KEY_LEN: usize = GEN_LEN + ADDRESS_ID_LEN + SCORE_KEY_LEN + ADDRESS_ID_LEN;

const STATS_LEN: usize = 8 * 4;

const META_ACTIVE_GEN_KEY: &[u8] = b"addr_neighbors_active_gen";
const META_ACTIVE_HEIGHT_KEY: &[u8] = b"addr_neighbors_active_height";
const META_ACTIVE_TIP_HASH_KEY: &[u8] = b"addr_neighbors_active_tip_hash";

const META_BUILD_STATE_KEY: &[u8] = b"addr_neighbors_build_state";
const META_BUILD_GEN_KEY: &[u8] = b"addr_neighbors_build_gen";
const META_BUILD_HEIGHT_KEY: &[u8] = b"addr_neighbors_build_height";
const META_BUILD_TIP_HASH_KEY: &[u8] = b"addr_neighbors_build_tip_hash";
const META_BUILD_STARTED_AT_KEY: &[u8] = b"addr_neighbors_build_started_at";
const META_BUILD_ERROR_KEY: &[u8] = b"addr_neighbors_build_error";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AddressNeighborBuildState {
    Idle = 0,
    Running = 1,
    Complete = 2,
    Error = 3,
}

impl AddressNeighborBuildState {
    pub fn decode(byte: u8) -> Option<Self> {
        match byte {
            0 => Some(Self::Idle),
            1 => Some(Self::Running),
            2 => Some(Self::Complete),
            3 => Some(Self::Error),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct AddressId {
    pub address_type: u8,
    pub address_hash: [u8; 20],
}

impl AddressId {
    pub fn encode(&self) -> [u8; ADDRESS_ID_LEN] {
        let mut out = [0u8; ADDRESS_ID_LEN];
        out[0] = self.address_type;
        out[1..].copy_from_slice(&self.address_hash);
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != ADDRESS_ID_LEN {
            return None;
        }
        let address_type = bytes[0];
        let mut address_hash = [0u8; 20];
        address_hash.copy_from_slice(&bytes[1..]);
        Some(Self {
            address_type,
            address_hash,
        })
    }

    pub fn from_type_hash(address_type: u32, address_hash: [u8; 20]) -> Option<Self> {
        match address_type {
            1 => Some(Self {
                address_type: 1,
                address_hash,
            }),
            2 => Some(Self {
                address_type: 2,
                address_hash,
            }),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct AddressNeighborStats {
    pub inbound_tx_count: u64,
    pub outbound_tx_count: u64,
    pub inbound_value_sat: u64,
    pub outbound_value_sat: u64,
}

impl AddressNeighborStats {
    pub fn total_tx_count(&self) -> u64 {
        self.inbound_tx_count.saturating_add(self.outbound_tx_count)
    }

    pub fn total_value_sat(&self) -> u64 {
        self.inbound_value_sat.saturating_add(self.outbound_value_sat)
    }

    pub fn encode(&self) -> [u8; STATS_LEN] {
        let mut out = [0u8; STATS_LEN];
        out[0..8].copy_from_slice(&self.inbound_tx_count.to_le_bytes());
        out[8..16].copy_from_slice(&self.outbound_tx_count.to_le_bytes());
        out[16..24].copy_from_slice(&self.inbound_value_sat.to_le_bytes());
        out[24..32].copy_from_slice(&self.outbound_value_sat.to_le_bytes());
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != STATS_LEN {
            return None;
        }
        let inbound_tx_count = u64::from_le_bytes(bytes[0..8].try_into().ok()?);
        let outbound_tx_count = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
        let inbound_value_sat = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
        let outbound_value_sat = u64::from_le_bytes(bytes[24..32].try_into().ok()?);
        Some(Self {
            inbound_tx_count,
            outbound_tx_count,
            inbound_value_sat,
            outbound_value_sat,
        })
    }

    pub fn saturating_add(&self, other: &Self) -> Self {
        Self {
            inbound_tx_count: self.inbound_tx_count.saturating_add(other.inbound_tx_count),
            outbound_tx_count: self.outbound_tx_count.saturating_add(other.outbound_tx_count),
            inbound_value_sat: self.inbound_value_sat.saturating_add(other.inbound_value_sat),
            outbound_value_sat: self.outbound_value_sat.saturating_add(other.outbound_value_sat),
        }
    }
}

pub fn address_id_from_script_pubkey(script_pubkey: &[u8]) -> Option<AddressId> {
    if script_pubkey.len() == 25
        && script_pubkey[0] == 0x76
        && script_pubkey[1] == 0xa9
        && script_pubkey[2] == 0x14
        && script_pubkey[23] == 0x88
        && script_pubkey[24] == 0xac
    {
        let mut hash = [0u8; 20];
        hash.copy_from_slice(&script_pubkey[3..23]);
        return Some(AddressId {
            address_type: 1,
            address_hash: hash,
        });
    }
    if script_pubkey.len() == 23
        && script_pubkey[0] == 0xa9
        && script_pubkey[1] == 0x14
        && script_pubkey[22] == 0x87
    {
        let mut hash = [0u8; 20];
        hash.copy_from_slice(&script_pubkey[2..22]);
        return Some(AddressId {
            address_type: 2,
            address_hash: hash,
        });
    }
    None
}

pub fn neighbor_key(gen: u16, a: &AddressId, b: &AddressId) -> [u8; NEIGHBOR_KEY_LEN] {
    let mut out = [0u8; NEIGHBOR_KEY_LEN];
    let gen = gen.to_be_bytes();
    out[..GEN_LEN].copy_from_slice(&gen);
    out[GEN_LEN..GEN_LEN + ADDRESS_ID_LEN].copy_from_slice(&a.encode());
    out[GEN_LEN + ADDRESS_ID_LEN..].copy_from_slice(&b.encode());
    out
}

pub fn neighbor_rank_prefix(gen: u16, a: &AddressId) -> [u8; GEN_LEN + ADDRESS_ID_LEN] {
    let mut out = [0u8; GEN_LEN + ADDRESS_ID_LEN];
    out[..GEN_LEN].copy_from_slice(&gen.to_be_bytes());
    out[GEN_LEN..].copy_from_slice(&a.encode());
    out
}

pub fn neighbor_rank_key(
    gen: u16,
    a: &AddressId,
    total_value_sat: u64,
    total_tx_count: u64,
    b: &AddressId,
) -> [u8; NEIGHBOR_RANK_KEY_LEN] {
    let mut out = [0u8; NEIGHBOR_RANK_KEY_LEN];
    let inv_value = u64::MAX.saturating_sub(total_value_sat).to_be_bytes();
    let inv_tx = u64::MAX.saturating_sub(total_tx_count).to_be_bytes();

    let mut offset = 0;
    out[offset..offset + GEN_LEN].copy_from_slice(&gen.to_be_bytes());
    offset += GEN_LEN;
    out[offset..offset + ADDRESS_ID_LEN].copy_from_slice(&a.encode());
    offset += ADDRESS_ID_LEN;
    out[offset..offset + TX_VALUE_LEN].copy_from_slice(&inv_value);
    offset += TX_VALUE_LEN;
    out[offset..offset + TX_VALUE_LEN].copy_from_slice(&inv_tx);
    offset += TX_VALUE_LEN;
    out[offset..offset + ADDRESS_ID_LEN].copy_from_slice(&b.encode());
    out
}

pub fn decode_neighbor_rank_key(
    key: &[u8],
) -> Option<(u16, AddressId, AddressId, u64, u64)> {
    if key.len() != NEIGHBOR_RANK_KEY_LEN {
        return None;
    }
    let gen = u16::from_be_bytes(key[0..2].try_into().ok()?);
    let a = AddressId::decode(&key[2..2 + ADDRESS_ID_LEN])?;
    let inv_value = u64::from_be_bytes(
        key[2 + ADDRESS_ID_LEN..2 + ADDRESS_ID_LEN + 8]
            .try_into()
            .ok()?,
    );
    let inv_tx = u64::from_be_bytes(
        key[2 + ADDRESS_ID_LEN + 8..2 + ADDRESS_ID_LEN + 16]
            .try_into()
            .ok()?,
    );
    let b = AddressId::decode(&key[key.len() - ADDRESS_ID_LEN..])?;
    let total_value_sat = u64::MAX.saturating_sub(inv_value);
    let total_tx_count = u64::MAX.saturating_sub(inv_tx);
    Some((gen, a, b, total_value_sat, total_tx_count))
}

pub struct AddressNeighborIndex<S> {
    store: S,
}

impl<S> AddressNeighborIndex<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }
}

impl<S: KeyValueStore> AddressNeighborIndex<S> {
    pub fn active_generation(&self) -> Result<Option<u16>, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_ACTIVE_GEN_KEY)? else {
            return Ok(None);
        };
        if bytes.len() != 2 {
            return Err(StoreError::Backend(
                "invalid addr_neighbors_active_gen".to_string(),
            ));
        }
        Ok(Some(u16::from_le_bytes([bytes[0], bytes[1]])))
    }

    pub fn build_generation(&self) -> Result<Option<u16>, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_BUILD_GEN_KEY)? else {
            return Ok(None);
        };
        if bytes.len() != 2 {
            return Err(StoreError::Backend(
                "invalid addr_neighbors_build_gen".to_string(),
            ));
        }
        Ok(Some(u16::from_le_bytes([bytes[0], bytes[1]])))
    }

    pub fn build_state(&self) -> Result<AddressNeighborBuildState, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_BUILD_STATE_KEY)? else {
            return Ok(AddressNeighborBuildState::Idle);
        };
        if bytes.len() != 1 {
            return Err(StoreError::Backend(
                "invalid addr_neighbors_build_state".to_string(),
            ));
        }
        AddressNeighborBuildState::decode(bytes[0]).ok_or_else(|| {
            StoreError::Backend("invalid addr_neighbors_build_state value".to_string())
        })
    }

    pub fn build_height(&self) -> Result<Option<u32>, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_BUILD_HEIGHT_KEY)? else {
            return Ok(None);
        };
        if bytes.len() != 4 {
            return Err(StoreError::Backend(
                "invalid addr_neighbors_build_height".to_string(),
            ));
        }
        let mut buf = [0u8; 4];
        buf.copy_from_slice(&bytes);
        Ok(Some(u32::from_le_bytes(buf)))
    }

    pub fn build_tip_hash(&self) -> Result<Option<[u8; 32]>, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_BUILD_TIP_HASH_KEY)? else {
            return Ok(None);
        };
        if bytes.len() != 32 {
            return Err(StoreError::Backend(
                "invalid addr_neighbors_build_tip_hash".to_string(),
            ));
        }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&bytes);
        Ok(Some(hash))
    }

    pub fn build_started_at(&self) -> Result<Option<u64>, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_BUILD_STARTED_AT_KEY)? else {
            return Ok(None);
        };
        if bytes.len() != 8 {
            return Err(StoreError::Backend(
                "invalid addr_neighbors_build_started_at".to_string(),
            ));
        }
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&bytes);
        Ok(Some(u64::from_le_bytes(buf)))
    }

    pub fn build_error(&self) -> Result<Option<String>, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_BUILD_ERROR_KEY)? else {
            return Ok(None);
        };
        if bytes.is_empty() {
            return Ok(None);
        }
        String::from_utf8(bytes).map(Some).map_err(|_| {
            StoreError::Backend("invalid addr_neighbors_build_error utf8".to_string())
        })
    }

    pub fn set_build_state(&self, batch: &mut WriteBatch, state: AddressNeighborBuildState) {
        batch.put(Column::Meta, META_BUILD_STATE_KEY, [state as u8]);
    }

    pub fn set_build_generation(&self, batch: &mut WriteBatch, gen: u16) {
        batch.put(Column::Meta, META_BUILD_GEN_KEY, gen.to_le_bytes());
    }

    pub fn set_build_height(&self, batch: &mut WriteBatch, height: u32) {
        batch.put(Column::Meta, META_BUILD_HEIGHT_KEY, height.to_le_bytes());
    }

    pub fn set_build_tip_hash(&self, batch: &mut WriteBatch, hash: &[u8; 32]) {
        batch.put(Column::Meta, META_BUILD_TIP_HASH_KEY, *hash);
    }

    pub fn set_build_started_at(&self, batch: &mut WriteBatch, unix_seconds: u64) {
        batch.put(
            Column::Meta,
            META_BUILD_STARTED_AT_KEY,
            unix_seconds.to_le_bytes(),
        );
    }

    pub fn set_build_error(&self, batch: &mut WriteBatch, message: &str) {
        batch.put(Column::Meta, META_BUILD_ERROR_KEY, message.as_bytes());
    }

    pub fn set_active_index(
        &self,
        batch: &mut WriteBatch,
        gen: u16,
        height: u32,
        tip_hash: &[u8; 32],
    ) {
        batch.put(Column::Meta, META_ACTIVE_GEN_KEY, gen.to_le_bytes());
        batch.put(
            Column::Meta,
            META_ACTIVE_HEIGHT_KEY,
            height.to_le_bytes(),
        );
        batch.put(Column::Meta, META_ACTIVE_TIP_HASH_KEY, *tip_hash);
    }

    pub fn active_height(&self) -> Result<Option<u32>, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_ACTIVE_HEIGHT_KEY)? else {
            return Ok(None);
        };
        if bytes.len() != 4 {
            return Err(StoreError::Backend(
                "invalid addr_neighbors_active_height".to_string(),
            ));
        }
        let mut buf = [0u8; 4];
        buf.copy_from_slice(&bytes);
        Ok(Some(u32::from_le_bytes(buf)))
    }

    pub fn active_tip_hash(&self) -> Result<Option<[u8; 32]>, StoreError> {
        let Some(bytes) = self.store.get(Column::Meta, META_ACTIVE_TIP_HASH_KEY)? else {
            return Ok(None);
        };
        if bytes.len() != 32 {
            return Err(StoreError::Backend(
                "invalid addr_neighbors_active_tip_hash".to_string(),
            ));
        }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&bytes);
        Ok(Some(hash))
    }

    pub fn get(
        &self,
        gen: u16,
        a: &AddressId,
        b: &AddressId,
    ) -> Result<Option<AddressNeighborStats>, StoreError> {
        let key = neighbor_key(gen, a, b);
        let Some(bytes) = self.store.get(Column::AddressNeighbor, &key)? else {
            return Ok(None);
        };
        AddressNeighborStats::decode(&bytes)
            .ok_or_else(|| StoreError::Backend("invalid address neighbor entry".to_string()))
            .map(Some)
    }

    pub fn upsert_delta(
        &self,
        batch: &mut WriteBatch,
        gen: u16,
        a: &AddressId,
        b: &AddressId,
        delta: AddressNeighborStats,
    ) -> Result<AddressNeighborStats, StoreError> {
        let key = neighbor_key(gen, a, b);
        let existing = match self.store.get(Column::AddressNeighbor, &key)? {
            Some(bytes) => AddressNeighborStats::decode(&bytes)
                .ok_or_else(|| StoreError::Backend("invalid address neighbor entry".to_string()))?,
            None => AddressNeighborStats::default(),
        };

        let next = existing.saturating_add(&delta);

        if existing != AddressNeighborStats::default() {
            let old_rank = neighbor_rank_key(
                gen,
                a,
                existing.total_value_sat(),
                existing.total_tx_count(),
                b,
            );
            batch.delete(Column::AddressNeighborRank, old_rank);
        }

        let next_rank = neighbor_rank_key(
            gen,
            a,
            next.total_value_sat(),
            next.total_tx_count(),
            b,
        );
        batch.put(Column::AddressNeighbor, key, next.encode());
        batch.put(Column::AddressNeighborRank, next_rank, next.encode());
        Ok(next)
    }

    pub fn top_neighbors(
        &self,
        gen: u16,
        a: &AddressId,
        limit: usize,
    ) -> Result<Vec<(AddressId, AddressNeighborStats)>, StoreError> {
        let prefix = neighbor_rank_prefix(gen, a);
        let entries = self
            .store
            .scan_prefix_limited(Column::AddressNeighborRank, &prefix, limit)?;
        let mut out = Vec::with_capacity(entries.len());
        for (key, value) in entries {
            let (_, _, b, _, _) = match decode_neighbor_rank_key(&key) {
                Some(decoded) => decoded,
                None => continue,
            };
            let stats = match AddressNeighborStats::decode(&value) {
                Some(stats) => stats,
                None => continue,
            };
            out.push((b, stats));
        }
        Ok(out)
    }
}
