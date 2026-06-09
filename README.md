# EasyCan — verifiable app sources

Reproducible source for the EasyCan sovereign apps (**vault**, **messenger**). This repository is
the **trust anchor**: anyone can rebuild a canister's WASM from a tagged commit and obtain the same
`module_hash` the Internet Computer certifies on-chain (the in-app `#verify` page shows it live).

This is a **generated subset** of a private development monorepo; the EasyCan marketplace/portal
backend is intentionally **not** part of it (it is irrelevant to verifying the apps).

## Reproduce a release hash
```
docker build --build-arg PACKAGE=vault-canister -t easycan-verify .
docker run --rm easycan-verify sha256sum /out/app.wasm
```
The printed SHA-256 must equal `wasm_sha256` in the release `manifest.json` and the on-chain
`module_hash`. Details: `docs/build/REPRODUCIBLE_BUILD.md`.

## Releases & self-upgrade
Each tag `vault-vX.Y.Z` / `messenger-vX.Y.Z` triggers `.github/workflows/release.yml`, which builds
via the Dockerfile and publishes the WASM, the frontend bundle and `manifest.json` as an immutable
release, and force-pushes them to the `dist` branch (latest-only). Apps discover and download updates
from the browser via `https://raw.githubusercontent.com/<repo>/dist/<app>/manifest.json` — committed
files carry the `Access-Control-Allow-Origin: *` header that release assets lack.
