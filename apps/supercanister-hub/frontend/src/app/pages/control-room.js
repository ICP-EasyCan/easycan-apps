/**
 * control-room.js — Manifesto runtime + Control Room (F4 della rivoluzione).
 *
 * Il GEMELLO RUNTIME del gate hash. Il gate prova *cosa gira* (il binario); il Manifesto enumera
 * *cosa l'agente è armato a fare* — per intero, perché l'`Action` è un enum Candid CHIUSO e un Job
 * è una sequenza dichiarata, non codice opaco. Niente black-box: ogni potere armato è leggibile.
 *
 * Tutto LETTURA su query già esposte (list_jobs / list_schedules / list_bundles / automation_log /
 * last_checkin / get_delivery_config) — zero hash mosso, come F3. La provenienza (hash-ricetta) è il
 * join lato-client job.owning_bundle → bundle.sha256.
 *
 * Modello a due livelli (principio scolpito in F0): un job è ARMATO quando ha uno schedule → agisce
 * in TUA ASSENZA. La governance è il disarmo: "revocare la carta" = togliere lo schedule. Da qui
 * "Disarm" per-job e il panic "Disarm all". "Kill" elimina del tutto il job.
 */

import { el, render } from '@shared/ui/dom.js';
import {
  listJobs, listSchedules, listBundles, automationLog, lastCheckin, getDeliveryConfig,
  jobStatus, unschedule, deleteJob,
  listSecrets, setSecret, deleteSecret,
} from '../../lib/hub-api.js';
import { toast, pageHeader } from '../../lib/ui.js';

export async function renderControlRoom(container) {
  render(container, pageHeader('Control Room'), el('p', { class: 'muted' }, 'Loading…'));

  let jobs = [], schedules = [], bundles = [];
  try {
    [jobs, schedules, bundles] = await Promise.all([listJobs(), listSchedules(), listBundles()]);
  } catch (e) {
    render(container, pageHeader('Control Room'), el('p', { class: 'error' }, `Failed to load: ${e.message}`));
    return;
  }
  // Accessori: se falliscono, il manifesto resta in piedi.
  const [log, checkin, delivery, secrets] = await Promise.all([
    automationLog().catch(() => []),
    lastCheckin().catch(() => null),
    getDeliveryConfig().catch(() => null),
    listSecrets().catch(() => []),
  ]);
  // Lo status per-job è 1 query a job: best-effort, parallelo.
  const statuses = new Map(
    await Promise.all(jobs.map((j) =>
      jobStatus(j.job_id).then((s) => [j.job_id, s]).catch(() => [j.job_id, null]))),
  );

  const now = Math.floor(Date.now() / 1000);
  const bundleById = new Map(bundles.map((b) => [b.module_id, b]));
  const schedByJob = new Map(schedules.map((s) => [s.job_id, s]));

  const armed = jobs.filter((j) => schedByJob.has(j.job_id));
  const declared = jobs.filter((j) => !schedByJob.has(j.job_id));

  render(container,
    pageHeader('Control Room',
      'Everything this agent is armed to do — enumerated in full, nothing hidden. The runtime twin of the hash gate.'),
    presenceSection(checkin, now),
    delivery ? deliverySection(delivery, checkin, now) : null,
    credentialsSection(secrets, container),
    el('div', { class: 'section' },
      el('div', { class: 'cr-section-head' },
        el('h2', {}, `Armed automations (${armed.length})`),
        armed.length
          ? el('button', { class: 'btn-danger', onclick: () => doDisarmAll(schedules, container) }, '⏻ Disarm all')
          : null),
      el('p', { class: 'muted', style: 'margin:0 0 0.7rem;' }, 'These run on the canister timer — in your absence.'),
      armed.length
        ? el('div', { class: 'grid' }, ...armed.map((j) =>
            jobCard(j, schedByJob.get(j.job_id), bundleById, statuses.get(j.job_id), now, container)))
        : el('div', { class: 'empty' }, 'Nothing is armed. The agent runs nothing while you are away.')),
    el('div', { class: 'section' },
      el('h2', {}, `Set up, not armed (${declared.length})`),
      el('p', { class: 'muted', style: 'margin:0 0 0.7rem;' }, 'Present but unscheduled — they only run when you hit “Run now”.'),
      declared.length
        ? el('div', { class: 'grid' }, ...declared.map((j) =>
            jobCard(j, null, bundleById, statuses.get(j.job_id), now, container)))
        : el('div', { class: 'empty' }, 'No idle automations.')),
    el('div', { class: 'section' },
      el('h2', {}, `Activity log (${log.length})`),
      log.length
        ? el('div', { class: 'log' }, log.slice().reverse().join('\n'))
        : el('div', { class: 'empty' }, 'No automation activity yet.')),
  );
}

