use fluxd_consensus::Hash256;
use fluxd_primitives::encoding::{DecodeError, Decoder, Encoder};
use fluxd_storage::{Column, KeyValueStore, StoreError, WriteBatch};

const SCRIPT_HASH_LEN: usize = 32;
const CKPT_INDEX_LEN: usize = 4;

const CKPT_VALUE_LEN: usize = 4 + 4 + 32;

pub const DEFAULT_CHECKPOINT_INTERVAL: u64 = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AddressTxCursor {
    pub height: u32,
    pub tx_index: u32,
    pub txid: Hash256,
}

pub fn address_tx_total_key(script_hash: &Hash256) -> [u8; SCRIPT_HASH_LEN] {
    *script_hash
}

pub fn address_tx_checkpoint_key(script_hash: &Hash256, checkpoint_index: u32) -> [u8; SCRIPT_HASH_LEN + CKPT_INDEX_LEN] {
    let mut out = [0u8; SCRIPT_HASH_LEN + CKPT_INDEX_LEN];
    out[..SCRIPT_HASH_LEN].copy_from_slice(script_hash);
    out[SCRIPT_HASH_LEN..].copy_from_slice(&checkpoint_index.to_be_bytes());
    out
}

pub fn encode_total(total: u64) -> [u8; 8] {
    total.to_le_bytes()
}

pub fn decode_total(bytes: &[u8]) -> Result<u64, DecodeError> {
    if bytes.len() != 8 {
        return Err(DecodeError::InvalidData("invalid address tx total"));
    }
    let mut buf = [0u8; 8];
    buf.copy_from_slice(bytes);
    Ok(u64::from_le_bytes(buf))
}

pub fn encode_checkpoint(cursor: &AddressTxCursor) -> Vec<u8> {
    let mut encoder = Encoder::new();
    encoder.write_u32_le(cursor.height);
    encoder.write_u32_le(cursor.tx_index);
    encoder.write_bytes(&cursor.txid);
    encoder.into_inner()
}

pub fn decode_checkpoint(bytes: &[u8]) -> Result<AddressTxCursor, DecodeError> {
    if bytes.len() != CKPT_VALUE_LEN {
        return Err(DecodeError::InvalidData("invalid address tx checkpoint"));
    }
    let mut decoder = Decoder::new(bytes);
    let height = decoder.read_u32_le()?;
    let tx_index = decoder.read_u32_le()?;
    let txid = decoder.read_fixed::<32>()?;
    if !decoder.is_empty() {
        return Err(DecodeError::TrailingBytes);
    }
    Ok(AddressTxCursor {
        height,
        tx_index,
        txid,
    })
}

pub struct AddressTxIndex<S> {
    store: S,
}

impl<S> AddressTxIndex<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }
}

impl<S: KeyValueStore> AddressTxIndex<S> {
    pub fn total(&self, script_hash: &Hash256) -> Result<Option<u64>, StoreError> {
        let key = address_tx_total_key(script_hash);
        let Some(bytes) = self.store.get(Column::AddressTxTotal, &key)? else {
            return Ok(None);
        };
        decode_total(&bytes)
            .map(Some)
            .map_err(|err| StoreError::Backend(err.to_string()))
    }

    pub fn set_total(&self, batch: &mut WriteBatch, script_hash: &Hash256, total: u64) {
        let key = address_tx_total_key(script_hash);
        batch.put(Column::AddressTxTotal, key, encode_total(total));
    }

    pub fn delete_total(&self, batch: &mut WriteBatch, script_hash: &Hash256) {
        let key = address_tx_total_key(script_hash);
        batch.delete(Column::AddressTxTotal, key);
    }

    pub fn put_checkpoint(
        &self,
        batch: &mut WriteBatch,
        script_hash: &Hash256,
        checkpoint_index: u32,
        cursor: &AddressTxCursor,
    ) {
        let key = address_tx_checkpoint_key(script_hash, checkpoint_index);
        batch.put(Column::AddressTxCheckpoint, key, encode_checkpoint(cursor));
    }

    pub fn delete_checkpoint(
        &self,
        batch: &mut WriteBatch,
        script_hash: &Hash256,
        checkpoint_index: u32,
    ) {
        let key = address_tx_checkpoint_key(script_hash, checkpoint_index);
        batch.delete(Column::AddressTxCheckpoint, key);
    }

    pub fn checkpoint(
        &self,
        script_hash: &Hash256,
        checkpoint_index: u32,
    ) -> Result<Option<AddressTxCursor>, StoreError> {
        let key = address_tx_checkpoint_key(script_hash, checkpoint_index);
        let Some(bytes) = self.store.get(Column::AddressTxCheckpoint, &key)? else {
            return Ok(None);
        };
        decode_checkpoint(&bytes)
            .map(Some)
            .map_err(|err| StoreError::Backend(err.to_string()))
    }
}
