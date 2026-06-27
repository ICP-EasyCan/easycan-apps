//! cap-store — KV `namespace:key` sovrano + host bundle (gate hash) del supercanister-hub
//!
//! Due primitive in un solo crate:
//!   1. KV `namespace:key` (MemId STORE_KV_MEM = 80) — storage unico della shell:
//!      indirizzamento per chiave con overwrite (a differenza di cap-crud id-based).
//!      Copre dati delle mini-app installate (bundle) + dati propri della shell.
//!   2. Host bundle (F1) — installa mini-app verificate per hash:
//!      registro meta (MemId STORE_BUNDLE_META = 81) + asset chunked (MemId STORE_ASSETS_MEM = 82).
//!
//! Il GATE (cuore del prodotto): `install_bundle` ricalcola `sha256(bytes)` IN-CANISTER e
//! confronta con l'atteso dichiarato nel manifest. **Mismatch ⇒ rifiuto SENZA STATO**
//! (nessun phantom-install): tutti i check che possono fallire (già-installato → hash → decode)
//! avvengono PRIMA di qualsiasi scrittura. Solo dopo i 3 check si scrive in 81/82.
//!
//! F2: enforcement permessi per-attore (Owner | Bundle(id)) ristretto ai namespace dichiarati.
//!     La policy vive QUI (una sola porta), non nel canister host: deve valere sia per il path
//!     browser (shell, F4) sia per il path server-side senza browser (scheduler, F3). Le primitive
//!     `kv_*` restano la base (= porta-owner, senza restrizioni); sopra sta il layer `kv_*_as(actor, ..)`
//!     che per `Bundle(id)` autorizza contro `storage_namespaces` del registro 81 (persistito in F1).
//!
//! Dipendenze: `sha2` per il gate. Auth (chi è owner/bundle) nel canister host; la policy namespace qui.

use candid::CandidType;
use candid::Principal;
use core_types::Memory;
use ic_stable_structures::storable::{Blob, Bound};
use ic_stable_structures::{StableBTreeMap, Storable};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::cell::RefCell;

// ─── Limiti ──────────────────────────────────────────────────────────────────

const MAX_KEY_SIZE: usize = 256; // "namespace:key" UTF-8
const MAX_VALUE_SIZE: usize = 65_536; // 64 KB per valore
const MAX_ASSET_KEY_SIZE: usize = 512; // "{module_id}/{path}::{i}"
const CHUNK_SIZE: usize = 60_000; // sotto MAX_VALUE_SIZE, margine per overhead Blob

type KeyBlob = Blob<MAX_KEY_SIZE>;
type ValueBlob = Blob<MAX_VALUE_SIZE>;
type MetaKeyBlob = Blob<MAX_KEY_SIZE>; // module_id (≤256)
type AssetKeyBlob = Blob<MAX_ASSET_KEY_SIZE>;

// ─── Tipi bundle (schema manifest — vedi supercanister_bundle_index_schema) ────

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub struct BundlePermissions {
    pub storage_namespaces: Vec<String>,
    pub http_outcall_hosts: Vec<String>,
    pub inter_canister: Vec<String>,
    pub uses_crypto: bool,
    pub uses_timer: bool,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub struct BundleFile {
    pub path: String,
    pub content_type: String,
    pub size: u64,
    pub total_chunks: u32,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub struct BundleMeta {
    pub module_id: String,
    pub version: String,
    pub sha256: String, // hex del bundle verificato (= il gate superato)
    pub size_bytes: u64,
    pub installed_at: u64, // secondi
    pub files: Vec<BundleFile>,
    pub permissions: BundlePermissions,
}

impl Storable for BundleMeta {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).unwrap())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).unwrap()
    }
    fn into_bytes(self) -> Vec<u8> {
        candid::encode_one(&self).unwrap()
    }
    const BOUND: Bound = Bound::Unbounded;
}

/// Asset servito da un bundle (non-certificato). Il canister host costruisce l'HttpResponse.
pub struct ServedAsset {
    pub content_type: String,
    pub body: Vec<u8>,
}

// ─── Storage ──────────────────────────────────────────────────────────────────

thread_local! {
    static KV: RefCell<Option<StableBTreeMap<KeyBlob, ValueBlob, Memory>>> =
        const { RefCell::new(None) };

    // module_id → BundleMeta (registro: hash verificato + permessi + files)
    static BUNDLE_META: RefCell<Option<StableBTreeMap<MetaKeyBlob, BundleMeta, Memory>>> =
        const { RefCell::new(None) };

    // "{module_id}/{path}::{i}" → chunk raw
    static ASSETS: RefCell<Option<StableBTreeMap<AssetKeyBlob, ValueBlob, Memory>>> =
        const { RefCell::new(None) };
}

/// Inizializza lo storage di cap-store. Da chiamare nel `init`/`post_upgrade` del canister host
/// con le tre memorie congelate: STORE_KV_MEM (80), STORE_BUNDLE_META (81), STORE_ASSETS_MEM (82).
pub fn init_storage(kv_mem: Memory, bundle_meta_mem: Memory, assets_mem: Memory) {
    KV.with(|k| *k.borrow_mut() = Some(StableBTreeMap::init(kv_mem)));
    BUNDLE_META.with(|b| *b.borrow_mut() = Some(StableBTreeMap::init(bundle_meta_mem)));
    ASSETS.with(|a| *a.borrow_mut() = Some(StableBTreeMap::init(assets_mem)));
}

