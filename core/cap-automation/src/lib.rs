//! cap-automation — ABI di azioni-primitiva interne + scheduler persistente del supercanister-hub
//!
//! Decisione di impostazione (confermata): **niente interprete DSL** (no dispatcher/judge/surgeon
//! del kernel). Un `Job` è una **sequenza dichiarata** di azioni-primitiva (tipi Candid, non un
//! programma JSON interpretato). Lo scheduler è **sottile e persistente**.
//!
//! ## Il fix del bug `clock` del kernel (il punto critico)
//! Il kernel teneva i `TimerId` in una `HashMap` **in-memory** → persi all'upgrade. Qui **non**
//! creo timer per-schedule: gli schedule vivono **solo in stable** (`AUTO_SCHEDULES_MEM` 91) e
//! l'esecuzione è guidata dall'**unico tick consolidato di `core-timer`** già wirato nell'host.
//! Ad ogni tick `run_due(now)` legge gli schedule dovuti e li esegue. Il ri-armo è quindi
//! **automatico e strutturale**: `post_upgrade` ri-chiama `init_storage` (ritrova gli schedule in
//! stable) + ri-registra la cleanup-fn → niente stato-timer in-memory da perdere.
//! Conseguenza: in F3 le azioni erano **sincrone**; la catena è resa **async** da F3b (la cleanup-fn
//! di core-timer, `Fn()`, lancia `run_due` con `ic_cdk::futures::spawn`). Azioni esterne async:
//! `Http` (F3b) e `CanisterCall` (F3c), entrambe permission-gated via una porta di `cap-store`
//! chiamata *prima* dell'await (`authorize_http` / `authorize_call`).
//!
//! ## ABI azioni (F3, set fisso interno)
//! `KvSet`/`KvGet`/`KvDel` eseguite via `cap_store::kv_*_as(actor, ..)` → **riuso diretto
//! dell'enforcement F2**: un job con `owning_bundle = Some(id)` agisce come `Actor::Bundle(id)`,
//! confinato ai `storage_namespaces` del registro 81; `owning_bundle = None` → `Actor::Owner`.
//! `CryptoHash` = sha256 hex (deterministico/sync). VetKeys è browser-interattiva → fuori da F3.
//!
//! Dipendenza a senso unico: cap-automation → cap-store.

use candid::CandidType;
use candid::Principal;
use core_types::Memory;
use ic_cdk::call::Call;
use ic_cdk::management_canister::{
    http_request, transform_context_from_query, HttpHeader, HttpMethod, HttpRequestArgs,
};
use ic_stable_structures::storable::{Blob, Bound};
use ic_stable_structures::{StableBTreeMap, Storable};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::HashSet;

use cap_store::Actor;

const MAX_ID: usize = 128;
const LOG_CAP: u64 = 200; // ring buffer: entry massime nel log esecuzioni

// Budget d'uscita (G1, Rilievo 3) — l'agente non si suicida i cicli. Due tetti, nessuno stato stable:
//   - per-run: una singola esecuzione job non può lanciare più di N azioni d'uscita (job-bomba);
//   - per-tick: l'insieme degli azioni d'uscita di TUTTI i job dovuti in un tick è limitato (sciame).
// La cadenza è già limitata dal tick unico di core-timer (120s) + no catch-up; questi chiudono il resto.
const MAX_OUTBOUND_PER_RUN: u32 = 4;
const MAX_OUTBOUND_PER_TICK: u32 = 16;

type IdBlob = Blob<MAX_ID>;

// ═══════════════════════════════════════════════════════════════════════════
// Tipi (Candid — persistibili in stable e passabili sul filo agli endpoint host)
// ═══════════════════════════════════════════════════════════════════════════

/// Azione-primitiva. Gli argomenti stringa supportano il templating `{{stepN[.campo]}}` e i
/// token-tempo `{{now}}` / `{{now-N}}` / `{{now+N}}` (secondi d'esecuzione).
///
/// `KvSet/KvGet/KvDel/CryptoHash` (F3) sono **interne e sincrone**. `Http` (F3b) è **esterna e
/// async**: l'unico canale di esfiltrazione, quindi permission-gated via `cap_store::authorize_http`
/// *prima* dell'outcall (Owner libero; `Bundle(id)` solo verso `permissions.http_outcall_hosts`).
/// L'output dell'azione `Http` è il **body** della risposta (header scartati) → templatabile dagli
/// step successivi; il resolver JSON di `resolve_ref` estrae i campi da una risposta API.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub enum Action {
    KvSet { namespace: String, key: String, value: String },
    KvGet { namespace: String, key: String },
    KvDel { namespace: String, key: String },
    /// sha256(input) → hex. `input` templatabile.
    CryptoHash { input: String },
    /// HTTP outcall (F3b). `method` ∈ {GET,POST,HEAD}; `url`/`body` templatabili; `body` vuoto → nessun
    /// body; `max_response_bytes` 0 → default replica (2MB). Output = body della risposta (utf8-lossy).
    Http {
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: String,
        max_response_bytes: u64,
    },
    /// Chiamata inter-canister (F3c). Forma generica minimale: `canister_id` (Principal testuale,
    /// templatabile), `method`, e `arg_hex` = argomenti candid **già codificati** in esadecimale
    /// (autorati nel job, templatabili). Permission-gated via `cap_store::authorize_call` *prima*
    /// dell'await (Owner libero; `Bundle(id)` solo verso `permissions.inter_canister`). Output = i byte
    /// candid **raw della risposta in hex** (tipo ignoto nella forma generica → non li decodifichiamo;
    /// hex è deterministico e templatabile). A differenza di `Http`, un **reject del canister = `Err`**.
    CanisterCall {
        canister_id: String,
        method: String,
        arg_hex: String,
    },
}

/// Guardia booleana singola (NON un interprete): `field` riferisce `stepN[.campo]`, confrontato
/// con `value` tramite `op`. Operatori: `== != > >= < <= contains`.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub struct Guard {
    pub field: String,
    pub op: String,
    pub value: String,
}

/// Un job = sequenza dichiarata di azioni sotto i permessi del bundle proprietario.
///
/// Semantica della guardia (una sola, niente branching): gli step si eseguono in ordine
/// accumulando output; se `guard` è presente viene valutata **dopo aver eseguito lo step a cui
/// fa riferimento** (prefisso = indice `stepN` citato + 1). Se **falsa**, gli step rimanenti
/// (l'effetto) sono **saltati** e l'esito è `Skipped`. Senza guardia: tutti gli step eseguiti.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub struct Job {
    pub job_id: String,
    pub owning_bundle: Option<String>, // None → Actor::Owner ; Some(id) → Actor::Bundle(id) confinato
    pub actions: Vec<Action>,
    pub guard: Option<Guard>,
    /// Etichetta umana per il Feed-home (F5): il *racconto* dell'agente ("Watch my websites")
    /// invece dell'opaco `job_id`. **Campo additivo `Option`** (forward-compat candid: i Job già
    /// salvati senza questo campo decodificano con `None`) → **nessun nuovo MemId, nessun freeze**:
    /// vive dentro lo struct già in `AUTO_JOBS_MEM` (90). Il giudizio editoriale del Feed resta
    /// DERIVATO (status/external/guard/capsula), non dichiarato: niente tassonomia/`kind` (anti-DSL).
    pub title: Option<String>,
}

