//! cap-crud — storage CRUD generico per record namespace-based
//!
//! Ogni record appartiene a un namespace (stringa). Il canister è schema-agnostic:
//! salva blob binari (Vec<u8>), il frontend interpreta come JSON.
//!
//! Chiave indice: NsKey(namespace[64] | inv_timestamp[8] | id[8])
//! Layout fisso 80 bytes — range queries per namespace in O(log n + m).
//!
//! Endpoint: create_record, get_record, list_records, update_record, delete_record, count_records
//! Storage: 3 MemoryId (RECORDS + COUNTER + NS_INDEX)
//! Dipendenze: nessuna (auth nel canister host)

use candid::CandidType;
use core_storage::StableCounter;
use core_types::{EmptyMarker, Memory};
use ic_stable_structures::{storable::Bound, StableBTreeMap, Storable};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;

// ─── Configurazione ─────────────────────────────────────────────────────────

pub struct CrudConfig {
    pub max_record_bytes: usize,
    pub max_records_per_namespace: u64,
}

impl Default for CrudConfig {
    fn default() -> Self {
        Self {
            max_record_bytes: 4096,
            max_records_per_namespace: 10_000,
        }
    }
}

// ─── NsKey ──────────────────────────────────────────────────────────────────
//
// Layout: namespace (64 bytes, UTF-8 padded con zeri) | inv_timestamp (8 bytes BE) | id (8 bytes BE)
//
// inv_timestamp = u64::MAX - created_at → la BTree ordina per tempo decrescente.
// Questo permette list_records con paginazione offset/limit senza raccogliere e invertire.

const NS_MAX_BYTES: usize = 64;
const NS_KEY_SIZE: usize = NS_MAX_BYTES + 8 + 8; // 80

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct NsKey([u8; NS_KEY_SIZE]);

impl NsKey {
    fn new(namespace: &str, created_at: u64, id: u64) -> Self {
        let mut k = [0u8; NS_KEY_SIZE];
        let ns = namespace.as_bytes();
        let len = ns.len().min(NS_MAX_BYTES);
        k[..len].copy_from_slice(&ns[..len]);
        let inv_ts = u64::MAX - created_at;
        k[NS_MAX_BYTES..NS_MAX_BYTES + 8].copy_from_slice(&inv_ts.to_be_bytes());
        k[NS_MAX_BYTES + 8..].copy_from_slice(&id.to_be_bytes());
        Self(k)
    }

    /// Range inclusivo che copre tutti i record del namespace dato.
    fn range_for_ns(namespace: &str) -> (Self, Self) {
        let mut start = [0u8; NS_KEY_SIZE];
        let ns = namespace.as_bytes();
        let len = ns.len().min(NS_MAX_BYTES);
        start[..len].copy_from_slice(&ns[..len]);
        // start: inv_ts=0, id=0 → più recente possibile

        let mut end = [0u8; NS_KEY_SIZE];
        end[..len].copy_from_slice(&ns[..len]);
        end[NS_MAX_BYTES..].fill(0xFF);
        // end: inv_ts=MAX, id=MAX → più vecchio possibile

        (Self(start), Self(end))
    }

    fn id(&self) -> u64 {
        u64::from_be_bytes(self.0[NS_MAX_BYTES + 8..NS_KEY_SIZE].try_into().unwrap())
    }
}

impl Storable for NsKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut b = [0u8; NS_KEY_SIZE];
        b.copy_from_slice(&bytes);
        Self(b)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.0.to_vec()
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: NS_KEY_SIZE as u32,
        is_fixed_size: true,
    };
}

// ─── Tipi ───────────────────────────────────────────────────────────────────

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct CrudRecord {
    pub id: u64,
    pub namespace: String,
    pub data: Vec<u8>,
    pub created_at: u64,
    pub updated_at: u64,
}

core_types::storable_candid!(CrudRecord);

/// Input dal frontend — senza id e timestamp (assegnati dal backend).
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct CreateInput {
    pub namespace: String,
    pub data: Vec<u8>,
}

/// Input per update — sovrascrive data, aggiorna updated_at.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct UpdateInput {
    pub data: Vec<u8>,
}

