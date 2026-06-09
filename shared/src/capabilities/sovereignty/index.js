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
import { parseMetadata, deriveSovereignty, controllersInclude } from '../../core/sovereignty.js';
import {
  grantSupport, revokeSupport,
  addController, removeController, removePortal, restorePortal,
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
  const ctrls = buildControllersSection(meta, {
    controllers, mgmtError, appAdmin, myPrincipal, canisterId, onChanged,
  });
  return [platform, ctrls].filter(Boolean);
}

// ─── Platform section (ex eject.js) ──────────────────────────────────────────
//
// Modello binario, sovrano-di-default: dopo il claim l'app è SEMPRE emancipated
// (EasyCan non è controller). L'unico asse è il supporto EasyCan, opt-in:
//   Sovereign · support off → Grant EasyCan support (aggiunge lo spawner ai controller)
//   Sovereign · support on  → Revoke EasyCan support (lo rimuove)
//
// "Grant support" NON ridà l'app a EasyCan in gestione: aggiunge solo lo spawner
// ai controller per dargli il controllo IC necessario al supporto (status,
// top-up, fix/upgrade). L'utente resta admin e unica autorità; può revocare in
// ogni momento. Il vecchio stato "Managed" + "Take control" non esiste più:
// l'app esce dal claim già sovrana.

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
  const originalSpawner = m.originalSpawner;
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
      'support is off until you choose to turn it on.'
    ));
  } else if (sov.supportGranted) {
    rows.push(infoRow('Mode', 'Sovereign'));
    rows.push(infoRow('EasyCan support', 'On — safety net'));
    rows.push(noteEl(
      'You\'re sovereign, with a safety net. While support is on, EasyCan is a controller of ' +
      'this canister — control is temporarily shared. EasyCan can inspect status, top up ' +
      'cycles, and apply fixes or updates. You stay the admin and can revoke this access ' +
      'whenever you want.'
    ));
    rows.push(el('div', { class: 'settings-row' }, buildRevokeSupportBtn(originalSpawner, canisterId, onChanged)));
  } else {
    rows.push(infoRow('Mode', 'Sovereign'));
    rows.push(infoRow('EasyCan support', 'Off — self-custody'));
    rows.push(infoRow('Portal access', sov.portalRemoved ? 'Off — monitor via NNS' : 'On'));
    rows.push(noteEl(sov.portalRemoved
      ? 'Full self-custody, and the EasyCan portal can\'t read this canister either — monitor ' +
        'cycles via NNS. Top-up from the EasyCan Dashboard still works. You can grant EasyCan ' +
        'support (which also restores portal read access) whenever you want.'
      : 'Full self-custody by default: EasyCan is not a controller of this canister — you stand ' +
        'on your own from the start. The EasyCan portal can still read your canister\'s cycles ' +
        'and status. You can grant EasyCan support access, and revoke it whenever you want.'
    ));
    rows.push(el('div', { class: 'settings-row' }, buildGrantSupportBtn(originalSpawner, canisterId, sov.portalRemoved, onChanged)));
  }

  return { title: 'Platform', content: rows };
}

function buildGrantSupportBtn(originalSpawner, canisterId, portalRemoved = false, onChanged = null) {
  if (!originalSpawner) {
    return el('button', { class: 'btn-secondary', disabled: true }, 'Support unavailable');
  }
  const bullets = [
    'EasyCan becomes a controller of this canister again, so while support is on control is shared: it can inspect status, top up cycles, and apply fixes or updates.',
    'You stay the owner and admin of the app — this does NOT hand it back to EasyCan management.',
    'You can revoke support at any time from this Platform section.',
  ];
  if (portalRemoved) {
    // Support on ⟹ EasyCan dashboard on. The dashboard is currently off, so granting
    // support will turn it back on too (we restore it first to never pass through the
    // invalid "support on + dashboard off" state).
    bullets.push('Your EasyCan dashboard is currently off; granting support turns it back on so cycles and status stay visible.');
  }
  return el(
    'button',
    {
      class: 'btn-secondary',
      onclick: () => openConfirmModal({
        title: 'Grant EasyCan support',
        intro: 'This adds EasyCan back as a controller of this canister so we can help you. After granting:',
        bullets,
        confirmLabel: 'Grant support',
        confirmClass: 'btn-primary',
        busyLabel: 'Granting…',
        action: async () => {
          // Restore the dashboard FIRST so we never sit in "support on + dashboard off"
          // (invariant: support on ⟹ portal on). If granting then fails, we stay in a
          // valid state (emancipated, dashboard on, no support).
          if (portalRemoved) await restorePortal(canisterId);
          await grantSupport(canisterId, originalSpawner);
        },
        onChanged,
      }),
    },
    'Grant EasyCan support',
  );
}

