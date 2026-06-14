/**
 * capabilities/sovereignty/index.js — L4: builder UI condiviso della sovranità.
 *
 * Generalizza i vecchi `eject.js` + `controllers.js` del vault in UN builder
 * app-agnostico, riusabile da ogni app marketplace. Produce le sezioni Platform
 * e Controllers pronte per `extraSections` di `renderSettings`
 * (`@shared/capabilities/settings/index.js`).
 *
 *   import { buildSovereigntySections } from '@shared/capabilities/sovereignty/index.js';
 *
 *   const sections = buildSovereigntySections({
 *     meta,          // risultato grezzo di platform_metadata (o null)
 *     controllers,   // Principal[] da canister_status (o [] se status non disponibile)
 *     appAdmin,      // Principal | null — platform_get_admin
 *     myPrincipal,   // Principal | null — identità dell'utente (per etichettare i controller)
 *     mgmtError,     // string | null — errore di fetch dei controller
 *     canisterId,    // string — canister target, INIETTATO (mai importato da config)
 *   });
 *   // → [{ title, content }] da spreddare in extraSections
 *
 * ── Contratto con l'host (dipendenze implicite) ──────────────────────────────
 *  1. CSS: l'host DEVE caricare `@shared/styles/base.css`, che definisce le
 *     classi usate qui: `.settings-*`, `.modal-*`, `.btn-*`, `.controllers-list`,
 *     `.ctrl-*`. Senza base.css le sezioni rendono senza stile.
 *  2. DOM: usa `el` da `@shared/ui/dom.js`.
 *  3. Aggiornamento post-mutazione: se l'host passa `onChanged`, dopo ogni
 *     mutazione riuscita il builder la invoca (rifetch + re-render in-place) al
 *     posto del reload. Senza `onChanged` il fallback è `window.location.reload()`
 *     (presuppone un host con hash-router che ricostruisce la pagina settings da
 *     zero rifacendo fetch+builder). Cfr. `page.js::mountSovereigntyPage`.
 *  4. `canisterId`, `myPrincipal`, `appAdmin` sono INIETTATI dal chiamante: il
 *     builder non importa `config.js` né `auth.js` → resta app-agnostico.
 *
 * ── Frugalità cicli ──────────────────────────────────────────────────────────
 *  Il builder NON fa alcuna chiamata IC per derivare lo stato: riceve
 *  `(meta, controllers)` già fetchati (al più UNA `canister_status` lato host) e
 *  li passa a L1 (`@shared/core/sovereignty.js`). Le azioni (L2,
 *  `@shared/core/platform.js`) partono solo sul click dei bottoni.
 *
 * ── Copy neutra ──────────────────────────────────────────────────────────────
 *  Tutta la copy utente vive QUI, in un solo posto. Tre soli termini:
 *  `EasyCan`, `EasyCan identity`, `app identity`. Mai `spawner`/`portal owner`/
 *  `in-app identity` in stringhe utente.
 */

import { el } from '../../ui/dom.js';
import { Principal } from '@dfinity/principal';
import { parseMetadata, deriveSovereignty, deriveBackupKeys, systemPrincipals } from '../../core/sovereignty.js';
import {
  addController, removeController, removePortal,
} from '../../core/platform.js';

/**
 * Costruisce le sezioni Platform + Controllers da dati pre-fetchati.
 * Il fetch (platform_metadata, canister_status, platform_get_admin) è
 * responsabilità del chiamante (centralizzato, parallelo).
 *
 * @param {{
 *   meta:        Record<string, any> | null,
 *   controllers?: import('@dfinity/principal').Principal[],
 *   appAdmin?:   import('@dfinity/principal').Principal | null,
 *   myPrincipal?: import('@dfinity/principal').Principal | null,
 *   mgmtError?:  string | null,
 *   canisterId:  string,
 *   onChanged?:  () => Promise<void>,
 * }} opts
 * @returns {Array<{ title: string, content: HTMLElement[] }>}
 *
 * `onChanged` (opzionale): callback invocata dopo OGNI mutazione riuscita, al posto
 * del `window.location.reload()`. L'host la usa per rifetchare+ri-renderizzare la
 * pagina in-place (cfr. `page.js::mountSovereigntyPage`), evitando il full reload
 * (re-bundle + re-auth + schermata vuota). Se assente, il fallback resta il reload.
 */