/// Risultato paginato di list_records.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ListResult {
    pub records: Vec<CrudRecord>,
    pub total: u64,
}

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static RECORDS: RefCell<Option<StableBTreeMap<u64, CrudRecord, Memory>>> =
        const { RefCell::new(None) };

    static NS_INDEX: RefCell<Option<StableBTreeMap<NsKey, EmptyMarker, Memory>>> =
        const { RefCell::new(None) };

    static COUNTER: RefCell<Option<StableCounter>> = const { RefCell::new(None) };

    static CONFIG: RefCell<CrudConfig> = RefCell::new(CrudConfig::default());
}

// ─── Init ───────────────────────────────────────────────────────────────────

pub fn init_storage(records_mem: Memory, counter_mem: Memory, ns_index_mem: Memory) {
    RECORDS.with(|r| {
        *r.borrow_mut() = Some(StableBTreeMap::init(records_mem));
    });
    COUNTER.with(|c| {
        *c.borrow_mut() = Some(StableCounter::new(counter_mem));
    });
    NS_INDEX.with(|n| {
        *n.borrow_mut() = Some(StableBTreeMap::init(ns_index_mem));
    });
}

pub fn configure(config: CrudConfig) {
    CONFIG.with(|c| *c.borrow_mut() = config);
}

fn with_records<R>(f: impl FnOnce(&StableBTreeMap<u64, CrudRecord, Memory>) -> R) -> R {
    RECORDS.with(|r| {
        let borrow = r.borrow();
        f(borrow
            .as_ref()
            .expect("cap-crud: init_storage() not called"))
    })
}

fn with_records_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<u64, CrudRecord, Memory>) -> R,
) -> R {
    RECORDS.with(|r| {
        let mut borrow = r.borrow_mut();
        f(borrow
            .as_mut()
            .expect("cap-crud: init_storage() not called"))
    })
}

fn with_ns_index<R>(f: impl FnOnce(&StableBTreeMap<NsKey, EmptyMarker, Memory>) -> R) -> R {
    NS_INDEX.with(|n| {
        let borrow = n.borrow();
        f(borrow
            .as_ref()
            .expect("cap-crud: init_storage() not called"))
    })
}

fn with_ns_index_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<NsKey, EmptyMarker, Memory>) -> R,
) -> R {
    NS_INDEX.with(|n| {
        let mut borrow = n.borrow_mut();
        f(borrow
            .as_mut()
            .expect("cap-crud: init_storage() not called"))
    })
}

fn next_id() -> u64 {
    COUNTER.with(|c| {
        c.borrow()
            .as_ref()
            .expect("cap-crud: init_storage() not called")
            .next_id()
    })
}

#[cfg(not(test))]
fn now() -> u64 {
    ic_cdk::api::time()
}

#[cfg(test)]
fn now() -> u64 {
    TEST_TIME.with(|t| *t.borrow())
}

