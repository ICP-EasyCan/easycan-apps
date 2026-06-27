/**
 * run.js — host di una mini-app in iframe sandboxed + bridge postMessage.
 *
 * Modello di sicurezza (la spina del prodotto):
 *  - L'iframe è `sandbox="allow-scripts"` SENZA `allow-same-origin` → origin opaco/null.
 *    Non ha la sessione II dell'owner, non legge storage/cookie del parent, è cross-origin
 *    verso l'API del canister. L'UNICO canale verso la shell è postMessage.
 *  - La shell riconosce QUALE bundle ha parlato dall'`event.source` (== iframe.contentWindow),
 *    NON da un id dichiarato nel payload (un id nel payload sarebbe falsificabile).
 *  - La shell tagga il namespace e chiama `kv_*_as(Actor::Bundle(id), …)`: l'enforcement vero
 *    (namespace ∈ quelli dichiarati nel manifest) è IN-CANISTER (cap-store F2). Il controllo JS
 *    qui sotto è solo difesa-in-profondità + messaggio d'errore pulito.
 *
 * Iframe VIVO (latenza). Gli asset del bundle sono serviti NON-certificati (`/m/{id}/` = update
 * call → consenso ~2s, vs shell query istantanea), per OGNI file e OGNI apertura. Per non
 * ripagarli, teniamo l'iframe VIVO in un pool (uno per module_id): ogni mini-app è un PANNELLO
 * persistente (barra + badge + iframe) dentro uno **stage** fuori dal #route-container (che il
 * router svuota ad ogni navigazione). Entrando in #run/ lo stage SOSTITUISCE la regione contenuti;
 * uscendo lo NASCONDIAMO (mai staccare i pannelli dal DOM: staccare = reload del documento →
 * vanifica tutto). Tre invarianti di sicurezza tengono il modello intatto:
 *   1. attribuzione per `event.source`, per-iframe (mappa contentWindow→namespaces, mai dal payload);
 *   2. teardown DURO dell'intero pool al logout (no leak di DOM tra utenti su SPA/macchina condivisa);
 *   3. pannelli nascosti via CSS, mai staccati; entry buttata se `bundle.version` cambia.
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate }   from '@shared/ui/router.js';
import { CANISTER_ID } from '@shared/core/config.js';
import { listBundles, kvGetAs, kvSetAs, kvDeleteAs, kvListAs } from '../../lib/hub-api.js';
import { permissionBadges } from '../../lib/ui.js';

// Pool di iframe vivi — uno per module_id. { panel, iframe, namespaces, version, onMessage }
const pool = new Map();
let _leaveWired = false;

function getStage() {
  let stage = document.getElementById('bundle-stage');
  if (!stage) {
    stage = el('div', { id: 'bundle-stage', class: 'bundle-stage' });
    document.getElementById('app').appendChild(stage);
  }
  return stage;
}

// Stage attivo (sostituisce la regione contenuti) o nascosto (route-container torna visibile).
function setRunView(active) {
  const stage = getStage();
  const rc = document.getElementById('route-container');
  stage.classList.toggle('active', active);
  if (rc) rc.style.display = active ? 'none' : '';
}

function hideStage() { setRunView(false); }

function showOnly(moduleId) {
  setRunView(true);
  for (const [id, entry] of pool) {
    entry.panel.classList.toggle('hidden', id !== moduleId);
  }
}

// Teardown di una singola entry: rimuove il listener message + il pannello dal DOM, cancella dal pool.
function teardownEntry(moduleId) {
  const entry = pool.get(moduleId);
  if (!entry) return;
  window.removeEventListener('message', entry.onMessage);
  entry.panel.remove();
  pool.delete(moduleId);
}

// Teardown DURO di tutto il pool — chiamato al logout (invariante 2: nessun DOM con dati
// dell'utente precedente sopravvive a un cambio sessione su SPA/macchina condivisa).
export function teardownAllBundles() {
  for (const id of [...pool.keys()]) teardownEntry(id);
  const stage = document.getElementById('bundle-stage');
  if (stage) stage.remove();
  const rc = document.getElementById('route-container');
  if (rc) rc.style.display = '';
}

// Un solo listener persistente: nasconde lo stage quando si lascia una rotta #run/.
function wireLeave() {
  if (_leaveWired) return;
  _leaveWired = true;
  window.addEventListener('hashchange', () => {
    if (!window.location.hash.startsWith('#run/')) hideStage();
  });
}

// Crea il pannello vivo (barra + badge + iframe) + bridge per un module_id non ancora in pool.
function createEntry(moduleId, bundle) {
  const namespaces = new Set(bundle.permissions.storage_namespaces);

  const iframe = el('iframe', {
    src: `/m/${moduleId}/index.html`,
    // allow-scripts: la mini-app gira; allow-forms: i suoi <form> emettono l'evento
    // submit (senza, il browser blocca la submission a monte e `onsubmit` non scatta mai
    // → "Add non fa niente"). NON allow-same-origin → l'origin resta opaco: l'unico canale
    // verso la shell è postMessage, l'enforcement vero è in-canister. La spina regge.
    sandbox: 'allow-scripts allow-forms',
    title: moduleId,
  });

  // Overlay di caricamento: serving non-certificato (~2s) → senza questo il riquadro resta bianco
  // al PRIMO caricamento. Le riaperture successive sono istantanee (iframe vivo, niente spinner).
  const spinner = el('div', { class: 'bundle-loading' },
    el('div', { class: 'spinner' }),
    el('p', { class: 'muted' }, `Starting ${moduleId}…`),
  );
  let _hidden = false;
  const hideSpinner = () => { if (_hidden) return; _hidden = true; spinner.classList.add('gone'); };
  // Segnale "app viva" = primo handshake del bridge (l'app chiama Hub.host() al boot);
  // `load` dell'iframe è il fallback (HTML arrivato anche se l'app non parlasse mai).
  iframe.addEventListener('load', hideSpinner);

  const panel = el('div', { class: 'bundle-panel' },
    el('div', { class: 'bundle-bar' },
      el('button', { class: 'btn-ghost', onclick: () => navigate('#mini-apps') }, '← Mini-apps'),
      el('strong', {}, moduleId),
      el('span', { class: 'muted', style: 'margin-left:auto;' }, `v${bundle.version}`),
    ),
    el('div', {}, ...permissionBadges(bundle.permissions)),
    el('div', { class: 'bundle-host' }, spinner, iframe),
  );

  // ─── Bridge (per-iframe) ─────────────────────────────────────────────────────
  const onMessage = async (event) => {
    // Identifica il mittente dal SOURCE, non dal payload (invariante 1).
    if (event.source !== iframe.contentWindow) return;
    hideSpinner(); // l'app ha parlato → è viva: via l'overlay (anche prima del fallback `load`)
    const msg = event.data;
    if (!msg || msg.__hub !== 1 || !msg.rid) return;

    const reply = (payload) =>
      iframe.contentWindow?.postMessage({ __hub: 1, rid: msg.rid, ...payload }, '*');

    const ns = String(msg.ns ?? '');
    // Difesa-in-profondità: il bundle può toccare SOLO i namespace dichiarati nel suo manifest.
    if (msg.op !== 'host' && !namespaces.has(ns)) {
      console.error(`[hub-bridge] ${moduleId} op="${msg.op}" denied: ns "${ns}" not in [${[...namespaces].join(', ')}]`);
      reply({ ok: false, error: `permission denied: namespace "${ns}" not declared by this bundle` });
      return;
    }

    try {
      let value;
      switch (msg.op) {
        case 'host':  reply({ ok: true, value: { module_id: moduleId, namespaces: [...namespaces] } }); return;
        case 'get':   value = await kvGetAs(moduleId, ns, String(msg.key ?? '')); break;
        case 'set':   await kvSetAs(moduleId, ns, String(msg.key ?? ''), String(msg.value ?? '')); value = true; break;
        case 'del':   await kvDeleteAs(moduleId, ns, String(msg.key ?? '')); value = true; break;
        case 'list':  value = await kvListAs(moduleId, ns); break;
        default:      reply({ ok: false, error: `unknown op "${msg.op}"` }); return;
      }
      reply({ ok: true, value });
    } catch (e) {
      console.error(`[hub-bridge] ${moduleId} op="${msg.op}" ns="${ns}" failed:`, e);
      reply({ ok: false, error: e.message || String(e) });
    }
  };

  window.addEventListener('message', onMessage);
  getStage().appendChild(panel);
  pool.set(moduleId, { panel, iframe, namespaces, version: bundle.version, onMessage });
}

export async function renderRun(container, moduleId) {
  wireLeave();

  let bundle;
  try {
    const bundles = await listBundles();
    bundle = bundles.find((b) => b.module_id === moduleId);
  } catch (e) {
    hideStage();
    render(container, el('p', { class: 'error' }, `Failed to load: ${e.message}`));
    return;
  }
  if (!bundle) {
    hideStage();
    teardownEntry(moduleId); // se era installato e ora non più
    render(container,
      el('p', { class: 'error' }, `Mini-app "${moduleId}" is not installed.`),
      el('button', { class: 'btn-secondary', onclick: () => navigate('#mini-apps') }, 'Back to Mini-apps'));
    return;
  }

  // Invariante 3: version bump → butta l'entry vecchia, ricrea col codice nuovo.
  const existing = pool.get(moduleId);
  if (existing && existing.version !== bundle.version) teardownEntry(moduleId);

  if (!pool.has(moduleId)) createEntry(moduleId, bundle);
  showOnly(moduleId); // ri-aggancio (vivo, istantaneo) o mostra il fresco

  void CANISTER_ID; // (origin di riferimento — l'iframe è same-origin ma sandboxed→opaco)
}
