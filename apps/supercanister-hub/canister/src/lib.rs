//! EasyHub (supercanister-hub) — canister host
//!
//! Un canister personale sovrano che ospita mini-app installabili verificate per hash
//! (l'app-store DENTRO il proprio canister), con dati, crypto e automazioni — verificabile,
//! senza backdoor, ogni app confinata ai permessi approvati.
//!
//! F0: scaffold + congelamento layout stable. Storage = KV `namespace:key` (cap-store).
//! Host bundle (F1), enforcement permessi (F2), automazione (F3) arrivano dopo.

use candid::{CandidType, Principal};
use serde::Deserialize;
use ic_stable_structures::memory_manager::MemoryManager;
use ic_stable_structures::DefaultMemoryImpl;
use std::cell::RefCell;
use std::time::Duration;

// Re-export tipi Candid per export_candid!()
use cap_automation::{Job, JobOutcome, Schedule};
use cap_crypto::DerivationContext;
use cap_store::{Actor, BundleMeta, BundlePermissions};
use core_assets::{HttpRequest, HttpResponse};
use ic_cdk::management_canister::{HttpRequestResult, TransformArgs};

#[cfg(feature = "platform")]
use cap_platform::{AppMetadata, Status};

// ─── MemoryManager ──────────────────────────────────────────────────────────

thread_local! {
    static MM: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(core_storage::new_memory_manager());
}

fn get_mem(id: core_storage::MemoryId) -> core_types::Memory {
    MM.with(|m| m.borrow().get(id))
}

// ─── Init / Post-upgrade ────────────────────────────────────────────────────

// Standalone (dev): init(owner) — l'owner è chi deploya il canister.
#[cfg(not(feature = "platform"))]
#[ic_cdk::init]
fn init(owner: Principal) {
    init_all_storage();
    core_auth::set_owner(owner);
    core_assets::rebuild_cert_tree();
    register_cleanups();
}

// Platform: init(spawner, factory) — deployato dalla piattaforma SaaS.
#[cfg(feature = "platform")]
#[ic_cdk::init]
fn init(spawner: Principal, factory: Principal) {
    init_all_storage();
    cap_platform::init_platform(spawner, factory, ic_cdk::api::msg_caller());
    core_assets::rebuild_cert_tree();
    register_cleanups();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    init_all_storage();
    core_assets::rebuild_cert_tree();
    register_cleanups();
}

fn init_all_storage() {
    core_auth::init_storage(
        get_mem(core_storage::AUTH_OWNER_MEM),
        get_mem(core_storage::AUTH_WHITELIST_MEM),
    );
    core_assets::init_storage(get_mem(core_storage::ASSETS_MEM));

    #[cfg(feature = "platform")]
    cap_platform::init_storage(get_mem(core_storage::PLATFORM_STATE_MEM));

    // cap-store — KV `namespace:key` (80) + host bundle: registro meta (81) + asset chunked (82).
    cap_store::init_storage(
        get_mem(core_storage::STORE_KV_MEM),
        get_mem(core_storage::STORE_BUNDLE_META),
        get_mem(core_storage::STORE_ASSETS_MEM),
    );

    // cap-automation — job (90) + schedule (91) + status (92) + log (93).
    // Gli schedule vivono in stable: ritrovati qui ad ogni post_upgrade, ri-armati dal tick (vedi
    // register_cleanups). Nessun timer per-schedule in-memory → il bug `clock` del kernel è impossibile.
    cap_automation::init_storage(
        get_mem(core_storage::AUTO_JOBS_MEM),
        get_mem(core_storage::AUTO_SCHEDULES_MEM),
        get_mem(core_storage::AUTO_STATUS_MEM),
        get_mem(core_storage::AUTO_LOG_MEM),
    );
}

