// EasyHub — G2a/G2b: il MOTORE D'USCITA (cap-automation) dal vivo su PocketIC.
//
// G2b (prova LIVE col segreto) aggiunge sopra G2a:
//   • CanisterCall verso un canister ICRC ETEROGENEO reale (`test_mock_ledger`), non più self-call:
//     lettura saldo (`icrc1_balance_of`) + trasferimento (`icrc1_transfer`) con cambio di stato
//     osservato dal vivo; un errore APPLICATIVO del ledger (saldo insufficiente) è una *reply*
//     candid → output/Completed (≠ il reject di trasporto di C1, che è Err/Failed).
//   • Http col segreto round-out: `{{secret:NAME}}` in header E body, verificato sulla richiesta
//     uscente, sul percorso 200 OK, con no-leak nel log anche a CONSEGNA RIUSCITA (G1 copriva il
//     fallimento). NB onesto: PocketIC mocka sempre il *peer* HTTP — il motore è reale, il trasporto
//     sul filo (TLS verso internet) è infra IC, fuori dal codice nostro e non esercitato qui.
//
// Perché esiste. Le azioni esterne `Http` (F3b) e `CanisterCall` (F3c) finora erano
// **authorization-only**: i 10 unit-test di cap-automation usano un `block_on` che *panica*
// su `Pending`, cioè non hanno mai eseguito un'azione che sospende davvero. Questo test accende
// il motore async end-to-end contro una replica vera, **senza segreto** (job `owning_bundle:
// None` → `Actor::Owner` → le porte `authorize_http`/`authorize_call` passano libere: nessuna
// credenziale serve ancora — quella è G1). De-riska il motore in isolamento PRIMA che G1 ci
// inietti `{{secret:NAME}}`. La rete vera (webhook reale) è G2b: qui il *peer* HTTP è mockato
// (PocketIC `mock_canister_http_response`), il nostro motore è reale.
//
// Cosa prova:
//   A — Http nudo: l'outcall PARTE (visibile a `get_canister_http`), la `transform` esportata
//       dall'host si applica, il body torna come output dello step ed è templatabile ({{step0}}).
//   B — CanisterCall nuda: chiamata inter-canister reale (il hub chiama sé stesso), output candid
//       raw → hex non vuoto, templatabile.
//   C1 — CanisterCall verso un metodo inesistente → reject → l'azione è `Err`, job `Failed:`, no panic.
//   C2 — Http con risposta mockata a REJECT → l'azione è `Err`, job `Failed:`, no panic.
//
// Prerequisiti:
//   export POCKET_IC_BIN=/path/to/pocket-ic
//   cargo build --target wasm32-unknown-unknown --release -p hub-canister
// Run:
//   POCKET_IC_BIN=$(which pocket-ic) cargo test -p hub-canister --test engine_live

use candid::{decode_one, encode_args, encode_one, CandidType, Deserialize, Nat, Principal};
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc1::transfer::TransferArg;
use pocket_ic::common::rest::{
    CanisterHttpReply, CanisterHttpReject, CanisterHttpRequest, CanisterHttpResponse,
    MockCanisterHttpResponse, RawMessageId,
};
use pocket_ic::{PocketIc, PocketIcBuilder};
use std::time::Duration;

// ── Tipi candid del motore (ridefiniti localmente sul wire-format, come admin_integration.rs:
//    hub-canister è cdylib, non linkabile come lib). Le varianti candid sono identificate per
//    hash del nome, non per ordine: basta che nomi+tipi combacino con cap_automation. ──────────

#[derive(CandidType, Deserialize, Clone)]
enum Action {
    KvSet { namespace: String, key: String, value: String },
    KvGet { namespace: String, key: String },
    KvDel { namespace: String, key: String },
    CryptoHash { input: String },
    Http {
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: String,
        max_response_bytes: u64,
    },
    CanisterCall {
        canister_id: String,
        method: String,
        arg_hex: String,
    },
}

#[derive(CandidType, Deserialize, Clone)]
struct Guard {
    field: String,
    op: String,
    value: String,
}

#[derive(CandidType, Deserialize, Clone)]
struct Job {
    job_id: String,
    owning_bundle: Option<String>,
    actions: Vec<Action>,
    guard: Option<Guard>,
    title: Option<String>,
}

#[derive(CandidType, Deserialize, Debug, PartialEq)]
enum JobOutcome {
    Completed,
    Skipped,
}

// ── Setup ─────────────────────────────────────────────────────────────────────

fn load_wasm() -> Vec<u8> {
    let path = format!(
        "{}/../../../target/wasm32-unknown-unknown/release/hub_canister.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|_| {
        panic!("WASM non trovato in {path} — esegui: cargo build --target wasm32-unknown-unknown --release -p hub-canister")
    })
}

