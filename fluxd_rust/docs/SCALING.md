# Scaling & Staging (VPS / Flux)

## Primary bottlenecks

- `fluxd_rust` sync + indexing throughput (CPU + SSD IOPS)
- `explorer-api` upstream timeouts (RPC calls, fanout endpoints)
- `flux-explorer` SSR throughput (CPU)

## Scale-up first

- Recommended: 8 vCPU / 16 GB RAM / 200 GB SSD (enough for chainstate + indexes + some headroom)
- Heavy: 16 vCPU / 32 GB RAM / 500 GB SSD (room for snapshots/backups, logs, and growth)

## Cache strategy

- Put a CDN/WAF in front of the public domain and cache aggressively.
- Cache candidates:
  - `/api/v1/status` (short TTL)
  - `/api/v1/sync` (short TTL)
  - `/api/v1/blocks/latest` (short TTL)
  - `/api/v1/supply` (long TTL + stale-while-revalidate)
  - `/api/v1/richlist` (long TTL + stale-while-revalidate)

## Rate limiting

- Keep rate limits at the edge when possible.
- If rate limiting is done in `explorer-api`, keep it per-IP and per-endpoint.

## Availability

- If you need a hot standby, run a second stack with independent volumes.
- `flux-explorer` can be scaled horizontally behind a load balancer.
- `explorer-api` can be scaled horizontally if it stays stateless.

## Staging

Checklist:
- Separate volumes (never share `/data` between prod and staging).
- Validate: `./fluxd_rust/scripts/vps_deploy_smoke_checklist.sh --public-url <staging-url>`

## Promotion

- Deploy staging build
- Validate staging smoke + health
- Deploy production
- Validate production smoke + health
- Compare `GET /api/v1/status` between staging/prod