// ─── Presenza-owner (heartbeat F1) ─────────────────────────────────────────────

function presenceSection(checkin, now) {
  const line = checkin == null
    ? el('span', { class: 'muted' }, 'never — no heartbeat recorded yet')
    : el('span', { class: 'ok' }, `${ago(now - checkin)} ago`);
  return el('div', { class: 'section cr-presence' },
    el('h2', {}, 'Presence'),
    el('div', { class: 'meta' }, 'Last check-in: ', line),
    el('p', { class: 'muted', style: 'font-size:0.8rem; margin:0.3rem 0 0;' },
      'Server-stamped on every open. The dead-man’s switch reads this heartbeat — silence is what arms a release.'),
  );
}

// ─── Consegna outbound / capsula (F2) ──────────────────────────────────────────
//
// La capsula in outbound-push: al silenzio è l'AGENTE a spingere l'envelope sigillato verso un canale
// d'uscita dell'erede (nessun estraneo entra — [[outbound_only]]). Stato derivato dallo stesso calcolo
// del trigger host (`silence_expired`) + il flag fire-once `delivered`.

function deliverySection(delivery, checkin, now) {
  const window = Number(delivery.window_secs);
  const channel = delivery.channel;

  let status, kind;
  if (delivery.delivered) {
    status = 'DELIVERED — the agent pushed the sealed capsule out';
    kind = 'ok';
  } else if (checkin == null) {
    status = 'no heartbeat yet — delivery waits, nothing pushed (fail-closed)';
    kind = 'muted';
  } else {
    const silence = now - checkin;
    if (silence > window) { status = 'DUE NOW — silence elapsed; pushes at the next tick'; kind = 'badge danger'; }
    else { status = `armed — delivers in ${ago(window - silence)} of further silence`; kind = 'ok'; }
  }

  return el('div', { class: 'section cr-release' },
    el('h2', {}, 'Outbound delivery · time capsule'),
    el('div', { class: 'card' },
      el('div', { class: 'meta' }, 'Pushes the sealed capsule out through channel ',
        el('span', { class: 'mono' }, channel),
        ` after ${ago(window)} of your silence.`),
      el('div', { class: 'cr-status' }, el('span', { class: kind }, status)),
      el('p', { class: 'muted', style: 'font-size:0.8rem; margin:0.5rem 0 0;' },
        'No plaintext, and no key, live in the canister: only ciphertext is stored, and only ciphertext goes out. ' +
        'The heir opens it off-canister with the passphrase you handed them — nothing here can read it.'),
    ),
  );
}

// ─── Credenziali d'uscita (G1) ──────────────────────────────────────────────────
//
// La keystone del modello outbound-only: l'agente esce in modo autenticato senza tenere il segreto
// inline nel job. Un job le usa per NOME col token {{secret:NAME}}, risolto solo nei campi d'uscita.
// Etichetta ONESTA sul tier: vivono sulla subnet (non solo nel browser), send-only e revocabili.

