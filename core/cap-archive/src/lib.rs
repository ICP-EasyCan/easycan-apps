//! cap-archive — cronologia messaggi persistente
//!
//! L'owner salva i messaggi (inviati e ricevuti) nel proprio canister.
//! localStorage è la cache locale, il canister è la fonte di verità.
//!
//! Chiave: ArchiveKey(peer[29 bytes] | timestamp_be[8 bytes] | from_me[1 byte])
//! Layout fisso 38 bytes — consente range queries per peer in O(log n + m)
//! invece di O(n_totale). Dedup via contains_key O(log n).
//!
//! Endpoint: archive_messages, get_archived_messages, set_chat_persistent,
//!           is_chat_persistent, get_all_persistent_chats
//! Storage: 3 MemoryId (ARCHIVE + COUNTER + PERSIST_FLAGS)
//! Dipendenze: core-auth (require_owner_or_user)

use candid::{CandidType, Principal};
use core_storage::StableCounter;
use core_types::{Memory, StorablePrincipal};
use ic_stable_structures::{storable::Bound, StableBTreeMap, Storable};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashSet;

// ─── Configurazione ─────────────────────────────────────────────────────────

pub struct ArchiveConfig {
    pub max_messages_per_peer: u64,
    pub max_payload_bytes: usize,
    pub max_batch_size: usize,
}

impl Default for ArchiveConfig {
    fn default() -> Self {
        Self {
            max_messages_per_peer: 1000,
            max_payload_bytes: 512,
            max_batch_size: 100,
        }
    }
}

// ─── ArchiveKey ─────────────────────────────────────────────────────────────
//
// Layout: peer (29 bytes, little-endian padded) | timestamp (8 bytes, big-endian) | from_me (1 byte)
//
// Ordinamento nella StableBTreeMap: prima per peer, poi per timestamp crescente.
// Questo permette di recuperare tutti i messaggi di un peer con un range scan O(m).
//
// Perché big-endian per timestamp: StableBTreeMap ordina per bytes — big-endian
// mappa l'ordinamento numerico su quello lessicografico dei bytes.
//
// Perché padding a 29 bytes per peer: Principal può essere 1-29 bytes.
// Padding con zeri → nessun overlap tra peer diversi nel range scan (dimostrazione:
// due principal diversi non condividono mai il prefisso perché la struttura del
// Principal include un checksum e la lunghezza è implicita nel pattern di bits).

const PRINCIPAL_MAX_BYTES: usize = 29;
const KEY_SIZE: usize = PRINCIPAL_MAX_BYTES + 8 + 1; // 38

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ArchiveKey([u8; KEY_SIZE]);

impl ArchiveKey {
    fn new(peer: Principal, timestamp: u64, from_me: bool) -> Self {
        let mut k = [0u8; KEY_SIZE];
        let pb = peer.as_slice();
        k[..pb.len()].copy_from_slice(pb);
        k[PRINCIPAL_MAX_BYTES..PRINCIPAL_MAX_BYTES + 8]
            .copy_from_slice(&timestamp.to_be_bytes());
        k[KEY_SIZE - 1] = from_me as u8;
        Self(k)
    }

    /// Range inclusivo che copre tutti i messaggi del peer dato.
    fn range_for_peer(peer: Principal) -> (Self, Self) {
        // start: peer padded | timestamp=0 | from_me=0  (minimo per questo peer)
        let start = Self::new(peer, 0, false);
        // end:   peer padded | timestamp=MAX | from_me=MAX  (massimo per questo peer)
        let mut end_bytes = [0u8; KEY_SIZE];
        let pb = peer.as_slice();
        end_bytes[..pb.len()].copy_from_slice(pb);
        end_bytes[PRINCIPAL_MAX_BYTES..].fill(0xFF);
        (start, Self(end_bytes))
    }
}

impl Storable for ArchiveKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut b = [0u8; KEY_SIZE];
        b.copy_from_slice(&bytes);
        Self(b)
    }
    fn into_bytes(self) -> Vec<u8> {
        self.0.to_vec()
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: KEY_SIZE as u32,
        is_fixed_size: true,
    };
}

// ─── Tipi ───────────────────────────────────────────────────────────────────

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ArchivedMessage {
    pub id: u64,
    pub peer: Principal,
    pub from_me: bool,
    pub payload: Vec<u8>,
    pub timestamp: u64,
}