/// Deploy hub su una subnet applicativa (gli HTTP outcall richiedono una app-subnet). Owner = sender.
fn setup() -> (PocketIc, Principal, Principal) {
    let pic = PocketIcBuilder::new().with_application_subnet().build();
    let owner = Principal::from_slice(&[7u8; 29]);
    let id = pic.create_canister();
    pic.add_cycles(id, 100_000_000_000_000);
    pic.install_canister(id, load_wasm(), encode_one(owner).unwrap(), None);
    (pic, id, owner)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn create_job(pic: &PocketIc, id: Principal, owner: Principal, job: Job) {
    let raw = pic
        .update_call(id, owner, "create_job", encode_one(job).unwrap())
        .expect("create_job trap");
    let r: Result<(), String> = decode_one(&raw).unwrap();
    r.expect("create_job err");
}

fn job_status(pic: &PocketIc, id: Principal, owner: Principal, job_id: &str) -> Option<String> {
    let raw = pic
        .query_call(id, owner, "job_status", encode_one(job_id).unwrap())
        .expect("job_status trap");
    decode_one(&raw).unwrap()
}

fn kv_get(pic: &PocketIc, id: Principal, owner: Principal, ns: &str, key: &str) -> Option<Vec<u8>> {
    let raw = pic
        .query_call(id, owner, "kv_get", encode_args((ns, key)).unwrap())
        .expect("kv_get trap");
    decode_one(&raw).unwrap()
}

/// Avvia `run_job_now` senza bloccare e fa avanzare la replica finché un HTTP outcall non è in
/// attesa. Ritorna (message_id da await, prima richiesta http pendente).
fn submit_and_collect_http(
    pic: &PocketIc,
    id: Principal,
    owner: Principal,
    job_id: &str,
) -> (RawMessageId, CanisterHttpRequest) {
    let msg = pic
        .submit_call(id, owner, "run_job_now", encode_one(job_id).unwrap())
        .expect("submit run_job_now");
    for _ in 0..40 {
        pic.tick();
        let reqs = pic.get_canister_http();
        if let Some(req) = reqs.into_iter().next() {
            return (msg, req);
        }
    }
    panic!("nessun HTTP outcall registrato dopo 40 tick");
}

fn run_job_now_blocking(
    pic: &PocketIc,
    id: Principal,
    owner: Principal,
    job_id: &str,
) -> Result<JobOutcome, String> {
    let raw = pic
        .update_call(id, owner, "run_job_now", encode_one(job_id).unwrap())
        .expect("run_job_now trap");
    decode_one(&raw).unwrap()
}

fn http_action(url: &str) -> Action {
    Action::Http {
        method: "GET".into(),
        url: url.into(),
        headers: vec![],
        body: String::new(),
        max_response_bytes: 0,
    }
}

fn set_secret(pic: &PocketIc, id: Principal, owner: Principal, name: &str, value: &str) {
    let raw = pic
        .update_call(id, owner, "set_secret", encode_args((name, value)).unwrap())
        .expect("set_secret trap");
    let r: Result<(), String> = decode_one(&raw).unwrap();
    r.expect("set_secret err");
}

fn automation_log(pic: &PocketIc, id: Principal, owner: Principal) -> Vec<String> {
    let raw = pic
        .query_call(id, owner, "automation_log", encode_one(()).unwrap())
        .expect("automation_log trap");
    decode_one(&raw).unwrap()
}

// ── G2b: ledger ICRC reale (canister eterogeneo) ────────────────────────────────

/// Carica un WASM del workspace per nome (stesso layout di `load_wasm`, ma generico).
fn load_wasm_named(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../../../target/wasm32-unknown-unknown/release/{name}.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|_| {
        panic!("WASM '{name}' non trovato in {path} — build: cargo build --target wasm32-unknown-unknown --release -p {name}")
    })
}

/// Deploya `test_mock_ledger` (ICRC-1/2 heap-only) sulla stessa subnet del hub. Init arg = `()`.
fn deploy_ledger(pic: &PocketIc) -> Principal {
    let lid = pic.create_canister();
    pic.add_cycles(lid, 100_000_000_000_000);
    pic.install_canister(lid, load_wasm_named("test_mock_ledger"), encode_one(()).unwrap(), None);
    lid
}

/// Test helper del ledger: conia `amount` e8s su `to`.
fn mint(pic: &PocketIc, ledger: Principal, to: Principal, amount: u64) {
    pic.update_call(ledger, Principal::anonymous(), "mint", encode_args((to, amount)).unwrap())
        .expect("mint trap");
}

/// Saldo on-ledger (query diretta, per la verifica indipendente del cambio di stato).
fn ledger_balance(pic: &PocketIc, ledger: Principal, who: Principal) -> u64 {
    let acct = Account { owner: who, subaccount: None };
    let raw = pic
        .query_call(ledger, Principal::anonymous(), "icrc1_balance_of", encode_one(acct).unwrap())
        .expect("balance_of trap");
    let n: Nat = decode_one(&raw).unwrap();
    u64::try_from(n.0).unwrap()
}