export function buildSovereigntySections({
  meta,
  controllers = [],
  appAdmin = null,
  myPrincipal = null,
  mgmtError = null,
  canisterId,
  onChanged = null,
}) {
  const platform = buildPlatformSection(meta, controllers, canisterId, onChanged);
  const backup = buildBackupKeySection(meta, {
    controllers, mgmtError, appAdmin, myPrincipal, canisterId, onChanged,
  });
  const ctrls = buildControllersSection(meta, {
    controllers, mgmtError, appAdmin, myPrincipal, canisterId, onChanged,
  });
  return [platform, backup, ctrls].filter(Boolean);
}

// ─── Platform section (ex eject.js) ──────────────────────────────────────────
//
// Modello binario, sovrano-di-default: dopo il claim l'app è SEMPRE emancipated
// (EasyCan non è controller, e post-F4 non è più ri-aggiungibile —
// `cap-platform::add_controller` rifiuta lo spawner). Non c'è alcun asse
// "support": l'app esce dal claim sovrana e resta sovrana. L'unico stato residuo
// è l'accesso del portale (la dashboard EasyCan), gestito nella sezione
// Controllers. Il vecchio "Managed" + "Take control" non esiste più.

/**
 * @param {Record<string, any> | null} meta  risultato di platform_metadata, o null
 * @param {import('@dfinity/principal').Principal[]} controllers
 * @param {string} canisterId
 * @returns {{ title: string, content: HTMLElement[] } | null}
 */
function buildPlatformSection(meta, controllers, canisterId, onChanged = null) {
  const m = parseMetadata(meta);
  if (!m) return null;

  const sov = deriveSovereignty(m, controllers);
  const rows = [];

  if (sov.mode === 'standalone') {
    rows.push(infoRow('Mode', 'Standalone'));
    rows.push(noteEl('This app is not connected to any marketplace.'));
    return { title: 'Platform', content: rows };
  }

  if (sov.mode === 'managed') {
    // Defensive: post-claim the app is always emancipated (sovereign-by-default),
    // so this state isn't reached through the normal flow. Show a read-only note
    // instead of the old orchestrated "Take control" action (now removed).
    rows.push(infoRow('Mode', 'Setup'));
    rows.push(noteEl(
      'EasyCan is finishing setup of this canister. Once setup completes the app ' +
      'becomes sovereign automatically — you are the owner and admin, and EasyCan ' +
      'is not a controller of the canister.'
    ));
  } else {
    rows.push(infoRow('Mode', 'Sovereign'));
    rows.push(infoRow('Portal access', sov.portalRemoved ? 'Off — monitor via NNS' : 'On'));
    rows.push(noteEl(sov.portalRemoved
      ? 'Full self-custody, and the EasyCan portal can\'t read this canister either — monitor ' +
        'cycles via NNS. Top-up from the EasyCan Dashboard still works.'
      : 'Full self-custody: EasyCan is not a controller of this canister — you stand on your ' +
        'own. The EasyCan portal can still read your canister\'s cycles and status.'
    ));
  }

  return { title: 'Platform', content: rows };
}

// ─── Generic confirm modal ───────────────────────────────────────────────────
//
// Interno al modulo (lo usano sia Platform che Controllers). NON esportato: è un
// dettaglio implementativo del builder, non parte dell'API pubblica.

/**
 * @param {{
 *   title: string,
 *   intro: string,
 *   bullets: string[],
 *   tip?: string,
 *   confirmLabel: string,
 *   confirmClass: 'btn-primary' | 'btn-danger' | 'btn-secondary' | 'btn-success',
 *   busyLabel: string,
 *   action: () => Promise<any>,
 *   onChanged?: () => Promise<void>,
 * }} opts
 */