core_types::storable_candid!(ArchivedMessage);

/// Input dal frontend — senza id (assegnato dal backend).
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct ArchiveInput {
    pub from_me: bool,
    pub payload: Vec<u8>,
    pub timestamp: u64,
}

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static ARCHIVE: RefCell<Option<StableBTreeMap<ArchiveKey, ArchivedMessage, Memory>>> =
        const { RefCell::new(None) };

    static COUNTER: RefCell<Option<StableCounter>> = const { RefCell::new(None) };

    static PERSIST_FLAGS: RefCell<Option<StableBTreeMap<StorablePrincipal, u8, Memory>>> =
        const { RefCell::new(None) };

    static CONFIG: RefCell<ArchiveConfig> = RefCell::new(ArchiveConfig::default());
}

// ─── Init ───────────────────────────────────────────────────────────────────

pub fn init_storage(archive_mem: Memory, counter_mem: Memory, persist_flags_mem: Memory) {
    ARCHIVE.with(|a| {
        *a.borrow_mut() = Some(StableBTreeMap::init(archive_mem));
    });
    COUNTER.with(|c| {
        *c.borrow_mut() = Some(StableCounter::new(counter_mem));
    });
    PERSIST_FLAGS.with(|p| {
        *p.borrow_mut() = Some(StableBTreeMap::init(persist_flags_mem));
    });
}

pub fn configure(config: ArchiveConfig) {
    CONFIG.with(|c| *c.borrow_mut() = config);
}

fn with_archive<R>(f: impl FnOnce(&StableBTreeMap<ArchiveKey, ArchivedMessage, Memory>) -> R) -> R {
    ARCHIVE.with(|a| {
        let borrow = a.borrow();
        f(borrow
            .as_ref()
            .expect("cap-archive: init_storage() not called"))
    })
}

fn with_archive_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<ArchiveKey, ArchivedMessage, Memory>) -> R,
) -> R {
    ARCHIVE.with(|a| {
        let mut borrow = a.borrow_mut();
        f(borrow
            .as_mut()
            .expect("cap-archive: init_storage() not called"))
    })
}