/// Hex decode (lower/upper, lunghezza pari) — speculare a `to_hex`, per decodificare l'output
/// candid raw di una `CanisterCall` e riverificarne il tipo.
fn from_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// `CanisterCall { canister_id, method, arg_hex }` con `arg` candid-encodato di un singolo valore.
fn icrc_call<T: CandidType>(ledger: Principal, method: &str, arg: T) -> Action {
    Action::CanisterCall {
        canister_id: ledger.to_text(),
        method: method.into(),
        arg_hex: to_hex(&encode_one(arg).unwrap()),
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// A — Http nudo: l'outcall parte davvero, transform applicata, body → output.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn http_outcall_fires_and_body_flows() {
    let (pic, id, owner) = setup();

    // step0 = Http GET ; step1 = scrivi il body nel KV → prova che l'output è fluito.
    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jhttp".into(),
            owning_bundle: None,
            actions: vec![
                http_action("https://example.com/api"),
                Action::KvSet {
                    namespace: "auto".into(),
                    key: "result".into(),
                    value: "{{step0}}".into(),
                },
            ],
            guard: None,
            title: None,
        },
    );

    let (msg, req) = submit_and_collect_http(&pic, id, owner, "jhttp");
    // L'outcall è PARTITO con la url del job.
    assert!(req.url.contains("example.com"), "url inattesa: {}", req.url);

    // Il peer è mockato; il motore è reale. (1 nodo app-subnet → niente additional_responses.)
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: req.subnet_id,
        request_id: req.request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply {
            status: 200,
            headers: vec![],
            body: b"PONG".to_vec(),
        }),
        additional_responses: vec![],
    });

    let raw = pic.await_call(msg).expect("await run_job_now");
    let outcome: Result<JobOutcome, String> = decode_one(&raw).unwrap();
    assert_eq!(outcome.unwrap(), JobOutcome::Completed);

    // Il body è fluito allo step successivo (transform tiene il body, scarta gli header).
    assert_eq!(
        kv_get(&pic, id, owner, "auto", "result"),
        Some(b"PONG".to_vec())
    );
    assert_eq!(
        job_status(&pic, id, owner, "jhttp").as_deref(),
        Some("Completed")
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// B — CanisterCall nuda: chiamata inter-canister reale (hub → hub), output hex non vuoto.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn canister_call_fires_and_output_flows() {
    let (pic, id, owner) = setup();
    let empty_args = to_hex(&encode_args(()).unwrap()); // candid `()` = "4449444c0000"

    // Il hub chiama sé stesso (`get_owner`, query) via inter-canister; l'output candid raw (un
    // Principal) → hex, scritto nel KV per provarne il flusso.
    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jcall".into(),
            owning_bundle: None,
            actions: vec![
                Action::CanisterCall {
                    canister_id: id.to_text(),
                    method: "get_owner".into(),
                    arg_hex: empty_args,
                },
                Action::KvSet {
                    namespace: "auto".into(),
                    key: "callout".into(),
                    value: "{{step0}}".into(),
                },
            ],
            guard: None,
            title: None,
        },
    );

    let outcome = run_job_now_blocking(&pic, id, owner, "jcall");
    assert_eq!(outcome.unwrap(), JobOutcome::Completed);

    // Output candid raw (hex) presente e non vuoto.
    let stored = kv_get(&pic, id, owner, "auto", "callout").expect("callout assente");
    let hex = String::from_utf8(stored).unwrap();
    assert!(!hex.is_empty(), "output CanisterCall vuoto");
    assert!(hex.starts_with("4449444c"), "non sembra candid: {hex}"); // magic "DIDL"
}

