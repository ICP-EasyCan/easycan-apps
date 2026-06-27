/**
 * hub-api.js — wrapper sottili sull'actor del canister EasyHub.
 *
 * Tutto passa da @shared/core/icp.js (call=update, query). I valori KV sono trattati come
 * stringhe utf8 (encode/decode qui), così bridge e UI non maneggiano byte grezzi.
 *
 * Due path KV:
 *  - kv* (owner): le primitive raw, owner-gated, senza restrizioni (uso shell/settings).
 *  - kv*As (bundle-context): la shell media un bundle in iframe → Actor::Bundle(id), confinato
 *    ai namespace dichiarati. L'enforcement è IN-CANISTER (cap-store F2): qui ci si fida del canister.
 */

import { call, query } from '@shared/core/icp.js';
import { CANISTER_ID } from '@shared/core/config.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const cid = () => CANISTER_ID;
const toBytes = (str) => enc.encode(str ?? '');
const fromBytes = (bytes) => dec.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

/** Estrae il valore da un Result candid { Ok } / { Err } o lancia. */
function unwrap(res) {
  if (res && 'Err' in res) throw new Error(res.Err);
  if (res && 'Ok' in res) return res.Ok;
  return res;
}

// ─── Presenza-owner / heartbeat (F1) ──────────────────────────────────────────

/** Timbra la presenza dell'owner (il canister registra il *quando* server-side). */
export const checkin = () => call(cid(), 'checkin').then(unwrap);
/** Ultimo battito in secondi (Number), o null. */
export const lastCheckin = () =>
  query(cid(), 'last_checkin').then((opt) => (opt.length ? Number(opt[0]) : null));

// ─── Credenziali d'uscita (G1) ────────────────────────────────────────────────
//
// Vivono nel namespace riservato __secrets (KV 80, bundle-denied). Un job le referenzia per nome col
// resolver {{secret:NAME}}, risolto SOLO nei campi d'uscita e SOLO per Actor::Owner (in-canister).
// Mai il chiaro on-the-wire: list ritorna { name, masked }, non esiste un get del valore.

/** Registra/aggiorna una credenziale d'uscita (owner). */
export const setSecret = (name, value) => call(cid(), 'set_secret', name, value).then(unwrap);
/** Elenca le credenziali: [{ name, masked }]. Mai il chiaro. */
export const listSecrets = () => query(cid(), 'list_secrets');
/** Revoca (cancella) una credenziale (owner). Idempotente. */
export const deleteSecret = (name) => call(cid(), 'delete_secret', name).then(unwrap);

// ─── Bundles (host store) ─────────────────────────────────────────────────────

export const listBundles = () => query(cid(), 'list_bundles');

export function installBundle(moduleId, bytes, expectedSha256, version, permissions) {
  return call(cid(), 'install_bundle', moduleId, bytes, expectedSha256, version, permissions)
    .then(unwrap);
}

export const uninstallBundle = (moduleId) =>
  call(cid(), 'uninstall_bundle', moduleId).then(unwrap);

// ─── KV owner ─────────────────────────────────────────────────────────────────

export const kvList = (ns) => query(cid(), 'kv_list', ns);
export const kvGet = (ns, key) =>
  query(cid(), 'kv_get', ns, key).then((opt) => (opt.length ? fromBytes(opt[0]) : null));
export const kvSet = (ns, key, value) =>
  call(cid(), 'kv_set', ns, key, toBytes(value)).then(unwrap);
export const kvDelete = (ns, key) => call(cid(), 'kv_delete', ns, key).then(unwrap);

// ─── KV bundle-context (bridge) — Actor::Bundle(id), enforcement in-canister ──

const bundleActor = (id) => ({ Bundle: id });

export const kvSetAs = (id, ns, key, value) =>
  call(cid(), 'kv_set_as', bundleActor(id), ns, key, toBytes(value)).then(unwrap);
export const kvGetAs = (id, ns, key) =>
  query(cid(), 'kv_get_as', bundleActor(id), ns, key)
    .then(unwrap)
    .then((opt) => (opt.length ? fromBytes(opt[0]) : null));
export const kvDeleteAs = (id, ns, key) =>
  call(cid(), 'kv_delete_as', bundleActor(id), ns, key).then(unwrap);
export const kvListAs = (id, ns) =>
  query(cid(), 'kv_list_as', bundleActor(id), ns).then(unwrap);

// ─── Automazioni ──────────────────────────────────────────────────────────────

export const listJobs = () => query(cid(), 'list_jobs');
export const createJob = (job) => call(cid(), 'create_job', job).then(unwrap);
export const deleteJob = (jobId) => call(cid(), 'delete_job', jobId).then(unwrap);
export const listSchedules = () => query(cid(), 'list_schedules');
export const scheduleJob = (jobId, intervalSecs) =>
  call(cid(), 'schedule_job', jobId, BigInt(intervalSecs)).then(unwrap);
export const unschedule = (scheduleId) => call(cid(), 'unschedule', scheduleId).then(unwrap);
export const runJobNow = (jobId) => call(cid(), 'run_job_now', jobId).then(unwrap);
export const jobStatus = (jobId) =>
  query(cid(), 'job_status', jobId).then((opt) => (opt.length ? opt[0] : null));
export const automationLog = () => query(cid(), 'automation_log');

// ─── Capsula del tempo: deposito dell'envelope (sigillato off-canister) ────────
//
// L'owner sigilla l'envelope nel browser (passphrase, @shared/core/crypto.js) e lo deposita opaco:
// il canister non vede mai il plaintext. Al silenzio è l'agente a consegnarlo FUORI (vedi sotto) —
// nessun wrapper di "ritiro" lato-erede ([[outbound_only]]).

/** Owner: deposita l'envelope cifrato (Uint8Array). Re-seal ri-arma il push outbound. */
export const setReleaseCapsule = (envelope) =>
  call(cid(), 'set_release_capsule', envelope).then(unwrap);

// ─── Capsula in OUTBOUND-PUSH (l'agente consegna FUORI al silenzio) — endpoint owner ──
//
// Il modello outbound: la capsula non si fa "ritirare" dall'erede; al silenzio l'agente spinge
// l'envelope (opaco, sigillato con passphrase off-canister) verso un canale `__secrets` dell'erede.
// La delivery-config dice "verso quale canale" + "dopo quanta finestra di silenzio" + `delivered`
// (flag fire-once: re-sigillare con setReleaseCapsule lo riazzera, ri-armando la consegna).

/** Owner: arma la consegna outbound (canale `__secrets` + finestra di silenzio in secondi). */
export const setDeliveryConfig = (channel, windowSecs) =>
  call(cid(), 'set_delivery_config', channel, BigInt(windowSecs)).then(unwrap);
/** Owner: disarma la consegna outbound (cancella la config). Idempotente. */
export const clearDeliveryConfig = () => call(cid(), 'clear_delivery_config').then(unwrap);
/** Owner: config di consegna corrente { channel, window_secs, delivered } o null. */
export const getDeliveryConfig = () =>
  query(cid(), 'get_delivery_config').then((opt) => (opt.length ? opt[0] : null));

// (cicli + memoria del canister vivono ora nella sezione "Canister" della settings condivisa,
//  via @shared/capabilities/settings/canister-health.js — non più una pagina Insights propria.)

export { fromBytes, toBytes };