fn register_cleanups() {
    // core-timer è l'UNICO substrato dello scheduler persistente di cap-automation (F3).
    // `clear()` prima di registrare evita doppioni al post_upgrade. La cleanup-fn esegue gli
    // schedule dovuti leggendoli dallo stable (90-93): il ri-armo è implicito nel re-init.
    core_timer::clear();
    core_timer::register_cleanup(|| {
        // F3b: `run_due` è ora async (può contenere azioni `Http`). La cleanup-fn di core-timer è
        // sincrona → lancio il future con `ic_cdk::spawn` e ritorno subito. Lo stato (schedule,
        // next_run) vive in stable, quindi il fire-and-forget non perde nulla.
        let now_secs = ic_cdk::api::time() / 1_000_000_000;
        ic_cdk::futures::spawn(async move {
            cap_automation::run_due(now_secs).await;
            // Consegna outbound della capsula al silenzio (fire-once). DOPO run_due: condivide il
            // budget d'uscita per-tick coi job; se esaurito, ritenta al tick successivo.
            deliver_capsule_if_due(now_secs).await;
        });
    });
    core_timer::schedule(Duration::from_secs(120));
}

// ═══════════════════════════════════════════════════════════════════════════
// Wrapper #[update]/#[query]
// ═══════════════════════════════════════════════════════════════════════════

fn caller() -> Principal {
    ic_cdk::api::msg_caller()
}

// ─── app version (self-upgrade §B) ────────────────────────────────────────────

#[ic_cdk::query]
fn app_version() -> String { core_types::app_version!() }

// ─── core-auth ──────────────────────────────────────────────────────────────

#[ic_cdk::query]
fn get_owner() -> Principal { core_auth::owner() }

#[ic_cdk::query]
fn get_user_principal() -> Option<Principal> { core_auth::user_principal() }

#[ic_cdk::update]
fn allow_claim() -> Result<(), String> { core_auth::allow_claim(caller()) }

#[ic_cdk::update]
fn claim_user_principal() -> Result<(), String> { core_auth::claim_user_principal(caller()) }

// ─── core-assets ────────────────────────────────────────────────────────────

fn require_asset_admin(caller: Principal) -> Result<(), String> {
    if core_auth::require_owner(caller).is_ok() {
        return Ok(());
    }
    #[cfg(feature = "platform")]
    if cap_platform::is_provisioning_factory(caller) {
        return Ok(());
    }
    Err("Unauthorized: not owner or factory".to_string())
}

#[ic_cdk::update]
fn upload_asset(path: String, content_type: String, content: Vec<u8>) -> Result<(), String> {
    core_auth::require_owner(caller())?;
    core_assets::upload_asset(path, content_type, content);
    Ok(())
}

#[ic_cdk::update]
fn upload_asset_batch(assets: Vec<(String, String, Vec<u8>)>) -> Result<(), String> {
    require_asset_admin(caller())?;
    core_assets::upload_asset_batch(assets);
    Ok(())
}

#[ic_cdk::update]
fn finalize_assets() -> Result<(), String> {
    require_asset_admin(caller())?;
    core_assets::finalize_assets();
    Ok(())
}

/// Svuota tutti gli asset prima di ricaricare un bundle frontend nuovo (self-upgrade §B).
#[ic_cdk::update]
fn clear_assets() -> Result<(), String> {
    require_asset_admin(caller())?;
    core_assets::clear_assets();
    Ok(())
}

/// Parsa `/m/{module_id}/{path...}` → (module_id, path). Il prefisso `/m/` isola gli asset dei
/// bundle (serviti NON-certificati da cap-store) da quelli propri della shell (certificati da core-assets).
fn parse_module_path(url: &str) -> Option<(String, String)> {
    let path = url.split('?').next().unwrap_or(url);
    let rest = path.strip_prefix("/m/")?;
    if rest.is_empty() {
        return None;
    }
    match rest.split_once('/') {
        Some((id, sub)) if !id.is_empty() => Some((id.to_string(), sub.to_string())),
        _ => Some((rest.to_string(), String::new())), // "/m/{id}" → index.html
    }
}