// ═══════════════════════════════════════════════════════════════════════════════
// C1 — CanisterCall verso metodo inesistente → reject → azione Err, job Failed, no panic.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn canister_call_reject_is_err_not_panic() {
    let (pic, id, owner) = setup();
    let empty_args = to_hex(&encode_args(()).unwrap());

    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jbad".into(),
            owning_bundle: None,
            actions: vec![Action::CanisterCall {
                canister_id: id.to_text(),
                method: "metodo_che_non_esiste".into(),
                arg_hex: empty_args,
            }],
            guard: None,
            title: None,
        },
    );

    let outcome = run_job_now_blocking(&pic, id, owner, "jbad");
    assert!(outcome.is_err(), "un reject deve essere Err");
    assert_eq!(
        job_status(&pic, id, owner, "jbad")
            .as_deref()
            .map(|s| s.starts_with("Failed:")),
        Some(true)
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// C2 — Http con risposta mockata a REJECT → azione Err, job Failed, no panic.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn http_reject_is_err_not_panic() {
    let (pic, id, owner) = setup();

    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jhttpbad".into(),
            owning_bundle: None,
            actions: vec![http_action("https://example.com/down")],
            guard: None,
            title: None,
        },
    );

    let (msg, req) = submit_and_collect_http(&pic, id, owner, "jhttpbad");
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: req.subnet_id,
        request_id: req.request_id,
        response: CanisterHttpResponse::CanisterHttpReject(CanisterHttpReject {
            reject_code: 1,
            message: "outcall fallito (mock)".into(),
        }),
        additional_responses: vec![],
    });

    let raw = pic.await_call(msg).expect("await run_job_now");
    let outcome: Result<JobOutcome, String> = decode_one(&raw).unwrap();
    assert!(outcome.is_err(), "un reject dell'outcall deve essere Err");
    assert_eq!(
        job_status(&pic, id, owner, "jhttpbad")
            .as_deref()
            .map(|s| s.starts_with("Failed:")),
        Some(true)
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// G1 — credenziale d'uscita: `{{secret:NAME}}` raggiunge l'outcall (header), poi forza un
//      FALLIMENTO e prova che il CHIARO non compare in errore né nel log (Rilievo 1, dal vivo).
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn secret_reaches_outcall_but_never_leaks_in_log_or_error() {
    let (pic, id, owner) = setup();
    const PLAIN: &str = "sk-LIVE-SUPERSECRET-9f3a";

    set_secret(&pic, id, owner, "TOKEN", PLAIN);

    // Job Owner: GET con header Authorization che referenzia il segreto per nome.
    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jsec".into(),
            owning_bundle: None,
            actions: vec![Action::Http {
                method: "GET".into(),
                url: "https://example.com/notify".into(),
                headers: vec![("Authorization".into(), "Bearer {{secret:TOKEN}}".into())],
                body: String::new(),
                max_response_bytes: 0,
            }],
            guard: None,
            title: None,
        },
    );

    let (msg, req) = submit_and_collect_http(&pic, id, owner, "jsec");

    // (a) Il segreto è stato RISOLTO nel campo d'uscita: l'header reale porta il chiaro (non vacuo).
    let auth = req
        .headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("Authorization"))
        .map(|h| h.value.clone())
        .unwrap_or_default();
    assert_eq!(auth, format!("Bearer {PLAIN}"), "il segreto non è arrivato all'outcall");

    // (b) Forza il fallimento della consegna (webhook morto).
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: req.subnet_id,
        request_id: req.request_id,
        response: CanisterHttpResponse::CanisterHttpReject(CanisterHttpReject {
            reject_code: 1,
            message: "delivery failed (mock)".into(),
        }),
        additional_responses: vec![],
    });

    let raw = pic.await_call(msg).expect("await run_job_now");
    let outcome: Result<JobOutcome, String> = decode_one(&raw).unwrap();

    // (c) Il fallimento è osservabile (Err + Failed:) ma il CHIARO non trapela — né nell'errore…
    let err = outcome.expect_err("la consegna fallita deve essere Err");
    assert!(!err.contains(PLAIN), "il chiaro è trapelato nell'errore: {err}");

    // …né nello status…
    let status = job_status(&pic, id, owner, "jsec").unwrap_or_default();
    assert!(status.starts_with("Failed:"), "atteso Failed, ho: {status}");
    assert!(!status.contains(PLAIN), "il chiaro è trapelato nello status: {status}");

    // …né nel log di automazione (auto-conoscenza pubblica all'owner).
    let log = automation_log(&pic, id, owner);
    assert!(
        !log.iter().any(|l| l.contains(PLAIN)),
        "il chiaro è trapelato nel log: {log:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// G1 — budget d'uscita: un job con troppe azioni d'uscita è rifiutato PRIMA di bruciare cicli.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn outbound_budget_caps_a_job() {
    let (pic, id, owner) = setup();

    // 5 outcall in un solo job > MAX_OUTBOUND_PER_RUN (4): la 5ª non parte → job Failed.
    // Tutte verso un canister-call inesistente sarebbe reject; usiamo CanisterCall così è bloccante
    // e non richiede mock HTTP. Il budget morde PRIMA dell'esecuzione della 5ª azione.
    let empty_args = to_hex(&encode_args(()).unwrap());
    let mut actions = Vec::new();
    for _ in 0..5 {
        actions.push(Action::CanisterCall {
            canister_id: id.to_text(),
            method: "get_owner".into(),
            arg_hex: empty_args.clone(),
        });
    }
    create_job(
        &pic,
        id,
        owner,
        Job { job_id: "jbudget".into(), owning_bundle: None, actions, guard: None, title: None },
    );

    let outcome = run_job_now_blocking(&pic, id, owner, "jbudget");
    let err = outcome.expect_err("oltre budget deve essere Err");
    assert!(err.contains("budget"), "errore inatteso: {err}");
}

// ═══════════════════════════════════════════════════════════════════════════════
// G2b — CanisterCall verso un ledger ICRC ETEROGENEO reale: lettura saldo, output
//       candid raw (un `Nat`) che fluisce allo step successivo via {{step0}}.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn canister_call_to_real_icrc_ledger_reads_and_flows() {
    let (pic, id, owner) = setup();
    let ledger = deploy_ledger(&pic);
    mint(&pic, ledger, id, 1_000_000); // il chiamante del ledger è il HUB (`id`)

    // step0 = leggi il saldo del hub sul ledger; step1 = scrivi l'output candid raw nel KV.
    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jbal".into(),
            owning_bundle: None,
            actions: vec![
                icrc_call(ledger, "icrc1_balance_of", Account { owner: id, subaccount: None }),
                Action::KvSet { namespace: "auto".into(), key: "bal".into(), value: "{{step0}}".into() },
            ],
            guard: None,
            title: None,
        },
    );

    let outcome = run_job_now_blocking(&pic, id, owner, "jbal");
    assert_eq!(outcome.unwrap(), JobOutcome::Completed);

    // L'output è fluito allo step successivo ed è candid valido: decodificandolo riottengo il saldo.
    let stored = kv_get(&pic, id, owner, "auto", "bal").expect("bal assente");
    let hex = String::from_utf8(stored).unwrap();
    assert!(hex.starts_with("4449444c"), "non sembra candid: {hex}");
    let bal: Nat = decode_one(&from_hex(&hex)).expect("output non è un Nat");
    assert_eq!(bal, Nat::from(1_000_000u64), "il saldo letto dal ledger non torna");
}