/// Schedule persistente. `next_run_secs` ri-letto dallo stable ad ogni tick → niente timer in-memory.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub struct Schedule {
    pub schedule_id: String,
    pub job_id: String,
    pub interval_secs: u64,
    pub next_run_secs: u64,
}

/// Esito di un'esecuzione (per endpoint + status).
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq)]
pub enum JobOutcome {
    Completed,
    Skipped,
}

// ─── Storable ─────────────────────────────────────────────────────────────────

impl Storable for Job {
    fn to_bytes(&self) -> Cow<'_, [u8]> { Cow::Owned(candid::encode_one(self).unwrap()) }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self { candid::decode_one(&bytes).unwrap() }
    fn into_bytes(self) -> Vec<u8> { candid::encode_one(&self).unwrap() }
    const BOUND: Bound = Bound::Unbounded;
}

impl Storable for Schedule {
    fn to_bytes(&self) -> Cow<'_, [u8]> { Cow::Owned(candid::encode_one(self).unwrap()) }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self { candid::decode_one(&bytes).unwrap() }
    fn into_bytes(self) -> Vec<u8> { candid::encode_one(&self).unwrap() }
    const BOUND: Bound = Bound::Unbounded;
}

#[derive(CandidType, Deserialize, Clone)]
struct StorableText(String);

impl Storable for StorableText {
    fn to_bytes(&self) -> Cow<'_, [u8]> { Cow::Owned(candid::encode_one(self).unwrap()) }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self { candid::decode_one(&bytes).unwrap() }
    fn into_bytes(self) -> Vec<u8> { candid::encode_one(&self).unwrap() }
    const BOUND: Bound = Bound::Unbounded;
}

// ═══════════════════════════════════════════════════════════════════════════
// Storage (MemoryId 90-93, congelati in F0)
// ═══════════════════════════════════════════════════════════════════════════

