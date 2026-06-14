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

## What `#verify` covers — backend vs frontend
The verification model deliberately draws a line between the two halves of an app, because they do
**not** offer the same guarantee. Read this before trusting a green badge:

- **Backend (the WASM): reproducible + verified.** This is where sovereignty actually lives — the
  canister enforces `msg_caller() == owner`, with no backdoor and no admin recovery. Anyone can
  rebuild the WASM from a tagged commit via the Dockerfile and get the **same `wasm_sha256`** the IC
  certifies on-chain. The in-app `#verify` badge compares the live `module_hash` against this hash.
  A malicious frontend cannot forge your principal or take the canister: the trust anchor is here.

- **Frontend (the UI bundle): integrity-checked, *not* reproducibly verified.** The frontend is served
  with HTTP certification (the bytes you receive are the bytes the canister holds) and the self-upgrade
  download is checked against `frontend_sha256` in the manifest (the downloaded bundle matches what was
  published). But the frontend **bakes the target network at build time** (`DFX_NETWORK`), so the same
  source does **not** rebuild to the same bytes — `frontend_sha256` changes on every build and **cannot
  be reproduced from source** the way the WASM can. It guards *integrity of a specific published
  bundle*, not *reproducible authenticity*.

**Consequence — read this honestly:** a frontend-only fix changes `frontend_sha256` while `wasm_sha256`
stays byte-identical. The immutable release tag and the `#verify` badge (both anchored on the WASM) are
**unaffected and stay green** — correctly, because the backend really is unchanged. The new UI reaches
the installed base through the **mutable `dist` branch** (see its own `README`), refreshed without a new
version tag. This is a convenience trade-off: whoever controls the repo can update the served UI without
a version bump. It does **not** weaken the sovereignty guarantee (that is enforced by the backend), but
it is a softer spot than the WASM, and we state it rather than hide it.
