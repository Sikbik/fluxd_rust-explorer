FROM rust:1.75.0-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    cmake \
    pkg-config \
    libssl-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY . ./

RUN cargo build -p fluxd --release --locked

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -r -u 10001 -m -d /home/fluxd fluxd

COPY --from=builder /src/target/release/fluxd /usr/local/bin/fluxd
COPY --from=builder /src/target/release/fluxd-cli /usr/local/bin/fluxd-cli

USER fluxd
WORKDIR /data

VOLUME ["/data"]

# P2P (mainnet/testnet/regtest), RPC, and dashboard ports.
EXPOSE 16125 26125 36125 16124 26124 36124 8080

ENTRYPOINT ["/usr/local/bin/fluxd-cli"]
CMD ["--network","mainnet","--backend","fjall","--data-dir","/data","--params-dir","/data/params","--fetch-params","--rpc-addr","0.0.0.0:16124","--dashboard-addr","0.0.0.0:8080"]