// ═══════════════════════════════════════════════════════════════════════════════
// G2b — CanisterCall che CAMBIA STATO su un canister terzo: `icrc1_transfer` reale, verificato
//       con una read indipendente sul ledger (mittente decrementato, destinatario accreditato).
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn canister_call_icrc_transfer_changes_state() {
    let (pic, id, owner) = setup();
    let ledger = deploy_ledger(&pic);
    let recipient = Principal::from_slice(&[9u8; 29]);
    mint(&pic, ledger, id, 1_000_000);

    let transfer = TransferArg {
        from_subaccount: None,
        to: Account { owner: recipient, subaccount: None },
        amount: Nat::from(400_000u64),
        fee: None,
        memo: None,
        created_at_time: None,
    };
    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jxfer".into(),
            owning_bundle: None,
            actions: vec![icrc_call(ledger, "icrc1_transfer", transfer)],
            guard: None,
            title: None,
        },
    );

    let outcome = run_job_now_blocking(&pic, id, owner, "jxfer");
    assert_eq!(outcome.unwrap(), JobOutcome::Completed);

    // Stato cambiato DAVVERO, osservato con una query indipendente sul ledger.
    assert_eq!(ledger_balance(&pic, ledger, id), 600_000, "mittente non decrementato");
    assert_eq!(ledger_balance(&pic, ledger, recipient), 400_000, "destinatario non accreditato");
}

// ═══════════════════════════════════════════════════════════════════════════════
// G2b — un errore APPLICATIVO del ledger (saldo insufficiente) è una *reply* candid, non un
//       reject: l'azione è Ok (output), il job Completed, lo stato resta invariato. Distingue
//       l'errore-di-dominio dal reject di trasporto di C1 (che è Err/Failed).
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn canister_call_app_error_is_reply_not_reject() {
    let (pic, id, owner) = setup();
    let ledger = deploy_ledger(&pic);
    mint(&pic, ledger, id, 100); // saldo volutamente insufficiente

    let overdraft = TransferArg {
        from_subaccount: None,
        to: Account { owner: Principal::from_slice(&[9u8; 29]), subaccount: None },
        amount: Nat::from(500_000u64),
        fee: None,
        memo: None,
        created_at_time: None,
    };
    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jover".into(),
            owning_bundle: None,
            actions: vec![icrc_call(ledger, "icrc1_transfer", overdraft)],
            guard: None,
            title: None,
        },
    );

    // Reply (anche se è un `Err` di dominio) → azione Ok → job Completed (NON Failed).
    let outcome = run_job_now_blocking(&pic, id, owner, "jover");
    assert_eq!(outcome.unwrap(), JobOutcome::Completed, "un Err di dominio resta una reply");
    assert_eq!(
        job_status(&pic, id, owner, "jover").as_deref(),
        Some("Completed")
    );
    // Stato invariato: il trasferimento non è avvenuto.
    assert_eq!(ledger_balance(&pic, ledger, id), 100, "il saldo non doveva cambiare");
}

// ═══════════════════════════════════════════════════════════════════════════════
// G2b — il budget d'uscita morde con chiamate ETEROGENEE reali (non self-call): 5 `icrc1_balance_of`
//       in un job > MAX_OUTBOUND_PER_RUN (4) → la 5ª non parte → job Failed.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn outbound_budget_caps_with_real_ledger() {
    let (pic, id, owner) = setup();
    let ledger = deploy_ledger(&pic);
    mint(&pic, ledger, id, 1);

    let mut actions = Vec::new();
    for _ in 0..5 {
        actions.push(icrc_call(ledger, "icrc1_balance_of", Account { owner: id, subaccount: None }));
    }
    create_job(
        &pic,
        id,
        owner,
        Job { job_id: "jledgerbudget".into(), owning_bundle: None, actions, guard: None, title: None },
    );

    let outcome = run_job_now_blocking(&pic, id, owner, "jledgerbudget");
    let err = outcome.expect_err("oltre budget deve essere Err");
    assert!(err.contains("budget"), "errore inatteso: {err}");
}

// ═══════════════════════════════════════════════════════════════════════════════
// G2b — Http col segreto, ROUND-OUT: `{{secret:NAME}}` in header E body, verificato sulla richiesta
//       USCENTE, sul percorso 200 OK; il chiaro non trapela nel log nemmeno a CONSEGNA RIUSCITA
//       (G1 copriva il fallimento — qui chiudo il successo).
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn http_post_secret_in_header_and_body_succeeds_without_leak() {
    let (pic, id, owner) = setup();
    const PLAIN: &str = "sk-LIVE-POST-7b21c";

    set_secret(&pic, id, owner, "TOKEN", PLAIN);

    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jpost".into(),
            owning_bundle: None,
            actions: vec![Action::Http {
                method: "POST".into(),
                url: "https://example.com/webhook".into(),
                headers: vec![("Authorization".into(), "Bearer {{secret:TOKEN}}".into())],
                body: "{\"token\":\"{{secret:TOKEN}}\"}".into(),
                max_response_bytes: 0,
            }],
            guard: None,
            title: None,
        },
    );

    let (msg, req) = submit_and_collect_http(&pic, id, owner, "jpost");

    // Il segreto è risolto in ENTRAMBI i campi d'uscita: header…
    let auth = req
        .headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("Authorization"))
        .map(|h| h.value.clone())
        .unwrap_or_default();
    assert_eq!(auth, format!("Bearer {PLAIN}"), "segreto assente dall'header uscente");
    // …e body.
    let body = String::from_utf8_lossy(&req.body).to_string();
    assert!(body.contains(PLAIN), "segreto assente dal body uscente: {body}");

    // Consegna RIUSCITA (200 OK).
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: req.subnet_id,
        request_id: req.request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply {
            status: 200,
            headers: vec![],
            body: b"OK".to_vec(),
        }),
        additional_responses: vec![],
    });

    let raw = pic.await_call(msg).expect("await run_job_now");
    let outcome: Result<JobOutcome, String> = decode_one(&raw).unwrap();
    assert_eq!(outcome.unwrap(), JobOutcome::Completed);

    // No-leak anche sul SUCCESSO: né status né log nominano il chiaro.
    let status = job_status(&pic, id, owner, "jpost").unwrap_or_default();
    assert_eq!(status, "Completed");
    let log = automation_log(&pic, id, owner);
    assert!(
        !log.iter().any(|l| l.contains(PLAIN)),
        "il chiaro è trapelato nel log a consegna riuscita: {log:?}"
    );
}

