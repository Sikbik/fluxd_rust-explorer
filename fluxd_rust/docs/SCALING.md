# Scaling & Staging (VPS / Flux)

This is a pragmatic ops note for scaling the public explorer stack.

## Primary bottlenecks

- `fluxd_rust` sync + indexing throughput (CPU + SSD IOPS)
- `explorer-api` upstream timeouts (RPC calls, fanout endpoints)
- `flux-explorer` SSR throughput (CPU)

## Scale-up first

For public traffic, prefer scaling up a single node before adding complexity.

- Recommended: 8 vCPU / 16 GB RAM / 500 GB SSD
- Heavy: 16 vCPU / 32 GB RAM / 1 TB SSD

## Cache and rate limiting

- `explorer-api` already sets `Cache-Control` for hot endpoints and rate-limits `/api/v1/*`.
- For higher traffic, put a CDN/WAF in front of the public domain and cache:
  - `/api/v1/status`, `/api/v1/sync` (short TTL)
  - `/api/v1/supply`, `/api/v1/richlist` (long TTL + stale-while-revalidate)

## Staging

Create a staging deploy with the same stack but a separate app name / domain.

Checklist:
- Staging uses its own volumes (never share `/data` between prod and staging).
- Run `./scripts/vps_deploy_smoke_checklist.sh --public-url <staging-url>`
- Run Playwright smoke suite against staging before promoting.

## Promotion

- Deploy staging build
- Validate staging smoke + health
- Deploy production
- Validate production smoke + health
- Compare `GET /api/v1/status` between staging/prod for lag and uptime sanity