function openConfirmModal(opts) {
  const existing = document.getElementById('platform-confirm-modal');
  if (existing) existing.remove();

  let busy = false;
  let errorMsg = '';

  const confirmBtn = el(
    'button',
    {
      class: opts.confirmClass,
      onclick: async () => {
        if (busy) return;
        busy = true;
        errorMsg = '';
        refresh();
        try {
          const res = await opts.action();
          if (res && 'Err' in res) throw new Error(res.Err);
          if (opts.onChanged) {
            // Rerender in-place PRIMA di chiudere: il modal resta su busyLabel finché
            // i dati freschi non sono pronti, poi si chiude sulla pagina aggiornata
            // → niente schermata vuota intermedia. onChanged gestisce i propri errori.
            await opts.onChanged();
            close();
          } else {
            close();
            window.location.reload();
          }
        } catch (err) {
          errorMsg = err?.message || String(err);
          busy = false;
          refresh();
        }
      },
    },
    opts.confirmLabel,
  );

  const cancelBtn = el(
    'button',
    { class: 'btn-secondary', onclick: () => close() },
    'Cancel',
  );

  const errorBox = el('p', {
    class: 'small',
    style: 'color: var(--error); display: none;',
  }, '');
  const busyBox = el('p', {
    class: 'small muted',
    style: 'display: none;',
  }, opts.busyLabel);

  function refresh() {
    confirmBtn.disabled = busy;
    cancelBtn.disabled = busy;
    if (errorMsg) {
      errorBox.textContent = errorMsg;
      errorBox.style.display = '';
    } else {
      errorBox.style.display = 'none';
    }
    busyBox.style.display = busy ? '' : 'none';
  }

  const bodyChildren = [
    el('p', { class: 'small' }, opts.intro),
    el(
      'ul',
      { class: 'small muted' },
      ...opts.bullets.map((b) => el('li', {}, b)),
    ),
  ];
  if (opts.tip) {
    bodyChildren.push(el('p', { class: 'small muted' }, opts.tip));
  }
  bodyChildren.push(errorBox, busyBox);

  const overlay = el(
    'div',
    { class: 'sov-modal-overlay', id: 'platform-confirm-modal' },
    el(
      'div',
      { class: 'sov-modal-dialog' },
      el('div', { class: 'sov-modal-header' }, el('h3', {}, opts.title)),
      el('div', { class: 'sov-modal-body' }, ...bodyChildren),
      el('div', { class: 'sov-modal-footer' }, cancelBtn, confirmBtn),
    ),
  );

  function close() { overlay.remove(); }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !busy) close();
  });

  document.body.appendChild(overlay);
  refresh();
  setTimeout(() => confirmBtn.focus(), 50);
}

// ─── Backup key section ──────────────────────────────────────────────────────
//
// F2 del piano self-install: dare all'utente lo strumento di recovery *prima* di
// togliergli la rete di P_portal (F3). Una "backup key" è semplicemente un
// controller IC aggiunto dall'utente — un'identità che possiede ALTROVE (un
// principal dfx, o una seconda Internet Identity). Serve a due cose:
//   1. Recovery: se perde il login di quest'app, riprende il controllo del
//      canister con la backup key (a livello IC: dfx/NNS — la UI in-app richiede
//      il login admin, che è proprio ciò che ha perso).
//   2. Cruscotto-unico sovrano: riusando la STESSA backup key su tutte le sue
//      app, una sola identità le controlla tutte.
//
// Il meccanismo (`platform_add_controller`) esiste già: F2 è la *cornice* — lo
// stato "configurato ✓ / assente ⚠" (gate per F3) e la spinta a impostarla.
// Niente stato backend: le backup key si derivano dalla lista controller via
// `deriveBackupKeys` (L1, tutto ciò che non è un'identità di sistema nota).