thread_local! {
    static JOBS: RefCell<Option<StableBTreeMap<IdBlob, Job, Memory>>> = const { RefCell::new(None) };
    static SCHEDULES: RefCell<Option<StableBTreeMap<IdBlob, Schedule, Memory>>> = const { RefCell::new(None) };
    static STATUS: RefCell<Option<StableBTreeMap<IdBlob, StorableText, Memory>>> = const { RefCell::new(None) };
    static LOG: RefCell<Option<StableBTreeMap<u64, StorableText, Memory>>> = const { RefCell::new(None) };
    static LOG_NEXT: Cell<u64> = const { Cell::new(0) };

    // Reentrancy guard per job_id (in-memory: i lock non sopravvivono all'upgrade, ed è corretto —
    // dopo un upgrade non c'è alcuna esecuzione in volo da proteggere).
    static RUNNING: RefCell<HashSet<String>> = RefCell::new(HashSet::new());

    // Budget d'uscita per-tick (G1): azzerato all'inizio di `run_due`/`run_job_now`, consumato dalle
    // azioni d'uscita. In-memory: non deve sopravvivere all'upgrade (è un contatore di finestra).
    static TICK_OUTBOUND: Cell<u32> = const { Cell::new(0) };

    // Note di consegna d'uscita (G3, Rilievo 4): un'`Http` che PARTE ma il peer risponde non-2xx NON è
    // un Err di trasporto → il job resta `Completed`, ma la consegna è di fatto fallita (es. webhook
    // morto = 404). Senza traccia morirebbe muta. Le note sono raccolte per-run e drenate da
    // `run_with_lock`: il job conserva il suo esito, ma il log mostra anche la consegna mancata. Mai il
    // segreto — la nota porta SOLO lo status HTTP, mai l'URL/body risolto. In-memory (finestra di run).
    static DELIVERY_NOTES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Inizializza lo storage. Da chiamare nel `init`/`post_upgrade` dell'host con le 4 memorie
/// congelate: AUTO_JOBS_MEM (90), AUTO_SCHEDULES_MEM (91), AUTO_STATUS_MEM (92), AUTO_LOG_MEM (93).
pub fn init_storage(jobs_mem: Memory, schedules_mem: Memory, status_mem: Memory, log_mem: Memory) {
    JOBS.with(|m| *m.borrow_mut() = Some(StableBTreeMap::init(jobs_mem)));
    SCHEDULES.with(|m| *m.borrow_mut() = Some(StableBTreeMap::init(schedules_mem)));
    STATUS.with(|m| *m.borrow_mut() = Some(StableBTreeMap::init(status_mem)));
    LOG.with(|m| *m.borrow_mut() = Some(StableBTreeMap::init(log_mem)));
    // Riallinea il contatore del ring buffer al massimo presente in stable (robusto all'upgrade).
    let next = with_log(|m| m.iter().map(|e| *e.key()).max().map(|k| k + 1).unwrap_or(0));
    LOG_NEXT.with(|c| c.set(next));
}

fn with_jobs<R>(f: impl FnOnce(&mut StableBTreeMap<IdBlob, Job, Memory>) -> R) -> R {
    JOBS.with(|m| f(m.borrow_mut().as_mut().expect("cap-automation: init_storage() non chiamato")))
}
fn with_schedules<R>(f: impl FnOnce(&mut StableBTreeMap<IdBlob, Schedule, Memory>) -> R) -> R {
    SCHEDULES.with(|m| f(m.borrow_mut().as_mut().expect("cap-automation: init_storage() non chiamato")))
}
fn with_status<R>(f: impl FnOnce(&mut StableBTreeMap<IdBlob, StorableText, Memory>) -> R) -> R {
    STATUS.with(|m| f(m.borrow_mut().as_mut().expect("cap-automation: init_storage() non chiamato")))
}
fn with_log<R>(f: impl FnOnce(&mut StableBTreeMap<u64, StorableText, Memory>) -> R) -> R {
    LOG.with(|m| f(m.borrow_mut().as_mut().expect("cap-automation: init_storage() non chiamato")))
}

fn id_key(s: &str) -> Result<IdBlob, String> {
    IdBlob::try_from(s.as_bytes()).map_err(|_| format!("cap-automation: id troppo lungo (max {MAX_ID} byte)"))
}

// ═══════════════════════════════════════════════════════════════════════════
// API job/schedule
// ═══════════════════════════════════════════════════════════════════════════

/// Crea un job. Rifiuta se `job_id` esiste già (modifica = `delete_job` + `create_job`).
pub fn create_job(job: Job) -> Result<(), String> {
    if job.job_id.is_empty() {
        return Err("cap-automation: job_id mancante".into());
    }
    let k = id_key(&job.job_id)?;
    if with_jobs(|m| m.contains_key(&k)) {
        return Err(format!("Job '{}' già esistente", job.job_id));
    }
    with_jobs(|m| { m.insert(k, job); });
    Ok(())
}

/// Elimina un job, il suo schedule (se presente) e il suo status. Idempotente.
pub fn delete_job(job_id: &str) -> Result<(), String> {
    let k = id_key(job_id)?;
    with_jobs(|m| { m.remove(&k); });
    with_schedules(|m| { m.remove(&k); }); // schedule_id == job_id (uno per job)
    with_status(|m| { m.remove(&k); });
    Ok(())
}

pub fn get_job(job_id: &str) -> Option<Job> {
    let k = id_key(job_id).ok()?;
    with_jobs(|m| m.get(&k))
}

pub fn list_jobs() -> Vec<Job> {
    with_jobs(|m| m.iter().map(|e| e.value().clone()).collect())
}

/// Schedula (o ri-schedula) un job a intervallo fisso. Un solo schedule per job (`schedule_id == job_id`).
/// `now` passato dall'host (`ic_cdk::api::time()/1e9`) per restare testabile fuori dalla replica.
pub fn schedule_job(job_id: &str, interval_secs: u64, now: u64) -> Result<String, String> {
    if interval_secs == 0 {
        return Err("cap-automation: intervallo deve essere > 0".into());
    }
    let k = id_key(job_id)?;
    if !with_jobs(|m| m.contains_key(&k)) {
        return Err(format!("Job '{job_id}' inesistente"));
    }
    let schedule = Schedule {
        schedule_id: job_id.to_string(),
        job_id: job_id.to_string(),
        interval_secs,
        next_run_secs: now.saturating_add(interval_secs),
    };
    with_schedules(|m| { m.insert(k, schedule.clone()); });
    Ok(schedule.schedule_id)
}

pub fn unschedule(schedule_id: &str) -> Result<(), String> {
    let k = id_key(schedule_id)?;
    with_schedules(|m| { m.remove(&k); });
    Ok(())
}

pub fn list_schedules() -> Vec<Schedule> {
    with_schedules(|m| m.iter().map(|e| e.value().clone()).collect())
}

pub fn job_status(job_id: &str) -> Option<String> {
    let k = id_key(job_id).ok()?;
    with_status(|m| m.get(&k)).map(|t| t.0)
}

pub fn automation_log() -> Vec<String> {
    with_log(|m| m.iter().map(|e| e.value().0.clone()).collect())
}

// ═══════════════════════════════════════════════════════════════════════════
// Esecuzione (sincrona, permission-gated, reentrancy-guarded)
// ═══════════════════════════════════════════════════════════════════════════

fn acquire(job_id: &str) -> bool {
    RUNNING.with(|r| r.borrow_mut().insert(job_id.to_string()))
}
fn release(job_id: &str) {
    RUNNING.with(|r| { r.borrow_mut().remove(job_id); });
}

/// Esegue il job manualmente, ora. Owner-gated nell'host. Restituisce l'esito (Completed/Skipped).
/// **Async da F3b** (un job può contenere azioni `Http`); le azioni interne non sospendono.
pub async fn run_job_now(job_id: &str, now: u64) -> Result<JobOutcome, String> {
    reset_tick_budget(); // esecuzione manuale = propria finestra di budget d'uscita
    let job = get_job(job_id).ok_or_else(|| format!("Job '{job_id}' inesistente"))?;
    run_with_lock(&job, now).await
}

/// Il tick: esegue gli schedule dovuti (`now >= next_run`) e avanza `next_run`. Ritorna quanti job
/// ha tentato. Mai panic. **Async da F3b:** la cleanup-fn sincrona di `core-timer` lancia questo
/// future con `ic_cdk::spawn` (vedi host `register_cleanups`) — così le azioni `Http` possono await-are.
pub async fn run_due(now: u64) -> u64 {
    reset_tick_budget(); // un tick = una finestra di budget d'uscita per tutti i job dovuti
    let due: Vec<Schedule> =
        with_schedules(|m| m.iter().map(|e| e.value().clone()).filter(|s| now >= s.next_run_secs).collect());
    let mut ran = 0u64;
    for s in due {
        if let Some(job) = get_job(&s.job_id) {
            let _ = run_with_lock(&job, now).await;
            ran += 1;
        }
        // Avanza next_run a `now + interval` (no catch-up storm su lunghi gap/upgrade).
        if let Ok(k) = id_key(&s.schedule_id) {
            let updated = Schedule { next_run_secs: now.saturating_add(s.interval_secs), ..s.clone() };
            with_schedules(|m| { m.insert(k, updated); });
        }
    }
    ran
}

async fn run_with_lock(job: &Job, now: u64) -> Result<JobOutcome, String> {
    if !acquire(&job.job_id) {
        return Err(format!("Job '{}' già in esecuzione", job.job_id));
    }
    DELIVERY_NOTES.with(|n| n.borrow_mut().clear()); // finestra di note pulita per questo run
    let result = execute(job, now).await;
    release(&job.job_id);

    let status_txt = match &result {
        Ok(JobOutcome::Completed) => "Completed".to_string(),
        Ok(JobOutcome::Skipped) => "Skipped".to_string(),
        Err(e) => format!("Failed:{e}"),
    };
    if let Ok(k) = id_key(&job.job_id) {
        with_status(|m| { m.insert(k, StorableText(status_txt.clone())); });
    }
    log_push(&format!("{now} {} {}", job.job_id, status_txt));
    // G3, Rilievo 4: una consegna partita ma respinta dal peer (Http non-2xx) lascia traccia accanto
    // all'esito — il job è `Completed`, ma il log la mostra come anomalia di consegna (no segreto).
    let notes = DELIVERY_NOTES.with(|n| std::mem::take(&mut *n.borrow_mut()));
    for note in notes {
        log_push(&format!("{now} {} {note}", job.job_id));
    }
    result
}

async fn execute(job: &Job, now: u64) -> Result<JobOutcome, String> {
    let actor = match &job.owning_bundle {
        Some(id) => Actor::Bundle(id.clone()),
        None => Actor::Owner,
    };
    let n = job.actions.len();
    // Prefisso = step a cui la guardia fa riferimento (+1). Senza guardia: tutti.
    let prefix = match &job.guard {
        Some(g) => max_step_ref(&g.field).map(|m| m + 1).unwrap_or(0).min(n),
        None => n,
    };

    let mut outputs: Vec<String> = Vec::with_capacity(n);
    let mut outbound_used = 0u32;
    for action in job.actions.iter().take(prefix) {
        if is_outbound(action) {
            consume_outbound(&mut outbound_used)?;
        }
        let out = run_action(action, &actor, &outputs, now).await?;
        outputs.push(out);
    }

    if let Some(g) = &job.guard {
        if !eval_guard(g, &outputs, now) {
            return Ok(JobOutcome::Skipped);
        }
        for action in job.actions.iter().skip(prefix) {
            if is_outbound(action) {
                consume_outbound(&mut outbound_used)?;
            }
            let out = run_action(action, &actor, &outputs, now).await?;
            outputs.push(out);
        }
    }
    Ok(JobOutcome::Completed)
}

/// Azione **d'uscita** (verso l'esterno): l'unica che brucia cicli in modo aperto → budget-gated.
fn is_outbound(a: &Action) -> bool {
    matches!(a, Action::Http { .. } | Action::CanisterCall { .. })
}

fn reset_tick_budget() {
    TICK_OUTBOUND.with(|c| c.set(0));
}

/// Consuma una unità di budget d'uscita (G1, Rilievo 3): per-run + per-tick. Err se uno dei tetti è
/// superato → l'azione non parte, il job va `Failed:` (osservabile), il canister resta vivo.
fn consume_outbound(per_run: &mut u32) -> Result<(), String> {
    *per_run += 1;
    if *per_run > MAX_OUTBOUND_PER_RUN {
        return Err(format!("budget d'uscita per run superato (max {MAX_OUTBOUND_PER_RUN})"));
    }
    let ok = TICK_OUTBOUND.with(|c| {
        let v = c.get();
        if v >= MAX_OUTBOUND_PER_TICK {
            false
        } else {
            c.set(v + 1);
            true
        }
    });
    if !ok {
        return Err(format!("budget d'uscita per tick superato (max {MAX_OUTBOUND_PER_TICK})"));
    }
    Ok(())
}

async fn run_action(action: &Action, actor: &Actor, outputs: &[String], now: u64) -> Result<String, String> {
    match action {
        Action::KvSet { namespace, key, value } => {
            let ns = resolve(namespace, outputs, now);
            let k = resolve(key, outputs, now);
            let v = resolve(value, outputs, now);
            cap_store::kv_set_as(actor, &ns, &k, v.as_bytes())?;
            Ok(String::new())
        }
        Action::KvGet { namespace, key } => {
            let ns = resolve(namespace, outputs, now);
            let k = resolve(key, outputs, now);
            let val = cap_store::kv_get_as(actor, &ns, &k)?;
            Ok(val.map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_default())
        }
        Action::KvDel { namespace, key } => {
            let ns = resolve(namespace, outputs, now);
            let k = resolve(key, outputs, now);
            cap_store::kv_delete_as(actor, &ns, &k)?;
            Ok(String::new())
        }
        Action::CryptoHash { input } => Ok(sha256_hex(resolve(input, outputs, now).as_bytes())),
        Action::Http { method, url, headers, body, max_response_bytes } => {
            let (_status, out) =
                exec_http_outbound(actor, method, url, headers, body, *max_response_bytes, outputs, now)
                    .await?;
            Ok(out)
        }
        Action::CanisterCall { canister_id, method, arg_hex } => {
            // `canister_id` NON porta segreti (resolver plain) → la porta vede solo il principal.
            let cid = resolve(canister_id, outputs, now);
            // ── La porta (F3c): autorizza PRIMA dell'effetto. Bundle confinato ai suoi target. ──
            cap_store::authorize_call(actor, &cid)?;
            let mut used: Vec<String> = Vec::new();
            let arg_hex = resolve_outbound(arg_hex, outputs, now, actor, &mut used);
            canister_call(&cid, method, &arg_hex).await.map_err(|e| scrub(e, &used))
        }
    }
}

/// Esegue un HTTP d'uscita risolvendo i campi (incl. `{{secret:NAME}}` per Owner; Bundle → vuoto),
/// passando la porta `authorize_http` PRIMA dell'effetto, e registrando una nota di consegna su
/// esito non-2xx. Estratto dal braccio `Http` di `run_action` per essere riusato sia dai job sia
/// dal push one-shot dell'host (`host_deliver`). Ritorna `(status, body)`; lo scrub toglie il chiaro
/// dei segreti da qualsiasi errore di trasporto.
async fn exec_http_outbound(
    actor: &Actor,
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: &str,
    max_response_bytes: u64,
    outputs: &[String],
    now: u64,
) -> Result<(u16, String), String> {
    // ── Campi D'USCITA: risolvo anche `{{secret:NAME}}` (solo per Owner; Bundle → vuoto).
    //    I valori chiari finiscono in `used` per lo scrub (Rilievo 1), MAI in outputs/log/KV. ──
    let mut used: Vec<String> = Vec::new();
    let url = resolve_outbound(url, outputs, now, actor, &mut used);
    // La porta (F3b): autorizza PRIMA dell'effetto. Per Owner è no-op (non tocca l'URL col
    // segreto); per Bundle l'URL non contiene segreti (non risolti) → comportamento invariato.
    cap_store::authorize_http(actor, &url)?;
    let body = resolve_outbound(body, outputs, now, actor, &mut used);
    let headers: Vec<(String, String)> = headers
        .iter()
        .map(|(n, v)| {
            (
                resolve_outbound(n, outputs, now, actor, &mut used),
                resolve_outbound(v, outputs, now, actor, &mut used),
            )
        })
        .collect();
    // Scrub: nessun messaggio d'errore d'uscita echeggia il chiaro risolto.
    let (status, out) = http_outcall(method, &url, &headers, &body, max_response_bytes)
        .await
        .map_err(|e| scrub(e, &used))?;
    // G3, Rilievo 4: la richiesta è PARTITA ma il peer l'ha respinta (non-2xx) → non è un Err di
    // trasporto (l'output resta il body, per i sentinelli), ma va reso osservabile. La nota porta
    // solo lo status — MAI l'URL risolto (conterrebbe `{{secret:NAME}}`).
    if status >= 400 {
        DELIVERY_NOTES.with(|n| n.borrow_mut().push(format!("Outbound HTTP {status}")));
    }
    Ok((status, out))
}

/// Push outbound **one-shot** riusabile DALL'HOST — la consegna della capsula del tempo in
/// outbound-push (l'agente esce, nessun estraneo entra; cfr. principio outbound-only). Riusa
/// ESATTAMENTE il path d'uscita dei job come `Actor::Owner`: resolve `{{secret:NAME}}` del canale,
/// porta `authorize_http`, outcall, nota di consegna non-2xx, scrub. Pensato per il tick dell'host
/// DOPO `run_due`, a **condizione (silenzio) decisa dall'host** (cap-automation non conosce la
/// custodia). Onora il **budget d'uscita per-tick condiviso** coi job (se i job lo esauriscono, la
/// consegna salta questo tick e ritenta il prossimo — il flag fire-once dell'host evita doppioni).
/// Le note di consegna sono drenate nel log QUI (fuori da `run_with_lock`). Ritorna lo status HTTP;
/// `Err` solo su trasporto o budget esaurito. Il chiaro del canale non compare mai in log/errore.
pub async fn host_deliver(
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: &str,
    now: u64,
    label: &str,
) -> Result<u16, String> {
    let mut budget = 0u32; // per-run locale (sempre 1 outcall); il tetto vero è quello per-tick condiviso
    consume_outbound(&mut budget)?;
    DELIVERY_NOTES.with(|n| n.borrow_mut().clear());
    let res = exec_http_outbound(&Actor::Owner, method, url, &headers, body, 0, &[], now).await;
    // Drena le note (la non-2xx di exec_http_outbound) nel log, come fa run_with_lock per i job.
    let notes = DELIVERY_NOTES.with(|n| std::mem::take(&mut *n.borrow_mut()));
    for note in notes {
        log_push(&format!("{now} {label} {note}"));
    }
    let (status, _) = res?;
    log_push(&format!("{now} {label} delivered:{status}"));
    Ok(status)
}

/// Esegue l'HTTP outcall via management canister. La transform è la query `transform` esportata
/// dall'host (consenso fra nodi: header non-deterministici strippati). I cycle sono calcolati e
/// allegati automaticamente da `ic_cdk::management_canister::http_request`. Ritorna `(status, body)`:
/// il **body** (utf8-lossy) resta l'output dell'azione per **qualsiasi** status (il job/sentinella può
/// guardare sul contenuto); lo **status** serve solo al chiamante per la nota di consegna (G3, Rilievo
/// 4). Solo un errore di **trasporto** è `Err`.
async fn http_outcall(
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: &str,
    max_response_bytes: u64,
) -> Result<(u16, String), String> {
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => HttpMethod::GET,
        "POST" => HttpMethod::POST,
        "HEAD" => HttpMethod::HEAD,
        other => return Err(format!("cap-automation: metodo HTTP non supportato '{other}'")),
    };
    let arg = HttpRequestArgs {
        url: url.to_string(),
        max_response_bytes: (max_response_bytes != 0).then_some(max_response_bytes),
        method,
        headers: headers.iter().map(|(n, v)| HttpHeader { name: n.clone(), value: v.clone() }).collect(),
        body: (!body.is_empty()).then(|| body.as_bytes().to_vec()),
        transform: Some(transform_context_from_query("transform".to_string(), vec![])),
        is_replicated: None,
    };
    let res = http_request(&arg).await.map_err(|e| format!("cap-automation: outcall fallito: {e:?}"))?;
    // `res.status` è un candid::Nat: lo riduco a u16 per la sola classificazione 2xx vs ≥400 (la nota).
    let status: u16 = u16::try_from(&res.status.0).unwrap_or(0);
    Ok((status, String::from_utf8_lossy(&res.body).to_string()))
}

