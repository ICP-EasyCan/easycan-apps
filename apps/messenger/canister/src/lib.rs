//! Sovereign Messenger — canister host
//!
//! Assemblato dalla fabbrica progetto_modulare.
//! Usa tutti i blocchi: auth, assets, presence, messaging, signaling, notify, archive, crypto.

use candid::Principal;
use ic_stable_structures::memory_manager::MemoryManager;
use ic_stable_structures::DefaultMemoryImpl;
use std::cell::RefCell;
use std::time::Duration;

// Re-export tipi Candid per export_candid!()
use cap_archive::{ArchiveInput, ArchivedMessage};
use cap_crud::{CreateInput, CrudRecord, ListResult, UpdateInput};
use cap_messaging::{FetchedMessage, LeaveMessageResult};
use cap_presence::PresenceInfo;
use cap_signaling::{SignalEntry, WebRtcSignalType};
use core_assets::{HttpRequest, HttpResponse};

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

#[cfg(not(feature = "platform"))]
#[ic_cdk::init]
fn init(owner: Principal) {
    init_all_storage();
    core_auth::set_owner(owner);
    core_assets::rebuild_cert_tree();
    register_cleanups();
}

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

    cap_presence::init_storage(get_mem(core_storage::PRESENCE_MEM));
    cap_messaging::init_storage(
        get_mem(core_storage::MESSAGING_OUTBOX_MEM),
        get_mem(core_storage::MESSAGING_COUNTER_MEM),
    );
    cap_signaling::init_storage(
        get_mem(core_storage::SIGNALING_BOARD_MEM),
        get_mem(core_storage::SIGNALING_COUNTER_MEM),
    );
    cap_notify::init_storage(
        get_mem(core_storage::NOTIFY_SENDERS_MEM),
        get_mem(core_storage::NOTIFY_CALLERS_MEM),
    );
    cap_archive::init_storage(
        get_mem(core_storage::ARCHIVE_MEM),
        get_mem(core_storage::ARCHIVE_COUNTER_MEM),
        get_mem(core_storage::ARCHIVE_PERSIST_FLAGS_MEM),
    );
    cap_crud::init_storage(
        get_mem(core_storage::CRUD_RECORDS_MEM),
        get_mem(core_storage::CRUD_COUNTER_MEM),
        get_mem(core_storage::CRUD_NS_INDEX_MEM),
    );
    cap_crud::configure(cap_crud::CrudConfig {
        max_record_bytes: 65_536,
        max_records_per_namespace: 10_000,
    });
}

fn register_cleanups() {
    core_timer::clear();
    core_timer::register_cleanup(|| cap_presence::cleanup_stale());
    core_timer::register_cleanup(|| cap_messaging::cleanup_expired());
    core_timer::register_cleanup(|| cap_signaling::cleanup_expired());
    // Tick di sola pulizia-memoria (netturbino): la correttezza è sempre in lettura
    // (fetch_my_messages / get_my_signals filtrano lo scaduto; get_presence calcola
    // la staleness a read-time dopo Fase A). 1h ≫ del bisogno (msg TTL 7g) e taglia
    // ~87% del floor idle (timer era ~11,75B/day su ~13B). Vedi messenger_cycles_saving §Fase B.
    core_timer::schedule(Duration::from_secs(3600));
}

// ═══════════════════════════════════════════════════════════════════════════
// Wrapper #[update]/#[query]
// ═══════════════════════════════════════════════════════════════════════════

fn caller() -> Principal {
    ic_cdk::api::msg_caller()
}

// ─── app version (self-upgrade §B) ────────────────────────────────────────────

/// Versione semver bakeata a build dal `Cargo.toml` dell'app (unica fonte di verità,
/// condivisa col `manifest.version` della release). Il `module_hash` resta la prova crittografica.
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

#[ic_cdk::update]
fn add_to_whitelist(peer: Principal) -> Result<(), String> {
    core_auth::add_to_whitelist(caller(), peer)
}

#[ic_cdk::update]
fn remove_from_whitelist(peer: Principal) -> Result<(), String> {
    core_auth::remove_from_whitelist(caller(), peer)
}