// ── G3, Rilievo 4: consegna respinta (non-2xx) lascia traccia, MAI muta né leaky ────
//
// Il caso peggiore di "ti avviso": il webhook è raggiungibile ma morto (404/410/401) → l'outcall
// PARTE e ritorna (non è un reject di trasporto), quindi il job è Completed. Senza il nudge morirebbe
// in silenzio. Asserzioni: (1) il job resta Completed (semantica invariata per i sentinelli);
// (2) il log porta una riga-nota `Outbound HTTP 404` accanto all'esito; (3) la nota NON contiene il
// segreto risolto (porta solo lo status, mai l'URL).
#[test]
fn http_delivery_non_2xx_is_observable_without_leaking_secret() {
    let (pic, id, owner) = setup();
    const PLAIN: &str = "https://hooks.example.com/T/B/dead-webhook-9f3";

    set_secret(&pic, id, owner, "CHANNEL", PLAIN);

    create_job(
        &pic,
        id,
        owner,
        Job {
            job_id: "jdead".into(),
            owning_bundle: None,
            actions: vec![Action::Http {
                method: "POST".into(),
                url: "{{secret:CHANNEL}}".into(),
                headers: vec![],
                body: "alert".into(),
                max_response_bytes: 0,
            }],
            guard: None,
            title: None,
        },
    );

    let (msg, req) = submit_and_collect_http(&pic, id, owner, "jdead");
    // Il segreto è davvero risolto nell'URL uscente (è il canale di consegna).
    assert_eq!(req.url, PLAIN, "l'URL uscente non porta il segreto risolto: {}", req.url);

    // Il peer è VIVO ma respinge: 404 (webhook cancellato) — reply, non reject di trasporto.
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: req.subnet_id,
        request_id: req.request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply {
            status: 404,
            headers: vec![],
            body: b"Not Found".to_vec(),
        }),
        additional_responses: vec![],
    });

    let raw = pic.await_call(msg).expect("await run_job_now");
    let outcome: Result<JobOutcome, String> = decode_one(&raw).unwrap();
    // (1) Semantica invariata: l'outcall è partita → il job è Completed (non Failed di trasporto).
    assert_eq!(outcome.unwrap(), JobOutcome::Completed);
    assert_eq!(job_status(&pic, id, owner, "jdead").as_deref(), Some("Completed"));

    // (2) Ma la consegna respinta NON muore muta: una riga-nota la rende osservabile.
    let log = automation_log(&pic, id, owner);
    assert!(
        log.iter().any(|l| l.contains("jdead") && l.contains("Outbound HTTP 404")),
        "manca la nota di consegna non-2xx nel log: {log:?}"
    );
    // (3) La nota porta solo lo status, MAI il segreto risolto (l'URL del canale).
    assert!(
        !log.iter().any(|l| l.contains(PLAIN)),
        "il segreto è trapelato nella nota di consegna: {log:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPSULA DEL TEMPO — consegna OUTBOUND-PUSH dal vivo (Fase 5, punto 1).
//
// Diversamente dai job (run_job_now/run_due esposti), la consegna-capsula si aggancia al TICK unico
// di core-timer (120s): la cleanup-fn spawna un future fire-and-forget che, DOPO run_due, chiama
// `deliver_capsule_if_due`. Quindi qui non c'è un message_id da await — il push si OSSERVA via
// `get_canister_http` dopo aver fatto scattare il tick (advance_time oltre l'intervallo). Ciò che si
// verifica è che il canister ESCA col payload giusto + la logica fire-once/best-effort/scrub; il
// transito sul filo (TLS verso il webhook reale) è infra IC, mockata come nei test G2/G3 sopra
// (peer HTTP mockato): è lo stesso confine onesto, non il filo.
// ═══════════════════════════════════════════════════════════════════════════════

// Tipo candid locale, speculare a `DeliveryConfig` del canister (wire-format per nome+tipo dei campi).
#[derive(CandidType, Deserialize, Debug)]
struct DeliveryConfig {
    channel: String,
    window_secs: u64,
    delivered: bool,
}

fn checkin(pic: &PocketIc, id: Principal, owner: Principal) {
    let raw = pic
        .update_call(id, owner, "checkin", encode_one(()).unwrap())
        .expect("checkin trap");
    let r: Result<(), String> = decode_one(&raw).unwrap();
    r.expect("checkin err");
}

fn set_release_capsule(pic: &PocketIc, id: Principal, owner: Principal, envelope: &[u8]) {
    let raw = pic
        .update_call(id, owner, "set_release_capsule", encode_one(envelope.to_vec()).unwrap())
        .expect("set_release_capsule trap");
    let r: Result<(), String> = decode_one(&raw).unwrap();
    r.expect("set_release_capsule err");
}

fn set_delivery_config(pic: &PocketIc, id: Principal, owner: Principal, channel: &str, window_secs: u64) {
    let raw = pic
        .update_call(id, owner, "set_delivery_config", encode_args((channel, window_secs)).unwrap())
        .expect("set_delivery_config trap");
    let r: Result<(), String> = decode_one(&raw).unwrap();
    r.expect("set_delivery_config err");
}

fn get_delivery_config(pic: &PocketIc, id: Principal, owner: Principal) -> Option<DeliveryConfig> {
    let raw = pic
        .query_call(id, owner, "get_delivery_config", encode_one(()).unwrap())
        .expect("get_delivery_config trap");
    decode_one(&raw).unwrap()
}

/// Fa scattare il tick di core-timer (avanza il tempo oltre l'intervallo di 120s) e raccoglie il primo
/// HTTP outcall che la consegna-capsula mette in attesa. Il push è fire-and-forget (spawnato dalla
/// cleanup-fn del tick) → niente message_id, si osserva via `get_canister_http`.
fn tick_and_collect_http(pic: &PocketIc, advance_secs: u64) -> Option<CanisterHttpRequest> {
    pic.advance_time(Duration::from_secs(advance_secs));
    for _ in 0..40 {
        pic.tick();
        if let Some(req) = pic.get_canister_http().into_iter().next() {
            return Some(req);
        }
    }
    None
}

/// Fa scattare il tick e prova che NESSUN outcall riparte (fire-once: capsula già consegnata).
fn tick_expect_no_http(pic: &PocketIc, advance_secs: u64) {
    pic.advance_time(Duration::from_secs(advance_secs));
    for _ in 0..40 {
        pic.tick();
    }
    assert!(
        pic.get_canister_http().is_empty(),
        "outcall inatteso: la consegna NON doveva ripartire (fire-once)"
    );
}

/// Lascia che il future spawnato riprenda dopo aver mockato la risposta (marca delivered / ritenta).
fn settle(pic: &PocketIc) {
    for _ in 0..10 {
        pic.tick();
    }
}

fn mock_reply(pic: &PocketIc, req: &CanisterHttpRequest, status: u16, body: &[u8]) {
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: req.subnet_id,
        request_id: req.request_id,
        response: CanisterHttpResponse::CanisterHttpReply(CanisterHttpReply {
            status,
            headers: vec![],
            body: body.to_vec(),
        }),
        additional_responses: vec![],
    });
}