fn next_id() -> u64 {
    COUNTER.with(|c| {
        c.borrow()
            .as_ref()
            .expect("cap-archive: init_storage() not called")
            .next_id()
    })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// O(m) — range scan per peer, non O(n_totale).
fn count_for_peer(peer: Principal) -> u64 {
    let (start, end) = ArchiveKey::range_for_peer(peer);
    with_archive(|a| a.range(start..=end).count() as u64)
}

/// O(log n) — lookup diretto per chiave composta.
fn has_duplicate(peer: Principal, from_me: bool, timestamp: u64) -> bool {
    let key = ArchiveKey::new(peer, timestamp, from_me);
    with_archive(|a| a.contains_key(&key))
}

// ─── Funzioni pubbliche ─────────────────────────────────────────────────────

/// Archivia un batch di messaggi per un peer.
/// Il canister host deve verificare require_owner_or_user.
pub fn archive_messages(peer: Principal, messages: Vec<ArchiveInput>) -> Result<u64, String> {
    let (max_batch, max_payload, max_per_peer) = CONFIG.with(|c| {
        let cfg = c.borrow();
        (cfg.max_batch_size, cfg.max_payload_bytes, cfg.max_messages_per_peer)
    });

    if messages.len() > max_batch {
        return Err(format!("Batch too large: max {max_batch} messages"));
    }

    for msg in &messages {
        if msg.payload.len() > max_payload {
            return Err(format!("Payload too large: max {max_payload} bytes"));
        }
    }

    // Ring buffer, strategia insert-then-trim: teniamo al massimo max_per_peer
    // messaggi per peer, preferendo i più recenti.
    //
    // 1) Dedup: scartiamo i messaggi la cui chiave (peer+timestamp+from_me) è già
    //    in store (preserva l'esistente) o già vista in questo stesso batch (evita
    //    che due "gemelli" si sovrascrivano e vengano contati due volte).
    // 2) Inseriamo TUTTI i nuovi, POI tagliamo i più vecchi del peer finché non si
    //    rientra nel cap. Inserire-prima-di-tagliare è ciò che rende corretto il
    //    "tieni i recenti": le chiavi sono ordinate per timestamp big-endian, quindi
    //    il "più vecchio" è sempre il primo del range — se un arrivo fosse più vecchio
    //    di tutti, sarebbe LUI a cadere per primo, senza sacrificare un recente.
    // Sostituisce il vecchio comportamento che scartava in silenzio i nuovi tenendo
    // i 1000 più vecchi.
    let mut seen: HashSet<(bool, u64)> = HashSet::new();
    let to_insert: Vec<ArchiveInput> = messages
        .into_iter()
        .filter(|m| !has_duplicate(peer, m.from_me, m.timestamp) && seen.insert((m.from_me, m.timestamp)))
        .collect();

    if to_insert.is_empty() {
        return Ok(0);
    }

    // Inserisci tutti i nuovi (chiavi distinte per costruzione), tenendo traccia
    // delle chiavi per contare a valle quanti sopravvivono al trim.
    let mut new_keys: Vec<ArchiveKey> = Vec::with_capacity(to_insert.len());
    for msg in to_insert {
        let id = next_id();
        let key = ArchiveKey::new(peer, msg.timestamp, msg.from_me);
        new_keys.push(key.clone());
        with_archive_mut(|a| {
            a.insert(
                key,
                ArchivedMessage {
                    id,
                    peer,
                    from_me: msg.from_me,
                    payload: msg.payload,
                    timestamp: msg.timestamp,
                },
            );
        });
    }

    // Trim al cap: rimuovi le entry più vecchie del peer eccedenti.
    let count_now = count_for_peer(peer);
    if count_now > max_per_peer {
        let to_evict = count_now - max_per_peer;
        let (start, end) = ArchiveKey::range_for_peer(peer);
        let oldest: Vec<ArchiveKey> = with_archive(|a| {
            a.range(start..=end)
                .take(to_evict as usize)
                .map(|e| e.key().clone())
                .collect()
        });
        with_archive_mut(|a| {
            for k in oldest {
                a.remove(&k);
            }
        });
    }

    // Ritorna quanti dei messaggi NUOVI sono davvero rimasti archiviati dopo il trim
    // (un arrivo più vecchio del cap può essere stato tagliato subito → non conta).
    let survived = with_archive(|a| new_keys.iter().filter(|k| a.contains_key(k)).count()) as u64;
    Ok(survived)
}

/// Recupera i messaggi archiviati per un peer, ordinati per timestamp.
/// O(m) — range scan, già ordinati per chiave (timestamp big-endian).
pub fn get_archived_messages(peer: Principal) -> Vec<ArchivedMessage> {
    let (start, end) = ArchiveKey::range_for_peer(peer);
    with_archive(|a| {
        // Raccoglie prima le chiavi (iter su LazyEntry usa .key()), poi recupera i valori.
        let keys: Vec<ArchiveKey> = a.range(start..=end).map(|e| e.key().clone()).collect();
        keys.into_iter().filter_map(|k| a.get(&k)).collect()
    })
}

/// Cancella un singolo messaggio archiviato per `peer` (identificato per `id`).
/// O(m) — range scan nel range del peer (cap max_messages_per_peer), niente indice per id.
pub fn delete_archived_message(peer: Principal, id: u64) -> Result<(), String> {
    let (start, end) = ArchiveKey::range_for_peer(peer);
    let key = with_archive(|a| {
        a.range(start..=end)
            .find(|e| e.value().id == id)
            .map(|e| e.key().clone())
    });
    match key {
        Some(k) => {
            with_archive_mut(|a| a.remove(&k));
            Ok(())
        }
        None => Err("not found".to_string()),
    }
}

/// Attiva/disattiva la persistenza per una chat.
pub fn set_chat_persistent(peer: Principal, persistent: bool) {
    PERSIST_FLAGS.with(|p| {
        let mut borrow = p.borrow_mut();
        let map = borrow
            .as_mut()
            .expect("cap-archive: init_storage() not called");
        if persistent {
            map.insert(StorablePrincipal(peer), 1u8);
        } else {
            map.remove(&StorablePrincipal(peer));
        }
    });
}

/// Controlla se una chat è persistente.
pub fn is_chat_persistent(peer: Principal) -> bool {
    PERSIST_FLAGS.with(|p| {
        let borrow = p.borrow();
        let map = borrow
            .as_ref()
            .expect("cap-archive: init_storage() not called");
        map.contains_key(&StorablePrincipal(peer))
    })
}

/// Lista di tutte le chat con persistenza attiva.
pub fn get_all_persistent_chats() -> Vec<Principal> {
    PERSIST_FLAGS.with(|p| {
        let borrow = p.borrow();
        let map = borrow
            .as_ref()
            .expect("cap-archive: init_storage() not called");
        let mut result = Vec::new();
        for entry in map.iter() {
            result.push(entry.key().0);
            if result.len() >= 200 {
                break;
            }
        }
        result
    })
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::memory_manager::MemoryId;

    fn setup() {
        let mm = core_storage::new_memory_manager();
        init_storage(
            mm.get(MemoryId::new(50)),
            mm.get(MemoryId::new(51)),
            mm.get(MemoryId::new(52)),
        );
    }

    fn p(id: u8) -> Principal {
        Principal::from_slice(&[id])
    }

    fn msg(from_me: bool, timestamp: u64) -> ArchiveInput {
        ArchiveInput {
            from_me,
            payload: b"ciao".to_vec(),
            timestamp,
        }
    }

    #[test]
    fn archive_and_retrieve() {
        setup();
        let peer = p(1);
        let result = archive_messages(peer, vec![msg(true, 100), msg(false, 200)]).unwrap();
        assert_eq!(result, 2);

        let msgs = get_archived_messages(peer);
        assert_eq!(msgs.len(), 2);
        // Già ordinati per timestamp (chiave big-endian)
        assert_eq!(msgs[0].timestamp, 100);
        assert_eq!(msgs[1].timestamp, 200);
    }

    #[test]
    fn dedup_idempotente() {
        setup();
        let peer = p(2);
        archive_messages(peer, vec![msg(true, 100)]).unwrap();
        // Stesso messaggio due volte
        let result = archive_messages(peer, vec![msg(true, 100)]).unwrap();
        assert_eq!(result, 0);
        assert_eq!(get_archived_messages(peer).len(), 1);
    }

    #[test]
    fn isolamento_tra_peer() {
        setup();
        let alice = p(3);
        let bob = p(4);
        archive_messages(alice, vec![msg(true, 1), msg(true, 2)]).unwrap();
        archive_messages(bob, vec![msg(true, 10)]).unwrap();

        assert_eq!(get_archived_messages(alice).len(), 2);
        assert_eq!(get_archived_messages(bob).len(), 1);
        assert_eq!(count_for_peer(alice), 2);
        assert_eq!(count_for_peer(bob), 1);
    }

    #[test]
    fn archive_key_range_non_si_sovrappone() {
        // Verifica che il range di un peer non includa messaggi di un altro peer
        let alice = p(5);
        let bob = p(6);
        let (_alice_start, alice_end) = ArchiveKey::range_for_peer(alice);
        let bob_key = ArchiveKey::new(bob, 0, false);
        // Il messaggio di bob NON deve cadere nel range di alice
        assert!(bob_key > alice_end);
    }

    #[test]
    fn ring_buffer_evicts_oldest_keeps_recent() {
        setup();
        let peer = p(20);
        // Riempi fino al cap (default 1000) con timestamp crescenti 1..=1000.
        // Batch da 100 (max_batch_size) per volta.
        for base in (1..=1000u64).step_by(100) {
            let batch: Vec<ArchiveInput> = (base..base + 100).map(|t| msg(true, t)).collect();
            archive_messages(peer, batch).unwrap();
        }
        assert_eq!(count_for_peer(peer), 1000);

        // Inserisci 50 messaggi NUOVI (timestamp 1001..=1050): devono entrare
        // evincendo i 50 più vecchi (timestamp 1..=50).
        let newer: Vec<ArchiveInput> = (1001..=1050u64).map(|t| msg(true, t)).collect();
        let inserted = archive_messages(peer, newer).unwrap();
        assert_eq!(inserted, 50);

        // Cap invariato.
        assert_eq!(count_for_peer(peer), 1000);

        let msgs = get_archived_messages(peer);
        // I più vecchi (1..=50) sono stati evinti; il minimo ora è 51.
        assert_eq!(msgs.first().unwrap().timestamp, 51);
        // I più recenti sono sopravvissuti.
        assert_eq!(msgs.last().unwrap().timestamp, 1050);
    }

    #[test]
    fn ring_buffer_batch_maggiore_del_cap_tiene_i_recenti() {
        setup();
        let peer = p(21);
        // Config con cap piccolo per esercitare il ramo "batch > max_per_peer".
        configure(ArchiveConfig {
            max_messages_per_peer: 10,
            max_payload_bytes: 512,
            max_batch_size: 100,
        });
        let batch: Vec<ArchiveInput> = (1..=100u64).map(|t| msg(true, t)).collect();
        let inserted = archive_messages(peer, batch).unwrap();
        assert_eq!(inserted, 10);
        let msgs = get_archived_messages(peer);
        assert_eq!(msgs.len(), 10);
        // Sopravvivono i 10 più recenti: timestamp 91..=100.
        assert_eq!(msgs.first().unwrap().timestamp, 91);
        assert_eq!(msgs.last().unwrap().timestamp, 100);
        // Ripristina il default per non contaminare altri test (CONFIG è thread_local).
        configure(ArchiveConfig::default());
    }

    #[test]
    fn ring_buffer_dedup_intra_batch_niente_sovra_evict() {
        // Due "gemelli" (stessa chiave from_me+timestamp) nello stesso batch NON
        // devono contare doppio: si inserisce una sola entry e si evince UN solo
        // vecchio, non due. (Fix caveat 1: dedup intra-batch + insert-then-trim.)
        setup();
        let peer = p(22);
        configure(ArchiveConfig {
            max_messages_per_peer: 5,
            max_payload_bytes: 512,
            max_batch_size: 100,
        });
        // Riempi a 5 (ts 1..=5).
        let fill: Vec<ArchiveInput> = (1..=5u64).map(|t| msg(true, t)).collect();
        assert_eq!(archive_messages(peer, fill).unwrap(), 5);
        assert_eq!(count_for_peer(peer), 5);

        // Batch con due gemelli (ts 10) + un terzo distinto (ts 11).
        let batch = vec![msg(true, 10), msg(true, 10), msg(true, 11)];
        let inserted = archive_messages(peer, batch).unwrap();
        // Solo 2 chiavi distinte sopravvivono, non 3.
        assert_eq!(inserted, 2);
        // Cap invariato: evinti esattamente 2 vecchi (ts 1,2), NON 3.
        assert_eq!(count_for_peer(peer), 5);
        let timestamps: Vec<u64> = get_archived_messages(peer).iter().map(|m| m.timestamp).collect();
        assert_eq!(timestamps, vec![3, 4, 5, 10, 11]);
        configure(ArchiveConfig::default());
    }

    #[test]
    fn ring_buffer_arrivo_piu_vecchio_non_evince_i_recenti() {
        // A coda piena, un messaggio più VECCHIO di tutti non deve entrare a scapito
        // dei recenti: dev'essere lui stesso a cadere nel trim. (Fix caveat 2:
        // insert-then-trim taglia sempre il timestamp più basso, che ora è l'arrivo.)
        setup();
        let peer = p(23);
        configure(ArchiveConfig {
            max_messages_per_peer: 3,
            max_payload_bytes: 512,
            max_batch_size: 100,
        });
        for t in 100..=102u64 {
            archive_messages(peer, vec![msg(true, t)]).unwrap();
        }
        assert_eq!(count_for_peer(peer), 3);

        // Arriva un ts 50 (più vecchio di tutti) a coda piena.
        let inserted = archive_messages(peer, vec![msg(true, 50)]).unwrap();
        // Non è sopravvissuto: 0 nuovi archiviati.
        assert_eq!(inserted, 0);
        assert_eq!(count_for_peer(peer), 3);
        let timestamps: Vec<u64> = get_archived_messages(peer).iter().map(|m| m.timestamp).collect();
        // I tre recenti sopravvivono; il 50 non c'è.
        assert_eq!(timestamps, vec![100, 101, 102]);
        configure(ArchiveConfig::default());
    }

    #[test]
    fn persist_flag_set_unset() {
        setup();
        let peer = p(7);
        assert!(!is_chat_persistent(peer));
        set_chat_persistent(peer, true);
        assert!(is_chat_persistent(peer));
        set_chat_persistent(peer, false);
        assert!(!is_chat_persistent(peer));
    }

    #[test]
    fn get_all_persistent_chats_lista() {
        setup();
        let a = p(8);
        let b = p(9);
        set_chat_persistent(a, true);
        set_chat_persistent(b, true);
        let chats = get_all_persistent_chats();
        assert!(chats.contains(&a));
        assert!(chats.contains(&b));
    }
}
