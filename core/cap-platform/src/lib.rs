//! cap-platform — ponte SaaS per app della fabbrica
//!
//! Trasforma un'app standalone in un'app vendibile su marketplace.
//! Senza questo modulo (o senza feature "platform"), l'app funziona standalone.
//!
//! Flusso piattaforma (modello binario sovrano-di-default):
//!   1. app_factory crea il canister con init(spawner, factory)
//!   2. cap_platform::set_spawner(spawner, factory) — spawner diventa owner temporaneo
//!   3. Utente chiama claim(token) → cross-canister a spawner::complete_claim
//!   4. complete_claim setta controllers=[app, P_app, P_portal] (spawner escluso),
//!      poi chiama init_admin(user) → user diventa owner + user_principal.
//!      L'app esce GIA' sovrana: eject_platform() non e' necessaria al claim.
//!   5. Supporto EasyCan e' opt-in: add_controller(original_spawner) lo ri-aggiunge.
//!      eject_platform() rimuove lo spawner se e' stato aggiunto come supporto.
//!
//! Storage: 1 MemoryId (PLATFORM_STATE_MEM = 250)
//! Dipendenze: core-auth (set_owner, set_user_principal, require_owner_or_user)

use candid::{CandidType, Principal};
use core_types::Memory;
use ic_stable_structures::StableBTreeMap;
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;

// ─── Tipi ───────────────────────────────────────────────────────────────────

/// Stato della piattaforma, persistente in stable memory.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct PlatformState {
    /// Principal del canister spawner (chi ha provisionato questa app).
    pub spawner: Option<Principal>,
    /// Principal del canister factory (chi ha creato il WASM).
    pub factory_id: Option<Principal>,
    /// Admin dell'app (il buyer dopo il claim).
    pub admin: Option<Principal>,
    /// Identita' portale del buyer (P_portal, diversa da P_app).
    pub portal_owner: Option<Principal>,
    /// Tier corrente: 0=demo, 1=pro.
    pub tier: u8,
    /// Scadenza del tier in nanosecondi Unix (None = nessuna scadenza).
    pub tier_expires_ns: Option<u64>,
    /// Spawner originale (impostato una volta in set_spawner, mai cancellato).
    /// Serve al re-enroll: l'app conosce sempre da quale marketplace proviene.
    pub original_spawner: Option<Principal>,
    /// Portal owner originale (impostato una volta in set_portal_owner, mai cancellato).
    /// Serve all'auto-restore in re_enroll: dopo il rejoin il portale riacquista
    /// accesso senza intervento esterno.
    pub original_portal_owner: Option<Principal>,
}

impl Default for PlatformState {
    fn default() -> Self {
        Self {
            spawner: None,
            factory_id: None,
            admin: None,
            portal_owner: None,
            tier: 0,
            tier_expires_ns: None,
            original_spawner: None,
            original_portal_owner: None,
        }
    }
}

impl ic_stable_structures::Storable for PlatformState {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).unwrap())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).unwrap()
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Unbounded;
}

/// Metadati dell'app esposti al marketplace.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct AppMetadata {
    pub is_standalone: bool,
    pub admin: Option<Principal>,
    pub spawner: Option<Principal>,
    pub ejected: bool,
    /// Hash SHA256 del WASM installato (hex string). None = non ancora impostato.
    /// L'utente puo' verificare autonomamente l'integrita' del WASM.
    pub wasm_hash: Option<String>,
    /// Tier corrente: 0=demo, 1=pro.
    pub tier: u8,
    /// Identita' portale del buyer (P_portal). None se l'app e' standalone,
    /// se non e' stato ancora settato, o se e' stato rimosso post-eject.
    /// Quando Some, il portale del marketplace ha (o aveva) accesso autenticato.
    pub portal_owner: Option<Principal>,
    /// Spawner originale, conservato anche post-eject. Usato dalla UI di
    /// re-enroll per riproporre lo stesso marketplace di partenza.
    pub original_spawner: Option<Principal>,
    /// Portal owner originale, conservato anche post-eject. Auto-ripristinato
    /// da `re_enroll` se `portal_owner` e' None.
    pub original_portal_owner: Option<Principal>,
}

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static STATE: RefCell<Option<StableBTreeMap<u8, PlatformState, Memory>>> =
        const { RefCell::new(None) };
}

// ─── Init ───────────────────────────────────────────────────────────────────

/// Inizializza lo storage con la memory allocata dal MemoryManager.
pub fn init_storage(state_mem: Memory) {
    STATE.with(|s| {
        *s.borrow_mut() = Some(StableBTreeMap::init(state_mem));
    });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn with_state<R>(f: impl FnOnce(&StableBTreeMap<u8, PlatformState, Memory>) -> R) -> R {
    STATE.with(|s| {
        let borrow = s.borrow();
        let map = borrow.as_ref().expect("cap-platform: init_storage() not called");
        f(map)
    })
}

fn with_state_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<u8, PlatformState, Memory>) -> R,
) -> R {
    STATE.with(|s| {
        let mut borrow = s.borrow_mut();
        let map = borrow.as_mut().expect("cap-platform: init_storage() not called");
        f(map)
    })
}

