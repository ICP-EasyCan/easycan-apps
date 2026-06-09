# Build riproducibile del WASM — recipe di verifica

> **Perché esiste.** Dopo l'acquisto, dentro l'app (pagina `#verify`), il buyer vede
> l'hash del WASM che il suo canister sta eseguendo — l'IC lo certifica come
> `module_hash`. Questa pagina spiega come **chiunque** può ricompilare il sorgente
> open-source e ottenere lo **stesso** hash, trasformando la fiducia in verifica.
> Segnale di fiducia §A (L0). Il `module_hash` copre il **backend (canister)**; il
> frontend è un asse di verifica separato (vedi caveat in fondo).

## Cosa si verifica

Lo **SHA-256 del modulo WASM** = il `module_hash` che il protocollo IC certifica a
`install_code`. È lo standard ICP (lo leggono `dfx canister info`, la dashboard IC,
e la pagina `#verify`), pubblico e non falsificabile. **Non** è il Blake3 interno
della pipeline spawner↔factory: quello resta un dettaglio d'integrità interna.

L'artefatto verificabile è il WASM **dopo** `wasm-opt -Oz --strip-debug` — è ciò che
finisce on-chain, quindi ciò che l'hash certifica. Per questo `scripts/build-app-wasm.sh`
ora esegue wasm-opt in modo **obbligatorio** (non più condizionale) e fallisce se la
versione di binaryen non è quella pinnata.

## I 4 pin che rendono l'hash deterministico

Il PoC (2026-06-05, validato su `vault-canister` con vetkeys e `messenger-canister`)
ha mostrato che la build è già deterministica; l'unico dato machine-specific che
trapelava era il path locale (stringhe di panic/debug), azzerato dal remap. Bastano:

1. **rustc** — `1.95.0`. Pin via `rust-toolchain.toml` (root) e immagine base `rust:1.95.0`.
2. **binaryen / wasm-opt** — `129`. Pin via tarball versionato (GitHub release), **non**
   `apt install binaryen` (versione non controllata). Checksum nel `Dockerfile`.
3. **RUSTFLAGS remap** — `--remap-path-prefix=$HOME=/h --remap-path-prefix=$PWD=/src`.
   Collassa i path machine-specific a path canonici → stesso hash su macchine diverse.
   In Docker `CARGO_HOME` è messo sotto `$HOME` così il remap cattura anche il registry.
4. **Cargo.lock** — committato nel repo (dipendenze esatte).

## Come verificare (Docker — consigliato)

Docker è solo il veicolo pulito che pinna rustc + binaryen + remap (toglie il
"funziona da me"). Non è obbligatorio, ma è ciò che la comunità si aspetta.

```bash
# Vault
docker build --build-arg PACKAGE=vault-canister     -t easycan-verify .
docker run --rm easycan-verify          # stampa raw + module_hash

# Messenger
docker build --build-arg PACKAGE=messenger-canister -t easycan-verify .
docker run --rm easycan-verify

# Solo l'hash finale (module_hash):
docker run --rm easycan-verify sha256sum /out/app.wasm
```

Lo SHA-256 di `/out/app.wasm` deve combaciare con:
- il `Module hash` di `dfx canister info <canister-id>` (o della dashboard IC) del
  canister installato;
- l'hash pubblicato nella GitHub Release di quella versione (Fase 2).

## Come verificare (senza Docker)

Serve rustc 1.95.0 + binaryen 129 + il repo a un commit/tag preciso:

```bash
export RUSTFLAGS="--remap-path-prefix=$HOME=/h --remap-path-prefix=$PWD=/src"
./scripts/build-app-wasm.sh -p vault-canister -o /tmp/out
# stampa: ==> module_hash (SHA-256, post wasm-opt): <hash>
```

Senza il remap l'hash è ancora deterministico **sulla stessa macchina** ma differisce
cross-machine (path diversi); con il remap combacia ovunque.

## Tagliare una release (release flow)

Ogni versione pubblicata deve avere su GitHub: il **commit**, lo **SHA-256**
(= `module_hash`) e il riferimento al `Dockerfile` con cui è stata costruita. Così la
pagina `#verify` dentro l'app ha un valore autoritativo contro cui confrontare l'hash
live, e chiunque può rifare la build e ottenere lo stesso hash.