/// Esegue la chiamata inter-canister (F3c) con argomenti candid raw. La porta `authorize_call` ha
/// già validato `cid` (Principal) e il confinamento del bundle. Qui: ri-parse del principal (la porta
/// non restituisce il `Principal`), decode hex degli argomenti, call `unbounded_wait` con args raw.
/// Output = byte candid raw della risposta **in hex** (tipo ignoto → non decodificati). Un reject del
/// canister chiamato (o un errore di trasporto) è `Err`.
async fn canister_call(cid: &str, method: &str, arg_hex: &str) -> Result<String, String> {
    let target = Principal::from_text(cid.trim())
        .map_err(|_| format!("cap-automation: canister target non valido: '{cid}'"))?;
    let arg_bytes = from_hex(arg_hex)?;
    let res = Call::unbounded_wait(target, method)
        .with_raw_args(&arg_bytes)
        .await
        .map_err(|e| format!("cap-automation: inter-canister call fallita: {e:?}"))?;
    Ok(to_hex(&res.into_bytes()))
}

/// Hex encode (lowercase, no prefix). Per l'output candid raw della `CanisterCall`.
fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Hex decode zero-dep (accetta lower/upper, ignora spazi attorno; lunghezza pari).
/// Hex vuoto → args vuoti (`candid::encode_args(())` produce comunque un header, ma per una call
/// senza argomenti la replica accetta anche un payload vuoto).
fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err("cap-automation: arg_hex con lunghezza dispari".to_string());
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    let nibble = |c: u8| -> Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(format!("cap-automation: carattere hex non valido: '{}'", c as char)),
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        out.push((nibble(bytes[i])? << 4) | nibble(bytes[i + 1])?);
        i += 2;
    }
    Ok(out)
}

