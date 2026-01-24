# Backup / Restore (VPS + Flux)

This document describes a pragmatic backup/restore strategy for the Flux explorer stack.

## What needs backups

### Critical (`fluxd-data` volume → `/data`)

- `/data/wallet.dat` (private keys, Sapling scan cursor, wallet metadata)
- `/data/db/` (Fjall partitions: UTXO set + secondary indexes)
- `/data/blocks/` (flatfiles + undo; enables reindex without full re-download)

### Medium (`explorer-data` volume → `/app/data`)

- `/app/data/price-cache.db` (SQLite cache used for CSV export and price lookups)

## Minimum viable strategy

1. **Daily**: backup `wallet.dat` (small, most important)
2. **Weekly**: backup `price-cache.db`
3. **Monthly or before upgrades**: backup full `/data` (large)

If you lose `db/` but keep `blocks/`, you can recover by running `--reindex` (or selective `--reindex-*` flags).

## Safe procedure

### Wallet-only backup (preferred)

Use the daemon RPC `backupwallet <destination>` (online-safe).

Example (Docker Compose stack on VPS):

```bash
# Run inside the fluxd container (requires container has access to the target path)
docker exec -i fluxd \
  sh -lc 'curl -sS -u "$FLUXD_RPC_USER:$FLUXD_RPC_PASS" \
    "http://127.0.0.1:16124/daemon/backupwallet?destination=/data/backups/wallet-$(date +%F).dat"'
```

Notes:
- Keep backups outside `/data` if you are copying the full volume elsewhere.
- Consider encrypting the wallet (`encryptwallet`) and backing up the passphrase securely.

### Volume tar backup (offline-safe)

For consistent snapshots of a live DB, stop the stack first.

```bash
# Stop services (VPS)
docker compose -f docker-compose.vps.yml down

mkdir -p /srv/backups/explorer-rust

# Backup named volumes using a helper container
# (replace project prefix if needed)
docker run --rm \
  -v explorer-rust_fluxd-data:/source:ro \
  -v /srv/backups/explorer-rust:/backup \
  busybox \
  sh -lc 'tar czf /backup/fluxd-data-$(date +%F).tar.gz -C /source .'

docker run --rm \
  -v explorer-rust_explorer-data:/source:ro \
  -v /srv/backups/explorer-rust:/backup \
  busybox \
  sh -lc 'tar czf /backup/explorer-data-$(date +%F).tar.gz -C /source .'

# Restart
docker compose -f docker-compose.vps.yml up -d
```

## Restore

### Restore full volumes

```bash
# Stop
docker compose -f docker-compose.vps.yml down

# Create volumes if missing
docker volume create explorer-rust_fluxd-data || true
docker volume create explorer-rust_explorer-data || true

# Restore from tarballs

docker run --rm \
  -v explorer-rust_fluxd-data:/restore \
  -v /srv/backups/explorer-rust:/backup \
  busybox \
  sh -lc 'tar xzf /backup/fluxd-data-YYYY-MM-DD.tar.gz -C /restore'

docker run --rm \
  -v explorer-rust_explorer-data:/restore \
  -v /srv/backups/explorer-rust:/backup \
  busybox \
  sh -lc 'tar xzf /backup/explorer-data-YYYY-MM-DD.tar.gz -C /restore'

# Start
docker compose -f docker-compose.vps.yml up -d
```

### Post-restore validation

- Run `./fluxd_rust/scripts/vps_deploy_smoke_checklist.sh --public-url https://<domain>`
- If indexes are corrupted but blocks exist: restart `fluxd` with `--reindex` (see `docs/OPERATIONS.md`)

## Snapshot bootstraps

If you need fast bootstrap for new nodes, see `docs/FAST_SYNC.md`.