#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse {
    // Gli asset dei bundle sono non-certificati → si servono via update (come lo SPA fallback).
    if parse_module_path(&req.url).is_some() {
        return HttpResponse {
            status_code: 200,
            headers: vec![],
            body: vec![],
            upgrade: Some(true),
        };
    }
    core_assets::http_request(&req)
}

#[ic_cdk::update]
fn http_request_update(req: HttpRequest) -> HttpResponse {
    if let Some((module_id, path)) = parse_module_path(&req.url) {
        return match cap_store::serve(&module_id, &path) {
            Some(asset) => HttpResponse {
                status_code: 200,
                headers: vec![
                    ("content-type".to_string(), asset.content_type),
                    ("cache-control".to_string(), "no-cache".to_string()),
                ],
                body: asset.body,
                upgrade: Some(false),
            },
            None => HttpResponse {
                status_code: 404,
                headers: vec![("content-type".to_string(), "text/plain".to_string())],
                body: b"Not Found".to_vec(),
                upgrade: Some(false),
            },
        };
    }
    core_assets::http_request_update(&req)
}

// ─── cap-store (KV `namespace:key`) ───────────────────────────────────────────
//
// Due path. (1) Path OWNER (`kv_*`, owner-or-user, senza restrizioni): primitive raw =
// `cap_store::Actor::Owner`. (2) Path BUNDLE-CONTEXT (`kv_*_as`, F4): il chiamante on-the-wire ora
// esiste — è il **bridge della shell** che media i bundle in iframe sandboxed (origin opaco). Il
// bridge resta owner-gated (solo l'owner autenticato può chiamarli) ma DICHIARA l'`Actor::Bundle(id)`
// per conto di cui agisce → `cap-store::kv_*_as` (F2) applica l'enforcement IN-CANISTER: il bundle
// tocca SOLO i `storage_namespaces` dichiarati nel suo manifest (registro 81), cross-namespace = `Err`.
// La sicurezza è imposta dal canister, non dal JS del bridge (difesa in profondità).

#[ic_cdk::update]
fn kv_set(namespace: String, key: String, value: Vec<u8>) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::kv_set(&namespace, &key, &value)
}

#[ic_cdk::query]
fn kv_get(namespace: String, key: String) -> Option<Vec<u8>> {
    if core_auth::require_owner_or_user(caller()).is_err() { return None; }
    cap_store::kv_get(&namespace, &key)
}

#[ic_cdk::update]
fn kv_delete(namespace: String, key: String) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::kv_delete(&namespace, &key)
}

#[ic_cdk::query]
fn kv_list(namespace: String) -> Vec<String> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_store::kv_list(&namespace)
}

// Path bundle-context (F4): la shell media un bundle in iframe sandboxed. Owner-gated sul filo +
// `Actor::Bundle(id)` confinato ai namespace dichiarati (registro 81, enforcement F2 in-canister).

#[ic_cdk::update]
fn kv_set_as(actor: Actor, namespace: String, key: String, value: Vec<u8>) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::kv_set_as(&actor, &namespace, &key, &value)
}

#[ic_cdk::query]
fn kv_get_as(actor: Actor, namespace: String, key: String) -> Result<Option<Vec<u8>>, String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::kv_get_as(&actor, &namespace, &key)
}

#[ic_cdk::update]
fn kv_delete_as(actor: Actor, namespace: String, key: String) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::kv_delete_as(&actor, &namespace, &key)
}

#[ic_cdk::query]
fn kv_list_as(actor: Actor, namespace: String) -> Result<Vec<String>, String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::kv_list_as(&actor, &namespace)
}