fn mock_reject(pic: &PocketIc, req: &CanisterHttpRequest, message: &str) {
    pic.mock_canister_http_response(MockCanisterHttpResponse {
        subnet_id: req.subnet_id,
        request_id: req.request_id,
        response: CanisterHttpResponse::CanisterHttpReject(CanisterHttpReject {
            reject_code: 1,
            message: message.into(),
        }),
        additional_responses: vec![],
    });
}

/// Arma la capsula: registra il canale d'uscita in `__secrets`, timbra la presenza, deposita
/// l'envelope opaco e configura la consegna. Ritorna nulla — lo stato è nel canister.
fn arm_capsule(
    pic: &PocketIc,
    id: Principal,
    owner: Principal,
    channel_name: &str,
    channel_url: &str,
    envelope: &[u8],
    window_secs: u64,
) {
    set_secret(pic, id, owner, channel_name, channel_url);
    checkin(pic, id, owner); // timbra last_checkin = ora del canister (l'origine del silenzio)
    set_release_capsule(pic, id, owner, envelope);
    set_delivery_config(pic, id, owner, channel_name, window_secs);
}

// Envelope-metodo opaco (forma di Fase 1: JSON-UTF8 self-descrittivo). Il backend lo vede `Vec<u8>` e
// lo trasmette intatto — non lo decifra né lo riscrive. Il `ct` porta un marcatore distintivo per le
// asserzioni di no-leak.
const ENVELOPE: &[u8] = br#"{"v":1,"method":"passphrase","kdf":{"algo":"PBKDF2-SHA256","salt":"c2FsdHk","iter":600000},"ct":"Y2lwaGVydGV4dC1jYWZlMTIzNA"}"#;