function credentialsSection(secrets, container) {
  const nameInput = el('input', { type: 'text', placeholder: 'NAME (A-Z 0-9 _ - .)', class: 'cr-secret-name' });
  const valueInput = el('input', { type: 'password', placeholder: 'value (e.g. webhook URL or token)', class: 'cr-secret-value' });

  const add = async () => {
    const name = nameInput.value.trim();
    const value = valueInput.value;
    if (!name || !value) { toast('Name and value required', 'err'); return; }
    try {
      await setSecret(name, value);
      toast('Credential saved', 'ok');
      renderControlRoom(container);
    } catch (e) { toast(`Save failed: ${e.message}`, 'err'); }
  };

  return el('div', { class: 'section cr-credentials' },
    el('h2', {}, `Outbound credentials (${secrets.length})`),
    el('p', { class: 'muted', style: 'margin:0 0 0.7rem; font-size:0.82rem;' },
      'Referenced by name in outbound actions as ',
      el('span', { class: 'mono' }, '{{secret:NAME}}'),
      ' — resolved only in the URL/headers/body that go out, never stored in logs, KV, or step outputs.'),
    secrets.length
      ? el('div', { class: 'grid' }, ...secrets.map((s) => el('div', { class: 'card' },
          el('div', { class: 'cr-card-head' },
            el('h3', {}, s.name),
            el('span', { class: 'badge perm' }, 'send-only')),
          el('div', { class: 'meta mono' }, s.masked),
          el('div', { class: 'card-actions' },
            el('button', { class: 'btn-danger', onclick: () => doRevoke(s.name, container) }, 'Revoke')))))
      : el('div', { class: 'empty' }, 'No credentials yet.'),
    el('div', { class: 'card', style: 'margin-top:0.7rem;' },
      el('div', { class: 'cr-secret-form' }, nameInput, valueInput,
        el('button', { class: 'btn-primary', onclick: add }, 'Add')),
      el('p', { class: 'muted', style: 'font-size:0.78rem; margin:0.5rem 0 0;' },
        'Honest about the trade-off: a credential lives on the subnet that runs your code — not only in your browser. ' +
        'Keep it least-privilege (prefer a webhook URL-capability over a real API token); it is send-only and revocable here.'),
    ),
  );
}

async function doRevoke(name, container) {
  if (!confirm(`Revoke credential "${name}"? Jobs referencing it will resolve it to empty.`)) return;
  try { await deleteSecret(name); toast('Revoked', 'ok'); renderControlRoom(container); }
  catch (e) { toast(`Revoke failed: ${e.message}`, 'err'); }
}

// ─── Job card (manifesto per-job) ──────────────────────────────────────────────