fn get_state() -> PlatformState {
    with_state(|m| m.get(&0u8).unwrap_or_default())
}

fn save_state(state: &PlatformState) {
    with_state_mut(|m| {
        m.insert(0u8, state.clone());
    });
}

// ─── Setup piattaforma (chiamato da init del canister host) ─────────────────

/// Registra spawner e factory. Chiamato dal canister host in `init(spawner, factory)`
/// quando l'app viene deployata dalla piattaforma SaaS.
///
/// Imposta lo spawner come owner temporaneo in core-auth.
pub fn set_spawner(spawner: Principal, factory: Principal) {
    let mut state = get_state();
    state.spawner = Some(spawner);
    state.factory_id = Some(factory);
    // original_spawner: settato una volta, mai sovrascritto (resta dopo eject)
    if state.original_spawner.is_none() {
        state.original_spawner = Some(spawner);
    }
    save_state(&state);
    // Spawner diventa owner temporaneo fino al claim
    core_auth::set_owner(spawner);
}

// ─── Init Admin (chiamato dallo spawner dopo il claim) ──────────────────────

/// Imposta l'admin dell'app. Solo lo spawner puo' chiamarla.
///
/// Dopo questa chiamata, l'admin (buyer) diventa user_principal in core-auth
/// e puo' usare tutte le funzionalita' dell'app.
pub fn init_admin(caller: Principal, owner: Principal) -> Result<(), String> {
    let state = get_state();
    // Guardia sull'identita' IMMUTABILE del marketplace (`original_spawner`), non
    // sul campo mutabile `spawner`. Fonte di verita' unica: il claim funziona anche
    // quando l'app esce gia' sovrana (lo spawner non resta tra i controller).
    match state.original_spawner {
        Some(sp) if caller == sp => {}
        _ => return Err("Unauthorized: only spawner can init admin".to_string()),
    }
    // Idempotente: se admin gia' impostato, non cambiare
    if state.admin.is_some() {
        return Ok(());
    }
    let mut state = state;
    state.admin = Some(owner);
    save_state(&state);
    // Sovrano di default: al claim l'admin diventa SUBITO owner pieno (non piu' lo
    // spawner come owner temporaneo). Il "supporto EasyCan" e' un opt-in esplicito
    // successivo, non uno stato implicito.
    core_auth::set_owner(owner);
    core_auth::set_user_principal(owner);
    Ok(())
}

// ─── Set Portal Owner ───────────────────────────────────────────────────────

/// Imposta il portal owner (identita' P_portal del buyer).
/// Solo lo spawner puo' chiamarla.
pub fn set_portal_owner(caller: Principal, portal_owner: Principal) -> Result<(), String> {
    let state = get_state();
    match state.original_spawner {
        Some(sp) if caller == sp => {}
        _ => return Err("Unauthorized: only spawner can set portal owner".to_string()),
    }
    // Set-once: il portal owner si imposta UNA sola volta, al claim. Bloccare le
    // riscritture chiude la via di ri-escalation (uno spawner non puo' piu'
    // riassegnare portal_owner per poi rientrare come controller). Idempotente se
    // chiamato di nuovo con lo stesso principal (retry del claim prima del consume
    // del token).
    if let Some(existing) = state.original_portal_owner {
        if existing == portal_owner {
            return Ok(());
        }
        return Err("portal_owner already set to a different principal (set-once)".to_string());
    }
    let mut state = state;
    state.portal_owner = Some(portal_owner);
    state.original_portal_owner = Some(portal_owner);
    save_state(&state);
    Ok(())
}

// ─── Claim (async — cross-canister call allo spawner) ───────────────────────

/// Claim dell'app. Il caller invia il token, cap-platform lo inoltra
/// allo spawner via cross-canister call.
///
/// Ritorna il principal del caller (P_app) che diventa admin.
pub async fn claim(caller: Principal, token: Vec<u8>) -> Result<Principal, String> {
    let state = get_state();
    let spawner = state
        .spawner
        .ok_or("Not a platform app: no spawner configured")?;

    // Cross-canister call: spawner.complete_claim(token, caller)
    let args = (token, caller);
    let response = ic_cdk::call::Call::unbounded_wait(spawner, "complete_claim")
        .with_args(&args)
        .await
        .map_err(|err| format!("Cross-canister call failed: {err:?}"))?;

    let inner_result: Result<(), String> = response
        .candid()
        .map_err(|err| format!("Failed to decode response: {err:?}"))?;

    inner_result.map(|()| caller).map_err(|e| format!("Spawner rejected claim: {e}"))
}

// ─── Eject Platform (async — modifica controller) ───────────────────────────