// ─── credenziali d'uscita (G1) ────────────────────────────────────────────────
//
// La KEYSTONE del modello outbound-only: l'agente esce in modo autenticato senza tenere il segreto
// inline nel job. Le credenziali vivono nel namespace RISERVATO `__secrets` (KV 80, bundle-denied dal
// guardrail `__`) — nessun nuovo MemId. Un job le referenzia per NOME col resolver `{{secret:NAME}}`,
// risolto SOLO nei campi d'uscita e SOLO per `Actor::Owner` (vedi cap-automation). Onestà del tier:
// la credenziale è solo-invio e revocabile, ma vive sulla subnet che esegue il tuo codice.
//
// **Nessun `get_secret`**: il chiaro non è mai esposto on-the-wire. `list_secrets` ritorna nomi +
// un mascheramento fisso (non derivato dal valore → zero-leak anche sulla lunghezza).

/// Credenziale come la vede l'owner: nome + valore mascherato (mai il chiaro).
#[derive(CandidType, Deserialize, Clone, Debug)]
struct SecretInfo {
    name: String,
    masked: String,
}

const SECRET_MASK: &str = "••••••••";

/// Registra/aggiorna una credenziale d'uscita. Owner-gated.
#[ic_cdk::update]
fn set_secret(name: String, value: String) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::set_secret(&name, &value)
}

/// Elenca le credenziali (nomi + mascherato). Owner-gated. Mai il chiaro.
#[ic_cdk::query]
fn list_secrets() -> Vec<SecretInfo> {
    if core_auth::require_owner_or_user(caller()).is_err() {
        return vec![];
    }
    cap_store::secret_names()
        .into_iter()
        .map(|name| SecretInfo { name, masked: SECRET_MASK.to_string() })
        .collect()
}

/// Revoca (cancella) una credenziale. Owner-gated. Idempotente.
#[ic_cdk::update]
fn delete_secret(name: String) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::delete_secret(&name)
}

// ─── presenza-owner / heartbeat (F1) ──────────────────────────────────────────
//
// Sostrato della categoria "se vado in silenzio" (dead-man's switch, eredità, pausa-di-sicurezza).
// `checkin()` timbra **server-side** (`ic_cdk::api::time()`) nel namespace RISERVATO `__presence`:
// più robusto del client che manda il proprio timestamp (non può mentire sul *quando*), e non
// falsificabile da un'app installata (cap-store nega `__`-namespace ai bundle). La staleness
// `now - last_checkin > finestra` NON è una primitiva nuova: è una guardia di automazione
// (`last_checkin < {{now-finestra}}`), nessun timer/MemId aggiunto.

const PRESENCE_NS: &str = "__presence";
const LAST_CHECKIN_KEY: &str = "last_checkin";

/// Timbra la presenza dell'owner col tempo del canister (secondi). Owner-gated (fail-closed).
/// Ignora qualsiasi valore del client: il *quando* lo decide il server.
#[ic_cdk::update]
fn checkin() -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    let now_secs = ic_cdk::api::time() / 1_000_000_000;
    cap_store::kv_set(PRESENCE_NS, LAST_CHECKIN_KEY, now_secs.to_string().as_bytes())
}