/// Un peer può chiedere solo di sé stesso (`caller == peer`, pre-flight del
/// mutual-contact check); owner/user vedono tutto. Terzi: sempre `false`,
/// così la whitelist non è sondabile dall'esterno (grafo sociale).
#[ic_cdk::query]
fn is_whitelisted(peer: Principal) -> bool {
    let c = caller();
    (c == peer || core_auth::is_authorized(c)) && core_auth::is_whitelisted(peer)
}

// ─── core-assets ────────────────────────────────────────────────────────────

#[ic_cdk::update]
fn upload_asset(path: String, content_type: String, content: Vec<u8>) -> Result<(), String> {
    core_auth::require_owner(caller())?;
    core_assets::upload_asset(path, content_type, content);
    Ok(())
}

/// Guard: owner OR factory (platform provisioning).
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

/// Svuota tutti gli asset prima di ricaricare un bundle nuovo (self-upgrade §B): evita file
/// orfani col bundle Vite (hash di contenuto diversi). Va seguito da upload_asset_batch + finalize.
#[ic_cdk::update]
fn clear_assets() -> Result<(), String> {
    require_asset_admin(caller())?;
    core_assets::clear_assets();
    Ok(())
}

#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse { core_assets::http_request(&req) }

#[ic_cdk::update]
fn http_request_update(req: HttpRequest) -> HttpResponse { core_assets::http_request_update(&req) }

// ─── cap-presence ───────────────────────────────────────────────────────────

#[ic_cdk::update]
fn set_presence(online: bool) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_presence::set_presence(online);
    Ok(())
}

#[ic_cdk::query]
fn get_presence() -> Result<PresenceInfo, String> {
    core_auth::require_authorized(caller())?;
    Ok(cap_presence::get_presence())
}

// ─── cap-messaging ──────────────────────────────────────────────────────────

#[ic_cdk::update]
fn leave_message(to: Principal, payload: Vec<u8>, ttl_secs: u64) -> Result<LeaveMessageResult, String> {
    core_auth::require_owner_or_user(caller())?;
    cap_messaging::leave_message(to, payload, ttl_secs)
}

#[ic_cdk::query]
fn fetch_my_messages() -> Vec<FetchedMessage> {
    let c = caller();
    if !core_auth::is_authorized(c) { return vec![]; }
    cap_messaging::fetch_my_messages(c)
}

#[ic_cdk::query]
fn count_my_messages() -> u64 {
    let c = caller();
    if !core_auth::is_authorized(c) { return 0; }
    cap_messaging::count_my_messages(c)
}

#[ic_cdk::update]
fn ack_messages(ids: Vec<u64>) -> Result<(), String> {
    let c = caller();
    core_auth::require_authorized(c)?;
    cap_messaging::ack_messages(c, core_auth::owner(), ids);
    Ok(())
}

#[ic_cdk::update]
fn delete_own_message(id: u64) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_messaging::delete_own_message(id)
}

#[ic_cdk::update]
fn edit_own_message(id: u64, new_payload: Vec<u8>) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_messaging::edit_own_message(id, new_payload)
}

#[ic_cdk::query]
fn pending_ids_for(to: Principal) -> Vec<u64> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_messaging::pending_ids_for(to)
}

// ─── cap-signaling ──────────────────────────────────────────────────────────

#[ic_cdk::update]
fn post_signal(to: Principal, sig_type: WebRtcSignalType, data: String) -> Result<(), String> {
    core_auth::require_authorized(caller())?;
    cap_signaling::post_signal(to, sig_type, data)
}

#[ic_cdk::query]
fn get_my_signals() -> Vec<SignalEntry> {
    let c = caller();
    if !core_auth::is_authorized(c) { return vec![]; }
    cap_signaling::get_my_signals(c)
}

#[ic_cdk::update]
fn ack_signals(ids: Vec<u64>) -> Result<(), String> {
    let c = caller();
    core_auth::require_authorized(c)?;
    cap_signaling::ack_signals(c, core_auth::owner(), ids);
    Ok(())
}

// ─── cap-notify ─────────────────────────────────────────────────────────────

#[ic_cdk::update]
fn notify_pending_message(_sender: Principal) -> Result<(), String> {
    let c = caller();
    core_auth::require_authorized(c)?;
    cap_notify::notify_pending_message(c);
    Ok(())
}

#[ic_cdk::query]
fn get_pending_senders() -> Vec<Principal> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_notify::get_pending_senders()
}