// ─── Templating + guardia (no judge/surgeon: un resolver + un evaluator) ────────

/// Sostituisce ogni `{{stepN[.campo]}}` con l'output dello step N (vedi `resolve_ref`),
/// e `{{now}}` / `{{now-N}}` / `{{now+N}}` col tempo d'esecuzione (secondi). Quest'ultimo (F1)
/// rende esprimibile la **staleness** come guardia esistente: `last_checkin < {{now-finestra}}`
/// ⟺ `now - last_checkin > finestra` (il dead-man's switch dichiarato come job armato).
fn resolve(s: &str, outputs: &[String], now: u64) -> String {
    // Resolver "interno": `{{secret:NAME}}` NON è gestito qui → resta vuoto (token sconosciuto).
    // È il contenimento del segreto: in KvSet/KvGet/guard/canister_id il chiaro non può comparire.
    resolve_tokens(s, |expr| resolve_ref(expr, outputs, now))
}

/// Resolver dei CAMPI D'USCITA (url/header/body di `Http`, arg di `CanisterCall`): come `resolve`,
/// ma il token `{{secret:NAME}}` viene sostituito col **chiaro** della credenziale — e **solo** se
/// `actor == Owner` (per `Bundle` → vuoto, speculare al guardrail `__` di cap-store: una mini-app
/// non eredita i segreti dell'owner). I chiari sostituiti sono accumulati in `used` per lo scrub
/// degli errori (Rilievo 1). Il segreto non finisce MAI in `outputs` (l'output dell'azione è altro):
/// quindi non è ri-templabile in un KvSet/guard/log.
fn resolve_outbound(
    s: &str,
    outputs: &[String],
    now: u64,
    actor: &Actor,
    used: &mut Vec<String>,
) -> String {
    resolve_tokens(s, |expr| match expr.strip_prefix("secret:") {
        Some(name) => {
            if let Actor::Owner = actor {
                if let Some(v) = cap_store::get_secret_value(name.trim()) {
                    let val = String::from_utf8_lossy(&v).to_string();
                    if !val.is_empty() {
                        used.push(val.clone());
                    }
                    return val;
                }
            }
            // Bundle, o credenziale assente → vuoto (no leak, l'errore non nomina il chiaro).
            String::new()
        }
        None => resolve_ref(expr, outputs, now),
    })
}