function buildRevokeSupportBtn(originalSpawner, canisterId, onChanged = null) {
  return el(
    'button',
    {
      class: 'btn-secondary',
      onclick: () => openConfirmModal({
        title: 'Revoke EasyCan support',
        intro: 'This removes EasyCan from the controllers of this canister. After revoking:',
        bullets: [
          'EasyCan can no longer automatically inspect status, apply fixes, or top up cycles on your behalf.',
          'Manual top-up from the EasyCan Dashboard still works.',
          'You remain the admin and sole authority, exactly as before.',
          'You can grant support again at any time.',
        ],
        confirmLabel: 'Revoke support',
        confirmClass: 'btn-primary',
        busyLabel: 'Revoking…',
        action: () => revokeSupport(canisterId, originalSpawner),
        onChanged,
      }),
    },
    'Revoke EasyCan support',
  );
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
  const originalSpawnerP = m.originalSpawner;
  const originalPortalOwnerP = m.originalPortalOwner;
  // Portale rimosso: aveva un'identità EasyCan (original presente) ma ora è
  // fuori dai controller (portal_owner None). Si può riattivare la dashboard.
  const portalRemoved = sov.portalRemoved;
  // EasyCan (spawner) è ancora controller? Vero in Managed (spawner presente) e
  // in Emancipated+support (original_spawner ri-aggiunto). Se vero, rimuovere il
  // portale lascia il terzo al controllo e l'utente cieco → hard-block del remove
  // (bottone disabilitato + hint contestuale).
  const easycanIsController = controllersInclude(controllers, originalSpawnerP);

  function isProtected(p) {
    const t = p.toText();
    if (t === selfP.toText()) return true;
    if (appAdmin && t === appAdmin.toText()) return true;
    if (spawnerP && t === spawnerP.toText()) return true;
    // Support concesso (emancipated + original_spawner ri-aggiunto): EasyCan è
    // di nuovo controller. Non rimovibile da qui — il flow ufficiale è "Revoke
    // EasyCan support" (sezione Platform), simmetrico alla protezione dello
    // spawner attivo in Managed. Evita la doppia via di revoca.
    if (sov.supportGranted && originalSpawnerP && t === originalSpawnerP.toText()) return true;
    return false;
  }

  function isSupportAccess(p) {
    return sov.supportGranted && originalSpawnerP !== null && p.toText() === originalSpawnerP.toText();
  }

  function isPortalOwner(p) {
    return portalOwnerP !== null && p.toText() === portalOwnerP.toText();
  }

  function labelFor(p) {
    const t = p.toText();
    if (t === selfP.toText()) return 'This canister (self-management)';
    if (appAdmin && t === appAdmin.toText()) return 'Your app identity (you)';
    if (spawnerP && t === spawnerP.toText()) return 'EasyCan';
    // Emancipated (spawner None) ma original_spawner ri-aggiunto = supporto concesso
    if (!spawnerP && originalSpawnerP && t === originalSpawnerP.toText()) {
      return 'EasyCan (support access)';
    }
    if (portalOwnerP && t === portalOwnerP.toText()) return 'Your EasyCan identity';
    if (myPrincipal && t === myPrincipal.toText()) return 'Your app identity (you)';
    return 'Other';
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
      // Removing the dashboard identity (portal owner) is hard-blocked while EasyCan
      // support is on — sovereign-by-default, EasyCan is a controller only when support
      // is granted, so portalBlocked ⟹ support on. Turning off the dashboard then would
      // leave a third party in control while you lose visibility. Revoke support first;
      // once support is off the dashboard identity can be removed cleanly.
      const portalBlocked = isPortalOwner(ctrl) && easycanIsController;
      const hardBlockHint = !portalBlocked ? '' :
        'EasyCan support is on, so it\'s a controller of this canister. Revoke EasyCan ' +
        'support first (Platform section above), then you can turn off the dashboard.';
      list.appendChild(renderControllerRow(ctrl, {
        isProtected: isProtected(ctrl),
        isPortalOwner: isPortalOwner(ctrl),
        isSupportAccess: isSupportAccess(ctrl),
        hardBlock: portalBlocked,
        hardBlockHint,
        label: labelFor(ctrl),
        canisterId,
        onChanged,
      }));
    }
    rows.push(list);
  }

  // Portale rimosso → riga di riattivazione dashboard
  if (portalRemoved) {
    rows.push(renderRestorePortalRow(originalPortalOwnerP, canisterId, onChanged));
  }

  // Add-row
  rows.push(el('hr', { class: 'settings-divider' }));
  rows.push(buildAddRow(canisterId, onChanged));

  return { title: 'Controllers', content: rows };
}

