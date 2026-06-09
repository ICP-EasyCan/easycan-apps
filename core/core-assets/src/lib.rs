//! core-assets — asset storage + HTTP serving + IC Response Certification v2
//!
//! Carica il frontend (HTML/JS/CSS) in stable memory e lo serve via HTTP
//! con certificazione IC valida. Supporta SPA fallback.
//!
//! Nessun #[update]/#[query] — il canister host wrappa le funzioni.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use candid::CandidType;
use core_types::Memory;
use ic_http_certification::{
    DefaultCelBuilder, DefaultResponseCertification, HttpCertification,
    HttpCertificationPath, HttpCertificationTree, HttpCertificationTreeEntry,
    HttpResponse as CertHttpResponse, StatusCode,
    CERTIFICATE_EXPRESSION_HEADER_NAME, CERTIFICATE_HEADER_NAME,
};
use ic_stable_structures::{StableBTreeMap, storable::Bound, Storable};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;

// ─── Tipi HTTP (interfaccia Candid standard ICP) ────────────────────────────

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub upgrade: Option<bool>,
}

// ─── Tipi Storable ──────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct AssetPath(pub String);

impl Storable for AssetPath {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(self.0.as_bytes().to_vec())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        AssetPath(String::from_utf8(bytes.into_owned()).unwrap_or_default())
    }
    fn into_bytes(self) -> Vec<u8> {
        self.0.into_bytes()
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 512,
        is_fixed_size: false,
    };
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct AssetData {
    pub content_type: String,
    pub content: Vec<u8>,
}

impl Storable for AssetData {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).unwrap())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).unwrap()
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    const BOUND: Bound = Bound::Unbounded;
}

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static ASSETS: RefCell<Option<StableBTreeMap<AssetPath, AssetData, Memory>>> =
        const { RefCell::new(None) };

    static CERT_TREE: RefCell<HttpCertificationTree> =
        RefCell::new(HttpCertificationTree::default());

    static CERT_MAP: RefCell<HashMap<String, (HttpCertification, String)>> =
        RefCell::new(HashMap::new());
}

// ─── Init ───────────────────────────────────────────────────────────────────

/// Inizializza l'asset storage con la memory allocata dal MemoryManager.
pub fn init_storage(assets_mem: Memory) {
    ASSETS.with(|a| {
        *a.borrow_mut() = Some(StableBTreeMap::init(assets_mem));
    });
}

fn with_assets<R>(f: impl FnOnce(&StableBTreeMap<AssetPath, AssetData, Memory>) -> R) -> R {
    ASSETS.with(|a| {
        let borrow = a.borrow();
        let map = borrow.as_ref().expect("core-assets: init_storage() not called");
        f(map)
    })
}

fn with_assets_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<AssetPath, AssetData, Memory>) -> R,
) -> R {
    ASSETS.with(|a| {
        let mut borrow = a.borrow_mut();
        let map = borrow.as_mut().expect("core-assets: init_storage() not called");
        f(map)
    })
}

// ─── CEL expression ─────────────────────────────────────────────────────────

fn build_cel_expr() -> ic_http_certification::cel::DefaultResponseOnlyCelExpression<'static> {
    DefaultCelBuilder::response_only_certification()
        .with_response_certification(
            DefaultResponseCertification::certified_response_headers(vec!["content-type"]),
        )
        .build()
}

// ─── Certification tree ─────────────────────────────────────────────────────

fn add_to_cert_tree(path: &str, content_type: &str, content: &[u8]) {
    let cel = build_cel_expr();
    let cel_str = cel.to_string();
    let response = CertHttpResponse::builder()
        .with_status_code(StatusCode::OK)
        .with_headers(vec![
            ("content-type".to_string(), content_type.to_string()),
            (CERTIFICATE_EXPRESSION_HEADER_NAME.to_string(), cel_str.clone()),
        ])
        .with_body(Cow::Borrowed(content))
        .build();
    let certification = HttpCertification::response_only(&cel, &response, None)
        .expect("response_only certification failed");

    let tree_path = HttpCertificationPath::exact(path);
    let entry = HttpCertificationTreeEntry::new(&tree_path, certification);
    CERT_TREE.with(|t| t.borrow_mut().insert(&entry));
    CERT_MAP.with(|m| {
        m.borrow_mut()
            .insert(path.to_string(), (certification, cel_str));
    });
}