#[cfg(test)]
thread_local! {
    static TEST_TIME: RefCell<u64> = const { RefCell::new(0) };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// O(log n + m) — range scan sull'indice, non O(max_id).
fn count_in_namespace(namespace: &str) -> u64 {
    let (start, end) = NsKey::range_for_ns(namespace);
    with_ns_index(|idx| idx.range(start..=end).count() as u64)
}

// ─── Funzioni pubbliche ─────────────────────────────────────────────────────

/// Crea un nuovo record nel namespace specificato.
/// Il canister host deve verificare require_owner_or_user prima di chiamare.
pub fn create_record(input: CreateInput) -> Result<CrudRecord, String> {
    let (max_bytes, max_per_ns) = CONFIG.with(|c| {
        let cfg = c.borrow();
        (cfg.max_record_bytes, cfg.max_records_per_namespace)
    });

    if input.data.len() > max_bytes {
        return Err(format!("Record too large: max {max_bytes} bytes"));
    }

    if input.namespace.is_empty() || input.namespace.len() > 64 {
        return Err("Namespace must be 1-64 characters".to_string());
    }

    let count = count_in_namespace(&input.namespace);
    if count >= max_per_ns {
        return Err(format!(
            "Too many records in namespace '{}': max {max_per_ns}",
            input.namespace
        ));
    }

    let now = now();
    let id = next_id();
    let record = CrudRecord {
        id,
        namespace: input.namespace,
        data: input.data,
        created_at: now,
        updated_at: now,
    };

    let ns_key = NsKey::new(&record.namespace, now, id);
    with_records_mut(|records| {
        records.insert(id, record.clone());
    });
    with_ns_index_mut(|idx| {
        idx.insert(ns_key, EmptyMarker);
    });

    Ok(record)
}

/// Recupera un record per ID.
pub fn get_record(id: u64) -> Option<CrudRecord> {
    with_records(|records| records.get(&id))
}

/// Lista paginata dei record in un namespace, ordinati per created_at desc.
/// O(log n + m) — range scan sull'indice.
pub fn list_records(namespace: &str, offset: u64, limit: u64) -> ListResult {
    let (start, end) = NsKey::range_for_ns(namespace);

    // Raccogli chiavi dall'indice (già ordinate desc per timestamp)
    let (total, ids) = with_ns_index(|idx| {
        let keys: Vec<NsKey> = idx.range(start..=end)
            .map(|e| e.key().clone())
            .collect();
        let total = keys.len() as u64;
        let ids: Vec<u64> = keys.into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .map(|k| k.id())
            .collect();
        (total, ids)
    });

    let records = with_records(|records| {
        ids.iter().filter_map(|id| records.get(id)).collect()
    });

    ListResult { records, total }
}

/// Aggiorna i dati di un record esistente.
/// Il canister host deve verificare require_owner_or_user prima di chiamare.
pub fn update_record(id: u64, input: UpdateInput) -> Result<CrudRecord, String> {
    let max_bytes = CONFIG.with(|c| c.borrow().max_record_bytes);

    if input.data.len() > max_bytes {
        return Err(format!("Record too large: max {max_bytes} bytes"));
    }

    let mut record = with_records(|records| records.get(&id))
        .ok_or_else(|| format!("Record {id} not found"))?;

    record.data = input.data;
    record.updated_at = now();

    with_records_mut(|records| {
        records.insert(id, record.clone());
    });

    Ok(record)
}

/// Elimina un record per ID.
/// Il canister host deve verificare require_owner_or_user prima di chiamare.
pub fn delete_record(id: u64) -> Result<(), String> {
    let record = with_records(|records| records.get(&id))
        .ok_or_else(|| format!("Record {id} not found"))?;

    let ns_key = NsKey::new(&record.namespace, record.created_at, id);
    with_records_mut(|records| {
        records.remove(&id);
    });
    with_ns_index_mut(|idx| {
        idx.remove(&ns_key);
    });

    Ok(())
}

/// Conta i record in un namespace.
/// O(log n + m) — range scan sull'indice.
pub fn count_records(namespace: &str) -> u64 {
    count_in_namespace(namespace)
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::memory_manager::MemoryId;

    fn setup() {
        let mm = core_storage::new_memory_manager();
        init_storage(
            mm.get(MemoryId::new(70)),
            mm.get(MemoryId::new(71)),
            mm.get(MemoryId::new(72)),
        );
    }

    fn input(ns: &str, data: &[u8]) -> CreateInput {
        CreateInput {
            namespace: ns.to_string(),
            data: data.to_vec(),
        }
    }

    #[test]
    fn create_and_get() {
        setup();
        let rec = create_record(input("notes", b"hello")).unwrap();
        assert_eq!(rec.namespace, "notes");
        assert_eq!(rec.data, b"hello");

        let fetched = get_record(rec.id).unwrap();
        assert_eq!(fetched.id, rec.id);
        assert_eq!(fetched.data, b"hello");
    }

    #[test]
    fn count_per_namespace() {
        setup();
        create_record(input("notes", b"a")).unwrap();
        create_record(input("notes", b"b")).unwrap();
        create_record(input("tasks", b"c")).unwrap();

        assert_eq!(count_records("notes"), 2);
        assert_eq!(count_records("tasks"), 1);
        assert_eq!(count_records("empty"), 0);
    }

    #[test]
    fn list_records_desc_order_same_ts() {
        setup();
        // Timestamp identici → ordinamento secondario per id crescente
        let r1 = create_record(input("ns", b"first")).unwrap();
        let r2 = create_record(input("ns", b"second")).unwrap();
        let r3 = create_record(input("ns", b"third")).unwrap();

        let result = list_records("ns", 0, 10);
        assert_eq!(result.total, 3);
        assert_eq!(result.records[0].id, r1.id);
        assert_eq!(result.records[1].id, r2.id);
        assert_eq!(result.records[2].id, r3.id);
    }

    #[test]
    fn list_records_desc_order_diff_ts() {
        setup();
        // Timestamp diversi → il più recente prima
        TEST_TIME.with(|t| *t.borrow_mut() = 100);
        let r_old = create_record(input("ts", b"old")).unwrap();
        TEST_TIME.with(|t| *t.borrow_mut() = 300);
        let r_new = create_record(input("ts", b"new")).unwrap();
        TEST_TIME.with(|t| *t.borrow_mut() = 200);
        let r_mid = create_record(input("ts", b"mid")).unwrap();

        let result = list_records("ts", 0, 10);
        assert_eq!(result.total, 3);
        // Desc: new (300) → mid (200) → old (100)
        assert_eq!(result.records[0].id, r_new.id);
        assert_eq!(result.records[1].id, r_mid.id);
        assert_eq!(result.records[2].id, r_old.id);
    }

    #[test]
    fn list_records_pagination() {
        setup();
        for i in 0..5u8 {
            create_record(input("pg", &[i])).unwrap();
        }

        let page1 = list_records("pg", 0, 2);
        assert_eq!(page1.total, 5);
        assert_eq!(page1.records.len(), 2);

        let page2 = list_records("pg", 2, 2);
        assert_eq!(page2.total, 5);
        assert_eq!(page2.records.len(), 2);

        let page3 = list_records("pg", 4, 2);
        assert_eq!(page3.total, 5);
        assert_eq!(page3.records.len(), 1);
    }

    #[test]
    fn namespace_isolation() {
        setup();
        create_record(input("alpha", b"a1")).unwrap();
        create_record(input("alpha", b"a2")).unwrap();
        create_record(input("beta", b"b1")).unwrap();

        let alpha = list_records("alpha", 0, 100);
        let beta = list_records("beta", 0, 100);
        assert_eq!(alpha.total, 2);
        assert_eq!(beta.total, 1);
        assert!(alpha.records.iter().all(|r| r.namespace == "alpha"));
        assert!(beta.records.iter().all(|r| r.namespace == "beta"));
    }

    #[test]
    fn delete_removes_from_index() {
        setup();
        let rec = create_record(input("del", b"data")).unwrap();
        assert_eq!(count_records("del"), 1);

        delete_record(rec.id).unwrap();
        assert_eq!(count_records("del"), 0);
        assert!(get_record(rec.id).is_none());
    }

    #[test]
    fn delete_not_found() {
        setup();
        let result = delete_record(999);
        assert!(result.is_err());
    }

    #[test]
    fn update_preserves_index() {
        setup();
        let rec = create_record(input("upd", b"v1")).unwrap();
        let updated = update_record(rec.id, UpdateInput { data: b"v2".to_vec() }).unwrap();
        assert_eq!(updated.data, b"v2");
        assert_eq!(count_records("upd"), 1);

        let fetched = get_record(rec.id).unwrap();
        assert_eq!(fetched.data, b"v2");
    }

    #[test]
    fn update_not_found() {
        setup();
        let result = update_record(999, UpdateInput { data: b"x".to_vec() });
        assert!(result.is_err());
    }

    #[test]
    fn validation_namespace_length() {
        setup();
        // Vuoto
        let r1 = create_record(input("", b"data"));
        assert!(r1.is_err());

        // Troppo lungo (65 char)
        let long_ns = "a".repeat(65);
        let r2 = create_record(input(&long_ns, b"data"));
        assert!(r2.is_err());

        // Limite esatto (64 char)
        let exact_ns = "a".repeat(64);
        let r3 = create_record(input(&exact_ns, b"data"));
        assert!(r3.is_ok());
    }

    #[test]
    fn validation_record_size() {
        setup();
        configure(CrudConfig {
            max_record_bytes: 10,
            max_records_per_namespace: 100,
        });
        let r = create_record(input("ns", &[0u8; 11]));
        assert!(r.is_err());
    }

    #[test]
    fn validation_max_per_namespace() {
        setup();
        configure(CrudConfig {
            max_record_bytes: 4096,
            max_records_per_namespace: 2,
        });
        create_record(input("lim", b"1")).unwrap();
        create_record(input("lim", b"2")).unwrap();
        let r3 = create_record(input("lim", b"3"));
        assert!(r3.is_err());

        // Altro namespace non è limitato
        let r_other = create_record(input("other", b"ok"));
        assert!(r_other.is_ok());
    }

    #[test]
    fn ns_key_range_no_overlap() {
        let (_, alpha_end) = NsKey::range_for_ns("alpha");
        let (beta_start, _) = NsKey::range_for_ns("beta");
        assert!(beta_start > alpha_end);
    }
}