/// L'admin rimuove lo spawner dai controller del canister.
/// Dopo questa chiamata, l'app diventa completamente sovrana.
///
/// `also_remove_portal`: **LEGACY — il frontend passa SEMPRE `false`.**
/// La firma candid `(bool)` e' mantenuta solo per backward-compat.
/// La rimozione del portale post-eject passa
/// ora da `platform_remove_portal` (`remove_portal_controller`), modello
/// binario: l'eject tocca solo lo spawner, il portal_owner e' una preferenza
/// di dashboard gestita a parte.
/// Quando `true` (ramo legacy), rimuove anche `portal_owner` (P_portal) dai
/// controller: il portale del marketplace perde visibilita' autenticata sul
/// canister (canister_status, top-up dal portale).
pub async fn eject_platform(caller: Principal, also_remove_portal: bool) -> Result<(), String> {
    let state = get_state();
    let admin = state
        .admin
        .ok_or("No admin set — claim not completed")?;

    if caller != admin {
        return Err("Unauthorized: only admin can eject platform".to_string());
    }

    // Identita' immutabile dello spawner EasyCan: e' lei che va rimossa dai
    // controller, non un campo mutabile. `original_spawner` e' None solo se l'app
    // e' standalone (mai provisionata).
    let spawner = state
        .original_spawner
        .ok_or("Not a platform app (standalone)")?;

    // Leggi i controller attuali
    let canister_id = ic_cdk::api::canister_self();
    let status_args = ic_cdk::management_canister::CanisterStatusArgs { canister_id };
    let status = ic_cdk::management_canister::canister_status(&status_args)
        .await
        .map_err(|err| format!("Failed to get status: {err:?}"))?;

    // Rimuovi spawner (e opzionalmente portal_owner) dalla lista controller.
    // Idempotente: se lo spawner non e' (piu') controller, non rimuove nulla.
    let portal_owner = if also_remove_portal { state.portal_owner } else { None };
    let new_controllers: Vec<Principal> = status
        .settings
        .controllers
        .into_iter()
        .filter(|c| *c != spawner && Some(*c) != portal_owner)
        .collect();

    // Aggiorna i controller
    let update_args = ic_cdk::management_canister::UpdateSettingsArgs {
        canister_id,
        settings: ic_cdk::management_canister::CanisterSettings {
            controllers: Some(new_controllers),
            ..Default::default()
        },
    };
    ic_cdk::management_canister::update_settings(&update_args)
        .await
        .map_err(|err| format!("Failed to update settings: {err:?}"))?;

    // Fonte di verita' unica: la sovranita' e' la lista controller IC, non
    // `state.spawner` (vestigiale). Non lo tocchiamo. Aggiorniamo solo
    // `portal_owner` se l'utente ha scelto di rimuovere anche la dashboard.
    if also_remove_portal {
        let mut state = get_state();
        state.portal_owner = None;
        save_state(&state);
    }

    // L'admin e' (gia') owner pieno.
    core_auth::set_owner(admin);

    Ok(())
}

// ─── Query ──────────────────────────────────────────────────────────────────

/// Ritorna l'admin dell'app, se impostato.
pub fn get_admin() -> Option<Principal> {
    get_state().admin
}

/// Ritorna lo spawner EasyCan **se e solo se e' attualmente un controller IC**
/// del canister (fonte di verita' unica). None quando l'app e' sovrana (supporto
/// off), standalone, o pre-claim senza spawner. Deriva da `is_controller`, quindi
/// gira solo dentro un canister (non nei test puri — usare `derive_metadata`).
pub fn get_spawner() -> Option<Principal> {
    let original = get_state().original_spawner?;
    if ic_cdk::api::is_controller(&original) {
        Some(original)
    } else {
        None
    }
}

/// True se il caller e' il factory che ha creato questa app.
pub fn is_factory(caller: Principal) -> bool {
    get_state().factory_id.map(|f| f == caller).unwrap_or(false)
}

/// True se il caller e' il factory E la finestra di provisioning e' ancora
/// aperta (nessun admin → nessun claim avvenuto).
///
/// Guard per upload_asset_batch/finalize_assets: la factory puo' caricare gli
/// asset frontend solo durante il provisioning iniziale, prima del claim. Dopo
/// che l'utente ha fatto claim (`admin` settato) la finestra si chiude e la
/// factory non puo' piu' sostituire il frontend dell'app — `factory_id` resta
/// settato per sempre come marcatore "app provisioned", quindi `is_factory` da
/// solo non basta a chiudere la finestra.
pub fn is_provisioning_factory(caller: Principal) -> bool {
    let state = get_state();
    state.admin.is_none() && state.factory_id == Some(caller)
}

/// True se l'app e' standalone (nessuno spawner configurato).
pub fn is_standalone() -> bool {
    get_state().spawner.is_none() && get_state().factory_id.is_none()
}