fn commit_certified_data() {
    let root_hash = CERT_TREE.with(|t| t.borrow().root_hash());
    #[allow(deprecated)]
    ic_cdk::api::set_certified_data(&root_hash);
}

/// Ricostruisce l'albero di certificazione dalla stable memory.
/// Chiamata dal canister host in init() e post_upgrade().
pub fn rebuild_cert_tree() {
    CERT_TREE.with(|t| *t.borrow_mut() = HttpCertificationTree::default());
    CERT_MAP.with(|m| m.borrow_mut().clear());
    with_assets(|assets| {
        for entry in assets.iter() {
            let path = entry.key();
            let data = entry.value();
            add_to_cert_tree(&path.0, &data.content_type, &data.content);
        }
    });
    commit_certified_data();
}

// ─── Certified headers builder ──────────────────────────────────────────────

fn build_certified_headers(path: &str, content_type: &str) -> Vec<(String, String)> {
    let mut headers = vec![
        ("content-type".to_string(), content_type.to_string()),
        ("cache-control".to_string(), "public, max-age=3600".to_string()),
    ];

    let cert_data = CERT_MAP.with(|m| m.borrow().get(path).cloned());
    let Some((certification, cel_str)) = cert_data else {
        return headers;
    };

    let Some(cert_bytes) = ic_cdk::api::data_certificate() else {
        return headers;
    };

    let tree_path = HttpCertificationPath::exact(path);
    let entry = HttpCertificationTreeEntry::new(&tree_path, certification);
    let Ok(witness) = CERT_TREE.with(|t| t.borrow().witness(&entry, path)) else {
        return headers;
    };

    let Ok(witness_cbor) = serde_cbor::to_vec(&witness) else {
        return headers;
    };
    let expr_path = tree_path.to_expr_path();
    let Ok(expr_path_cbor) = serde_cbor::to_vec(&expr_path) else {
        return headers;
    };

    let ic_cert = format!(
        "certificate=:{cert_b64}:, tree=:{tree_b64}:, version=2, expr_path=:{expr_b64}:",
        cert_b64 = B64.encode(&cert_bytes),
        tree_b64 = B64.encode(&witness_cbor),
        expr_b64 = B64.encode(&expr_path_cbor),
    );

    headers.push((CERTIFICATE_EXPRESSION_HEADER_NAME.to_string(), cel_str));
    headers.push((CERTIFICATE_HEADER_NAME.to_string(), ic_cert));
    headers
}

// ─── Upload asset ───────────────────────────────────────────────────────────

/// Carica un asset nel canister. Il canister host deve verificare l'autorizzazione.
pub fn upload_asset(path: String, content_type: String, content: Vec<u8>) {
    add_to_cert_tree(&path, &content_type, &content);
    with_assets_mut(|assets| {
        assets.insert(AssetPath(path), AssetData { content_type, content });
    });
    commit_certified_data();
}

/// Carica più asset in una singola chiamata. Il canister host deve verificare l'autorizzazione.
/// Usato dalla factory durante provisioning per ridurre le ICC da N a N/batch_size.
pub fn upload_asset_batch(assets: Vec<(String, String, Vec<u8>)>) {
    for (path, content_type, content) in assets {
        add_to_cert_tree(&path, &content_type, &content);
        with_assets_mut(|map| {
            map.insert(AssetPath(path), AssetData { content_type, content });
        });
    }
    commit_certified_data();
}

/// Ricostruisce la certificazione dopo upload bulk.
/// Chiamata dalla factory dopo aver caricato tutti gli asset.
pub fn finalize_assets() {
    rebuild_cert_tree();
}