> **La pipeline di provisioning produce già l'artefatto verificabile.**
> `scripts/build-factory.sh` (usato da `platform/portal/deploy.sh`) **non** fa più un
> `cargo build` grezzo: delega a `scripts/build-app-wasm.sh` con lo schema remap, quindi
> il WASM caricato nel factory — e installato sul canister del buyer — è il **post
> `wasm-opt`** con `module_hash` riproducibile. Il `module_hash` live di `#verify`
> coincide perciò con l'hash che stampa `build-app-wasm.sh` e con quello del Dockerfile
> sullo stesso commit. (Prima di questo allineamento il marketplace installava il WASM
> grezzo, pre-`wasm-opt`: l'hash on-chain non era riproducibile dalla recipe → falso
> mismatch in `#verify`.) Docker resta la garanzia *cross-machine*: dimostra che l'hash
> non dipende dalla macchina di chi builda.

1. **Commit pulito.** Assicurati che il working tree sia committato (l'hash dipende dal
   sorgente esatto). Annota il commit SHA: `git rev-parse HEAD`.

2. **Build deterministica via Docker** (lo stesso comando che userà chi verifica):

   ```bash
   docker build --build-arg PACKAGE=vault-canister -t easycan-verify .
   SHA=$(docker run --rm easycan-verify sha256sum /out/app.wasm | cut -d' ' -f1)
   echo "$SHA"
   ```

   Questo SHA-256 è il `module_hash` che il canister esporrà on-chain dopo
   `install_code`, ed è ciò che la pagina `#verify` mostra come hash live.

3. **GitHub Release.** Crea una release con:
   - **tag** = la versione (es. `vault-v0.3.0`); usa un prefisso per-app se vault e
     messenger versionano in modo indipendente.
   - **body** = il commit SHA del punto 1 + lo SHA-256 del punto 2 + un link al
     `Dockerfile` (a quel commit) e a `docs/build/REPRODUCIBLE_BUILD.md`.

   Bozza di body:

   ```
   Reproducible build — backend WASM (module_hash)

   - Source commit: <git-sha>
   - module_hash (SHA-256, post wasm-opt -Oz --strip-debug): <sha256>
   - Build recipe: ./Dockerfile @ <git-sha>  ·  docs/build/REPRODUCIBLE_BUILD.md
   - Verify: docker build --build-arg PACKAGE=vault-canister -t easycan-verify .
             docker run --rm easycan-verify sha256sum /out/app.wasm

   The hash covers the backend (canister) code. Frontend assets are verified on a
   separate track (see REPRODUCIBLE_BUILD.md → "Caveat onesto").
   ```

4. **Upload via uploader.** Carica lo **stesso** artefatto (post wasm-opt) nel factory:

   ```bash
   cd platform/tools/saas_uploader && cargo build --release
   ./target/release/saas_uploader --target factory \
     --wasm <path al wasm post-opt> --canister-id <app_factory_id> --finalize
   ```

   L'uploader stampa **due** hash con label esplicite:

   ```
   Blake3  — internal pipeline integrity : <blake3>
   SHA-256 — module_hash, public verify  : <sha256>
   ```

   Lo **SHA-256** stampato deve combaciare con quello del punto 2 (Dockerfile) e con il
   `module_hash` live del canister provisionato. Se non combacia, hai caricato un wasm
   diverso da quello buildato/pubblicato — non rilasciare.

5. **Allinea la pagina `#verify`.** Aggiorna le costanti `VERIFY.{repoUrl, releaseTag,
   releaseSha256}` in `apps/{vault,messenger}/frontend/src/main.js` con repo, tag della
   release e SHA-256. Finché sono `null` la pagina degrada onesta (mostra solo l'hash
   live, senza badge "matches release").

> **Invariante**: lo stesso artefatto post-`wasm-opt` attraversa tutti i punti
> (Dockerfile → SHA-256 → Release → uploader → `module_hash` on-chain → `#verify`). È
> l'unico modo perché i tre hash combacino. `build-app-wasm.sh` rende wasm-opt
> obbligatorio proprio per non poter pubblicare/caricare un wasm non ottimizzato.

## Release automatica via GitHub Action (`.github/workflows/release.yml`)

Il flusso manuale sopra è **automatizzato** dalla Action `release`, che è anche il motore del
self-upgrade (§B): a ogni tag `vault-v*` / `messenger-v*` produce gli artefatti **dallo stesso
`Dockerfile`** (così l'hash pubblicato è quello che chiunque riproduce con `docker build`) e li
allega come release assets. Decisioni e razionale: `memory/progetti/attivi/self_upgrade_piano.md`.

Cosa fa, in ordine:
1. **Tag guard** — fallisce se il tag (`vault-v0.3.0` → `0.3.0`) ≠ `version` in
   `apps/<app>/canister/Cargo.toml`. `Cargo.toml [package] version` è l'**unica fonte di verità**
   per la versione, condivisa con l'endpoint backend `app_version()` (macro `core_types::app_version!()`,
   `env!("CARGO_PKG_VERSION")`) e con `manifest.version` → non possono divergere.