/// Derivazione PURA dei metadati dallo stato + il fatto vivo "EasyCan e' un
/// controller IC?". Estratta come fn pura per restare testabile senza l'API
/// `is_controller` (che non gira nei `#[test]`). Fonte di verita' unica:
///
/// - `spawner` = `Some(original_spawner)` SSE EasyCan e' attualmente controller
///   ("supporto on"); altrimenti `None`. E' l'indicatore di controllo live.
/// - `ejected` = l'app e' stata claimata (`admin` impostato) ed e' una platform
///   app. Modello sovrano-di-default: claim ⟹ sovrano-base. NON dipende dal
///   supporto: concedere/revocare il supporto NON cambia `ejected` (cambia solo
///   `spawner`). La distinzione managed/emancipated e' collassata nel binario
///   sovrano ↔ supportato, che si legge da `spawner`.
fn derive_metadata(state: &PlatformState, easycan_controls: bool) -> AppMetadata {
    let had_platform = state.factory_id.is_some() || state.original_spawner.is_some();
    AppMetadata {
        is_standalone: !had_platform,
        admin: state.admin,
        spawner: if easycan_controls { state.original_spawner } else { None },
        ejected: had_platform && state.admin.is_some(),
        wasm_hash: None, // impostato dal marketplace dopo install_code
        tier: state.tier,
        portal_owner: state.portal_owner,
        original_spawner: state.original_spawner,
        original_portal_owner: state.original_portal_owner,
    }
}

/// Metadati per il marketplace / diagnostica. Legge la lista controller IC via
/// `is_controller` (sync, disponibile anche in query) e delega la forma a
/// [`derive_metadata`].
pub fn app_metadata() -> AppMetadata {
    let state = get_state();
    let easycan_controls = state
        .original_spawner
        .map(|s| ic_cdk::api::is_controller(&s))
        .unwrap_or(false);
    derive_metadata(&state, easycan_controls)
}

/// Come `app_metadata()` ma con redazione dei principal per chiamanti non
/// autorizzati (privacy: evita di correlare pubblicamente l'app al P_portal
/// del proprietario). I campi pubblici (`is_standalone`, `ejected`, `wasm_hash`,
/// `tier`) restano sempre visibili — `wasm_hash` deve restare auditabile da
/// chiunque. Autorizzati: admin, portal_owner, spawner, e gli original_* (parti
/// che conoscono già questi principal: lo spawner li ha impostati).
pub fn app_metadata_for(caller: Principal) -> AppMetadata {
    let mut meta = app_metadata();
    let c = Some(caller);
    let authorized = c == meta.admin
        || c == meta.portal_owner
        || c == meta.spawner
        || c == meta.original_spawner
        || c == meta.original_portal_owner;
    if !authorized {
        meta.admin = None;
        meta.spawner = None;
        meta.portal_owner = None;
        meta.original_spawner = None;
        meta.original_portal_owner = None;
    }
    meta
}

// ─── Cut portal access (post-eject) ─────────────────────────────────────────

/// Rimuove il `portal_owner` (P_portal) dai controller. Funziona anche post-eject.
///
/// Use case: utente ha fatto `eject_platform(also_remove_portal=false)`, vuole
/// in un secondo momento revocare anche l'accesso del portale (top-up + visibilita').
/// Idempotente: se `portal_owner` non e' tra i controller (o e' None), la chiamata
/// aggiorna comunque lo stato per riflettere "portale gia' fuori".
pub async fn remove_portal_controller(caller: Principal) -> Result<(), String> {
    let state = get_state();
    let admin = state
        .admin
        .ok_or("No admin set — claim not completed")?;

    if caller != admin {
        return Err("Unauthorized: only admin can cut portal access".to_string());
    }

    let portal_owner = match state.portal_owner {
        Some(p) => p,
        // Gia' rimosso o mai settato — nulla da fare
        None => return Ok(()),
    };

    let canister_id = ic_cdk::api::canister_self();
    let status_args = ic_cdk::management_canister::CanisterStatusArgs { canister_id };
    let status = ic_cdk::management_canister::canister_status(&status_args)
        .await
        .map_err(|err| format!("Failed to get status: {err:?}"))?;

    let new_controllers: Vec<Principal> = status
        .settings
        .controllers
        .into_iter()
        .filter(|c| *c != portal_owner)
        .collect();

    let update_args = ic_cdk::management_canister::UpdateSettingsArgs {
        canister_id,
        settings: ic_cdk::management_canister::CanisterSettings {
            controllers: Some(new_controllers),
            ..Default::default()
        },
    };
    ic_cdk::management_canister::update_settings(&update_args)
        .await
        .map_err(|err| format!("Failed to update settings: {err:?}"))?;

    // Aggiorna stato: portal_owner rimosso
    let mut state = get_state();
    state.portal_owner = None;
    save_state(&state);

    Ok(())
}

// ─── Restore portal access (simmetrico a remove_portal_controller) ──────────