/**
 * @param {Record<string, any> | null} meta
 * @param {{
 *   controllers?: import('@dfinity/principal').Principal[],
 *   appAdmin?:    import('@dfinity/principal').Principal | null,
 *   myPrincipal?: import('@dfinity/principal').Principal | null,
 *   canisterId:   string,
 *   onChanged?:   () => Promise<void>,
 * }} prefetched
 * @returns {{ title: string, content: HTMLElement[] } | null}
 */
function buildBackupKeySection(meta, {
  controllers = [],
  mgmtError = null,
  appAdmin = null,
  myPrincipal = null,
  canisterId,
  onChanged = null,
} = {}) {
  const m = parseMetadata(meta);
  if (!m || m.isStandalone) return null;

  const selfP = Principal.fromText(canisterId);
  // Una backup-key è un'identità che possiedi *altrove*: vietiamo l'aggiunta di
  // un'identità di sistema, e in particolare di P_portal (A2 #3) — rimetterla
  // controller riaprirebbe il vettore chiuso. Rifiuto client-side prima del round-trip.
  const rejectBackupKey = makeBackupKeyValidator(m, {
    appAdmin, myPrincipal, selfPrincipal: selfP,
  });

  // Senza la lista controller (canister_status fallita) non possiamo affermare
  // "nessuna backup key" — sarebbe un falso negativo. Mostriamo l'add (sempre
  // utile) ma non il banner ⚠, e rimandiamo l'errore alla sezione Controllers.
  if (mgmtError) {
    return { title: 'Backup key', content: [
      noteEl(
        'Add a backup key you control from elsewhere (a dfx principal, or a second ' +
        'Internet Identity) so you can always recover this canister.'),
      buildAddRow(canisterId, onChanged, {
        label: 'Add a backup key (a principal you control)',
        buttonLabel: 'Add backup key',
        rejectPrincipal: rejectBackupKey,
      }),
      recoveryHelp(),
    ] };
  }

  const backupKeys = deriveBackupKeys(m, controllers, {
    appAdmin, myPrincipal, selfPrincipal: selfP,
  });
  const hasBackup = backupKeys.length > 0;

  const rows = [];

  if (hasBackup) {
    rows.push(statusBanner('✓', 'You have a backup key', 'var(--success)'));
    rows.push(noteEl(
      'If you ever lose access to this app’s login, you can regain control of ' +
      'your canister with the backup key below. Keep it somewhere safe — and ' +
      'consider using the same backup key across all your EasyCan apps, so a single ' +
      'identity controls everything.'));
    const list = el('ul', { class: 'controllers-list' });
    for (const k of backupKeys) {
      list.appendChild(el('li', { class: 'ctrl-row' },
        el('div', { class: 'ctrl-info' },
          el('code', { class: 'ctrl-principal' }, k.toText()),
          el('span', { class: 'ctrl-label-tag' }, 'Backup key (you)'),
        )));
    }
    rows.push(list);
    rows.push(recoveryHelp());
    rows.push(el('hr', { class: 'settings-divider' }));
    rows.push(buildAddRow(canisterId, onChanged, {
      label: 'Add another backup key',
      buttonLabel: 'Add',
      rejectPrincipal: rejectBackupKey,
    }));
  } else {
    rows.push(statusBanner('⚠', 'No backup key set', 'var(--accent-2)'));
    rows.push(noteEl(
      'Right now only this app’s login controls your canister. If you lose that ' +
      'login, the canister becomes unrecoverable — there is no EasyCan recovery, ' +
      'by design. Before relying fully on self-custody, add a backup key you control ' +
      'from elsewhere: a dfx principal, or a second Internet Identity.'));
    rows.push(buildAddRow(canisterId, onChanged, {
      label: 'Add a backup key (a principal you control)',
      buttonLabel: 'Add backup key',
      rejectPrincipal: rejectBackupKey,
    }));
    rows.push(recoveryHelp());
  }

  return { title: 'Backup key', content: rows };
}