// ═══════════════════════════════════════════════════════════════════════════════
// CAP-1 — silenzio scaduto + capsula armata → il tick fa partire il push (l'agente ESCE).
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn capsule_push_fires_on_expired_silence() {
    let (pic, id, owner) = setup();
    const CHANNEL_URL: &str = "https://heir.example.com/inbox-7f3a";

    arm_capsule(&pic, id, owner, "HEIR", CHANNEL_URL, ENVELOPE, 60);

    // Silenzio scaduto (200 > 60s di finestra) E tick scattato (200 > 120s d'intervallo) → push.
    let req = tick_and_collect_http(&pic, 200).expect("la consegna-capsula non ha prodotto outcall");

    // L'agente è USCITO verso il canale dell'erede: URL = valore del segreto (risolto in host_deliver)…
    assert_eq!(req.url, CHANNEL_URL, "l'URL uscente non è il canale dell'erede");
    // …col body = envelope OPACO, intatto byte-per-byte (il backend non lo decifra né lo riscrive)…
    assert_eq!(req.body, ENVELOPE, "il body uscente non è l'envelope depositato");
    // …e content-type application/json (impostato da deliver_capsule_if_due).
    assert!(
        req.headers.iter().any(|h| {
            h.name.eq_ignore_ascii_case("content-type") && h.value.contains("application/json")
        }),
        "content-type application/json assente dall'outcall: {:?}",
        req.headers
    );

    // Peer mockato (confine onesto, come G2/G3): si prova che il canister ESCE col payload giusto e la
    // logica fire-once; il transito sul filo (TLS) è infra IC, non esercitato qui.
    mock_reply(&pic, &req, 200, b"OK");
    settle(&pic);

    // Consegna 2xx riuscita → fire-once marcato (delivered=true).
    let dc = get_delivery_config(&pic, id, owner).expect("delivery-config sparita");
    assert!(dc.delivered, "delivered non marcato dopo una consegna 2xx riuscita");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAP-2 — fire-once: dopo una consegna riuscita, un secondo tick (silenzio ancora scaduto) NON
//         ri-pusha. È la garanzia "al più un doppione, mai eredità ripetuta ad ogni tick".
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn capsule_push_is_fire_once() {
    let (pic, id, owner) = setup();
    arm_capsule(&pic, id, owner, "HEIR", "https://heir.example.com/inbox", ENVELOPE, 60);

    // 1ª consegna: parte e riesce → delivered=true.
    let req = tick_and_collect_http(&pic, 200).expect("la prima consegna non è partita");
    mock_reply(&pic, &req, 200, b"OK");
    settle(&pic);
    assert!(get_delivery_config(&pic, id, owner).unwrap().delivered, "delivered non marcato");

    // 2º tick, silenzio ANCORA scaduto, capsula NON ri-armata → niente secondo push.
    tick_expect_no_http(&pic, 200);
    assert!(
        get_delivery_config(&pic, id, owner).unwrap().delivered,
        "delivered non doveva tornare false"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAP-3 — best-effort: un fallimento di TRASPORTO (reject) lascia delivered=false → al tick
//         successivo la consegna RIPARTE. Marcatura solo su trasporto riuscito.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn capsule_push_best_effort_retries_on_transport_failure() {
    let (pic, id, owner) = setup();
    const CHANNEL_URL: &str = "https://heir.example.com/inbox-retry";
    arm_capsule(&pic, id, owner, "HEIR", CHANNEL_URL, ENVELOPE, 60);

    // 1º tentativo: il TRASPORTO fallisce (reject) → host_deliver Err → delivered resta false.
    let req = tick_and_collect_http(&pic, 200).expect("il primo tentativo non è partito");
    mock_reject(&pic, &req, "transport down (mock)");
    settle(&pic);
    assert!(
        !get_delivery_config(&pic, id, owner).unwrap().delivered,
        "un fallimento di trasporto NON deve marcare delivered (best-effort)"
    );

    // 2º tick: delivered ancora false → la consegna RIPARTE verso lo stesso canale.
    let req2 = tick_and_collect_http(&pic, 200).expect("la consegna NON è stata ritentata");
    assert_eq!(req2.url, CHANNEL_URL, "il ritentativo non punta allo stesso canale");

    // Stavolta il trasporto riesce (200) → delivered=true (fire-once d'ora in poi).
    mock_reply(&pic, &req2, 200, b"OK");
    settle(&pic);
    assert!(
        get_delivery_config(&pic, id, owner).unwrap().delivered,
        "la ritrasmissione riuscita non ha marcato delivered"
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAP-4 — consegna respinta (non-2xx) OSSERVABILE nel log via host_deliver, MA passphrase/envelope
//         e canale (segreto) MAI loggati. Il trasporto è riuscito (404 = reply) → delivered marcato.
// ═══════════════════════════════════════════════════════════════════════════════
#[test]
fn capsule_push_non_2xx_is_observable_without_leaking() {
    let (pic, id, owner) = setup();
    const CHANNEL_URL: &str = "https://heir.example.com/dead-inbox-DEADBEEF";
    arm_capsule(&pic, id, owner, "HEIR", CHANNEL_URL, ENVELOPE, 60);

    let req = tick_and_collect_http(&pic, 200).expect("la consegna non è partita");

    // Peer VIVO ma respinge (404, webhook cancellato): reply, non reject di trasporto → host_deliver
    // Ok(404) → la consegna è "partita" → delivered marcato (best-effort: ha fatto il possibile).
    mock_reply(&pic, &req, 404, b"Not Found");
    settle(&pic);
    assert!(
        get_delivery_config(&pic, id, owner).unwrap().delivered,
        "una consegna PARTITA (anche 404) marca delivered: il trasporto è riuscito"
    );

    // La consegna respinta NON muore muta: una riga-nota la rende osservabile, con la label dell'host.
    let log = automation_log(&pic, id, owner);
    assert!(
        log.iter().any(|l| l.contains("capsule-delivery") && l.contains("Outbound HTTP 404")),
        "manca la nota di consegna non-2xx nel log: {log:?}"
    );
    // …ma il ciphertext dell'envelope NON trapela mai nel log (il body opaco non viene loggato)…
    assert!(
        !log.iter().any(|l| l.contains("cafe1234") || l.contains("Y2lwaGVydGV4dC")),
        "il ciphertext dell'envelope è trapelato nel log: {log:?}"
    );
    // …né il canale d'uscita (il segreto risolto: l'URL del webhook).
    assert!(
        !log.iter().any(|l| l.contains("DEADBEEF") || l.contains("heir.example.com")),
        "il canale d'uscita (segreto) è trapelato nel log: {log:?}"
    );
}