2. **Build WASM via `Dockerfile`** → `sha256sum` = `module_hash` post `wasm-opt`.
3. **Build frontend** mainnet (`DFX_NETWORK=ic`) → `frontend.tar.gz`.
4. **`scripts/make-manifest.sh`** → `manifest.json` (vedi sotto).
5. **Release immutabile `<app>-vX.Y.Z`** — ancora d'audit: binari + manifest, body con commit + hash
   + recipe di verifica. **Rolling tag pre-release `<app>-latest`** — solo `manifest.json`, ri-spostato
   sul commit corrente a ogni release. L'app fa `fetch` di
   `releases/download/<app>-latest/manifest.json` (path fisso, niente GitHub API) e da lì segue gli URL
   immutabili dei binari. La pre-release non ruba il badge "Latest" del repo.

### `manifest.json` — il contratto del self-upgrade

```json
{
  "app": "vault",
  "version": "0.3.0",
  "min_compatible_version": "0.1.0",
  "wasm_url": "https://github.com/<repo>/releases/download/vault-v0.3.0/vault_canister.wasm",
  "wasm_sha256": "<= module_hash post wasm-opt = wasm_module_hash di install_chunked_code>",
  "frontend_url": "https://github.com/<repo>/releases/download/vault-v0.3.0/frontend.tar.gz",
  "frontend_sha256": "<sha256 del tarball dist/>",
  "released_at": "2026-06-06T00:00:00Z",
  "source_commit": "<git-sha da cui rifare la build>",
  "notes": "…"
}
```

Gli `*_url` puntano al tag **immutabile** (permanenti); il rolling tag è solo il punto di scoperta
del manifest. `wasm_sha256` chiude il cerchio §A↔§B: è insieme l'hash che `#verify` confronta, il
`module_hash` on-chain, e il `wasm_module_hash` che Fase 2 passa a `install_chunked_code`.

> **Punto 5 manuale ancora valido:** dopo la prima Release, allinea `VERIFY.{repoUrl, releaseTag,
> releaseSha256}` (e in §B `UPGRADE = { repo, channel }`) in `apps/{vault,messenger}/frontend/src/main.js`.

## Valori di riferimento (informativi)

> ⚠️ Questi hash dipendono dal **sorgente esatto** a un commit dato — cambiano a ogni
> modifica del codice. Il valore autoritativo per una versione è quello nella sua
> GitHub Release (Fase 2). Qui solo come sanity check del meccanismo, al momento della
> scrittura di questa nota (branch `feat/resend-claim-backend`, toolchain rustc 1.95.0
> + binaryen 129, schema remap sopra):

| App | `module_hash` (post wasm-opt -Oz --strip-debug) |
|-----|--------------------------------------------------|
| messenger-canister | `51aee5cd970c17d4e47a4ff0eedf92727feb46618ea79a61dd0bfd3b4c9798b8` |
| vault-canister     | `3753535deba2e30f9f78630143c7f7ee28e9173db099aad62038251c1e7bf21a` |

Due build consecutive con la stessa toolchain danno SHA-256 identico (verificato).

## Caveat onesto — il `module_hash` copre solo il backend

Gli asset frontend (serviti via HTTP certification v2) **non** sono nel `module_hash`.
Per il **Vault**, la cifratura E2EE vive nel frontend JS (`@shared/core/crypto.js`):
"verifica WASM" via `module_hash` **non** prova quel codice. La copy della pagina
`#verify` lo dice esplicitamente; il frontend è un asse di verifica a parte (hash
certificati degli asset + repro-build del bundle JS). Nasconderlo sarebbe overclaim.

## Bumpare i pin

- **rustc**: aggiorna `channel` in `rust-toolchain.toml` e il tag in `FROM rust:<ver>`
  del `Dockerfile`. Rigenera e ripubblica gli hash di riferimento.
- **binaryen**: aggiorna `BINARYEN_VERSION` + `BINARYEN_SHA256` nel `Dockerfile` e
  `EXPECTED_BINARYEN` in `scripts/build-app-wasm.sh`. Il checksum si ricava con
  `curl -fsSL <url> | sha256sum`.