/**
 * Costruisce un validatore "questo principal NON è una backup-key valida": ritorna
 * un messaggio d'errore (o null se va bene). P_portal (attuale/originale) ha un
 * messaggio dedicato — A2 (#3): rimetterlo controller riapre il vettore chiuso.
 * Le altre identità di sistema (self, app admin, spawner) ottengono un messaggio
 * generico. Specchia il rifiuto backend di `add_controller`.
 *
 * @param {ReturnType<typeof parseMetadata> | null} m
 * @param {Parameters<typeof systemPrincipals>[1]} ctx
 * @returns {(p: import('@dfinity/principal').Principal) => string | null}
 */
function makeBackupKeyValidator(m, ctx = {}) {
  const sys = systemPrincipals(m, ctx);
  const portalSet = new Set(
    [m?.portalOwner, m?.originalPortalOwner].filter(Boolean).map((p) => p.toText()),
  );
  return (p) => {
    const t = p.toText();
    if (portalSet.has(t)) {
      return 'This is your EasyCan identity, not a backup key. Re-adding it as a ' +
        'controller would re-open the EasyCan dashboard access you turned off. Use a key ' +
        'you control elsewhere (a dfx principal, or a second Internet Identity).';
    }
    if (sys.has(t)) {
      return 'This is already a system identity of this canister, not a backup key. Add a ' +
        'principal you control from elsewhere (a dfx principal, or a second Internet Identity).';
    }
    return null;
  };
}

/** Banner di stato con icona colorata + testo. */
function statusBanner(icon, text, color) {
  return el('div', { class: 'settings-row', style: 'align-items: center; gap: 0.5em;' },
    el('span', { style: `color: ${color}; font-size: 1.2em;` }, icon),
    el('span', { class: 'settings-label', style: `color: ${color};` }, text),
  );
}

/** Guida al recovery IC-native (collassabile): cosa fare quando il login è perso. */
function recoveryHelp() {
  return el('details', { class: 'settings-note small muted', style: 'margin-top: 0.5em;' },
    el('summary', { style: 'cursor: pointer;' }, 'How to recover with your backup key'),
    el('p', { class: 'small muted', style: 'margin-top: 0.5em;' },
      'If you lose this app’s login you can no longer use this page (it needs the ' +
      'admin login). Recover at the protocol level instead: with the backup key’s ' +
      'identity, use dfx or the NNS dashboard to manage the canister as a controller — ' +
      'e.g. top up cycles, or re-point the controllers. The backup key is a full IC ' +
      'controller, so it has the power to recover the canister on its own.'),
    el('p', { class: 'small muted' },
      'Example (dfx): dfx canister --network ic update-settings ' +
      '--add-controller <new-principal> <this-canister-id>'),
  );
}

// ─── Controllers section (ex controllers.js) ─────────────────────────────────
//
// Lista i controller del canister e permette di aggiungerne/rimuoverne. I
// controller "protetti" (self, app admin, spawner) non sono rimovibili da qui —
// il flow ufficiale per lo spawner è Emancipate (sezione Platform).
//
// Il portal_owner ("Your EasyCan identity") è rimovibile da qui: NON è un atto
// di sovranità (è la tua stessa identità II), è solo una scelta di visibilità
// dashboard. La rimozione è instradata su platform_remove_portal così i metadati
// restano coerenti.

/**
 * @param {Record<string, any> | null} meta  risultato di platform_metadata
 * @param {{
 *   controllers?: import('@dfinity/principal').Principal[],
 *   mgmtError?:   string | null,
 *   appAdmin?:    import('@dfinity/principal').Principal | null,
 *   myPrincipal?: import('@dfinity/principal').Principal | null,
 *   canisterId:   string,
 * }} prefetched
 * @returns {{ title: string, content: HTMLElement[] } | null}
 */
