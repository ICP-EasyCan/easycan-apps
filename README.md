# `dist` — self-upgrade transport branch (read this before trusting it)

This is **not** source code and **not** an audit anchor. It is the **transport channel** the apps
fetch from at runtime: each app downloads `https://raw.githubusercontent.com/<repo>/dist/<app>/manifest.json`
from the browser to discover and install updates (committed files carry the
`Access-Control-Allow-Origin: *` header that GitHub release assets lack).

Layout: `<app>/manifest.json` + `<app>/<version>/{<app>.wasm, frontend.tar.gz}` for each app
(`vault`, `messenger`). The branch is **latest-only**: it is force-pushed as a fresh single commit on
every publish, keeping just the current version of each app.

## What this branch guarantees — and what it does not

- **It is mutable.** Unlike an immutable release tag `<app>-vX.Y.Z`, this branch is force-pushed.
  Whoever controls the repo can update what it serves — including a **frontend-only change without a
  new version tag**. Treat it as "current latest", not as a fixed point in time.

- **The backend is the real anchor, and it is verifiable independently of this branch.** The
  `wasm_sha256` in each `manifest.json` is **reproducible**: rebuild it from the matching tagged commit
  via the Dockerfile (see the [`main` branch README](../../tree/main#reproduce-a-release-hash)) and you
  get the same hash the IC certifies on-chain. The in-app `#verify` badge checks exactly this. A
  tampered WASM here would not match on-chain → caught.

- **The frontend is integrity-checked but not reproducibly verified.** `frontend_sha256` guarantees the
  bundle you download equals the one published here, but the frontend bakes its target network at build
  time, so it does **not** rebuild byte-for-byte from source (`frontend_sha256` differs on every build).
  It is not an audit anchor the way `wasm_sha256` is.

**Bottom line:** sovereignty is enforced by the canister (`msg_caller() == owner`, no backdoor), whose
code is the reproducible WASM — not by this branch. This branch is a convenience for delivering updates;
trust it for *what is the latest UI*, and trust the **WASM hash + on-chain `module_hash`** for *whether
the code is authentic*. Full model: the [`main` branch README](../../tree/main#what-verify-covers--backend-vs-frontend).