/// Sostituisce ogni `{{...}}` col risultato di `f(expr)`. `{{` non terminato → letterale.
/// Scansiona il template ORIGINALE: il contenuto sostituito non viene ri-scansionato, quindi un
/// output di step che contenesse `{{secret:X}}` non può iniettare un segreto (non è ri-risolto).
fn resolve_tokens(s: &str, mut f: impl FnMut(&str) -> String) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("}}") {
            Some(end) => {
                let expr = rest[start + 2..start + 2 + end].trim();
                out.push_str(&f(expr));
                rest = &rest[start + 2 + end + 2..];
            }
            None => {
                out.push_str(&rest[start..]); // `{{` non terminato → letterale
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Rilievo 1: rimuove i valori chiari dei segreti da un messaggio d'errore prima che raggiunga
/// `status`/`automation_log`. Belt-and-suspenders: per Owner le porte sono già no-op (non vedono
/// l'URL col segreto), ma un errore di trasporto outcall/reject potrebbe echeggiare url/body.
fn scrub(msg: String, secrets: &[String]) -> String {
    let mut m = msg;
    for s in secrets {
        if !s.is_empty() {
            m = m.replace(s.as_str(), "«secret»");
        }
    }
    m
}

/// Risolve un token-tempo: `now` → `now`; `now-N`/`now+N` → `now ∓ N` (secondi, saturante).
/// `None` se l'espressione non è un token-tempo. Niente aritmetica generica: solo offset su `now`.
fn resolve_now(expr: &str, now: u64) -> Option<String> {
    let e = expr.trim();
    if e == "now" {
        return Some(now.to_string());
    }
    if let Some(rest) = e.strip_prefix("now-") {
        return rest.trim().parse::<u64>().ok().map(|n| now.saturating_sub(n).to_string());
    }
    if let Some(rest) = e.strip_prefix("now+") {
        return rest.trim().parse::<u64>().ok().map(|n| now.saturating_add(n).to_string());
    }
    None
}

/// `now[-/+N]` → tempo d'esecuzione (vedi `resolve_now`); `stepN` → output intero dello step N;
/// `stepN.a.b` → campo JSON (se l'output è JSON parseable).
/// Riferimento fuori range / non-JSON / campo assente → stringa vuota.
fn resolve_ref(expr: &str, outputs: &[String], now: u64) -> String {
    if let Some(t) = resolve_now(expr, now) {
        return t;
    }
    let (step_part, field_path) = match expr.split_once('.') {
        Some((s, f)) => (s, Some(f)),
        None => (expr, None),
    };
    let idx = match step_part.strip_prefix("step").and_then(|n| n.parse::<usize>().ok()) {
        Some(i) => i,
        None => return String::new(),
    };
    let raw = match outputs.get(idx) {
        Some(s) => s,
        None => return String::new(),
    };
    match field_path {
        None => raw.clone(),
        Some(path) => match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(v) => json_value_to_string(&json_extract(&v, path)),
            Err(_) => String::new(),
        },
    }
}

/// Dot-path su un JSON Value (oggetti + indici array). Assente → Null.
fn json_extract(v: &serde_json::Value, path: &str) -> serde_json::Value {
    let mut cur = v;
    for part in path.split('.') {
        cur = match cur {
            serde_json::Value::Object(map) => match map.get(part) {
                Some(x) => x,
                None => return serde_json::Value::Null,
            },
            serde_json::Value::Array(arr) => match part.parse::<usize>().ok().and_then(|i| arr.get(i)) {
                Some(x) => x,
                None => return serde_json::Value::Null,
            },
            _ => return serde_json::Value::Null,
        };
    }
    cur.clone()
}

fn json_value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn max_step_ref(field: &str) -> Option<usize> {
    let step_part = field.split_once('.').map(|(s, _)| s).unwrap_or(field);
    step_part.strip_prefix("step").and_then(|n| n.parse::<usize>().ok())
}

/// L'unico evaluator: confronta `field` (risolto come riferimento step/tempo) con `value` via `op`.
/// `value` passa anch'esso dal templating (F1) → può usare `{{now-N}}` per la staleness.
fn eval_guard(g: &Guard, outputs: &[String], now: u64) -> bool {
    let actual = resolve_ref(&g.field, outputs, now);
    let expected = resolve(&g.value, outputs, now);
    match g.op.as_str() {
        "==" => actual == expected,
        "!=" => actual != expected,
        ">" => num_cmp(&actual, &expected, |a, b| a > b),
        ">=" => num_cmp(&actual, &expected, |a, b| a >= b),
        "<" => num_cmp(&actual, &expected, |a, b| a < b),
        "<=" => num_cmp(&actual, &expected, |a, b| a <= b),
        "contains" => actual.contains(&expected),
        _ => false,
    }
}

fn num_cmp(a: &str, b: &str, cmp: fn(f64, f64) -> bool) -> bool {
    match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
        (Ok(va), Ok(vb)) => cmp(va, vb),
        _ => false,
    }
}

// ─── Log ring buffer (auto-conoscenza, MemId 93) ───────────────────────────────

