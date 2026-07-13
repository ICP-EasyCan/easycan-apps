//! core-timer — timer consolidato per tutte le capability
//!
//! Invece di N timer separati (uno per capability), un singolo timer
//! chiama tutte le funzioni di cleanup registrate.
//! Risparmio: 66% rispetto a timer separati (vedi economics.md).
//!
//! Nessun #[update]/#[query] — il canister host chiama schedule() in init/post_upgrade.

use std::cell::RefCell;
use std::time::Duration;

/// Tipo della funzione di cleanup — chiamata ad ogni tick del timer.
pub type CleanupFn = Box<dyn Fn() + 'static>;

thread_local! {
    static CLEANUP_FNS: RefCell<Vec<CleanupFn>> = const { RefCell::new(Vec::new()) };
}

/// Registra una funzione di cleanup. Chiamata dalle capability al loro init.
///
/// ```rust,ignore
/// core_timer::register_cleanup(|| {
///     cap_presence::cleanup_stale();
/// });
/// ```
pub fn register_cleanup(f: impl Fn() + 'static) {
    CLEANUP_FNS.with(|fns| {
        fns.borrow_mut().push(Box::new(f));
    });
}

/// Avvia il timer consolidato. Chiamata dal canister host in init() e post_upgrade().
///
/// `interval` è l'intervallo tra un tick e l'altro (raccomandato: 120 secondi).
/// Ad ogni tick, tutte le funzioni di cleanup registrate vengono eseguite.
pub fn schedule(interval: Duration) {
    ic_cdk_timers::set_timer_interval(interval, || async {
        run_all_cleanups();
    });
}

/// Pulisce le funzioni registrate. Utile prima di ri-registrare in post_upgrade().
pub fn clear() {
    CLEANUP_FNS.with(|fns| {
        fns.borrow_mut().clear();
    });
}

/// Esegue tutte le funzioni di cleanup registrate.
/// Pubblico per permettere test e invocazione manuale (es. da un #[update] di debug).
pub fn run_all_cleanups() {
    CLEANUP_FNS.with(|fns| {
        for f in fns.borrow().iter() {
            f();
        }
    });
}

/// Ritorna il numero di funzioni di cleanup registrate.
pub fn cleanup_count() -> usize {
    CLEANUP_FNS.with(|fns| fns.borrow().len())
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // Thread-local come CLEANUP_FNS: libtest esegue i test su thread paralleli,
    // un contatore globale condiviso incrocia i conteggi tra test.
    thread_local! {
        static CALL_COUNT: Cell<u32> = const { Cell::new(0) };
    }

    fn count() -> u32 {
        CALL_COUNT.with(|c| c.get())
    }

    fn add(n: u32) {
        CALL_COUNT.with(|c| c.set(c.get() + n));
    }

    fn reset() {
        clear();
        CALL_COUNT.with(|c| c.set(0));
    }

    #[test]
    fn register_and_run() {
        reset();
        register_cleanup(|| add(1));
        assert_eq!(cleanup_count(), 1);

        run_all_cleanups();
        assert_eq!(count(), 1);

        run_all_cleanups();
        assert_eq!(count(), 2);
    }

    #[test]
    fn multiple_cleanups_all_called() {
        reset();
        register_cleanup(|| add(1));
        register_cleanup(|| add(10));
        register_cleanup(|| add(100));

        assert_eq!(cleanup_count(), 3);
        run_all_cleanups();
        assert_eq!(count(), 111);
    }

    #[test]
    fn clear_removes_all() {
        reset();
        register_cleanup(|| add(1));
        register_cleanup(|| add(1));
        assert_eq!(cleanup_count(), 2);

        clear();
        assert_eq!(cleanup_count(), 0);

        run_all_cleanups();
        assert_eq!(count(), 0);
    }

    #[test]
    fn run_empty_noop() {
        reset();
        run_all_cleanups(); // nessun panic
        assert_eq!(count(), 0);
    }
}
