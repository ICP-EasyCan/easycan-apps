# syntax=docker/dockerfile:1
#
# Dockerfile — build riproducibile del WASM di un'app EasyCan (segnale di fiducia §A).
#
# Obiettivo: chiunque, su qualsiasi macchina, rifà questa build e ottiene lo STESSO
# SHA-256 del WASM. Quello SHA-256 è il `module_hash` che l'IC certifica per il
# canister installato → la pagina #verify in-app lo confronta con la release GitHub.
#
# I 4 pin che rendono l'hash deterministico (vedi PoC in docs/build/REPRODUCIBLE_BUILD.md):
#   1. rustc        → immagine base rust:1.95.0 + rust-toolchain.toml
#   2. binaryen     → tarball pinnato version_129 (checksum verificato sotto)
#   3. RUSTFLAGS    → --remap-path-prefix per azzerare i path machine-specific
#   4. Cargo.lock   → committato nel repo (dipendenze esatte)
#
# Uso:
#   docker build --build-arg PACKAGE=vault-canister     -t easycan-verify .
#   docker build --build-arg PACKAGE=messenger-canister -t easycan-verify .
#   docker run --rm easycan-verify         # stampa gli SHA-256 (raw + module_hash)
#
# One-liner di verifica (estrae solo il wasm finale):
#   docker run --rm easycan-verify sha256sum /out/app.wasm

FROM rust:1.95.0-bookworm

# ── Pin 2: binaryen 129 (wasm-opt). NON apt: la versione del repo non è controllata.
ARG BINARYEN_VERSION=129
ARG BINARYEN_SHA256=50b9fa62b9abea752da92ec57e0c555fee578760cd237c40107957715d2976ba
ARG BINARYEN_URL=https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz
RUN set -eux; \
    curl -fsSL "$BINARYEN_URL" -o /tmp/binaryen.tar.gz; \
    echo "${BINARYEN_SHA256}  /tmp/binaryen.tar.gz" | sha256sum -c -; \
    tar xzf /tmp/binaryen.tar.gz -C /tmp; \
    install -m0755 "/tmp/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt" /usr/local/bin/wasm-opt; \
    rm -rf /tmp/binaryen.tar.gz "/tmp/binaryen-version_${BINARYEN_VERSION}"; \
    test "$(wasm-opt --version)" = "wasm-opt version ${BINARYEN_VERSION} (version_${BINARYEN_VERSION})"

# ── Pin 3: path canonici. CARGO_HOME sotto $HOME così il remap $HOME=/h cattura
#    anche il registry (replica lo schema del PoC: ~/.cargo → /h/.cargo).
ENV HOME=/root
ENV CARGO_HOME=/root/.cargo
ENV PATH=/root/.cargo/bin:$PATH

# ── Pin 1: rust-toolchain.toml forza 1.95.0 + target wasm32 (idempotente: l'immagine
#    è già 1.95.0). Copiato per primo per fissare la toolchain prima del build.
WORKDIR /src
COPY rust-toolchain.toml ./
RUN rustup target add wasm32-unknown-unknown

# ── Sorgenti (il .dockerignore tiene fuori target/, node_modules/, .dfx/, .git/).
COPY . .

# Quale package compilare (deve avere la feature `platform`).
ARG PACKAGE=vault-canister

# ── Build deterministica. Schema RUSTFLAGS identico al PoC validato.
RUN set -eux; \
    WASM_NAME="$(echo "$PACKAGE" | tr '-' '_')"; \
    export RUSTFLAGS="--remap-path-prefix=${HOME}=/h --remap-path-prefix=${PWD}=/src"; \
    cargo build --target wasm32-unknown-unknown --release -p "$PACKAGE" --features platform; \
    mkdir -p /out; \
    RAW="target/wasm32-unknown-unknown/release/${WASM_NAME}.wasm"; \
    cp "$RAW" /out/app.raw.wasm; \
    # wasm-opt SEMPRE: l'artefatto che va a install_code (e che il module_hash certifica)
    # è il post -Oz --strip-debug, non il raw.
    wasm-opt -Oz --strip-debug /out/app.raw.wasm -o /out/app.wasm; \
    ( cd /out; \
      sha256sum app.raw.wasm > app.raw.wasm.sha256; \
      sha256sum app.wasm     > app.wasm.sha256 ); \
    echo "PACKAGE=${PACKAGE}" > /out/BUILD_INFO; \
    rustc --version >> /out/BUILD_INFO; \
    wasm-opt --version >> /out/BUILD_INFO

# Stampa i due hash: il raw (utile per cross-check col PoC) e il module_hash (post-opt).
CMD ["bash", "-lc", "echo '== EasyCan reproducible build =='; cat /out/BUILD_INFO; echo; echo 'raw WASM (pre wasm-opt):'; cat /out/app.raw.wasm.sha256; echo; echo 'module_hash (post wasm-opt -Oz --strip-debug, = what the IC certifies):'; cat /out/app.wasm.sha256"]
