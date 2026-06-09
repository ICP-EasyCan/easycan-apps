//! Sovereign Vault — canister host
//!
//! Personal security vault: Password Manager, File Manager, Encrypted Notes.
//! All data encrypted client-side with VetKeys AES-256-GCM.
//! Storage via cap-crud (namespace-based CRUD).

use candid::Principal;
use ic_stable_structures::memory_manager::MemoryManager;
use ic_stable_structures::DefaultMemoryImpl;
use std::cell::RefCell;

// Re-export tipi Candid per export_candid!()
use cap_crud::{CreateInput, CrudRecord, ListResult, UpdateInput};
use cap_crypto::DerivationContext;
use core_assets::{HttpRequest, HttpResponse};

#[cfg(feature = "platform")]
use cap_platform::AppMetadata;

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
}

#[cfg(feature = "platform")]
#[ic_cdk::init]
fn init(spawner: Principal, factory: Principal) {
    init_all_storage();
    cap_platform::set_spawner(spawner, factory);
    core_assets::rebuild_cert_tree();
}

#[ic_cdk::post_upgrade]
fn post_upgrade() {
    init_all_storage();
    core_assets::rebuild_cert_tree();
}

fn init_all_storage() {
    core_auth::init_storage(
        get_mem(core_storage::AUTH_OWNER_MEM),
        get_mem(core_storage::AUTH_WHITELIST_MEM),
    );
    core_assets::init_storage(get_mem(core_storage::ASSETS_MEM));

    #[cfg(feature = "platform")]
    cap_platform::init_storage(get_mem(core_storage::PLATFORM_STATE_MEM));

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

#[ic_cdk::query]
fn is_whitelisted(peer: Principal) -> bool { core_auth::is_whitelisted(peer) }

// ─── core-assets ────────────────────────────────────────────────────────────

#[ic_cdk::update]
fn upload_asset(path: String, content_type: String, content: Vec<u8>) -> Result<(), String> {
    core_auth::require_owner(caller())?;
    core_assets::upload_asset(path, content_type, content);
    Ok(())
}

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
#[ic_cdk::update]
async fn platform_restore_portal() -> Result<(), String> {
    cap_platform::restore_portal_controller(caller()).await
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
async fn platform_re_enroll(new_spawner: Principal) -> Result<(), String> {
    cap_platform::re_enroll(caller(), new_spawner).await
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