fn log_push(line: &str) {
    let idx = LOG_NEXT.with(|c| {
        let v = c.get();
        c.set(v + 1);
        v
    });
    with_log(|m| {
        m.insert(idx, StorableText(line.to_string()));
        // Pota le entry più vecchie oltre LOG_CAP.
        while m.len() > LOG_CAP {
            if let Some(oldest) = m.iter().next().map(|e| *e.key()) {
                m.remove(&oldest);
            } else {
                break;
            }
        }
    });
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ═══════════════════════════════════════════════════════════════════════════
// Test
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use cap_store::BundlePermissions;
    use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
    use ic_stable_structures::DefaultMemoryImpl;

    type Mm = MemoryManager<DefaultMemoryImpl>;

    /// Guida un future a completamento con un waker no-op. Le azioni interne (Kv/Crypto) non
    /// sospendono mai → un solo poll basta. Un `Pending` significherebbe un'azione async (`Http`):
    /// non unit-testabile (serve la replica) — qui i test usano solo azioni interne, per scelta F3b.
    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        unsafe fn noop(_: *const ()) {}
        unsafe fn clone(_: *const ()) -> RawWaker { RawWaker::new(std::ptr::null(), &VT) }
        static VT: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VT)) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = Box::pin(fut);
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("block_on: future Pending — azione async non testabile in unit test"),
        }
    }

    /// Inizializza cap-store (80-82) + cap-automation (90-93) sulla stessa MemoryManager.
    fn init_from(mm: &Mm) {
        cap_store::init_storage(mm.get(MemoryId::new(80)), mm.get(MemoryId::new(81)), mm.get(MemoryId::new(82)));
        init_storage(mm.get(MemoryId::new(90)), mm.get(MemoryId::new(91)), mm.get(MemoryId::new(92)), mm.get(MemoryId::new(93)));
    }

    fn setup() -> Mm {
        let mm = MemoryManager::init(DefaultMemoryImpl::default());
        init_from(&mm);
        mm
    }

    fn job(job_id: &str, owning_bundle: Option<&str>, actions: Vec<Action>, guard: Option<Guard>) -> Job {
        Job { job_id: job_id.into(), owning_bundle: owning_bundle.map(|s| s.into()), actions, guard, title: None }
    }

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

    fn install_bundle_ns(module_id: &str, namespaces: &[&str]) {
        let bundle = build_bundle(&[("index.html", "text/html", b"x")]);
        let hash = sha256_hex(&bundle);
        let perms = BundlePermissions {
            storage_namespaces: namespaces.iter().map(|s| s.to_string()).collect(),
            http_outcall_hosts: vec![],
            inter_canister: vec![],
            uses_crypto: false,
            uses_timer: true,
        };
        cap_store::install_bundle(module_id, &bundle, &hash, "1.0.0".into(), perms, 1).unwrap();
    }

    // (1) job single-step "scrivi KV" schedulato: gira solo quando dovuto, e scrive.
    #[test]
    fn scheduled_single_step_runs_when_due() {
        setup();
        create_job(job(
            "j1",
            None,
            vec![Action::KvSet { namespace: "auto".into(), key: "k".into(), value: "hello".into() }],
            None,
        ))
        .unwrap();
        schedule_job("j1", 60, 100).unwrap(); // next_run = 160
        assert_eq!(list_schedules().len(), 1);

        // Non ancora dovuto.
        assert_eq!(block_on(run_due(120)), 0);
        assert_eq!(cap_store::kv_get("auto", "k"), None);

        // Dovuto → esegue e scrive.
        assert_eq!(block_on(run_due(200)), 1);
        assert_eq!(cap_store::kv_get("auto", "k"), Some(b"hello".to_vec()));
        assert_eq!(job_status("j1").as_deref(), Some("Completed"));
        // next_run avanzato.
        assert_eq!(list_schedules()[0].next_run_secs, 260);
    }

    // (2) job 2-step con {{step0}}: l'output del primo step passa al secondo.
    #[test]
    fn two_step_passes_output() {
        setup();
        cap_store::kv_set("src", "x", b"VALUE").unwrap();
        create_job(job(
            "j2",
            None,
            vec![
                Action::KvGet { namespace: "src".into(), key: "x".into() },
                Action::KvSet { namespace: "dst".into(), key: "y".into(), value: "<<{{step0}}>>".into() },
            ],
            None,
        ))
        .unwrap();
        assert_eq!(block_on(run_job_now("j2", 1)).unwrap(), JobOutcome::Completed);
        assert_eq!(cap_store::kv_get("dst", "y"), Some(b"<<VALUE>>".to_vec()));
    }

    // (3) guardia: falsa → effetto saltato (Skipped); vera → eseguito.
    #[test]
    fn guard_gates_effect() {
        setup();
        cap_store::kv_set("src", "n", b"5").unwrap();
        let mk = |id: &str, threshold_op: &str, threshold: &str| {
            job(
                id,
                None,
                vec![
                    Action::KvGet { namespace: "src".into(), key: "n".into() },
                    Action::KvSet { namespace: "out".into(), key: id.into(), value: "fired".into() },
                ],
                Some(Guard { field: "step0".into(), op: threshold_op.into(), value: threshold.into() }),
            )
        };

        // 5 > 10 → falso → Skipped, niente scrittura.
        create_job(mk("jf", ">", "10")).unwrap();
        assert_eq!(block_on(run_job_now("jf", 1)).unwrap(), JobOutcome::Skipped);
        assert_eq!(cap_store::kv_get("out", "jf"), None);

        // 5 >= 5 → vero → Completed, scrive.
        create_job(mk("jt", ">=", "5")).unwrap();
        assert_eq!(block_on(run_job_now("jt", 1)).unwrap(), JobOutcome::Completed);
        assert_eq!(cap_store::kv_get("out", "jt"), Some(b"fired".to_vec()));
    }

    // (4) reentrancy: un job già in esecuzione viene rifiutato.
    #[test]
    fn reentrancy_rejected() {
        setup();
        create_job(job(
            "jr",
            None,
            vec![Action::KvSet { namespace: "auto".into(), key: "k".into(), value: "v".into() }],
            None,
        ))
        .unwrap();
        assert!(acquire("jr")); // simula esecuzione in volo
        assert!(block_on(run_job_now("jr", 1)).is_err());
        release("jr");
        // Dopo il rilascio riparte.
        assert_eq!(block_on(run_job_now("jr", 1)).unwrap(), JobOutcome::Completed);
    }

    // (5) schedule SOPRAVVIVE a un upgrade simulato (re-init storage dalla stessa MemoryManager).
    #[test]
    fn schedule_survives_upgrade() {
        let mm = setup();
        create_job(job(
            "ju",
            None,
            vec![Action::KvSet { namespace: "auto".into(), key: "k".into(), value: "after-upgrade".into() }],
            None,
        ))
        .unwrap();
        schedule_job("ju", 60, 100).unwrap(); // next_run = 160

        // Simula post_upgrade: ri-inizializza lo storage dalle stesse memorie stable.
        init_from(&mm);

        // Job + schedule ritrovati, niente timer in-memory da ri-creare.
        assert_eq!(list_jobs().len(), 1);
        assert_eq!(list_schedules().len(), 1);
        assert_eq!(block_on(run_due(200)), 1);
        assert_eq!(cap_store::kv_get("auto", "k"), Some(b"after-upgrade".to_vec()));
    }

    // (6) job di un bundle non tocca namespace non dichiarati (riuso enforcement F2).
    #[test]
    fn bundle_job_confined_to_declared_namespace() {
        setup();
        install_bundle_ns("b", &["b_data"]);

        // Namespace dichiarato → ok.
        create_job(job(
            "ok",
            Some("b"),
            vec![Action::KvSet { namespace: "b_data".into(), key: "k".into(), value: "v".into() }],
            None,
        ))
        .unwrap();
        assert_eq!(block_on(run_job_now("ok", 1)).unwrap(), JobOutcome::Completed);
        assert_eq!(cap_store::kv_get("b_data", "k"), Some(b"v".to_vec()));

        // Namespace NON dichiarato → azione rifiutata → job Failed, niente scrittura.
        create_job(job(
            "bad",
            Some("b"),
            vec![Action::KvSet { namespace: "segreti".into(), key: "k".into(), value: "v".into() }],
            None,
        ))
        .unwrap();
        assert!(block_on(run_job_now("bad", 1)).is_err());
        assert_eq!(cap_store::kv_get("segreti", "k"), None);
        assert_eq!(job_status("bad").as_deref().map(|s| s.starts_with("Failed:")), Some(true));
    }

    // (F1) STALENESS come guardia esistente: `last_checkin < {{now-finestra}}` ⟺ `now-last_checkin>finestra`.
    // Nessuna nuova primitiva di scheduling — solo il token-tempo nel resolver + value templato.
    #[test]
    fn staleness_guard_with_now_token() {
        setup();
        // Il battito (server-stamped) vive nel namespace riservato `__presence`, come secondi decimali.
        cap_store::kv_set("__presence", "last_checkin", b"1000").unwrap();

        // Job dead-man: leggi il battito; se è più vecchio di now-100 → "silenzio" → spara l'effetto.
        let mk = |id: &str| {
            job(
                id,
                None, // owner: l'unico a poter leggere il riservato
                vec![
                    Action::KvGet { namespace: "__presence".into(), key: "last_checkin".into() },
                    Action::KvSet { namespace: "out".into(), key: id.into(), value: "fired".into() },
                ],
                Some(Guard { field: "step0".into(), op: "<".into(), value: "{{now-100}}".into() }),
            )
        };

        // Owner presente: now=1050 → soglia 950; last_checkin=1000; 1000<950 falso → NON stale → Skipped.
        create_job(mk("fresh")).unwrap();
        assert_eq!(block_on(run_job_now("fresh", 1050)).unwrap(), JobOutcome::Skipped);
        assert_eq!(cap_store::kv_get("out", "fresh"), None);

        // Owner in silenzio: now=1200 → soglia 1100; last_checkin=1000; 1000<1100 vero → stale → Completed.
        create_job(mk("stale")).unwrap();
        assert_eq!(block_on(run_job_now("stale", 1200)).unwrap(), JobOutcome::Completed);
        assert_eq!(cap_store::kv_get("out", "stale"), Some(b"fired".to_vec()));
    }

    // (F1) il token `{{now}}` è interpolabile anche nel valore di un'azione (non solo nella guardia).
    #[test]
    fn now_token_in_action_value() {
        setup();
        create_job(job(
            "jn",
            None,
            vec![Action::KvSet { namespace: "auto".into(), key: "ts".into(), value: "{{now}}".into() }],
            None,
        ))
        .unwrap();
        block_on(run_job_now("jn", 4242)).unwrap();
        assert_eq!(cap_store::kv_get("auto", "ts"), Some(b"4242".to_vec()));
    }

    // (F5) FORWARD-COMPAT: un Job serializzato col vecchio layout (senza `title`) decodifica nel
    // nuovo struct con `title = None`. È l'invariante che rende il campo additivo-safe sui Job già
    // in stable (MemId 90) — nessun re-encode, nessuna corruzione, nessun freeze.
    #[test]
    fn old_job_without_title_decodes_with_none() {
        // Lo struct "storico" — identico a Job ma senza il campo `title`.
        #[derive(CandidType)]
        struct OldJob {
            job_id: String,
            owning_bundle: Option<String>,
            actions: Vec<Action>,
            guard: Option<Guard>,
        }
        let old = OldJob {
            job_id: "legacy".into(),
            owning_bundle: None,
            actions: vec![Action::CryptoHash { input: "x".into() }],
            guard: None,
        };
        let bytes = candid::encode_one(&old).unwrap();
        let decoded: Job = candid::decode_one(&bytes).unwrap();
        assert_eq!(decoded.job_id, "legacy");
        assert_eq!(decoded.title, None);
        assert_eq!(decoded.actions.len(), 1);
    }

    // (G1) Il resolver D'USCITA sostituisce `{{secret:NAME}}` col chiaro SOLO per Owner; per Bundle
    // resta vuoto (no eredità di segreti). Il chiaro sostituito è registrato in `used` per lo scrub.
    #[test]
    fn secret_resolves_only_for_owner_in_outbound() {
        setup();
        cap_store::set_secret("TOKEN", "sk-SECRET-123").unwrap();

        // Owner → risolve, e registra il chiaro per lo scrub.
        let mut used = Vec::new();
        let s = resolve_outbound("Bearer {{secret:TOKEN}}", &[], 0, &Actor::Owner, &mut used);
        assert_eq!(s, "Bearer sk-SECRET-123");
        assert_eq!(used, vec!["sk-SECRET-123".to_string()]);

        // Bundle → vuoto (nessun accesso ai segreti dell'owner), niente registrato.
        let mut used_b = Vec::new();
        let sb = resolve_outbound("Bearer {{secret:TOKEN}}", &[], 0, &Actor::Bundle("b".into()), &mut used_b);
        assert_eq!(sb, "Bearer ");
        assert!(used_b.is_empty());

        // Credenziale assente → vuoto, niente registrato (l'errore non nominerà il chiaro).
        let mut used_m = Vec::new();
        let sm = resolve_outbound("{{secret:GHOST}}", &[], 0, &Actor::Owner, &mut used_m);
        assert_eq!(sm, "");
        assert!(used_m.is_empty());
    }

    // (G1) CONTENIMENTO: il resolver interno (`resolve`, usato in KvSet/guard/canister_id) NON
    // risolve `{{secret:NAME}}` → resta vuoto. Il segreto non può trapelare in KV/outputs/guard.
    #[test]
    fn internal_resolver_never_expands_secret() {
        setup();
        cap_store::set_secret("TOKEN", "sk-SECRET-123").unwrap();
        assert_eq!(resolve("X{{secret:TOKEN}}Y", &[], 0), "XY");

        // E end-to-end: un job che prova a esfiltrare il segreto in KV scrive vuoto, non il chiaro.
        create_job(job(
            "leak",
            None,
            vec![Action::KvSet { namespace: "out".into(), key: "k".into(), value: "{{secret:TOKEN}}".into() }],
            None,
        ))
        .unwrap();
        block_on(run_job_now("leak", 1)).unwrap();
        assert_eq!(cap_store::kv_get("out", "k"), Some(b"".to_vec()));
    }

    // (G1) scrub: i valori chiari spariscono dal messaggio d'errore.
    #[test]
    fn scrub_removes_plaintext() {
        let msg = "outcall fallito verso https://h/x?token=sk-SECRET-123 (body sk-SECRET-123)".to_string();
        let scrubbed = scrub(msg, &["sk-SECRET-123".to_string()]);
        assert!(!scrubbed.contains("sk-SECRET-123"));
        assert!(scrubbed.contains("«secret»"));
    }

    // (G1) budget d'uscita per-run: oltre il tetto → Err (l'azione non parte).
    #[test]
    fn outbound_budget_per_run() {
        reset_tick_budget();
        let mut used = 0u32;
        for _ in 0..MAX_OUTBOUND_PER_RUN {
            assert!(consume_outbound(&mut used).is_ok());
        }
        assert!(consume_outbound(&mut used).is_err()); // la (max+1)-esima è rifiutata
    }

    // (G1) budget d'uscita per-tick: l'insieme dei job in un tick è limitato; il reset riapre la finestra.
    #[test]
    fn outbound_budget_per_tick() {
        reset_tick_budget();
        // Simula tanti job da 1 azione d'uscita ciascuno: contatori per-run separati, tick condiviso.
        for _ in 0..MAX_OUTBOUND_PER_TICK {
            let mut used = 0u32;
            assert!(consume_outbound(&mut used).is_ok());
        }
        let mut used = 0u32;
        assert!(consume_outbound(&mut used).is_err()); // tick esaurito
        reset_tick_budget();
        let mut used2 = 0u32;
        assert!(consume_outbound(&mut used2).is_ok()); // nuova finestra
    }

    // CryptoHash deterministico + templating verso uno step successivo.
    #[test]
    fn crypto_hash_action() {
        setup();
        create_job(job(
            "jh",
            None,
            vec![
                Action::CryptoHash { input: "abc".into() },
                Action::KvSet { namespace: "auto".into(), key: "digest".into(), value: "{{step0}}".into() },
            ],
            None,
        ))
        .unwrap();
        block_on(run_job_now("jh", 1)).unwrap();
        let expected = sha256_hex(b"abc");
        assert_eq!(cap_store::kv_get("auto", "digest"), Some(expected.into_bytes()));
    }
}