/// Ri-aggiunge il portal owner ai controller e risetta `state.portal_owner`.
/// Simmetrico a [`remove_portal_controller`]. Indipendente dallo spawner:
/// un'app emancipated resta emancipated (NON ri-aggiunge lo spawner, a
/// differenza di [`re_enroll`]). Riattiva solo la dashboard del marketplace.
///
/// Fonte del principal: `portal_owner` se ancora presente, altrimenti
/// `original_portal_owner` (settato una volta al claim, mai cancellato).
///
/// Guard: solo `admin`. Il portal owner non puo' autorizzare il proprio
/// ripristino (post-rimozione e' None, e comunque non e' un atto di sovranita').
///
/// Idempotente: se il portale e' gia' attivo e gia' controller, no-op.
pub async fn restore_portal_controller(caller: Principal) -> Result<(), String> {
    let state = get_state();
    let admin = state
        .admin
        .ok_or("No admin set — claim not completed")?;

    if caller != admin {
        return Err("Unauthorized: only admin can restore portal access".to_string());
    }

    let portal = state
        .portal_owner
        .or(state.original_portal_owner)
        .ok_or("No portal identity to restore — app never had one")?;

    let canister_id = ic_cdk::api::canister_self();
    let status_args = ic_cdk::management_canister::CanisterStatusArgs { canister_id };
    let status = ic_cdk::management_canister::canister_status(&status_args)
        .await
        .map_err(|err| format!("Failed to get status: {err:?}"))?;

    let mut controllers = status.settings.controllers;
    if !controllers.contains(&portal) {
        controllers.push(portal);
        let update_args = ic_cdk::management_canister::UpdateSettingsArgs {
            canister_id,
            settings: ic_cdk::management_canister::CanisterSettings {
                controllers: Some(controllers),
                ..Default::default()
            },
        };
        ic_cdk::management_canister::update_settings(&update_args)
            .await
            .map_err(|err| format!("Failed to update settings: {err:?}"))?;
    }

    let mut state = get_state();
    state.portal_owner = Some(portal);
    save_state(&state);

    Ok(())
}

// ─── Tier ───────────────────────────────────────────────────────────────────

/// Imposta il tier dell'app. Solo lo spawner puo' chiamarla.
///
/// `tier`: 0=demo, 1=pro.
/// `expires_ns`: scadenza in nanosecondi Unix (None = nessuna scadenza).
pub fn set_tier(caller: Principal, tier: u8, expires_ns: Option<u64>) -> Result<(), String> {
    let state = get_state();
    // Gate sull'identita' immutabile `original_spawner` (non sul campo mutabile):
    // cosi' un eventuale tier Pro sopravviverebbe all'emancipazione. NB: primitiva
    // disponibile ma non cablata ad alcun flusso — nessuno chiama set_tier oggi.
    // Il gating `require_tier` sull'archivio messenger e' stato rimosso (no freemium);
    // la primitiva resta pronta per un futuro uso deliberato (es. tier alto → upgrade).
    match state.original_spawner {
        Some(sp) if caller == sp => {}
        _ => return Err("Unauthorized: only spawner can set tier".to_string()),
    }
    let mut state = state;
    state.tier = tier;
    state.tier_expires_ns = expires_ns;
    save_state(&state);
    Ok(())
}

/// Tier corrente dell'app (0=demo, 1=pro).
/// Controlla la scadenza al momento della lettura — nessun timer necessario.
pub fn get_tier() -> u8 {
    let state = get_state();
    if let Some(expires) = state.tier_expires_ns {
        if ic_cdk::api::time() >= expires {
            return 0;
        }
    }
    state.tier
}

/// Verifica che il tier corrente sia almeno `min`. Ritorna Err se insufficiente.
/// Usata come guard nelle capability premium.
pub fn require_tier(min: u8) -> Result<(), String> {
    if get_tier() < min {
        return Err(format!(
            "Funzionalita' riservata al piano Pro (tier {min}) — piano attuale: demo"
        ));
    }
    Ok(())
}

// ─── Controller management (post-claim) ─────────────────────────────────────

/// Guard condiviso fra add/remove controller: solo admin (post-claim) o
/// portal_owner (finche' presente). Pre-claim non e' utilizzabile.
fn require_controller_manager(caller: Principal) -> Result<(), String> {
    let state = get_state();
    let admin = state
        .admin
        .ok_or("No admin set — claim not completed")?;
    if caller == admin {
        return Ok(());
    }
    if let Some(po) = state.portal_owner {
        if caller == po {
            return Ok(());
        }
    }
    Err("Unauthorized: only admin or portal owner can manage controllers".to_string())
}

/// Aggiunge un principal alla lista controller del canister.
///
/// Idempotente: se gia' presente, ritorna Ok senza modifiche.
///
/// Guard: caller == admin OR caller == portal_owner.
pub async fn add_controller(caller: Principal, principal: Principal) -> Result<(), String> {
    require_controller_manager(caller)?;

    let canister_id = ic_cdk::api::canister_self();
    let status_args = ic_cdk::management_canister::CanisterStatusArgs { canister_id };
    let status = ic_cdk::management_canister::canister_status(&status_args)
        .await
        .map_err(|err| format!("Failed to get status: {err:?}"))?;

    let mut controllers = status.settings.controllers;
    if controllers.contains(&principal) {
        return Ok(()); // gia' presente
    }
    controllers.push(principal);

    let update_args = ic_cdk::management_canister::UpdateSettingsArgs {
        canister_id,
        settings: ic_cdk::management_canister::CanisterSettings {
            controllers: Some(controllers),
            ..Default::default()
        },
    };
    ic_cdk::management_canister::update_settings(&update_args)
        .await
        .map_err(|err| format!("Failed to update settings: {err:?}"))?;

    Ok(())
}