/// Svuota **tutti** gli asset (mappa stable + albero di certificazione) e ricommitta i certified data.
/// Il canister host deve verificare l'autorizzazione (owner/factory).
///
/// Serve al self-upgrade (§B): un bundle frontend nuovo ha file con hash di contenuto diversi (Vite),
/// quindi un semplice re-upload `insert` lascerebbe i vecchi file orfani per sempre — un leak di storage
/// che cresce a ogni upgrade (gemello-asset di BUG-12). Chiamare `clear_assets()` prima di ricaricare il
/// bundle garantisce un replace pulito. Va seguito da `upload_asset_batch` + `finalize_assets`.
pub fn clear_assets() {
    clear_assets_inner();
    commit_certified_data();
}

/// Svuota mappa + albero **senza** ricommittare i certified data. Separato da `clear_assets`
/// così è testabile fuori dal canister (`set_certified_data` panica fuori dalla replica).
fn clear_assets_inner() {
    // StableBTreeMap non espone clear(): raccogli le chiavi e rimuovile una a una.
    let keys: Vec<AssetPath> = with_assets(|assets| assets.iter().map(|e| e.key().clone()).collect());
    with_assets_mut(|assets| {
        for k in &keys {
            assets.remove(k);
        }
    });
    CERT_TREE.with(|t| *t.borrow_mut() = HttpCertificationTree::default());
    CERT_MAP.with(|m| m.borrow_mut().clear());
}

// ─── Serve asset ────────────────────────────────────────────────────────────

/// Serve un asset con header certificati.
pub fn serve(path: &str) -> HttpResponse {
    with_assets(|assets| match assets.get(&AssetPath(path.to_string())) {
        Some(data) => HttpResponse {
            status_code: 200,
            headers: build_certified_headers(path, &data.content_type),
            body: data.content.clone(),
            upgrade: Some(false),
        },
        None => HttpResponse {
            status_code: 404,
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: b"Not Found".to_vec(),
            upgrade: Some(false),
        },
    })
}

// ─── HTTP routing ───────────────────────────────────────────────────────────

/// Risolve il path per SPA fallback.
pub fn resolve_path(url: &str) -> String {
    let path = url.split('?').next().unwrap_or("/");
    if path == "/" {
        "/index.html".to_string()
    } else if path.ends_with('/') {
        format!("{path}index.html")
    } else if !path.contains('.') {
        "/index.html".to_string()
    } else {
        path.to_string()
    }
}

/// Handler per http_request (query). Delega a update per SPA fallback.
pub fn http_request(req: &HttpRequest) -> HttpResponse {
    let original = req.url.split('?').next().unwrap_or("/");
    let resolved = resolve_path(&req.url);
    if original != resolved {
        return HttpResponse {
            status_code: 200,
            headers: vec![],
            body: vec![],
            upgrade: Some(true),
        };
    }
    serve(&resolved)
}

