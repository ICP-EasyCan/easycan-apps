//! cap-platform — ponte SaaS per app della fabbrica
//!
//! Trasforma un'app standalone in un'app vendibile su marketplace.
//! Senza questo modulo (o senza feature "platform"), l'app funziona standalone.
//!
//! Flusso piattaforma (modello binario sovrano-di-default):
//!   1. app_factory crea il canister con init(spawner, factory)
//!   2. cap_platform::set_spawner(spawner, factory) — spawner diventa owner temporaneo
//!   3. Utente chiama claim(token) → cross-canister a spawner::complete_claim
//!   4. complete_claim setta controllers=[app, P_app] (spawner E P_portal esclusi),
//!      poi chiama init_admin(user) → user diventa owner + user_principal.
//!      L'app esce GIA' sovrana: eject_platform() non e' necessaria al claim.
//!   5. F4: il grant-support EasyCan e' RITIRATO in modo permanente — lo spawner
//!      non e' ri-aggiungibile come controller (lock in add_controller). Update
//!      via self-upgrade §B (chiave utente), recovery via backup-key (F2).
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
    /// L'app conosce sempre da quale marketplace proviene; usato dal lock F4
    /// (`is_retired_support_principal`) e per escludere EasyCan dalle backup-key.
    pub original_spawner: Option<Principal>,
    /// Portal owner originale (impostato una volta in set_portal_owner, mai cancellato).
    /// Post-A2 (#3) serve solo come àncora di rifiuto in `is_portal_identity`:
    /// P_portal (attuale o originale) non e' ri-aggiungibile come controller. Il
    /// suo vecchio uso "auto-restore" e' decaduto col ritiro di `restore_portal_controller`.
    pub original_portal_owner: Option<Principal>,
    /// Chi, oltre all'admin, e' esente dalla redazione di `platform_status`
    /// (vede `controllers` e — se `private_ops` — i dati operativi). `None` =
    /// default `{portal_owner}`; `Some(vec![])` = solo l'admin. Additivo
    /// (backward-compat): le app pre-F1 lo leggono come `None`.
    pub status_viewers: Option<Vec<Principal>>,
    /// Se `Some(true)`, la redazione di `platform_status` copre anche i dati
    /// operativi (status/cycles/memory/freezing) per i non-viewer. `None`/`false`
    /// = operativi pubblici (comportamento storico via management canister).
    pub private_ops: Option<bool>,
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
            status_viewers: None,
            private_ops: None,
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
    /// Spawner originale, conservato anche post-eject. Identifica il marketplace
    /// di provenienza; usato per escludere EasyCan dalle backup-key dell'utente.
    pub original_spawner: Option<Principal>,
    /// Portal owner originale, conservato anche post-eject. Post-A2 e' solo
    /// l'ancora di rifiuto che impedisce di ri-aggiungere P_portal come controller.
    pub original_portal_owner: Option<Principal>,
}