/// Rimuove un principal dalla lista controller del canister.
///
/// Idempotente: se assente, ritorna Ok senza modifiche.
///
/// Guard: caller == admin OR caller == portal_owner.
///
/// Protezioni (per evitare lockout o bypass dei flow ufficiali):
/// - non si puo' rimuovere `ic_cdk::id()` (il canister stesso)
/// - non si puo' rimuovere `admin` (autobloccherebbe l'utente)
/// - non si puo' rimuovere `portal_owner` → usare `remove_portal_controller`
///
/// NB: rimuovere `original_spawner` (EasyCan) E' consentito — e' l'atto di
/// "revoke support" del modello binario. Non c'e' piu' un campo `spawner attivo`
/// da proteggere (fonte di verita' unica = lista controller).
pub async fn remove_controller(caller: Principal, principal: Principal) -> Result<(), String> {
    require_controller_manager(caller)?;

    let state = get_state();
    let admin = state.admin.expect("admin checked in require_controller_manager");

    let self_id = ic_cdk::api::canister_self();
    if principal == self_id {
        return Err("Cannot remove the canister itself from its controllers".to_string());
    }
    if principal == admin {
        return Err("Cannot remove the app admin (would lock you out)".to_string());
    }
    if let Some(po) = state.portal_owner {
        if principal == po {
            return Err(
                "Cannot remove the portal identity from here — use platform_remove_portal instead"
                    .to_string(),
            );
        }
    }

    let canister_id = self_id;
    let status_args = ic_cdk::management_canister::CanisterStatusArgs { canister_id };
    let status = ic_cdk::management_canister::canister_status(&status_args)
        .await
        .map_err(|err| format!("Failed to get status: {err:?}"))?;

    let before = status.settings.controllers.len();
    let controllers: Vec<Principal> = status
        .settings
        .controllers
        .into_iter()
        .filter(|c| *c != principal)
        .collect();
    if controllers.len() == before {
        return Ok(()); // gia' assente, idempotente
    }

    let update_args = ic_cdk::management_canister::UpdateSettingsArgs {
        canister_id,
        settings: ic_cdk::management_canister::CanisterSettings {
            controllers: Some(controllers),
            ..Default::default()
        },
    };
    ic_cdk::management_canister::update_settings(&update_args)
        .await
        .map_err(|err| format!("Failed to update settings: {err:?}"))?;

    Ok(())
}

// ─── Re-enrollment dopo eject ────────────────────────────────────────────────

/// Rientra sotto un marketplace dopo eject.
///
/// Condizioni:
/// - `factory_id` presente (era una platform app)
/// - `caller` e' l'admin (owner sovrano)
///
/// Aggiunge `new_spawner` come controller del canister (self-managed via
/// management canister) e ripristina la dashboard del portale.
///
/// Modello binario (fonte di verita' unica): re_enroll NON ripristina piu' una
/// "ownership managed" — l'owner resta l'admin (sovrano). E' di fatto un
/// grant-support verso un marketplace (di norma `original_spawner`) + restore
/// dashboard, mantenuto come endpoint di comodo. Idempotente.
pub async fn re_enroll(caller: Principal, new_spawner: Principal) -> Result<(), String> {
    let state = get_state();

    // Deve aver avuto uno spawner in origine
    let _factory = state
        .factory_id
        .ok_or("Not a platform app: no factory_id recorded")?;

    let admin = state
        .admin
        .ok_or("No admin set — claim not completed")?;

    if caller != admin {
        return Err("Unauthorized: only admin can re-enroll".to_string());
    }

    // Auto-restore portal_owner se assente: usa original_portal_owner.
    // Cosi' il portale del marketplace riacquista accesso senza intervento esterno.
    let restore_portal: Option<Principal> = if state.portal_owner.is_none() {
        state.original_portal_owner
    } else {
        None
    };

    // Aggiungi new_spawner (e opzionalmente portal_owner) ai controller.
    let canister_id = ic_cdk::api::canister_self();
    let status_args = ic_cdk::management_canister::CanisterStatusArgs { canister_id };
    let status = ic_cdk::management_canister::canister_status(&status_args)
        .await
        .map_err(|err| format!("Failed to get status: {err:?}"))?;

    let mut controllers = status.settings.controllers;
    let mut changed = false;
    if !controllers.contains(&new_spawner) {
        controllers.push(new_spawner);
        changed = true;
    }
    if let Some(po) = restore_portal {
        if !controllers.contains(&po) {
            controllers.push(po);
            changed = true;
        }
    }
    if changed {
        let update_args = ic_cdk::management_canister::UpdateSettingsArgs {
            canister_id,
            settings: ic_cdk::management_canister::CanisterSettings {
                controllers: Some(controllers),
                ..Default::default()
            },
        };
        ic_cdk::management_canister::update_settings(&update_args)
            .await
            .map_err(|err| format!("Failed to update settings: {err:?}"))?;
    }

    // Fonte di verita' unica: NON tocchiamo `state.spawner` (vestigiale) ne'
    // l'owner — l'app resta sovrana, l'admin resta owner. Aggiorniamo solo la
    // dashboard se l'abbiamo ripristinata.
    if let Some(po) = restore_portal {
        let mut state = get_state();
        state.portal_owner = Some(po);
        save_state(&state);
    }

    Ok(())
}

