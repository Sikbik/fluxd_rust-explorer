# Parity tests (C++ fluxd)

This repo does not depend on the legacy C++ daemon at runtime.

Instead, parity is enforced via a growing suite of unit tests that assert C++-compatible response shapes and invariants for RPC methods.

## RPC schema parity

In `fluxd_rust/crates/node/src/rpc.rs`, the test module contains `*_has_cpp_schema_keys` tests.

These tests validate that:
- required keys are present
- key types are compatible (string/int/bool/array/object)
- hex fields are the expected length

They are designed to catch drift in RPC response structure that would break clients.

## Running

From `fluxd_rust/`:

```bash
cargo test -p fluxd has_cpp_schema_keys
```

On a VPS, this can be run after a build as a fast sanity check before running mainnet smoke scripts.