/// Ultimo battito registrato (secondi), se presente. Lettura interna **non gated** —
/// usata sia dalla query owner-gated `last_checkin` sia dalla porta di rilascio F2.
fn current_last_checkin() -> Option<u64> {
    cap_store::kv_get(PRESENCE_NS, LAST_CHECKIN_KEY)
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// Ultimo battito registrato (secondi), se presente. Per la Control Room/frontend.
#[ic_cdk::query]
fn last_checkin() -> Option<u64> {
    if core_auth::require_owner_or_user(caller()).is_err() {
        return None;
    }
    current_last_checkin()
}

// ─── capsula del tempo: deposito envelope + matematica del silenzio ───────────
//
// L'owner deposita un envelope **opaco** (sigillato off-canister: oggi passphrase, vedi
// shared/src/core/crypto.js) nel namespace RISERVATO "__release" (KV 80, bundle-denied dal
// guardrail "__" di F1) — **nessun plaintext nel canister**, nessun nuovo MemId. Al SILENZIO è
// l'AGENTE a CONSEGNARLO FUORI (sezione outbound-push sotto): nessuna superficie inbound, nessun
// erede che entra ([[outbound_only]]). `cap_crypto::derive_encrypted_key` (core) resta in panchina
// per i metodi futuri (VetKeys/SubnetKey), senza endpoint qui.

const RELEASE_NS: &str = "__release";
const RELEASE_CAPSULE_KEY: &str = "capsule";

/// La matematica del SILENZIO, pura (testabile senza replica): `last_checkin = Some(t)` **e**
/// `now - t > window`. `None` (nessun battito) = silenzio non provabile → `false` (fail-closed).
/// Unico punto di verità per "è andato in silenzio?", usata dal push outbound (`deliver_capsule_if_due`).
fn silence_expired(last_checkin: Option<u64>, window_secs: u64, now: u64) -> bool {
    matches!(last_checkin, Some(t) if now.saturating_sub(t) > window_secs)
}

/// Owner deposita l'envelope cifrato (modello vault). Owner-gated. Sostituisce il precedente.
/// **Re-seal ⇒ ri-arma il push outbound:** azzera il flag `delivered` della delivery-config (se
/// presente) così una capsula nuova viene riconsegnata al prossimo silenzio (fire-once per envelope).
#[ic_cdk::update]
fn set_release_capsule(envelope: Vec<u8>) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::kv_set(RELEASE_NS, RELEASE_CAPSULE_KEY, &envelope)?;
    if let Some(mut dc) = load_delivery_config() {
        if dc.delivered {
            dc.delivered = false;
            save_delivery_config(&dc)?;
        }
    }
    Ok(())
}

// ─── consegna OUTBOUND-PUSH della capsula (l'agente esce, nessun estraneo entra) ─
//
// Riconversione del modello: invece dell'erede che ENTRA (inbound `release_*`), al SILENZIO è
// l'AGENTE a CONSEGNARE FUORI l'envelope cifrato verso un canale `__secrets` dell'erede, riusando
// lo scheletro provato (cap-automation `host_deliver` = resolve `{{secret}}` + porta + outcall +
// nota non-2xx). Il metodo di sigillatura è uno strato a strategia client-side (oggi passphrase
// out-of-band, vedi shared/src/core/crypto.js): qui l'envelope è **opaco** (Vec<u8>) → backend
// agnostico al metodo. La condizione è il silenzio (`silence_expired`), zero nuovi timer (gira sul
// tick unico di core-timer dopo `run_due`), zero nuovi MemId (KV 80, ns riservato `__release`).

const RELEASE_DELIVERY_KEY: &str = "delivery";

/// Config della consegna outbound: a QUALE canale `__secrets` (URL d'uscita) e dopo quanto silenzio,
/// con flag fire-once. Self-contenuta (non dipende da `ReleaseConfig`, che è il path inbound) →
/// la Fase 4 può rimuovere l'inbound senza toccare questo.
#[derive(CandidType, Deserialize, Clone, Debug, Default)]
struct DeliveryConfig {
    channel: String,    // nome della credenziale in `__secrets` (il suo valore è l'URL webhook)
    window_secs: u64,   // silenzio richiesto prima della consegna
    delivered: bool,    // fire-once: true dopo una consegna partita; il re-seal lo riazzera
}

fn load_delivery_config() -> Option<DeliveryConfig> {
    cap_store::kv_get(RELEASE_NS, RELEASE_DELIVERY_KEY)
        .and_then(|b| candid::decode_one::<DeliveryConfig>(&b).ok())
}

fn save_delivery_config(dc: &DeliveryConfig) -> Result<(), String> {
    let bytes = candid::encode_one(dc).map_err(|e| format!("delivery: encode config: {e}"))?;
    cap_store::kv_set(RELEASE_NS, RELEASE_DELIVERY_KEY, &bytes)
}