function buildControllersSection(meta, {
  controllers = [],
  mgmtError = null,
  appAdmin = null,
  myPrincipal = null,
  canisterId,
  onChanged = null,
} = {}) {
  const m = parseMetadata(meta);
  if (!m || m.isStandalone) return null;

  const sov = deriveSovereignty(m, controllers);
  const selfP = Principal.fromText(canisterId);
  const spawnerP = m.spawner;
  const portalOwnerP = m.portalOwner;
  // Portale rimosso: aveva un'identità EasyCan (original presente) ma ora è
  // fuori dai controller (portal_owner None). Stato permanente (A2 #3).
  const portalRemoved = sov.portalRemoved;

  function isProtected(p) {
    const t = p.toText();
    if (t === selfP.toText()) return true;
    if (appAdmin && t === appAdmin.toText()) return true;
    if (spawnerP && t === spawnerP.toText()) return true;
    return false;
  }

  function isPortalOwner(p) {
    return portalOwnerP !== null && p.toText() === portalOwnerP.toText();
  }

  function labelFor(p) {
    const t = p.toText();
    if (t === selfP.toText()) return 'This canister (self-management)';
    if (appAdmin && t === appAdmin.toText()) return 'Your app identity (you)';
    if (spawnerP && t === spawnerP.toText()) return 'EasyCan';
    if (portalOwnerP && t === portalOwnerP.toText()) return 'Your EasyCan identity';
    if (myPrincipal && t === myPrincipal.toText()) return 'Your app identity (you)';
    // Tutto il resto = un controller aggiunto dall'utente, ossia una backup key
    // (un'identità che possiede altrove). Cfr. buildBackupKeySection.
    return 'Backup key (you)';
  }

  const rows = [];

  rows.push(
    el('p', { class: 'settings-note muted' },
      'Principals authorized to manage this canister. Add your own identities (e.g. a dfx ' +
      'principal) to manage the canister from outside this app.'),
  );

  if (mgmtError) {
    rows.push(el('p', { class: 'small', style: 'color: var(--error);' },
      `Failed to load controllers: ${mgmtError}`));
  } else {
    const list = el('ul', { class: 'controllers-list' });
    for (const ctrl of controllers) {
      list.appendChild(renderControllerRow(ctrl, {
        isProtected: isProtected(ctrl),
        isPortalOwner: isPortalOwner(ctrl),
        label: labelFor(ctrl),
        canisterId,
        onChanged,
      }));
    }
    rows.push(list);
  }

  // Portale rimosso → nota informativa. La riattivazione è stata ritirata (A2 #3):
  // P_portal non è ri-aggiungibile come controller, la rimozione è permanente.
  if (portalRemoved) {
    rows.push(el('p', { class: 'small muted', style: 'margin-top: 0.5em;' },
      'The EasyCan dashboard is off for this canister. Re-enabling it from here has ' +
      'been retired: your EasyCan identity can no longer be re-added as a controller. ' +
      'You remain the sole authority — monitor and top up cycles via the NNS dashboard, ' +
      'or with a backup key you control.'));
  }

  // Nessuna add-row qui: aggiungere un controller = aggiungere una backup key,
  // e quel flusso (spiegato + spinto) vive nella sezione "Backup key" sopra.
  // Questa sezione resta la vista completa (lista + remove; la riattivazione dashboard
  // è ritirata in A2 → solo nota informativa quando portalRemoved).
  return { title: 'Controllers', content: rows };
}

