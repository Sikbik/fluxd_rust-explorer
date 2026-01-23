use std::sync::Arc;

use fluxd_chainstate::flatfiles::FlatFileStore;
use fluxd_chainstate::state::ChainState;
use fluxd_chainstate::validation::ValidationFlags;
use fluxd_consensus::params::{chain_params, Checkpoint, Network};
use fluxd_consensus::upgrades::UpgradeIndex;
use fluxd_pow::difficulty::target_to_compact;
use fluxd_primitives::block::{Block, BlockHeader, CURRENT_VERSION};
use fluxd_primitives::outpoint::OutPoint;
use fluxd_primitives::transaction::{Transaction, TxIn, TxOut};
use fluxd_storage::memory::MemoryStore;
use fluxd_storage::WriteBatch;

fn p2pkh_script(tag: u8) -> Vec<u8> {
    let mut script = Vec::with_capacity(25);
    script.extend_from_slice(&[0x76, 0xa9, 0x14]);
    script.extend_from_slice(&[tag; 20]);
    script.extend_from_slice(&[0x88, 0xac]);
    script
}

fn make_tx(vin: Vec<TxIn>, vout: Vec<TxOut>) -> Transaction {
    Transaction {
        f_overwintered: false,
        version: 1,
        version_group_id: 0,
        vin,
        vout,
        lock_time: 0,
        expiry_height: 0,
        value_balance: 0,
        shielded_spends: Vec::new(),
        shielded_outputs: Vec::new(),
        join_splits: Vec::new(),
        join_split_pub_key: [0u8; 32],
        join_split_sig: [0u8; 64],
        binding_sig: [0u8; 64],
        fluxnode: None,
    }
}

fn coinbase_tx(height: u32) -> Transaction {
    make_tx(
        vec![TxIn {
            prevout: OutPoint::null(),
            script_sig: height.to_le_bytes().to_vec(),
            sequence: u32::MAX,
        }],
        vec![TxOut {
            value: 0,
            script_pubkey: vec![0x51],
        }],
    )
}

fn make_header(prev_block: [u8; 32], time: u32, bits: u32, nonce_tag: u8) -> BlockHeader {
    BlockHeader {
        version: CURRENT_VERSION,
        prev_block,
        merkle_root: [0u8; 32],
        final_sapling_root: [0u8; 32],
        time,
        bits,
        nonce: [nonce_tag; 32],
        solution: Vec::new(),
        nodes_collateral: OutPoint::null(),
        block_sig: Vec::new(),
    }
}