// Tipi Management Canister: usati da ic_cdk::management_canister (nessuna ridefinizione)

// ─── Test ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::memory_manager::MemoryId;
    use ic_stable_structures::Storable;

    fn setup() {
        let mm = core_storage::new_memory_manager();
        // core-auth serve per i test
        core_auth::init_storage(mm.get(MemoryId::new(0)), mm.get(MemoryId::new(1)));
        // cap-platform
        init_storage(mm.get(MemoryId::new(250)));
    }

    fn p(id: u8) -> Principal {
        Principal::from_slice(&[id])
    }

    #[test]
    fn standalone_by_default() {
        setup();
        assert!(is_standalone());
        assert!(get_admin().is_none());
        assert!(get_spawner().is_none());

        let meta = app_metadata();
        assert!(meta.is_standalone);
        assert!(!meta.ejected);
    }

    #[test]
    fn set_spawner_configures_platform() {
        setup();
        let spawner = p(10);
        let factory = p(20);

        set_spawner(spawner, factory);

        assert!(!is_standalone());
        // get_spawner() ora deriva da is_controller (non gira nei #[test]); qui
        // verifichiamo lo stato configurato + l'owner temporaneo.
        assert_eq!(get_state().original_spawner, Some(spawner));
        // Spawner diventa owner temporaneo (fino al claim)
        assert_eq!(core_auth::owner(), spawner);
    }

    #[test]
    fn init_admin_only_by_spawner() {
        setup();
        let spawner = p(10);
        let factory = p(20);
        let user = p(30);
        let intruder = p(99);

        set_spawner(spawner, factory);

        // Intruso non puo' init_admin
        assert!(init_admin(intruder, user).is_err());

        // Spawner puo' init_admin
        assert!(init_admin(spawner, user).is_ok());
        assert_eq!(get_admin(), Some(user));
        assert_eq!(core_auth::user_principal(), Some(user));
    }

    #[test]
    fn init_admin_idempotent() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));

        assert!(init_admin(spawner, p(30)).is_ok());
        // Seconda chiamata non cambia admin
        assert!(init_admin(spawner, p(40)).is_ok());
        assert_eq!(get_admin(), Some(p(30)));
    }

    #[test]
    fn provisioning_factory_window_closes_after_claim() {
        setup();
        let spawner = p(10);
        let factory = p(20);
        let user = p(30);

        set_spawner(spawner, factory);

        // Finestra aperta: la factory puo' caricare asset pre-claim.
        assert!(is_provisioning_factory(factory));
        // Chi non e' la factory non passa, anche a finestra aperta.
        assert!(!is_provisioning_factory(spawner));
        assert!(!is_provisioning_factory(user));

        // Dopo il claim (admin settato) la finestra si chiude per tutti.
        assert!(init_admin(spawner, user).is_ok());
        assert!(!is_provisioning_factory(factory));
        // is_factory resta true (marcatore permanente), ma non basta piu'.
        assert!(is_factory(factory));
    }

    #[test]
    fn provisioning_factory_false_when_standalone() {
        setup();
        // Nessuno spawner/factory configurato: nessuno e' provisioning factory.
        assert!(!is_provisioning_factory(p(20)));
    }

    #[test]
    fn set_portal_owner_only_by_spawner() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));

        assert!(set_portal_owner(p(99), p(50)).is_err());
        assert!(set_portal_owner(spawner, p(50)).is_ok());

        let state = get_state();
        assert_eq!(state.portal_owner, Some(p(50)));
    }

    // app_metadata() chiama is_controller (non gira nei #[test]) → testiamo la
    // derivazione PURA via derive_metadata con il fatto "EasyCan e' controller?"
    // iniettato. Il wiring is_controller e' coperto dai test PocketIC (platform.rs).
    #[test]
    fn derive_metadata_pre_claim_easycan_controls() {
        setup();
        set_spawner(p(10), p(20));
        let state = get_state();

        // Pre-claim: nessun admin, EasyCan e' controller (sta provisionando).
        let meta = derive_metadata(&state, true);
        assert!(!meta.is_standalone);
        assert!(!meta.ejected, "pre-claim: non ancora ejected (admin None)");
        assert!(meta.admin.is_none());
        assert_eq!(meta.spawner, Some(p(10)), "EasyCan controller → spawner Some");
    }

    #[test]
    fn derive_metadata_sovereign_after_claim() {
        setup();
        set_spawner(p(10), p(20));
        let _ = init_admin(p(10), p(30));
        let state = get_state();

        // Sovrano (supporto OFF): EasyCan NON controller.
        let meta = derive_metadata(&state, false);
        assert_eq!(meta.admin, Some(p(30)));
        assert!(meta.ejected, "claimed + EasyCan fuori → sovrano (ejected=true)");
        assert!(meta.spawner.is_none(), "supporto off → spawner None");

        // Supporto ON: EasyCan di nuovo controller → spawner Some, ejected resta true.
        let meta_supported = derive_metadata(&state, true);
        assert!(meta_supported.ejected, "support on NON riporta a managed");
        assert_eq!(meta_supported.spawner, Some(p(10)), "support on → spawner Some");
    }

    #[test]
    fn platform_state_roundtrip() {
        let state = PlatformState {
            spawner: Some(p(1)),
            factory_id: Some(p(2)),
            admin: Some(p(3)),
            portal_owner: Some(p(4)),
            tier: 1,
            tier_expires_ns: Some(999_999),
            original_spawner: Some(p(1)),
            original_portal_owner: Some(p(4)),
        };
        let bytes = ic_stable_structures::Storable::to_bytes(&state);
        let restored = PlatformState::from_bytes(bytes);
        assert_eq!(restored.spawner, state.spawner);
        assert_eq!(restored.factory_id, state.factory_id);
        assert_eq!(restored.admin, state.admin);
        assert_eq!(restored.portal_owner, state.portal_owner);
        assert_eq!(restored.tier, 1);
        assert_eq!(restored.tier_expires_ns, Some(999_999));
    }

    #[test]
    fn derive_metadata_exposes_portal_owner() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        let _ = init_admin(spawner, p(30));
        set_portal_owner(spawner, p(50)).unwrap();

        // portal_owner resta un campo memorizzato (tenuto in sync da
        // remove/restore_portal), non derivato da is_controller.
        let meta = derive_metadata(&get_state(), false);
        assert_eq!(meta.portal_owner, Some(p(50)));
    }

    #[test]
    fn set_portal_owner_is_set_once() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));

        // Primo set ok.
        assert!(set_portal_owner(spawner, p(50)).is_ok());
        // Idempotente con lo stesso principal (retry del claim).
        assert!(set_portal_owner(spawner, p(50)).is_ok());
        // Riscrittura con principal DIVERSO bloccata (chiude la ri-escalation).
        assert!(set_portal_owner(spawner, p(51)).is_err());
        assert_eq!(get_state().portal_owner, Some(p(50)));
        assert_eq!(get_state().original_portal_owner, Some(p(50)));
    }

    // claim(), eject_platform() e remove_portal_controller() sono async e
    // richiedono cross-canister call → testati in integration test con PocketIC

    #[test]
    fn set_tier_only_by_spawner() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));

        assert!(set_tier(p(99), 1, None).is_err());
        assert!(set_tier(spawner, 1, None).is_ok());
        assert_eq!(get_tier(), 1);
    }

    #[test]
    fn require_tier_demo_fails_for_pro() {
        setup();
        // tier=0 (default)
        assert!(require_tier(0).is_ok());
        assert!(require_tier(1).is_err());
    }

    #[test]
    fn require_tier_pro_passes() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        set_tier(spawner, 1, None).unwrap();

        assert!(require_tier(0).is_ok());
        assert!(require_tier(1).is_ok());
    }

    // re_enroll, add_controller, remove_controller sono async e chiamano il
    // management canister → testati in integration test con PocketIC.
    // I guard sincroni (require_controller_manager) sono testati qui sotto.

    #[test]
    fn require_controller_manager_admin_ok() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        let _ = init_admin(spawner, p(30));
        assert!(require_controller_manager(p(30)).is_ok());
    }

    #[test]
    fn require_controller_manager_portal_owner_ok() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        let _ = init_admin(spawner, p(30));
        set_portal_owner(spawner, p(50)).unwrap();
        assert!(require_controller_manager(p(50)).is_ok());
    }

    #[test]
    fn require_controller_manager_stranger_err() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        let _ = init_admin(spawner, p(30));
        assert!(require_controller_manager(p(99)).is_err());
    }

    #[test]
    fn require_controller_manager_pre_claim_err() {
        setup();
        // Nessun admin settato
        assert!(require_controller_manager(p(1)).is_err());
    }

    #[test]
    fn original_spawner_preserved_across_set_spawner() {
        setup();
        let s1 = p(10);
        let s2 = p(11);
        set_spawner(s1, p(20));
        assert_eq!(get_state().original_spawner, Some(s1));
        // Anche se set_spawner venisse ri-chiamato, original_spawner non cambia
        set_spawner(s2, p(20));
        assert_eq!(get_state().original_spawner, Some(s1));
    }

    // (original_portal_owner_preserved_across_set rimosso: il set-once e' coperto
    // da set_portal_owner_is_set_once; la riassegnazione non e' piu' consentita.)

    #[test]
    fn original_portal_owner_exposed_in_metadata() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        set_portal_owner(spawner, p(50)).unwrap();
        let meta = derive_metadata(&get_state(), false);
        assert_eq!(meta.original_portal_owner, Some(p(50)));
    }

    #[test]
    fn original_spawner_exposed_in_metadata() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        let meta = derive_metadata(&get_state(), false);
        assert_eq!(meta.original_spawner, Some(spawner));
    }
}