function renderControllerRow(principal, { isProtected, isPortalOwner = false, isSupportAccess = false, hardBlock = false, hardBlockHint = '', label, canisterId, onChanged = null }) {
  const key = principal.toText();
  const infoChildren = [];

  if (isSupportAccess) {
    infoChildren.push(el('p', { class: 'small muted ctrl-hint' },
      'EasyCan has support access (it is a controller of this canister). ' +
      'To remove it, use "Revoke EasyCan support" in the Platform section above.'));
  }

  if (isPortalOwner && hardBlock) {
    infoChildren.push(el('p', { class: 'small muted ctrl-hint' }, hardBlockHint));
  } else if (isPortalOwner) {
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

  if (isPortalOwner && hardBlock) {
    // Hard-blocked: show a disabled Remove so the axis stays visible, but the only
    // path is "Revoke EasyCan support" first (explained in the hint above).
    const actions = el('div', { class: 'ctrl-actions' },
      el('button', {
        class: 'btn-text small',
        disabled: true,
        title: 'EasyCan is still a controller — see the note above',
      }, 'Remove'));
    row.appendChild(actions);
  } else if (!isProtected) {
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

function renderRestorePortalRow(originalPortalOwnerP, canisterId, onChanged = null) {
  const info = el('div', { class: 'ctrl-info' },
    el('p', { class: 'small muted ctrl-hint' },
      'The EasyCan dashboard is off for this canister. Re-enabling it adds your ' +
      'EasyCan identity back as a controller, so cycles, status and controllers ' +
      'become visible again from EasyCan — and you get notified when cycles run low. ' +
      'This does not bring back EasyCan as a manager: it stays your dashboard only.'),
    el('code', { class: 'ctrl-principal' }, originalPortalOwnerP.toText()),
    el('span', { class: 'ctrl-label-tag' }, 'Your EasyCan identity (dashboard off)'),
  );

  const row = el('li', { class: 'ctrl-row ctrl-row--off' }, info);
  const actions = el('div', { class: 'ctrl-actions' });
  const errorBox = el('span', { class: 'ctrl-error' }, '');
  errorBox.style.display = 'none';
  let busy = false;

  const btn = el('button', { class: 'btn-text small' }, 'Re-enable');
  btn.onclick = async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Re-enabling…';
    errorBox.style.display = 'none';
    try {
      await restorePortal(canisterId);
      if (onChanged) await onChanged();
      else window.location.reload();
    } catch (err) {
      errorBox.textContent = err?.message || String(err);
      errorBox.style.display = '';
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Re-enable';
    }
  };
  actions.appendChild(btn);
  row.appendChild(actions);
  row.appendChild(errorBox);
  return row;
}

function buildAddRow(canisterId, onChanged = null) {
  const input = el('input', {
    type: 'text',
    class: 'ctrl-add-input',
    placeholder: 'xxxxx-xxxxx-...-xxxxx-cai',
    autocomplete: 'off',
  });
  const btn = el('button', { class: 'btn-secondary small' }, 'Add');
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
    el('label', { class: 'small muted' }, 'Add a controller principal'),
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