/// Owner arma la consegna outbound: canale d'uscita + finestra di silenzio. Owner-gated, fail-closed.
/// Il canale deve già esistere in `__secrets` (registralo con `set_secret` prima). Riarmo: azzera
/// sempre `delivered` (ogni (ri)configurazione è una nuova promessa di consegna).
#[ic_cdk::update]
fn set_delivery_config(channel: String, window_secs: u64) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    if channel.trim().is_empty() {
        return Err("delivery: canale d'uscita vuoto".to_string());
    }
    if window_secs == 0 {
        return Err("delivery: la finestra di silenzio deve essere > 0".to_string());
    }
    if !cap_store::secret_names().iter().any(|n| n == &channel) {
        return Err(format!("delivery: nessuna credenziale '__secrets' di nome '{channel}'"));
    }
    save_delivery_config(&DeliveryConfig { channel, window_secs, delivered: false })
}

/// Disarma la consegna outbound (cancella la config). Owner-gated. Idempotente.
#[ic_cdk::update]
fn clear_delivery_config() -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::kv_delete(RELEASE_NS, RELEASE_DELIVERY_KEY)
}

/// Config di consegna corrente (owner). Per la Control Room.
#[ic_cdk::query]
fn get_delivery_config() -> Option<DeliveryConfig> {
    if core_auth::require_owner_or_user(caller()).is_err() {
        return None;
    }
    load_delivery_config()
}

/// Il trigger di consegna, valutato ad ogni tick (dopo `run_due`). Se c'è una capsula armata, non
/// ancora consegnata, e l'owner è in silenzio scaduto → spinge FUORI l'envelope opaco verso il canale
/// `__secrets` dell'erede e marca `delivered` (fire-once). Nessun caller (è il canister stesso) → la
/// condizione è puramente il silenzio, non un'autorizzazione di chiamante. Best-effort: su errore di
/// trasporto/budget NON marca `delivered` → ritenta al tick successivo (la nota di consegna non-2xx,
/// se il peer respinge, è già nel log di automazione via `host_deliver`).
async fn deliver_capsule_if_due(now: u64) {
    let Some(mut dc) = load_delivery_config() else { return };
    if dc.delivered || dc.channel.is_empty() {
        return;
    }
    if !silence_expired(current_last_checkin(), dc.window_secs, now) {
        return;
    }
    let Some(envelope) = cap_store::kv_get(RELEASE_NS, RELEASE_CAPSULE_KEY) else { return };
    // L'envelope-metodo (Fase 1) è JSON-UTF8 → testo trasmissibile così com'è. Resta opaco al backend.
    let body = String::from_utf8_lossy(&envelope).to_string();
    let url = format!("{{{{secret:{}}}}}", dc.channel); // "{{secret:CANALE}}" → URL risolto in host_deliver
    let headers = vec![("content-type".to_string(), "application/json".to_string())];
    // Outcall come Owner. Marca `delivered` solo se la consegna è PARTITA (Ok = trasporto riuscito,
    // anche su status non-2xx: in quel caso la nota nel log avvisa che il peer ha respinto). Err di
    // trasporto/budget → lascia `delivered=false` per ritentare. Marcatura DOPO l'await: un eventuale
    // trap nel callback lascia `delivered=false` → al più un doppione (meglio di un'eredità persa).
    match cap_automation::host_deliver("POST", &url, headers, &body, now, "capsule-delivery").await {
        Ok(_status) => {
            dc.delivered = true;
            let _ = save_delivery_config(&dc);
        }
        Err(_) => { /* ritenta al prossimo tick; nessuna marcatura */ }
    }
}