/// Stato runtime del canister (cicli/memoria/controllers), esposto da
/// `platform_status`. **Sovranita' ≠ opacita':** i campi sono `Option` per
/// permettere la **redazione per-campo** ai chiamanti non autorizzati (stesso
/// principio di `app_metadata_for`, che mette i principal a `None`). Regole:
///
/// - `module_hash`: MAI redatto (invariante di verificabilita': nasconderlo non
///   protegge il proprietario, toglie a chi interagisce con lui la verifica del
///   codice). `None` solo se il canister e' vuoto.
/// - `controllers`: viewer-gated SEMPRE (unico campo correlante). `None` per i
///   non-viewer.
/// - `status`/`cycles`/`memory_size`/`freezing_threshold`: pubblici per default;
///   `None` per i non-viewer SOLO se `private_ops` e' acceso (opacita' sovrana
///   senza danno a terzi).
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct Status {
    pub module_hash: Option<Vec<u8>>,
    pub controllers: Option<Vec<Principal>>,
    pub status: Option<ic_cdk::management_canister::CanisterStatusType>,
    pub cycles: Option<candid::Nat>,
    pub memory_size: Option<candid::Nat>,
    pub freezing_threshold: Option<candid::Nat>,
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

// ─── Status runtime (cicli/stato/controllers) — dashboard app-side ──────────

/// Polso cicli: query sincrona, gratis, pubblica. Il badge cicli della
/// dashboard la chiama senza inter-canister call (a differenza di
/// `platform_status`). Sempre visibile: il saldo cicli non correla il
/// proprietario a un'identita'.
pub fn cycles() -> candid::Nat {
    candid::Nat::from(ic_cdk::api::canister_cycle_balance())
}

/// True se `caller` e' esente dalla redazione di [`status`]. Sempre l'admin;
/// inoltre i `status_viewers` (default `{portal_owner}` se mai impostati). Puro
/// e testabile (nessuna API IC).
fn is_status_viewer(caller: Principal, state: &PlatformState) -> bool {
    if Some(caller) == state.admin {
        return true;
    }
    match &state.status_viewers {
        Some(viewers) => viewers.contains(&caller),
        None => Some(caller) == state.portal_owner,
    }
}

/// Costruisce lo [`Status`] redatto per `caller` a partire dai campi grezzi letti
/// da `canister_status`. **Puro** (nessuna API IC) → la matrice di redazione e'
/// testabile in `#[test]` iniettando i valori grezzi. Vedi [`Status`] per le
/// regole per-campo.
#[allow(clippy::too_many_arguments)]
fn redact_status(
    caller: Principal,
    state: &PlatformState,
    module_hash: Option<Vec<u8>>,
    controllers: Vec<Principal>,
    status: ic_cdk::management_canister::CanisterStatusType,
    cycles: candid::Nat,
    memory_size: candid::Nat,
    freezing_threshold: candid::Nat,
) -> Status {
    let is_viewer = is_status_viewer(caller, state);
    let private_ops = state.private_ops.unwrap_or(false);
    // Operativi: visibili se non privati, oppure al viewer.
    let ops_visible = !private_ops || is_viewer;
    Status {
        // module_hash: mai redatto (verificabilita').
        module_hash,
        // controllers: viewer-gated sempre.
        controllers: if is_viewer { Some(controllers) } else { None },
        status: if ops_visible { Some(status) } else { None },
        cycles: if ops_visible { Some(cycles) } else { None },
        memory_size: if ops_visible { Some(memory_size) } else { None },
        freezing_threshold: if ops_visible { Some(freezing_threshold) } else { None },
    }
}

/// Status runtime del canister, redatto per `caller`. Il canister chiama
/// `canister_status` **su se stesso** (e' controller di se') → non dipende piu'
/// da `P_portal`-controller (path che muore con F3). Update perche'
/// `canister_status` e' una inter-canister call.
pub async fn status(caller: Principal) -> Result<Status, String> {
    let canister_id = ic_cdk::api::canister_self();
    let status_args = ic_cdk::management_canister::CanisterStatusArgs { canister_id };
    let result = ic_cdk::management_canister::canister_status(&status_args)
        .await
        .map_err(|err| format!("Failed to get status: {err:?}"))?;

    let state = get_state();
    Ok(redact_status(
        caller,
        &state,
        result.module_hash,
        result.settings.controllers,
        result.status,
        result.cycles,
        result.memory_size,
        result.settings.freezing_threshold,
    ))
}

/// Imposta i `status_viewers` (chi, oltre all'admin, e' esente da redazione in
/// [`status`]). Admin-only. `vec![]` = solo l'admin (fuori anche il portale).
pub fn set_status_viewers(caller: Principal, viewers: Vec<Principal>) -> Result<(), String> {
    let mut state = get_state();
    let admin = state.admin.ok_or("No admin set — claim not completed")?;
    if caller != admin {
        return Err("Unauthorized: only admin can set status viewers".to_string());
    }
    state.status_viewers = Some(viewers);
    save_state(&state);
    Ok(())
}

/// Accende/spegne `private_ops` (estende la redazione di [`status`] ai dati
/// operativi per i non-viewer). Admin-only.
pub fn set_private_ops(caller: Principal, on: bool) -> Result<(), String> {
    let mut state = get_state();
    let admin = state.admin.ok_or("No admin set — claim not completed")?;
    if caller != admin {
        return Err("Unauthorized: only admin can set private ops".to_string());
    }
    state.private_ops = Some(on);
    save_state(&state);
    Ok(())
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

// ─── Restore portal access — RIMOSSO in A2 (#3) ─────────────────────────────
//
// `restore_portal_controller(caller)` ri-aggiungeva il portal owner (P_portal)
// ai controller dopo un `remove_portal_controller`. A2 vieta P_portal come
// controller in `add_controller` (vedi `is_portal_identity`): tenere un endpoint
// che fa esattamente la cosa vietata da un'altra porta sarebbe incoerente. Come
// `re_enroll` in F4, il ritiro rende la promessa vera *nel binario*, non solo de
// facto: la rimozione del portale è permanente per costruzione. `original_portal_owner`
// resta solo come àncora di rifiuto in `is_portal_identity` (non più "auto-restore").
// Override consapevole di F4 "restore_portal TENUTO": il test live ha mostrato che
// la porta va chiusa. Recovery resta IC-native via una backup-key dell'utente.

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

/// I principal del marketplace EasyCan (spawner attuale/originale, factory) che,
/// dopo F4 (ritiro grant-support), NON sono **mai** ri-aggiungibili come
/// controller di un'app claimata.
///
/// È il lock che rende la promessa "non posso tradirti" verificabile nel WASM,
/// non solo de facto: senza lo spawner tra i controller, ogni push-WASM EasyCan
/// (`core_spawner::upgrade_app_canister`, rimosso in F4) resta inerte **per
/// costruzione**, e il meccanismo di "grant support" sparisce dal binario. Le
/// backup-key dell'utente (qualsiasi altro principal) restano permesse.
fn is_retired_support_principal(state: &PlatformState, principal: Principal) -> bool {
    [state.original_spawner, state.spawner, state.factory_id]
        .into_iter()
        .flatten()
        .any(|p| p == principal)
}

/// True se `principal` è l'identità del portale (P_portal), attuale o originale.
///
/// Check gemello di [`is_retired_support_principal`], su un asse diverso: non è il
/// marketplace, è la *tua stessa* identità EasyCan/portale. A2 (#3) la vieta come
/// backup-key in [`add_controller`]: una volta che l'utente ha tolto il portale
/// dai controller (`remove_portal_controller`, atto sovrano permanente), rimetterlo
/// riaprirebbe il vettore "P_portal controller" che aveva chiuso. La backup-key
/// giusta è un'identità che possiede *altrove* (un principal dfx, una seconda II),
/// non la chiave del portale. `original_portal_owner` resta solo come àncora di
/// rifiuto qui (il ritiro di `restore_portal_controller` gli ha tolto l'altro uso).
fn is_portal_identity(state: &PlatformState, principal: Principal) -> bool {
    [state.portal_owner, state.original_portal_owner]
        .into_iter()
        .flatten()
        .any(|p| p == principal)
}

/// Aggiunge un principal alla lista controller del canister.
///
/// Idempotente: se gia' presente, ritorna Ok senza modifiche.
///
/// Guard: caller == admin OR caller == portal_owner.
///
/// Lock F4: rifiuta i principal del marketplace (spawner/factory, vedi
/// [`is_retired_support_principal`]) — il grant-support EasyCan è ritirato in
/// modo permanente e verificabile. Le backup-key dell'utente restano permesse.
///
/// Lock A2 (#3): rifiuta anche l'identità del portale (P_portal, attuale o
/// originale, vedi [`is_portal_identity`]) — rimetterla controller riaprirebbe il
/// vettore "P_portal controller" che la rimozione del portale aveva chiuso.
pub async fn add_controller(caller: Principal, principal: Principal) -> Result<(), String> {
    require_controller_manager(caller)?;

    let state = get_state();
    if is_retired_support_principal(&state, principal) {
        return Err(
            "EasyCan support is permanently retired: the marketplace (spawner/factory) \
             can never be re-added as a controller of a claimed app. You can add your \
             own backup keys."
                .to_string(),
        );
    }
    if is_portal_identity(&state, principal) {
        return Err(
            "This is your EasyCan/portal identity, not a backup key. Re-adding it as a \
             controller would re-open the access you closed when you turned off the \
             EasyCan dashboard. Use a key you control elsewhere (a dfx principal, or a \
             second Internet Identity) as your backup key."
                .to_string(),
        );
    }

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

// ─── Re-enrollment dopo eject — RIMOSSO in F4 ────────────────────────────────
//
// `re_enroll(new_spawner)` ri-aggiungeva uno spawner (di norma `original_spawner`)
// come controller dell'app = grant-support verso un marketplace. F4 ritira il
// grant-support in modo permanente e verificabile: il lock in `add_controller`
// (vedi `is_retired_support_principal`) impedisce di rimettere lo spawner tra i
// controller con qualunque path → `re_enroll` non avrebbe più semantica lecita ed
// è stato rimosso così da non comparire più nel `.did` dell'app (no sovereignty
// theater). Recovery → backup-key (F2); update → self-upgrade §B.

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
            status_viewers: Some(vec![p(5)]),
            private_ops: Some(true),
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

        // portal_owner resta un campo memorizzato (aggiornato da
        // remove_portal; restore_portal ritirato in A2), non derivato da is_controller.
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

    // add_controller, remove_controller sono async e chiamano il management
    // canister → testati in integration test con PocketIC. I guard sincroni
    // (require_controller_manager, is_retired_support_principal) qui sotto.

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
    fn lock_rejects_marketplace_principals_only() {
        setup();
        let spawner = p(10);
        let factory = p(20);
        set_spawner(spawner, factory);
        let _ = init_admin(spawner, p(30));
        let st = get_state();
        // F4: EasyCan (spawner/original_spawner) e la factory non sono mai
        // ri-aggiungibili come controller di un'app claimata.
        assert!(is_retired_support_principal(&st, spawner));
        assert!(is_retired_support_principal(&st, factory));
        // Le backup-key dell'utente (qualsiasi altro principal) restano permesse.
        assert!(!is_retired_support_principal(&st, p(77)));
        assert!(!is_retired_support_principal(&st, p(30))); // app admin
    }

    #[test]
    fn lock_rejects_portal_identity() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        let _ = init_admin(spawner, p(30));
        set_portal_owner(spawner, p(50)).unwrap();
        let st = get_state();
        // A2 (#3): P_portal (attuale e originale) non è ri-aggiungibile come
        // backup-key. Qui original == portal (set-once), entrambi rifiutati.
        assert!(is_portal_identity(&st, p(50)));
        assert_eq!(st.original_portal_owner, Some(p(50)));
        assert!(is_portal_identity(&st, st.original_portal_owner.unwrap()));
        // Una backup-key genuina (identità che possiedi altrove) resta permessa.
        assert!(!is_portal_identity(&st, p(77)));
        assert!(!is_portal_identity(&st, p(30))); // app admin
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

    // ── platform_status: matrice di redazione (redact_status puro) ──────────

    use ic_cdk::management_canister::CanisterStatusType;

    /// Stato post-claim con admin + portal_owner, per i test di redazione.
    fn status_state() -> PlatformState {
        let mut s = PlatformState::default();
        s.admin = Some(p(30));
        s.portal_owner = Some(p(50));
        s
    }

    /// Invoca redact_status con valori grezzi fissi (controllers = [app, p_app]).
    fn redact_for(caller: Principal, state: &PlatformState) -> Status {
        redact_status(
            caller,
            state,
            Some(vec![0xAA, 0xBB]),       // module_hash
            vec![p(1), p(30)],            // controllers
            CanisterStatusType::Running,
            candid::Nat::from(1_000u64),  // cycles
            candid::Nat::from(2_000u64),  // memory_size
            candid::Nat::from(3_000u64),  // freezing_threshold
        )
    }

    #[test]
    fn status_module_hash_always_public() {
        let state = status_state();
        // Anche un estraneo totale vede module_hash (invariante verificabilita').
        let s = redact_for(p(99), &state);
        assert_eq!(s.module_hash, Some(vec![0xAA, 0xBB]));
    }

    #[test]
    fn status_controllers_viewer_gated() {
        let state = status_state();
        // Admin: vede controllers.
        assert!(redact_for(p(30), &state).controllers.is_some());
        // portal_owner (viewer di default): vede controllers.
        assert!(redact_for(p(50), &state).controllers.is_some());
        // Estraneo: controllers redatti.
        assert!(redact_for(p(99), &state).controllers.is_none());
    }

    #[test]
    fn status_ops_public_by_default() {
        let state = status_state(); // private_ops None
        // Estraneo: dati operativi visibili (comportamento storico), controllers no.
        let s = redact_for(p(99), &state);
        assert!(s.status.is_some());
        assert!(s.cycles.is_some());
        assert!(s.memory_size.is_some());
        assert!(s.freezing_threshold.is_some());
        assert!(s.controllers.is_none());
    }

    #[test]
    fn status_private_ops_hides_ops_for_non_viewer() {
        let mut state = status_state();
        state.private_ops = Some(true);
        // Estraneo: solo module_hash, tutto il resto redatto.
        let s = redact_for(p(99), &state);
        assert_eq!(s.module_hash, Some(vec![0xAA, 0xBB]));
        assert!(s.controllers.is_none());
        assert!(s.status.is_none());
        assert!(s.cycles.is_none());
        assert!(s.memory_size.is_none());
        assert!(s.freezing_threshold.is_none());
        // Viewer (admin): vede tutto anche con private_ops on.
        let full = redact_for(p(30), &state);
        assert!(full.controllers.is_some());
        assert!(full.cycles.is_some());
    }

    #[test]
    fn status_empty_viewers_excludes_portal_owner() {
        let mut state = status_state();
        state.status_viewers = Some(vec![]); // svuotato → solo admin
        // portal_owner non e' piu' viewer.
        assert!(!is_status_viewer(p(50), &state));
        assert!(redact_for(p(50), &state).controllers.is_none());
        // admin resta sempre viewer.
        assert!(is_status_viewer(p(30), &state));
        assert!(redact_for(p(30), &state).controllers.is_some());
    }

    #[test]
    fn status_custom_viewer_set() {
        let mut state = status_state();
        state.status_viewers = Some(vec![p(77)]);
        assert!(is_status_viewer(p(77), &state));   // nel set
        assert!(!is_status_viewer(p(50), &state));  // portal_owner fuori dal set custom
        assert!(is_status_viewer(p(30), &state));   // admin sempre dentro
    }

    #[test]
    fn set_status_viewers_admin_only() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        let _ = init_admin(spawner, p(30));
        assert!(set_status_viewers(p(99), vec![p(1)]).is_err());
        assert!(set_status_viewers(p(30), vec![p(1)]).is_ok());
        assert_eq!(get_state().status_viewers, Some(vec![p(1)]));
    }

    #[test]
    fn set_private_ops_admin_only() {
        setup();
        let spawner = p(10);
        set_spawner(spawner, p(20));
        let _ = init_admin(spawner, p(30));
        assert!(set_private_ops(p(99), true).is_err());
        assert!(set_private_ops(p(30), true).is_ok());
        assert_eq!(get_state().private_ops, Some(true));
    }

    #[test]
    fn set_status_viewers_pre_claim_err() {
        setup();
        // Nessun admin settato → guard scatta.
        assert!(set_status_viewers(p(1), vec![]).is_err());
        assert!(set_private_ops(p(1), true).is_err());
    }
    // status() e cycles() chiamano API IC (canister_status / canister_cycle_balance)
    // → coperti dai test PocketIC; qui copriamo la redazione pura + i guard.
}