/// Handler per http_request_update (update). Usato per SPA fallback.
pub fn http_request_update(req: &HttpRequest) -> HttpResponse {
    serve(&resolve_path(&req.url))
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::memory_manager::MemoryId;

    fn setup() {
        let mm = core_storage::new_memory_manager();
        init_storage(mm.get(MemoryId::new(2)));
    }

    /// Upload senza certificazione — scrive direttamente nella mappa asset.
    /// In test, `ic_cdk::api::set_certified_data` non è disponibile.
    fn upload_nocert(path: &str, ct: &str, body: &[u8]) {
        with_assets_mut(|assets| {
            assets.insert(
                AssetPath(path.to_string()),
                AssetData {
                    content_type: ct.to_string(),
                    content: body.to_vec(),
                },
            );
        });
    }

    // ── resolve_path ──

    #[test]
    fn resolve_root_to_index() {
        assert_eq!(resolve_path("/"), "/index.html");
    }

    #[test]
    fn resolve_spa_route_to_index() {
        assert_eq!(resolve_path("/chats"), "/index.html");
        assert_eq!(resolve_path("/settings"), "/index.html");
    }

    #[test]
    fn resolve_file_unchanged() {
        assert_eq!(resolve_path("/index.html"), "/index.html");
        assert_eq!(resolve_path("/assets/app.js"), "/assets/app.js");
        assert_eq!(resolve_path("/style.css"), "/style.css");
    }

    #[test]
    fn resolve_trailing_slash_to_dir_index() {
        assert_eq!(resolve_path("/assets/"), "/assets/index.html");
        assert_eq!(resolve_path("/sub/path/"), "/sub/path/index.html");
    }

    #[test]
    fn resolve_strips_query_string() {
        assert_eq!(resolve_path("/app.js?v=123"), "/app.js");
        assert_eq!(resolve_path("/?foo=bar"), "/index.html");
    }

    // ── AssetPath / AssetData Storable ──

    #[test]
    fn asset_path_roundtrip() {
        let p = AssetPath("/test/file.js".to_string());
        let bytes = p.to_bytes();
        let p2 = AssetPath::from_bytes(bytes);
        assert_eq!(p, p2);
    }

    #[test]
    fn asset_data_roundtrip() {
        let d = AssetData {
            content_type: "text/html".to_string(),
            content: b"<h1>Hello</h1>".to_vec(),
        };
        let bytes = d.to_bytes();
        let d2 = AssetData::from_bytes(bytes);
        assert_eq!(d.content_type, d2.content_type);
        assert_eq!(d.content, d2.content);
    }

    // ── serve (senza cert) ──

    #[test]
    fn serve_not_found() {
        setup();
        let resp = serve("/nonexistent.js");
        assert_eq!(resp.status_code, 404);
    }

    #[test]
    fn serve_existing_asset() {
        setup();
        upload_nocert("/app.js", "application/javascript", b"console.log('hi')");

        let resp = serve("/app.js");
        assert_eq!(resp.status_code, 200);
        assert_eq!(resp.body, b"console.log('hi')");
        // Senza cert, serve solo content-type + cache-control
        assert!(resp.headers.iter().any(|(k, v)| k == "content-type" && v == "application/javascript"));
    }

    // ── http_request routing ──

    #[test]
    fn http_request_spa_fallback_triggers_upgrade() {
        setup();
        let req = HttpRequest {
            method: "GET".to_string(),
            url: "/chats".to_string(),
            headers: vec![],
            body: vec![],
        };
        let resp = http_request(&req);
        assert_eq!(resp.upgrade, Some(true));
    }

    #[test]
    fn http_request_file_served_directly() {
        setup();
        upload_nocert("/style.css", "text/css", b"body{}");

        let req = HttpRequest {
            method: "GET".to_string(),
            url: "/style.css".to_string(),
            headers: vec![],
            body: vec![],
        };
        let resp = http_request(&req);
        assert_eq!(resp.status_code, 200);
        assert_eq!(resp.body, b"body{}");
    }

    // ── clear_assets ──

    #[test]
    fn clear_assets_empties_the_map() {
        setup();
        upload_nocert("/index.html", "text/html", b"<old>");
        upload_nocert("/assets/old.js", "application/javascript", b"old");
        assert_eq!(serve("/index.html").status_code, 200);

        // clear_assets_inner: la variante senza commit (set_certified_data panica fuori dal canister).
        clear_assets_inner();

        assert_eq!(serve("/index.html").status_code, 404);
        assert_eq!(serve("/assets/old.js").status_code, 404);
        // Dopo il clear si può ricaricare un bundle nuovo senza file orfani.
        upload_nocert("/index.html", "text/html", b"<new>");
        let resp = serve("/index.html");
        assert_eq!(resp.status_code, 200);
        assert_eq!(resp.body, b"<new>");
    }

    #[test]
    fn http_request_update_serves_index() {
        setup();
        upload_nocert("/index.html", "text/html", b"<html>");

        let req = HttpRequest {
            method: "GET".to_string(),
            url: "/chats".to_string(),
            headers: vec![],
            body: vec![],
        };
        let resp = http_request_update(&req);
        assert_eq!(resp.status_code, 200);
        assert_eq!(resp.body, b"<html>");
    }
}