function jobCard(job, schedule, bundleById, status, now, container) {
  const bundleId = job.owning_bundle.length ? job.owning_bundle[0] : null;
  const acts = job.actions.map(describeAction);
  const reachesOut = acts.some((a) => a.external);

  // Provenienza = la "ricetta" hash-verificata. owner-context = la shell (verificata al #verify);
  // bundle-context = lo sha256 del bundle installato (il gate superato all'install).
  let provenance;
  if (bundleId) {
    const b = bundleById.get(bundleId);
    provenance = b
      ? el('span', {}, 'bundle ', el('span', { class: 'mono' }, bundleId),
          ' · ', el('span', { class: 'mono', title: b.sha256 }, `sha256 ${b.sha256.slice(0, 10)}…`))
      : el('span', { class: 'mono' }, `bundle ${bundleId} (not installed)`);
  } else {
    provenance = el('span', {}, 'owner context · the shell itself (hash-verified at ',
      el('a', { href: '#verify' }, '#verify'), ')');
  }

  const schedLine = schedule
    ? el('div', { class: 'meta ok' },
        `armed · every ${ago(Number(schedule.interval_secs))} · next ${ago(Math.max(0, Number(schedule.next_run_secs) - now))}`)
    : el('div', { class: 'meta muted' }, 'not armed');

  return el('div', { class: `card ${schedule ? 'cr-armed' : ''}` },
    el('div', { class: 'cr-card-head' },
      el('h3', {}, job.job_id),
      reachesOut ? el('span', { class: 'badge danger' }, 'reaches outside') : el('span', { class: 'badge' }, 'internal only')),
    el('div', { class: 'meta', style: 'font-size:0.8rem;' }, provenance),
    el('div', { class: 'cr-actions-list' },
      ...acts.map((a) => el('div', { class: 'cr-action' },
        el('span', { class: `badge ${a.external ? 'danger' : 'perm'}` }, a.kind),
        el('span', { class: 'mono', style: 'font-size:0.78rem;' }, a.desc)))),
    job.guard.length
      ? el('div', { class: 'meta muted', style: 'font-size:0.78rem;' },
          `guard: ${job.guard[0].field} ${job.guard[0].op} ${job.guard[0].value}`)
      : null,
    schedLine,
    status ? el('div', { class: 'meta muted', style: 'font-size:0.78rem;' }, `last status: ${status}`) : null,
    el('div', { class: 'card-actions' },
      schedule
        ? el('button', { class: 'btn-secondary', onclick: () => doDisarm(schedule.schedule_id, container) }, 'Disarm')
        : null,
      el('button', { class: 'btn-danger', onclick: () => doKill(job.job_id, container) }, 'Kill'),
    ),
  );
}

/** Enumera un'azione PER INTERO (l'enum è chiuso). `external` = "esce fuori" del modello a due livelli. */
function describeAction(action) {
  const k = Object.keys(action)[0];
  const v = action[k];
  switch (k) {
    case 'KvSet': return { kind: `kv:${v.namespace}`, desc: `set ${v.key}`, external: false };
    case 'KvGet': return { kind: `kv:${v.namespace}`, desc: `read ${v.key}`, external: false };
    case 'KvDel': return { kind: `kv:${v.namespace}`, desc: `delete ${v.key}`, external: false };
    case 'CryptoHash': return { kind: 'hash', desc: `sha256(${v.input})`, external: false };
    case 'Http': return { kind: 'http', desc: `${v.method} ${hostOf(v.url)}`, external: true };
    case 'CanisterCall':
      return { kind: 'call', desc: `${shortId(v.canister_id)} · ${v.method}`, external: true };
    default: return { kind: k, desc: '(unknown action)', external: true };
  }
}

// ─── Azioni di governo ─────────────────────────────────────────────────────────

async function doDisarm(scheduleId, container) {
  try { await unschedule(scheduleId); toast('Disarmed', 'ok'); renderControlRoom(container); }
  catch (e) { toast(`Disarm failed: ${e.message}`, 'err'); }
}

async function doKill(jobId, container) {
  if (!confirm(`Kill job "${jobId}"? This deletes it entirely.`)) return;
  try { await deleteJob(jobId); toast('Killed', 'ok'); renderControlRoom(container); }
  catch (e) { toast(`Kill failed: ${e.message}`, 'err'); }
}

/** Panic: disarma TUTTI gli schedule (non distrugge i job). Re-armare = ri-schedulare. */
async function doDisarmAll(schedules, container) {
  if (!confirm(`Disarm all ${schedules.length} armed job(s)? They stop running on the canister timer.\nThe jobs are kept — re-arm by scheduling again.`)) return;
  let failed = 0;
  for (const s of schedules) {
    try { await unschedule(s.schedule_id); } catch { failed++; }
  }
  toast(failed ? `Disarmed, ${failed} error(s)` : 'All jobs disarmed', failed ? 'err' : 'ok');
  renderControlRoom(container);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Host di una URL (templating-safe: se non parsabile, mostra il raw). */
function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function shortId(id) {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** Durata in secondi → stringa umana compatta. */
function ago(secs) {
  secs = Math.max(0, Math.floor(secs));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}