fn with_kv<R>(f: impl FnOnce(&mut StableBTreeMap<KeyBlob, ValueBlob, Memory>) -> R) -> R {
    KV.with(|k| {
        let mut guard = k.borrow_mut();
        f(guard.as_mut().expect("cap-store: init_storage() not called"))
    })
}

fn with_meta<R>(f: impl FnOnce(&mut StableBTreeMap<MetaKeyBlob, BundleMeta, Memory>) -> R) -> R {
    BUNDLE_META.with(|b| {
        let mut guard = b.borrow_mut();
        f(guard.as_mut().expect("cap-store: init_storage() not called"))
    })
}

fn with_assets<R>(f: impl FnOnce(&mut StableBTreeMap<AssetKeyBlob, ValueBlob, Memory>) -> R) -> R {
    ASSETS.with(|a| {
        let mut guard = a.borrow_mut();
        f(guard.as_mut().expect("cap-store: init_storage() not called"))
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. KV `namespace:key`
// ═══════════════════════════════════════════════════════════════════════════

fn composite_key(namespace: &str, key: &str) -> String {
    format!("{namespace}:{key}")
}

fn make_key(namespace: &str, key: &str) -> Result<KeyBlob, String> {
    let ck = composite_key(namespace, key);
    KeyBlob::try_from(ck.as_bytes())
        .map_err(|_| format!("cap-store: chiave troppo lunga (max {MAX_KEY_SIZE} byte)"))
}

/// Salva (overwrite) un valore con chiave composita `namespace:key`.
/// Niente panic: rifiuta con `Err` se key o valore eccedono i limiti.
pub fn kv_set(namespace: &str, key: &str, value: &[u8]) -> Result<(), String> {
    let k = make_key(namespace, key)?;
    let v = ValueBlob::try_from(value)
        .map_err(|_| format!("cap-store: valore troppo grande (max {MAX_VALUE_SIZE} byte)"))?;
    with_kv(|m| {
        m.insert(k, v);
    });
    Ok(())
}

/// Legge un valore.
pub fn kv_get(namespace: &str, key: &str) -> Option<Vec<u8>> {
    let k = make_key(namespace, key).ok()?;
    with_kv(|m| m.get(&k).map(|blob| blob.as_ref().to_vec()))
}

/// Cancella un valore. Idempotente.
pub fn kv_delete(namespace: &str, key: &str) -> Result<(), String> {
    let k = make_key(namespace, key)?;
    with_kv(|m| {
        m.remove(&k);
    });
    Ok(())
}

/// Lista le chiavi di un namespace (senza il prefisso `namespace:`).
pub fn kv_list(namespace: &str) -> Vec<String> {
    let prefix = format!("{namespace}:");
    let prefix_bytes = prefix.as_bytes();
    with_kv(|m| {
        m.iter()
            .filter_map(|entry| {
                let key_bytes: &[u8] = entry.key().as_ref();
                if key_bytes.starts_with(prefix_bytes) {
                    let full = String::from_utf8_lossy(key_bytes);
                    full.strip_prefix(&prefix).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect()
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// 1a. Credenziali d'uscita (G1) — registro `__secrets` nel KV (namespace riservato)
// ═══════════════════════════════════════════════════════════════════════════
//
// Le credenziali che l'agente usa **in uscita** (token webhook, bearer, ecc.) vivono nel
// namespace riservato `__secrets` dentro il KV (MemId 80) — gemello di `__presence`/`__release`,
// quindi **bundle-denied** dal guardrail `__` (vedi `authorize` sotto): nessun bundle può
// leggerle/scriverle, nemmeno dichiarandole. **Nessun nuovo MemId, nessun freeze.**
//
// Onestà sul tradeoff: per *usare* un segreto in uscita qualcuno sulla subnet lo vede. Per questo
// è solo-invio e revocabile (= cancellabile). Il chiaro NON è mai esposto on-the-wire: l'unico
// lettore è `get_secret_value`, chiamato dal resolver `{{secret:NAME}}` di cap-automation
// (ristretto ad `Actor::Owner`). Nessun endpoint host `get_secret`.

/// Namespace riservato delle credenziali d'uscita (G1). `__`-prefisso → bundle-denied.
pub const SECRETS_NS: &str = "__secrets";

/// Nome valido per una credenziale: non vuoto, ≤128 byte, charset sicuro `[A-Za-z0-9_.-]` così che
/// il token `{{secret:NAME}}` sia inequivocabile (niente `:`/spazi/`}` che confonderebbero il parser).
fn valid_secret_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Salva (overwrite) una credenziale d'uscita. Owner-gated nell'host.
pub fn set_secret(name: &str, value: &str) -> Result<(), String> {
    if !valid_secret_name(name) {
        return Err("cap-store: nome credenziale non valido (usa A-Z a-z 0-9 _ - . , max 128)".into());
    }
    if value.is_empty() {
        return Err("cap-store: valore credenziale vuoto".into());
    }
    kv_set(SECRETS_NS, name, value.as_bytes())
}

/// Revoca (cancella) una credenziale. Idempotente.
pub fn delete_secret(name: &str) -> Result<(), String> {
    kv_delete(SECRETS_NS, name)
}

/// Nomi delle credenziali registrate (mai i valori). Per l'host che ritorna nomi + mascherato.
pub fn secret_names() -> Vec<String> {
    kv_list(SECRETS_NS)
}

/// USO INTERNO (resolver d'uscita `{{secret:NAME}}` di cap-automation): legge il **chiaro** di una
/// credenziale. **Mai esporre on-the-wire** — nessun endpoint host la chiama direttamente; vive
/// dietro il resolver ristretto ad `Actor::Owner`. `None` se assente.
pub fn get_secret_value(name: &str) -> Option<Vec<u8>> {
    kv_get(SECRETS_NS, name)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1b. Enforcement permessi per-attore (F2)
// ═══════════════════════════════════════════════════════════════════════════
//
// L'attore che tocca il KV è `Owner` (la shell/utente, senza restrizioni) oppure un
// `Bundle(module_id)` (una mini-app installata). Un bundle può leggere/scrivere SOLO i
// namespace che ha dichiarato nel suo manifest (`permissions.storage_namespaces`, registro 81).
// `CandidType`/`Deserialize` per poter passare l'attore sul filo dallo scheduler (F3) / shell (F4).

/// Prefisso dei namespace **riservati alla shell/host** (es. `__presence` per il battito F1).
/// Un `Bundle` NON può toccarli, **anche se li dichiara** nel manifest: la presenza-owner non
/// dev'essere falsificabile da un'app installata (sostrato del dead-man's switch). L'`Owner`
/// (shell + job `owning_bundle:None`) resta libero — è il solo a poter scrivere il battito.
const RESERVED_NS_PREFIX: &str = "__";

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub enum Actor {
    Owner,
    Bundle(String), // module_id del bundle che agisce
}

/// Verifica che `actor` possa accedere a `namespace`.
/// Owner: sempre. Bundle(id): solo i `storage_namespaces` dichiarati (registro 81).
/// Bundle non installato o namespace non dichiarato → `Err` (rifiuto, niente stato toccato).
fn authorize(actor: &Actor, namespace: &str) -> Result<(), String> {
    match actor {
        Actor::Owner => Ok(()),
        Actor::Bundle(id) => {
            // Namespace riservato → negato a prescindere dalla dichiarazione (battito non falsificabile).
            if namespace.starts_with(RESERVED_NS_PREFIX) {
                return Err(format!(
                    "cap-store: namespace riservato '{namespace}' — accesso negato ai bundle"
                ));
            }
            let mk = meta_key(id)?;
            let meta = with_meta(|m| m.get(&mk))
                .ok_or_else(|| format!("cap-store: bundle '{id}' non installato"))?;
            if meta.permissions.storage_namespaces.iter().any(|n| n == namespace) {
                Ok(())
            } else {
                Err(format!(
                    "cap-store: permesso negato — il bundle '{id}' non dichiara il namespace '{namespace}'"
                ))
            }
        }
    }
}

/// Scrive nel KV nel contesto di `actor`. Bundle ristretto ai namespace dichiarati.
pub fn kv_set_as(actor: &Actor, namespace: &str, key: &str, value: &[u8]) -> Result<(), String> {
    authorize(actor, namespace)?;
    kv_set(namespace, key, value)
}

/// Legge dal KV nel contesto di `actor`. `Result` (non `Option`) per distinguere
/// **permesso negato** (`Err`) da **chiave assente** (`Ok(None)`): la lettura cross-bundle è un rifiuto.
pub fn kv_get_as(actor: &Actor, namespace: &str, key: &str) -> Result<Option<Vec<u8>>, String> {
    authorize(actor, namespace)?;
    Ok(kv_get(namespace, key))
}

/// Cancella dal KV nel contesto di `actor`. Bundle ristretto ai namespace dichiarati.
pub fn kv_delete_as(actor: &Actor, namespace: &str, key: &str) -> Result<(), String> {
    authorize(actor, namespace)?;
    kv_delete(namespace, key)
}

/// Lista le chiavi di un namespace nel contesto di `actor`. Bundle ristretto ai namespace dichiarati.
pub fn kv_list_as(actor: &Actor, namespace: &str) -> Result<Vec<String>, String> {
    authorize(actor, namespace)?;
    Ok(kv_list(namespace))
}

/// Estrae l'host (`authority` senza userinfo/porta) da una URL. Zero-dep, conservativo:
/// scheme `://` host `[:port][/...]`. Restituisce l'host in minuscolo, o `Err` se malformata.
/// Vive QUI (la porta) e non in cap-automation: l'estrazione è parte della decisione di sicurezza —
/// se la facesse il chiamante, un parsing diverso aprirebbe un bypass al confinamento.
fn host_of(url: &str) -> Result<String, String> {
    let after_scheme = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .ok_or_else(|| format!("cap-store: URL senza schema: '{url}'"))?;
    // L'authority finisce al primo '/', '?' o '#'.
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // Scarta eventuale userinfo (`user@host`) e porta (`host:port`).
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        return Err(format!("cap-store: host vuoto in URL: '{url}'"));
    }
    Ok(host.to_ascii_lowercase())
}

/// Seconda porta (F3b): autorizza un **HTTP outcall** di `actor` verso `url`.
/// Owner: sempre. Bundle(id): solo se l'host della URL ∈ `permissions.http_outcall_hosts` (registro 81).
/// L'host è estratto qui dentro (vedi `host_of`). Sincrona e pura: NON esegue l'outcall —
/// l'effetto async vive in cap-automation, che chiama questa porta *prima* di await-are.
pub fn authorize_http(actor: &Actor, url: &str) -> Result<(), String> {
    match actor {
        Actor::Owner => Ok(()),
        Actor::Bundle(id) => {
            let host = host_of(url)?;
            let mk = meta_key(id)?;
            let meta = with_meta(|m| m.get(&mk))
                .ok_or_else(|| format!("cap-store: bundle '{id}' non installato"))?;
            if meta.permissions.http_outcall_hosts.iter().any(|h| h.to_ascii_lowercase() == host) {
                Ok(())
            } else {
                Err(format!(
                    "cap-store: permesso negato — il bundle '{id}' non dichiara l'host '{host}'"
                ))
            }
        }
    }
}

/// Terza porta (F3c): autorizza una **chiamata inter-canister** di `actor` verso `target`.
/// Owner: sempre. Bundle(id): solo se `target` (Principal) ∈ `permissions.inter_canister` (registro 81).
/// Il `target` è parsato a `Principal` QUI (la decisione di sicurezza non si delega al chiamante:
/// un parsing diverso aprirebbe un bypass) e confrontato **canonicamente** coi target dichiarati —
/// così forme testuali equivalenti dello stesso principal coincidono e quelle malformate dichiarate
/// non matchano nulla. Sincrona e pura: autorizza, non esegue la call (l'effetto async vive in
/// cap-automation, che chiama questa porta *prima* di await-are).
pub fn authorize_call(actor: &Actor, target: &str) -> Result<(), String> {
    let want = Principal::from_text(target.trim())
        .map_err(|_| format!("cap-store: target inter-canister non valido: '{target}'"))?;
    match actor {
        Actor::Owner => Ok(()),
        Actor::Bundle(id) => {
            let mk = meta_key(id)?;
            let meta = with_meta(|m| m.get(&mk))
                .ok_or_else(|| format!("cap-store: bundle '{id}' non installato"))?;
            // Confronto canonico: un target dichiarato malformato semplicemente non matcha.
            if meta
                .permissions
                .inter_canister
                .iter()
                .filter_map(|t| Principal::from_text(t.trim()).ok())
                .any(|p| p == want)
            {
                Ok(())
            } else {
                Err(format!(
                    "cap-store: permesso negato — il bundle '{id}' non dichiara il canister '{want}'"
                ))
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Host bundle — install (gate hash) / serve / uninstall / list
// ═══════════════════════════════════════════════════════════════════════════

fn meta_key(module_id: &str) -> Result<MetaKeyBlob, String> {
    MetaKeyBlob::try_from(module_id.as_bytes())
        .map_err(|_| format!("cap-store: module_id troppo lungo (max {MAX_KEY_SIZE} byte)"))
}

fn asset_key(module_id: &str, path: &str, chunk: u32) -> Result<AssetKeyBlob, String> {
    let k = format!("{module_id}/{path}::{chunk}");
    AssetKeyBlob::try_from(k.as_bytes())
        .map_err(|_| format!("cap-store: asset key troppo lunga (max {MAX_ASSET_KEY_SIZE} byte)"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Installa un bundle verificandone l'hash IN-CANISTER (il GATE).
///
/// Ordine no-phantom-install: (1) già-installato? (2) hash atteso? (3) decode TLV?
/// — tutti PRIMA di scrivere. Un rifiuto a uno qualsiasi lascia **zero stato**.
/// `now_secs` è passato dall'host (`ic_cdk::api::time()/1e9`) per restare testabile fuori dalla replica.
pub fn install_bundle(
    module_id: &str,
    bytes: &[u8],
    expected_sha256: &str,
    version: String,
    permissions: BundlePermissions,
    now_secs: u64,
) -> Result<BundleMeta, String> {
    let mk = meta_key(module_id)?;

    // (1) già installato → rifiuto (no write). Reinstall richiede uninstall esplicito.
    if with_meta(|m| m.contains_key(&mk)) {
        return Err(format!("Bundle '{module_id}' già installato"));
    }

    // (2) GATE: hash ricalcolato in-canister vs atteso. Mismatch → STOP, zero stato.
    let actual = sha256_hex(bytes);
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "Gate hash fallito: atteso {expected_sha256}, calcolato {actual} — install rifiutato"
        ));
    }

    // (3) decode TLV. Bundle malformato → STOP, zero stato.
    let files = decode_bundle(bytes)?;

    // ── Solo ora si scrive (81 + 82) ──
    let mut file_metas: Vec<BundleFile> = Vec::with_capacity(files.len());
    let mut total_size: u64 = 0;
    for (path, content_type, data) in &files {
        let total_chunks = data.len().div_ceil(CHUNK_SIZE) as u32;
        for (i, chunk) in data.chunks(CHUNK_SIZE).enumerate() {
            let ak = asset_key(module_id, path, i as u32)?;
            let v = ValueBlob::try_from(chunk)
                .map_err(|_| "cap-store: chunk asset oltre il limite".to_string())?;
            with_assets(|a| {
                a.insert(ak, v);
            });
        }
        total_size += data.len() as u64;
        file_metas.push(BundleFile {
            path: path.clone(),
            content_type: content_type.clone(),
            size: data.len() as u64,
            total_chunks,
        });
    }

    let meta = BundleMeta {
        module_id: module_id.to_string(),
        version,
        sha256: actual,
        size_bytes: total_size,
        installed_at: now_secs,
        files: file_metas,
        permissions,
    };
    with_meta(|m| {
        m.insert(mk, meta.clone());
    });
    Ok(meta)
}

/// Serve un asset di un bundle (non-certificato). `path` è il sottopath dopo `/m/{id}/`.
/// Vuoto o trailing slash → `index.html`. `None` ⇒ 404.
pub fn serve(module_id: &str, path: &str) -> Option<ServedAsset> {
    let resolved = if path.is_empty() || path.ends_with('/') {
        format!("{path}index.html")
    } else {
        path.to_string()
    };

    let mk = meta_key(module_id).ok()?;
    let meta = with_meta(|m| m.get(&mk))?;
    let file = meta.files.iter().find(|f| f.path == resolved)?;

    let mut body = Vec::with_capacity(file.size as usize);
    for i in 0..file.total_chunks {
        let ak = asset_key(module_id, &resolved, i).ok()?;
        let chunk = with_assets(|a| a.get(&ak))?;
        body.extend_from_slice(chunk.as_ref());
    }

    Some(ServedAsset {
        content_type: file.content_type.clone(),
        body,
    })
}

/// Disinstalla un bundle: rimuove asset (82) + meta (81). **NON tocca il KV** (i dati del namespace restano).
pub fn uninstall_bundle(module_id: &str) -> Result<(), String> {
    let mk = meta_key(module_id)?;
    let meta = with_meta(|m| m.get(&mk))
        .ok_or_else(|| format!("Bundle '{module_id}' non trovato"))?;

    for file in &meta.files {
        for i in 0..file.total_chunks {
            if let Ok(ak) = asset_key(module_id, &file.path, i) {
                with_assets(|a| {
                    a.remove(&ak);
                });
            }
        }
    }
    with_meta(|m| {
        m.remove(&mk);
    });
    Ok(())
}

/// Lista i bundle installati (con hash verificato + permessi).
pub fn list_bundles() -> Vec<BundleMeta> {
    with_meta(|m| m.iter().map(|entry| entry.value().clone()).collect())
}

// ─── decode_bundle (TLV length-prefixed, compat apps/bundle_builder.py) ────────
//
// Format: [num_files: u32 LE] poi per ogni file:
//   [path_len: u32 LE][path][ct_len: u32 LE][content_type][data_len: u32 LE][data]
// Zero dipendenze. Portato da src/vault/http_gateway.rs del kernel.

fn decode_bundle(data: &[u8]) -> Result<Vec<(String, String, Vec<u8>)>, String> {
    if data.len() < 4 {
        return Err("Bundle troppo piccolo".to_string());
    }
    let mut pos = 0;
    let num_files = read_u32(data, &mut pos)?;
    let mut files = Vec::with_capacity(num_files as usize);
    for _ in 0..num_files {
        let path = read_string(data, &mut pos)?;
        let content_type = read_string(data, &mut pos)?;
        let file_data = read_blob(data, &mut pos)?;
        files.push((path, content_type, file_data));
    }
    Ok(files)
}

fn read_u32(data: &[u8], pos: &mut usize) -> Result<u32, String> {
    if *pos + 4 > data.len() {
        return Err("Fine inattesa del bundle".to_string());
    }
    let val = u32::from_le_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]);
    *pos += 4;
    Ok(val)
}

fn read_string(data: &[u8], pos: &mut usize) -> Result<String, String> {
    let len = read_u32(data, pos)? as usize;
    if *pos + len > data.len() {
        return Err("Fine inattesa del bundle (string)".to_string());
    }
    let s = String::from_utf8(data[*pos..*pos + len].to_vec())
        .map_err(|_| "UTF-8 non valido nel bundle".to_string())?;
    *pos += len;
    Ok(s)
}

fn read_blob(data: &[u8], pos: &mut usize) -> Result<Vec<u8>, String> {
    let len = read_u32(data, pos)? as usize;
    if *pos + len > data.len() {
        return Err("Fine inattesa del bundle (blob)".to_string());
    }
    let blob = data[*pos..*pos + len].to_vec();
    *pos += len;
    Ok(blob)
}

// ═══════════════════════════════════════════════════════════════════════════
// Test
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
    use ic_stable_structures::DefaultMemoryImpl;

    fn setup() {
        let mm = MemoryManager::init(DefaultMemoryImpl::default());
        init_storage(
            mm.get(MemoryId::new(80)),
            mm.get(MemoryId::new(81)),
            mm.get(MemoryId::new(82)),
        );
    }

    fn no_perms() -> BundlePermissions {
        BundlePermissions {
            storage_namespaces: vec![],
            http_outcall_hosts: vec![],
            inter_canister: vec![],
            uses_crypto: false,
            uses_timer: false,
        }
    }

    fn perms_ns(namespaces: &[&str]) -> BundlePermissions {
        BundlePermissions {
            storage_namespaces: namespaces.iter().map(|s| s.to_string()).collect(),
            ..no_perms()
        }
    }

    /// Installa un bundle minimale dichiarando i namespace `ns` (per testare l'enforcement KV).
    fn install_with_ns(module_id: &str, ns: &[&str]) {
        let bundle = build_bundle(&[("index.html", "text/html", b"x")]);
        let hash = sha256_hex(&bundle);
        install_bundle(module_id, &bundle, &hash, "1.0.0".into(), perms_ns(ns), 1).unwrap();
    }

    /// Costruisce un bundle nel formato TLV di bundle_builder.py.
    fn build_bundle(files: &[(&str, &str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(files.len() as u32).to_le_bytes());
        for (path, ct, data) in files {
            buf.extend_from_slice(&(path.len() as u32).to_le_bytes());
            buf.extend_from_slice(path.as_bytes());
            buf.extend_from_slice(&(ct.len() as u32).to_le_bytes());
            buf.extend_from_slice(ct.as_bytes());
            buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
            buf.extend_from_slice(data);
        }
        buf
    }

    // ── KV (regressione F0) ──

    #[test]
    fn kv_round_trip_set_get_delete_list() {
        setup();
        kv_set("notes", "a", b"hello").unwrap();
        kv_set("notes", "b", b"world").unwrap();
        assert_eq!(kv_get("notes", "a"), Some(b"hello".to_vec()));
        kv_set("notes", "a", b"hi").unwrap();
        assert_eq!(kv_get("notes", "a"), Some(b"hi".to_vec()));
        kv_set("other", "x", b"z").unwrap();
        let mut keys = kv_list("notes");
        keys.sort();
        assert_eq!(keys, vec!["a".to_string(), "b".to_string()]);
        kv_delete("notes", "a").unwrap();
        assert_eq!(kv_get("notes", "a"), None);
        kv_delete("notes", "a").unwrap(); // idempotente
    }

    #[test]
    fn kv_rejects_oversized_value() {
        setup();
        let big = vec![0u8; MAX_VALUE_SIZE + 1];
        assert!(kv_set("ns", "k", &big).is_err());
    }

    // ── decode_bundle ──

    #[test]
    fn decode_bundle_round_trip() {
        let bundle = build_bundle(&[
            ("index.html", "text/html", b"<h1>Hi</h1>"),
            ("app.js", "application/javascript", b"console.log(1)"),
        ]);
        let files = decode_bundle(&bundle).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "index.html");
        assert_eq!(files[0].2, b"<h1>Hi</h1>");
        assert_eq!(files[1].1, "application/javascript");
    }

    #[test]
    fn decode_bundle_rejects_truncated() {
        assert!(decode_bundle(&[1, 0]).is_err()); // < 4 byte
        let mut b = build_bundle(&[("a", "text/plain", b"xx")]);
        b.truncate(b.len() - 1); // tronca l'ultimo byte di data
        assert!(decode_bundle(&b).is_err());
    }

    // ── install_bundle: GATE ──

    #[test]
    fn install_serves_when_hash_matches() {
        setup();
        let bundle = build_bundle(&[("index.html", "text/html", b"<h1>Notes</h1>")]);
        let hash = sha256_hex(&bundle);
        install_bundle("notes", &bundle, &hash, "1.0.0".into(), no_perms(), 42).unwrap();

        let served = serve("notes", "index.html").unwrap();
        assert_eq!(served.body, b"<h1>Notes</h1>");
        assert_eq!(served.content_type, "text/html");
        // path vuoto → index.html
        assert_eq!(serve("notes", "").unwrap().body, b"<h1>Notes</h1>");
        assert_eq!(list_bundles().len(), 1);
        assert_eq!(list_bundles()[0].sha256, hash);
    }

    #[test]
    fn install_rejected_without_state_on_hash_mismatch() {
        setup();
        let bundle = build_bundle(&[("index.html", "text/html", b"<h1>X</h1>")]);
        let mut tampered = bundle.clone();
        *tampered.last_mut().unwrap() ^= 0x01; // cambia 1 byte
        let expected = sha256_hex(&bundle); // hash dell'ORIGINALE
        let r = install_bundle("notes", &tampered, &expected, "1.0.0".into(), no_perms(), 1);
        assert!(r.is_err());
        // NESSUNO stato: né meta né asset.
        assert!(list_bundles().is_empty());
        assert!(serve("notes", "index.html").is_none());
    }

    #[test]
    fn install_rejected_without_state_on_bad_tlv() {
        setup();
        let garbage = vec![9u8, 0, 0, 0, 1, 2, 3]; // num_files=9 ma dati assenti
        let hash = sha256_hex(&garbage);
        let r = install_bundle("bad", &garbage, &hash, "1.0.0".into(), no_perms(), 1);
        assert!(r.is_err());
        assert!(list_bundles().is_empty());
        assert!(serve("bad", "index.html").is_none());
    }

    #[test]
    fn install_rejects_duplicate() {
        setup();
        let bundle = build_bundle(&[("index.html", "text/html", b"x")]);
        let hash = sha256_hex(&bundle);
        install_bundle("a", &bundle, &hash, "1.0.0".into(), no_perms(), 1).unwrap();
        assert!(install_bundle("a", &bundle, &hash, "1.0.0".into(), no_perms(), 1).is_err());
    }

    // ── uninstall: pulisce asset, lascia KV ──

    #[test]
    fn uninstall_clears_assets_keeps_kv() {
        setup();
        // Dati KV dell'app nello stesso namespace del bundle.
        kv_set("notes", "doc1", b"contenuto utente").unwrap();
        let bundle = build_bundle(&[("index.html", "text/html", b"<h1>Notes</h1>")]);
        let hash = sha256_hex(&bundle);
        install_bundle("notes", &bundle, &hash, "1.0.0".into(), no_perms(), 1).unwrap();
        assert!(serve("notes", "index.html").is_some());

        uninstall_bundle("notes").unwrap();
        // Asset puliti...
        assert!(serve("notes", "index.html").is_none());
        assert!(list_bundles().is_empty());
        // ...ma il KV resta.
        assert_eq!(kv_get("notes", "doc1"), Some(b"contenuto utente".to_vec()));

        // Reinstall consentito dopo uninstall.
        assert!(install_bundle("notes", &bundle, &hash, "1.0.0".into(), no_perms(), 2).is_ok());
    }

    // ── F2: enforcement permessi per-attore ──

    #[test]
    fn owner_writes_any_namespace() {
        setup();
        // Owner non è ristretto: scrive in qualsiasi namespace, anche senza bundle installato.
        kv_set_as(&Actor::Owner, "qualsiasi", "k", b"v").unwrap();
        assert_eq!(kv_get_as(&Actor::Owner, "qualsiasi", "k").unwrap(), Some(b"v".to_vec()));
        kv_set_as(&Actor::Owner, "altro", "k2", b"v2").unwrap();
        assert!(kv_delete_as(&Actor::Owner, "altro", "k2").is_ok());
        assert!(kv_list_as(&Actor::Owner, "qualsiasi").is_ok());
    }

    #[test]
    fn bundle_writes_only_declared_namespace() {
        setup();
        install_with_ns("notes", &["notes_data"]);

        // Dentro il namespace dichiarato → ok + round-trip.
        kv_set_as(&Actor::Bundle("notes".into()), "notes_data", "doc1", b"ciao").unwrap();
        assert_eq!(
            kv_get_as(&Actor::Bundle("notes".into()), "notes_data", "doc1").unwrap(),
            Some(b"ciao".to_vec())
        );
        assert_eq!(
            kv_list_as(&Actor::Bundle("notes".into()), "notes_data").unwrap(),
            vec!["doc1".to_string()]
        );

        // Fuori dai namespace dichiarati → rifiutato, e KV non toccato.
        assert!(kv_set_as(&Actor::Bundle("notes".into()), "segreti", "k", b"x").is_err());
        assert!(kv_delete_as(&Actor::Bundle("notes".into()), "segreti", "k").is_err());
        assert!(kv_list_as(&Actor::Bundle("notes".into()), "segreti").is_err());
        // niente phantom-write nel namespace non dichiarato
        assert_eq!(kv_get_as(&Actor::Owner, "segreti", "k").unwrap(), None);
    }

    #[test]
    fn cross_bundle_read_blocked() {
        setup();
        install_with_ns("a", &["a_data"]);
        install_with_ns("b", &["b_data"]);
        // Il bundle "b" scrive nel suo namespace.
        kv_set_as(&Actor::Bundle("b".into()), "b_data", "k", b"privato_di_b").unwrap();

        // "a" prova a leggere il namespace di "b" → Err (permesso negato), NON Ok(None).
        let r = kv_get_as(&Actor::Bundle("a".into()), "b_data", "k");
        assert!(r.is_err());
        // L'owner invece legge ovunque: conferma che il dato esiste (non era assente).
        assert_eq!(kv_get_as(&Actor::Owner, "b_data", "k").unwrap(), Some(b"privato_di_b".to_vec()));
    }

    #[test]
    fn uninstalled_bundle_denied() {
        setup();
        // Nessun bundle installato → ogni accesso bundle-context è Err.
        assert!(kv_set_as(&Actor::Bundle("ghost".into()), "x", "k", b"v").is_err());
        assert!(kv_get_as(&Actor::Bundle("ghost".into()), "x", "k").is_err());
    }

    // ── F1: namespace riservato (`__`) — il battito non è falsificabile dai bundle ──

    #[test]
    fn bundle_denied_reserved_namespace_even_if_declared() {
        setup();
        // Un bundle malevolo dichiara il namespace riservato del battito.
        install_with_ns("evil", &["__presence"]);

        // …ma ogni accesso bundle-context al riservato è rifiutato a prescindere.
        assert!(kv_set_as(&Actor::Bundle("evil".into()), "__presence", "last_checkin", b"9999").is_err());
        assert!(kv_get_as(&Actor::Bundle("evil".into()), "__presence", "last_checkin").is_err());
        assert!(kv_delete_as(&Actor::Bundle("evil".into()), "__presence", "last_checkin").is_err());
        assert!(kv_list_as(&Actor::Bundle("evil".into()), "__presence").is_err());
        // niente phantom-write: il namespace riservato resta intatto
        assert_eq!(kv_get_as(&Actor::Owner, "__presence", "last_checkin").unwrap(), None);

        // L'owner (shell + job owning_bundle:None) invece scrive/legge il battito liberamente.
        kv_set_as(&Actor::Owner, "__presence", "last_checkin", b"1000").unwrap();
        assert_eq!(
            kv_get_as(&Actor::Owner, "__presence", "last_checkin").unwrap(),
            Some(b"1000".to_vec())
        );
    }

    // ── G1: credenziali d'uscita (`__secrets`) ──

    #[test]
    fn secret_set_list_delete_round_trip() {
        setup();
        set_secret("WEBHOOK", "https://hooks.example.com/abc123").unwrap();
        set_secret("api.token-1", "sk-XYZ").unwrap();
        let mut names = secret_names();
        names.sort();
        assert_eq!(names, vec!["WEBHOOK".to_string(), "api.token-1".to_string()]);
        // Il chiaro è leggibile solo dall'uso interno (resolver), mai elencato.
        assert_eq!(get_secret_value("WEBHOOK").as_deref(), Some(b"https://hooks.example.com/abc123".as_slice()));
        delete_secret("WEBHOOK").unwrap();
        assert_eq!(secret_names(), vec!["api.token-1".to_string()]);
        assert_eq!(get_secret_value("WEBHOOK"), None);
        delete_secret("WEBHOOK").unwrap(); // idempotente
    }

    #[test]
    fn secret_rejects_invalid_name_and_empty_value() {
        setup();
        assert!(set_secret("", "v").is_err());
        assert!(set_secret("has space", "v").is_err());
        assert!(set_secret("has:colon", "v").is_err());
        assert!(set_secret("ok_name", "").is_err()); // valore vuoto
        assert!(set_secret("ok_name", "v").is_ok());
    }

    #[test]
    fn secrets_namespace_denied_to_bundles() {
        setup();
        // Un bundle dichiara pure `__secrets`: il guardrail `__` lo nega comunque.
        install_with_ns("greedy", &["__secrets"]);
        assert!(kv_get_as(&Actor::Bundle("greedy".into()), "__secrets", "WEBHOOK").is_err());
        assert!(kv_set_as(&Actor::Bundle("greedy".into()), "__secrets", "WEBHOOK", b"x").is_err());
        // L'owner registra/legge liberamente.
        set_secret("WEBHOOK", "v").unwrap();
        assert_eq!(get_secret_value("WEBHOOK").as_deref(), Some(b"v".as_slice()));
    }

    // ── chunking: file > CHUNK_SIZE ──

    #[test]
    fn install_serves_multichunk_file() {
        setup();
        let big = vec![7u8; CHUNK_SIZE * 2 + 123]; // 3 chunk
        let bundle = build_bundle(&[("big.bin", "application/octet-stream", &big)]);
        let hash = sha256_hex(&bundle);
        install_bundle("m", &bundle, &hash, "1.0.0".into(), no_perms(), 1).unwrap();
        let served = serve("m", "big.bin").unwrap();
        assert_eq!(served.body, big);
        assert_eq!(list_bundles()[0].files[0].total_chunks, 3);
    }

    // ── F3b: porta HTTP outcall (authorize_http) ──

    fn install_with_hosts(module_id: &str, hosts: &[&str]) {
        let bundle = build_bundle(&[("index.html", "text/html", b"x")]);
        let hash = sha256_hex(&bundle);
        let perms = BundlePermissions {
            http_outcall_hosts: hosts.iter().map(|s| s.to_string()).collect(),
            ..no_perms()
        };
        install_bundle(module_id, &bundle, &hash, "1.0.0".into(), perms, 1).unwrap();
    }

    #[test]
    fn host_of_extracts_authority() {
        assert_eq!(host_of("https://api.example.com/v1/x?q=1").unwrap(), "api.example.com");
        assert_eq!(host_of("https://API.Example.com").unwrap(), "api.example.com");
        assert_eq!(host_of("https://user@api.example.com:8443/p").unwrap(), "api.example.com");
        assert!(host_of("api.example.com/no-scheme").is_err()); // niente schema → rifiuto
        assert!(host_of("https:///path").is_err()); // host vuoto → rifiuto
    }

    #[test]
    fn authorize_http_owner_unrestricted() {
        setup();
        assert!(authorize_http(&Actor::Owner, "https://qualsiasi.host/x").is_ok());
    }

    #[test]
    fn authorize_http_bundle_only_declared_host() {
        setup();
        install_with_hosts("b", &["api.example.com"]);
        // host dichiarato (con path/porta diversi) → ok
        assert!(authorize_http(&Actor::Bundle("b".into()), "https://api.example.com/v1/data").is_ok());
        assert!(authorize_http(&Actor::Bundle("b".into()), "https://api.example.com:443/x").is_ok());
        // host non dichiarato → Err
        assert!(authorize_http(&Actor::Bundle("b".into()), "https://evil.example.com/x").is_err());
        // sotto-dominio non è l'host dichiarato → Err (match esatto, niente wildcard)
        assert!(authorize_http(&Actor::Bundle("b".into()), "https://sub.api.example.com/x").is_err());
    }

    #[test]
    fn authorize_http_uninstalled_bundle_denied() {
        setup();
        assert!(authorize_http(&Actor::Bundle("ghost".into()), "https://api.example.com/x").is_err());
    }

    // ── F3c: porta inter-canister call (authorize_call) ──

    fn install_with_targets(module_id: &str, targets: &[&str]) {
        let bundle = build_bundle(&[("index.html", "text/html", b"x")]);
        let hash = sha256_hex(&bundle);
        let perms = BundlePermissions {
            inter_canister: targets.iter().map(|s| s.to_string()).collect(),
            ..no_perms()
        };
        install_bundle(module_id, &bundle, &hash, "1.0.0".into(), perms, 1).unwrap();
    }

    #[test]
    fn authorize_call_owner_unrestricted() {
        setup();
        assert!(authorize_call(&Actor::Owner, "ryjl3-tyaaa-aaaaa-aaaba-cai").is_ok());
        // ...ma un target malformato è rifiutato anche per Owner (parsing nella porta).
        assert!(authorize_call(&Actor::Owner, "not-a-principal").is_err());
    }

    #[test]
    fn authorize_call_bundle_only_declared_target() {
        setup();
        install_with_targets("b", &["ryjl3-tyaaa-aaaaa-aaaba-cai"]);
        // target dichiarato → ok; forma canonica equivalente (spazi attorno) → ok
        assert!(authorize_call(&Actor::Bundle("b".into()), "ryjl3-tyaaa-aaaaa-aaaba-cai").is_ok());
        assert!(authorize_call(&Actor::Bundle("b".into()), "  ryjl3-tyaaa-aaaaa-aaaba-cai  ").is_ok());
        // canister non dichiarato → Err
        assert!(authorize_call(&Actor::Bundle("b".into()), "rrkah-fqaaa-aaaaa-aaaaq-cai").is_err());
    }

    #[test]
    fn authorize_call_malformed_target_rejected() {
        setup();
        install_with_targets("b", &["ryjl3-tyaaa-aaaaa-aaaba-cai"]);
        assert!(authorize_call(&Actor::Bundle("b".into()), "garbage").is_err());
    }

    #[test]
    fn authorize_call_uninstalled_bundle_denied() {
        setup();
        assert!(authorize_call(&Actor::Bundle("ghost".into()), "ryjl3-tyaaa-aaaaa-aaaba-cai").is_err());
    }
}