// ─── cap-store (host bundle — gate hash) ──────────────────────────────────────
//
// Installa mini-app verificate per hash IN-CANISTER. Owner-gated. La verifica del manifest
// nel browser (UX) è in F4; qui vive il GATE autorevole: sha256(bytes) == expected → o rifiuto
// senza stato. Serving sotto /m/{id}/ via http_request_update (vedi sopra).

#[ic_cdk::update]
fn install_bundle(
    module_id: String,
    bytes: Vec<u8>,
    expected_sha256: String,
    version: String,
    permissions: BundlePermissions,
) -> Result<BundleMeta, String> {
    core_auth::require_owner_or_user(caller())?;
    let now_secs = ic_cdk::api::time() / 1_000_000_000;
    cap_store::install_bundle(&module_id, &bytes, &expected_sha256, version, permissions, now_secs)
}

#[ic_cdk::update]
fn uninstall_bundle(module_id: String) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_store::uninstall_bundle(&module_id)
}

#[ic_cdk::query]
fn list_bundles() -> Vec<BundleMeta> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_store::list_bundles()
}

// ─── cap-automation (azioni interne + scheduler persistente) ──────────────────
//
// Owner-gated (require_owner_or_user). Un job è una SEQUENZA DICHIARATA di azioni-primitiva
// (no DSL): eseguita sotto i permessi del bundle proprietario (`owning_bundle` → Actor::Bundle
// confinato ai namespace del registro 81, riuso F2; None → Actor::Owner). Lo scheduler NON crea
// timer per-job: gli schedule vivono in stable e il tick consolidato di core-timer chiama run_due.

#[ic_cdk::update]
fn create_job(job: Job) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_automation::create_job(job)
}

#[ic_cdk::update]
fn delete_job(job_id: String) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_automation::delete_job(&job_id)
}

#[ic_cdk::query]
fn list_jobs() -> Vec<Job> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_automation::list_jobs()
}

#[ic_cdk::update]
fn schedule_job(job_id: String, interval_secs: u64) -> Result<String, String> {
    core_auth::require_owner_or_user(caller())?;
    let now_secs = ic_cdk::api::time() / 1_000_000_000;
    cap_automation::schedule_job(&job_id, interval_secs, now_secs)
}

#[ic_cdk::update]
fn unschedule(schedule_id: String) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_automation::unschedule(&schedule_id)
}

#[ic_cdk::query]
fn list_schedules() -> Vec<Schedule> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_automation::list_schedules()
}

#[ic_cdk::update]
async fn run_job_now(job_id: String) -> Result<JobOutcome, String> {
    core_auth::require_owner_or_user(caller())?;
    let now_secs = ic_cdk::api::time() / 1_000_000_000;
    cap_automation::run_job_now(&job_id, now_secs).await
}

/// Transform per gli HTTP outcall (azione `Http` di cap-automation, F3b): canonicalizza la risposta
/// per il consenso fra nodi — tiene status+body, **scarta tutti gli header** (i non-deterministici
/// come Date romperebbero il consenso). Referenziata per nome ("transform") nella richiesta.
#[ic_cdk::query]
fn transform(args: TransformArgs) -> HttpRequestResult {
    HttpRequestResult { status: args.response.status, body: args.response.body, headers: vec![] }
}

#[ic_cdk::query]
fn job_status(job_id: String) -> Option<String> {
    if core_auth::require_owner_or_user(caller()).is_err() { return None; }
    cap_automation::job_status(&job_id)
}

#[ic_cdk::query]
fn automation_log() -> Vec<String> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_automation::automation_log()
}

// ─── cap-crypto ─────────────────────────────────────────────────────────────

#[ic_cdk::update]
async fn get_verification_key(context_name: String) -> Result<String, String> {
    cap_crypto::get_verification_key(context_name).await
}