function renderControllerRow(principal, { isProtected, isPortalOwner = false, label, canisterId, onChanged = null }) {
  const key = principal.toText();
  const infoChildren = [];

  if (isPortalOwner) {
    infoChildren.push(el('p', { class: 'small muted ctrl-hint' },
      'Removing this turns off the EasyCan dashboard (cycles, status, controllers). ' +
      'You are already the sole authority over this canister — but from then on monitoring ' +
      'and topping up cycles are your responsibility, via the NNS dashboard. ' +
      'Top-up from EasyCan keeps working either way. Keep this identity to manage everything ' +
      'comfortably from EasyCan and get notified when cycles run low.'));
  }

  infoChildren.push(
    el('code', { class: 'ctrl-principal' }, key),
    el('span', { class: 'ctrl-label-tag' }, label),
  );

  const info = el('div', { class: 'ctrl-info' }, ...infoChildren);

  const row = el('li', { class: 'ctrl-row' }, info);

  if (!isProtected) {
    const actions = el('div', { class: 'ctrl-actions' });
    let confirming = false;
    let busy = false;
    let errorMsg = '';
    const errorBox = el('span', { class: 'ctrl-error' }, '');

    function refresh() {
      actions.replaceChildren();
      if (busy) {
        actions.appendChild(el('span', { class: 'small muted' }, 'Removing…'));
        return;
      }
      if (confirming) {
        const confirmBtn = el('button', {
          class: 'btn-text small',
          style: 'color: var(--error);',
          onclick: doRemove,
        }, 'Confirm remove');
        const cancelBtn = el('button', {
          class: 'btn-text small',
          onclick: () => { confirming = false; refresh(); },
        }, 'Cancel');
        actions.appendChild(confirmBtn);
        actions.appendChild(cancelBtn);
      } else {
        const btn = el('button', {
          class: 'btn-text small',
          onclick: () => { confirming = true; refresh(); },
        }, 'Remove');
        actions.appendChild(btn);
      }
      if (errorMsg) {
        errorBox.textContent = errorMsg;
        errorBox.style.display = '';
      } else {
        errorBox.style.display = 'none';
      }
    }

    async function doRemove() {
      busy = true; errorMsg = ''; refresh();
      try {
        if (isPortalOwner) await removePortal(canisterId);
        else await removeController(canisterId, principal);
        // Rerender in-place se l'host lo supporta (bottone resta su "Removing…"
        // finché pronto); altrimenti fallback al full reload.
        if (onChanged) await onChanged();
        else window.location.reload();
      } catch (err) {
        errorMsg = err?.message || String(err);
        busy = false;
        confirming = false;
        refresh();
      }
    }

    refresh();
    row.appendChild(actions);
    row.appendChild(errorBox);
  }

  return row;
}

function buildAddRow(canisterId, onChanged = null, {
  label = 'Add a controller principal',
  buttonLabel = 'Add',
  rejectPrincipal = null,
} = {}) {
  const input = el('input', {
    type: 'text',
    class: 'ctrl-add-input',
    placeholder: 'xxxxx-xxxxx-...-xxxxx-cai',
    autocomplete: 'off',
  });
  const btn = el('button', { class: 'btn-secondary small' }, buttonLabel);
  const errorBox = el('p', {
    class: 'small',
    style: 'color: var(--error); display: none; margin: 0;',
  }, '');
  const busyBox = el('p', {
    class: 'small muted',
    style: 'display: none; margin: 0;',
  }, 'Adding…');

  let busy = false;

  function setError(msg) {
    if (msg) {
      errorBox.textContent = msg;
      errorBox.style.display = '';
    } else {
      errorBox.style.display = 'none';
    }
  }

  btn.onclick = async () => {
    if (busy) return;
    setError('');
    const raw = (input.value || '').trim();
    if (!raw) { setError('Enter a principal'); return; }
    let p;
    try { p = Principal.fromText(raw); } catch { setError('Invalid principal format'); return; }
    if (rejectPrincipal) {
      const why = rejectPrincipal(p);
      if (why) { setError(why); return; }
    }
    busy = true;
    btn.disabled = true;
    input.disabled = true;
    busyBox.style.display = '';
    try {
      await addController(canisterId, p);
      if (onChanged) await onChanged();
      else window.location.reload();
    } catch (err) {
      setError(err?.message || String(err));
      busy = false;
      btn.disabled = false;
      input.disabled = false;
      busyBox.style.display = 'none';
    }
  };

  return el(
    'div',
    { class: 'ctrl-add-row' },
    el('label', { class: 'small muted' }, label),
    el('div', { class: 'ctrl-add-inputs' }, input, btn),
    busyBox,
    errorBox,
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function infoRow(label, value) {
  return el(
    'div',
    { class: 'settings-row' },
    el('span', { class: 'settings-label' }, label),
    el('span', { class: 'settings-value mono small' }, value),
  );
}

function noteEl(text) {
  return el('p', { class: 'settings-note small muted' }, text);
}