/// Owner/user spegne il flag di un mittente qualsiasi (caso esistente); un mittente
/// autorizzato può spegnere SOLO il flag che ha acceso lui stesso (self-clear,
/// F3 upgrade-messenger — annullamento notifica su delete_own_message).
#[ic_cdk::update]
fn clear_pending_sender(sender: Principal) -> Result<(), String> {
    let c = caller();
    if core_auth::require_owner_or_user(c).is_err() {
        core_auth::require_authorized(c)?;
        if sender != c {
            return Err("Unauthorized: can only self-clear own flag".to_string());
        }
    }
    cap_notify::clear_pending_sender(sender);
    Ok(())
}

#[ic_cdk::update]
fn notify_pending_call(_caller_param: Principal) -> Result<(), String> {
    let c = caller();
    core_auth::require_authorized(c)?;
    cap_notify::notify_pending_call(c);
    Ok(())
}

#[ic_cdk::query]
fn get_pending_callers() -> Vec<Principal> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_notify::get_pending_callers()
}

#[ic_cdk::update]
fn clear_pending_caller(caller_to_clear: Principal) -> Result<(), String> {
    let c = caller();
    // owner/user può rimuovere chiunque (accept/reject/dismiss);
    // il caller stesso può rimuovere se stesso (annullamento spontaneo).
    if c != caller_to_clear {
        core_auth::require_owner_or_user(c)?;
    }
    cap_notify::clear_pending_caller(caller_to_clear);
    Ok(())
}

// ─── cap-archive ────────────────────────────────────────────────────────────

#[ic_cdk::update]
fn archive_messages(peer: Principal, messages: Vec<ArchiveInput>) -> Result<u64, String> {
    core_auth::require_owner_or_user(caller())?;
    cap_archive::archive_messages(peer, messages)
}

#[ic_cdk::query]
fn get_archived_messages(peer: Principal) -> Vec<ArchivedMessage> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_archive::get_archived_messages(peer)
}

#[ic_cdk::update]
fn set_chat_persistent(peer: Principal, persistent: bool) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_archive::set_chat_persistent(peer, persistent);
    Ok(())
}

#[ic_cdk::query]
fn is_chat_persistent(peer: Principal) -> bool {
    if core_auth::require_owner_or_user(caller()).is_err() { return false; }
    cap_archive::is_chat_persistent(peer)
}

#[ic_cdk::query]
fn get_all_persistent_chats() -> Vec<Principal> {
    if core_auth::require_owner_or_user(caller()).is_err() { return vec![]; }
    cap_archive::get_all_persistent_chats()
}

#[ic_cdk::update]
fn delete_archived_message(peer: Principal, id: u64) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_archive::delete_archived_message(peer, id)
}

// ─── cap-crud ───────────────────────────────────────────────────────────────

#[ic_cdk::update]
fn create_record(input: CreateInput) -> Result<CrudRecord, String> {
    core_auth::require_owner_or_user(caller())?;
    cap_crud::create_record(input)
}

#[ic_cdk::query]
fn get_record(id: u64) -> Option<CrudRecord> {
    if core_auth::require_owner_or_user(caller()).is_err() { return None; }
    cap_crud::get_record(id)
}

#[ic_cdk::query]
fn list_records(namespace: String, offset: u64, limit: u64) -> ListResult {
    if core_auth::require_owner_or_user(caller()).is_err() {
        return ListResult { records: vec![], total: 0 };
    }
    cap_crud::list_records(&namespace, offset, limit)
}

#[ic_cdk::update]
fn update_record(id: u64, input: UpdateInput) -> Result<CrudRecord, String> {
    core_auth::require_owner_or_user(caller())?;
    cap_crud::update_record(id, input)
}

#[ic_cdk::update]
fn delete_record(id: u64) -> Result<(), String> {
    core_auth::require_owner_or_user(caller())?;
    cap_crud::delete_record(id)
}

#[ic_cdk::query]
fn count_records(namespace: String) -> u64 {
    if core_auth::require_owner_or_user(caller()).is_err() { return 0; }
    cap_crud::count_records(&namespace)
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

// platform_restore_portal RIMOSSO in A2 (#3): P_portal non e' ri-aggiungibile
// come controller (vedi cap_platform::add_controller). La rimozione del portale
// e' permanente per costruzione.

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