#[ic_cdk::update]
async fn derive_encrypted_key(
    context_name: String,
    derivation_ctx: DerivationContext,
    transport_public_key: Vec<u8>,
) -> Result<String, String> {
    core_auth::require_owner_or_user(caller())?;
    let owner = core_auth::user_principal().unwrap_or_else(core_auth::owner);
    cap_crypto::derive_encrypted_key(context_name, derivation_ctx, transport_public_key, owner).await
}

// ─── cap-platform (solo con feature "platform") ─────────────────────────────

#[cfg(feature = "platform")]
#[ic_cdk::update]
async fn platform_claim(token: Vec<u8>) -> Result<Principal, String> {
    cap_platform::claim(caller(), token).await
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
fn platform_init_admin(owner: Principal) -> Result<(), String> {
    cap_platform::init_admin(caller(), owner)
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
fn platform_set_portal_owner(portal_owner: Principal) -> Result<(), String> {
    cap_platform::set_portal_owner(caller(), portal_owner)
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
async fn platform_eject(also_remove_portal: bool) -> Result<(), String> {
    cap_platform::eject_platform(caller(), also_remove_portal).await
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
async fn platform_remove_portal() -> Result<(), String> {
    cap_platform::remove_portal_controller(caller()).await
}

#[cfg(feature = "platform")]
#[ic_cdk::query]
fn platform_get_admin() -> Option<Principal> {
    cap_platform::get_admin()
}

#[cfg(feature = "platform")]
#[ic_cdk::query]
fn platform_is_standalone() -> bool {
    cap_platform::is_standalone()
}

#[cfg(feature = "platform")]
#[ic_cdk::query]
fn platform_metadata() -> AppMetadata {
    cap_platform::app_metadata_for(caller())
}

#[cfg(feature = "platform")]
#[ic_cdk::query]
fn platform_cycles() -> candid::Nat {
    cap_platform::cycles()
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
async fn platform_status() -> Result<Status, String> {
    cap_platform::status(caller()).await
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
fn platform_set_status_viewers(viewers: Vec<Principal>) -> Result<(), String> {
    cap_platform::set_status_viewers(caller(), viewers)
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
fn platform_set_private_ops(on: bool) -> Result<(), String> {
    cap_platform::set_private_ops(caller(), on)
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
fn platform_set_tier(tier: u8, expires_ns: Option<u64>) -> Result<(), String> {
    cap_platform::set_tier(caller(), tier, expires_ns)
}

#[cfg(feature = "platform")]
#[ic_cdk::query]
fn platform_get_tier() -> u8 {
    cap_platform::get_tier()
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
async fn platform_add_controller(principal: Principal) -> Result<(), String> {
    cap_platform::add_controller(caller(), principal).await
}

#[cfg(feature = "platform")]
#[ic_cdk::update]
async fn platform_remove_controller(principal: Principal) -> Result<(), String> {
    cap_platform::remove_controller(caller(), principal).await
}

// ─── Candid export ──────────────────────────────────────────────────────────

ic_cdk::export_candid!();

// ─── Test della matematica del silenzio ───────────────────────────────────────
// Pura → unit-testabile senza replica. È il punto di sicurezza: fail-closed.

#[cfg(test)]
mod tests {
    use super::*;

    // ─── silence_expired: la condizione del push outbound della capsula ────────
    #[test]
    fn silence_none_checkin_is_never_expired() {
        // Nessun battito = silenzio non provabile → false anche a now=MAX (fail-closed):
        // il push outbound NON parte senza un battito di riferimento.
        assert!(!silence_expired(None, 1000, u64::MAX));
    }

    #[test]
    fn silence_threshold_is_strict_and_saturating() {
        // == window → non scaduto; +1 → scaduto (stessa soglia stretta di authorize_release).
        assert!(!silence_expired(Some(0), 1000, 1000));
        assert!(silence_expired(Some(0), 1000, 1001));
        // now < last (clock skew / battito futuro) → saturating_sub = 0 → non scaduto.
        assert!(!silence_expired(Some(500), 1000, 100));
    }
}