#[test]
fn deep_reorg_reverts_utxo_spent_and_address_indexes() {
    let store = Arc::new(MemoryStore::new());
    let dir = tempfile::tempdir().expect("tempdir");
    let blocks = FlatFileStore::new(dir.path(), 10_000_000).expect("flatfiles");
    let undo = FlatFileStore::new_with_prefix(dir.path(), "undo", 10_000_000).expect("flatfiles");
    let chainstate = ChainState::new(Arc::clone(&store), blocks, undo);

    let mut params = chain_params(Network::Regtest);
    params.funding.exchange_height = i64::MAX;
    params.funding.foundation_height = i64::MAX;
    params.swap_pool.start_height = i64::MAX;
    params.fluxnode.start_payments_height = i64::MAX;
    params.consensus.digishield_averaging_window = 10_000;
    params.consensus.upgrades[UpgradeIndex::Lwma.as_usize()].activation_height = i32::MAX;
    params.consensus.upgrades[UpgradeIndex::Equi144_5.as_usize()].activation_height = i32::MAX;
    params.consensus.upgrades[UpgradeIndex::Acadia.as_usize()].activation_height = i32::MAX;
    params.consensus.upgrades[UpgradeIndex::Kamiooka.as_usize()].activation_height = i32::MAX;

    let now = 1_700_000_000u32;
    let bits = target_to_compact(&params.consensus.pow_limit);

    let mut headers = Vec::new();
    let header0 = make_header([0u8; 32], now, bits, 0);
    let hash0 = header0.hash();
    params.consensus.hash_genesis_block = hash0;
    params.consensus.checkpoints = vec![Checkpoint { height: 0, hash: hash0 }];
    headers.push(header0.clone());

    let mut prev = hash0;
    for height in 1u32..=100u32 {
        let header = make_header(prev, now + height, bits, (height & 0xff) as u8);
        prev = header.hash();
        headers.push(header);
    }
    let base_hash = prev;

    let fork1_101 = make_header(base_hash, now + 101, bits, 0xa1);
    let fork1_101_hash = fork1_101.hash();
    let fork2_101 = make_header(base_hash, now + 101, bits, 0xb1);
    let fork2_101_hash = fork2_101.hash();

    let fork1_102 = make_header(fork1_101_hash, now + 102, bits, 0xa2);
    let fork1_102_hash = fork1_102.hash();
    let fork2_102 = make_header(fork2_101_hash, now + 102, bits, 0xb2);
    let fork2_102_hash = fork2_102.hash();

    let fork1_103 = make_header(fork1_102_hash, now + 103, bits, 0xa3);
    let fork1_103_hash = fork1_103.hash();
    let fork2_103 = make_header(fork2_102_hash, now + 103, bits, 0xb3);

    headers.extend_from_slice(&[
        fork1_101.clone(),
        fork2_101.clone(),
        fork1_102.clone(),
        fork2_102.clone(),
        fork1_103.clone(),
        fork2_103.clone(),
    ]);

    let mut header_batch = WriteBatch::new();
    chainstate
        .insert_headers_batch_with_pow(&headers, &params.consensus, &mut header_batch, false)
        .expect("insert headers");
    chainstate.commit_batch(header_batch).expect("commit headers");

    let flags = ValidationFlags::default();

    let coinbase0 = coinbase_tx(0);
    let coinbase0_txid = coinbase0.txid().expect("coinbase txid");

    for height in 0u32..=100u32 {
        let header = headers[height as usize].clone();
        let coinbase = if height == 0 { coinbase0.clone() } else { coinbase_tx(height) };
        let block = Block {
            header,
            transactions: vec![coinbase],
        };
        let batch = chainstate
            .connect_block(&block, height as i32, &params, &flags, true, None, None, None, None)
            .expect("connect block");
        chainstate.commit_batch(batch).expect("commit block");
    }

    let script_a = p2pkh_script(0x11);
    let script_b = p2pkh_script(0x22);

    let coinbase0_outpoint = OutPoint {
        hash: coinbase0_txid,
        index: 0,
    };

    let fund_tx = make_tx(
        vec![TxIn {
            prevout: coinbase0_outpoint.clone(),
            script_sig: vec![0x01],
            sequence: u32::MAX,
        }],
        vec![TxOut {
            value: 0,
            script_pubkey: script_a.clone(),
        }],
    );
    let fund_txid = fund_tx.txid().expect("fund txid");
    let fund_outpoint = OutPoint { hash: fund_txid, index: 0 };

    let block101_f1 = Block {
        header: fork1_101,
        transactions: vec![coinbase_tx(101), fund_tx],
    };
    let batch = chainstate
        .connect_block(&block101_f1, 101, &params, &flags, true, None, None, None, None)
        .expect("connect 101 fork1");
    chainstate.commit_batch(batch).expect("commit 101 fork1");

    let spend_tx = make_tx(
        vec![TxIn {
            prevout: fund_outpoint.clone(),
            script_sig: vec![0x02],
            sequence: u32::MAX,
        }],
        vec![TxOut {
            value: 0,
            script_pubkey: script_b.clone(),
        }],
    );
    let spend_txid = spend_tx.txid().expect("spend txid");
    let spend_outpoint = OutPoint { hash: spend_txid, index: 0 };

    let block102_f1 = Block {
        header: fork1_102,
        transactions: vec![coinbase_tx(102), spend_tx],
    };
    let batch = chainstate
        .connect_block(&block102_f1, 102, &params, &flags, true, None, None, None, None)
        .expect("connect 102 fork1");
    chainstate.commit_batch(batch).expect("commit 102 fork1");

    let block103_f1 = Block {
        header: fork1_103,
        transactions: vec![coinbase_tx(103)],
    };
    let batch = chainstate
        .connect_block(&block103_f1, 103, &params, &flags, true, None, None, None, None)
        .expect("connect 103 fork1");
    chainstate.commit_batch(batch).expect("commit 103 fork1");

    assert!(chainstate.utxo_exists(&spend_outpoint).expect("utxo exists"));
    assert_eq!(
        chainstate.address_outpoints(&script_b).expect("address outpoints"),
        vec![spend_outpoint.clone()]
    );

    let spent = chainstate
        .spent_info(&fund_outpoint)
        .expect("spent index")
        .expect("spent info");
    assert_eq!(spent.txid, spend_txid);

    for hash in [fork1_103_hash, fork1_102_hash, fork1_101_hash] {
        let batch = chainstate.disconnect_block(&hash).expect("disconnect");
        chainstate.commit_batch(batch).expect("commit disconnect");
    }

    assert!(chainstate.utxo_exists(&coinbase0_outpoint).expect("utxo exists"));
    assert!(!chainstate.utxo_exists(&fund_outpoint).expect("utxo exists"));
    assert!(!chainstate.utxo_exists(&spend_outpoint).expect("utxo exists"));

    assert_eq!(chainstate.spent_info(&coinbase0_outpoint).expect("spent index"), None);

    assert!(chainstate
        .address_outpoints(&script_a)
        .expect("address outpoints")
        .is_empty());
    assert!(chainstate
        .address_outpoints(&script_b)
        .expect("address outpoints")
        .is_empty());

    let block101_f2 = Block {
        header: fork2_101,
        transactions: vec![coinbase_tx(101)],
    };
    let batch = chainstate
        .connect_block(&block101_f2, 101, &params, &flags, true, None, None, None, None)
        .expect("connect 101 fork2");
    chainstate.commit_batch(batch).expect("commit 101 fork2");

    let block102_f2 = Block {
        header: fork2_102,
        transactions: vec![coinbase_tx(102)],
    };
    let batch = chainstate
        .connect_block(&block102_f2, 102, &params, &flags, true, None, None, None, None)
        .expect("connect 102 fork2");
    chainstate.commit_batch(batch).expect("commit 102 fork2");

    let block103_f2 = Block {
        header: fork2_103,
        transactions: vec![coinbase_tx(103)],
    };
    let batch = chainstate
        .connect_block(&block103_f2, 103, &params, &flags, true, None, None, None, None)
        .expect("connect 103 fork2");
    chainstate.commit_batch(batch).expect("commit 103 fork2");

    assert!(!chainstate.utxo_exists(&fund_outpoint).expect("utxo exists"));
    assert!(chainstate
        .address_outpoints(&script_a)
        .expect("address outpoints")
        .is_empty());
}
