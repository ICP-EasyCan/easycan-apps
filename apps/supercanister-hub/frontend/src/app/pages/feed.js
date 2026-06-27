/**
 * feed.js — Feed-home (F5 della rivoluzione): la home come RACCONTO dell'agente, non una griglia di icone.
 *
 * La tesi di F0 (prodotto = agente sovrano, non launcher) resa percepibile: la prima cosa che vedi
 * è cosa il tuo computer ha fatto mentre non c'eri e cosa farà — "03:00 controllati i tuoi siti,
 * tutti verdi… tra 312 giorni si apre la capsula". Le mini-app restano, ma non sono più il volto.
 *
 * Tono editoriale = DIGEST CALMO (decisione Andrea, F5): mostra solo ciò che merita attenzione
 * (anomalie) + l'orizzonte (futuro); la routine è collassata in una riga-sommario. Il rischio vero
 * di F5 è di PRODOTTO (il feed non deve diventare rumore), non tecnico.
 *
 * Invariante di fiducia: il feed è una RESA di dati già verificabili (list_jobs/list_schedules/
 * automation_log/last_checkin/get_delivery_config), MAI inventato — ogni riga è tracciabile, gemello
 * narrativo del gate hash. Il giudizio editoriale (anomalia vs routine) è DERIVATO dallo status/
 * external/guardia/capsula, non da una categoria dichiarata (anti-DSL: nessun `kind` sul Job).
 * L'audit per-intero (azioni, host, provenienza-hash) vive nella Control Room: il feed vi rimanda.
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate }   from '@shared/ui/router.js';
import {
  listJobs, listSchedules, automationLog, lastCheckin, getDeliveryConfig, listBundles,
} from '../../lib/hub-api.js';
import { pageHeader } from '../../lib/ui.js';

export async function renderFeed(container) {
  render(container, pageHeader('Home'), el('p', { class: 'muted' }, 'Loading…'));

  let jobs = [], schedules = [];
  try {
    [jobs, schedules] = await Promise.all([listJobs(), listSchedules()]);
  } catch (e) {
    render(container, pageHeader('Home'), el('p', { class: 'error' }, `Failed to load: ${e.message}`));
    return;
  }
  // Accessori: se uno fallisce, il racconto resta in piedi.
  const [log, checkin, delivery, bundles] = await Promise.all([
    automationLog().catch(() => []),
    lastCheckin().catch(() => null),
    getDeliveryConfig().catch(() => null),
    listBundles().catch(() => []),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const titleOf = makeTitleLookup(jobs);
  const schedByJob = new Map(schedules.map((s) => [s.job_id, s]));

  // ─── Resa del log in attività per-job (collassa la routine) ──────────────────
  const activity = summarizeLog(log);              // Map<job_id, {total, completed, skipped, failed, lastStatus, lastTs}>
  const anomalies = collectAnomalies(activity, titleOf, delivery, checkin, now);
  const horizon = collectHorizon(jobs, schedByJob, delivery, checkin, now, titleOf);

  // Se l'agente è del tutto inerte — nessuno dei 3 verbi avviato (niente mini-app installate,
  // niente automazioni/storia, niente capsula armata) → first-run "Start here".
  const inert = jobs.length === 0 && !delivery && log.length === 0 && bundles.length === 0;

  render(container,
    heroSection(checkin, now, jobs.length, schedules.length),
    inert ? emptyState() : null,
    horizon.length
      ? section('On the horizon', 'What your agent will do next — even while you’re away.',
          el('div', { class: 'feed-list' }, ...horizon))
      : null,
    anomalies.length
      ? section('Needs your attention', 'Out of the ordinary — surfaced, not buried.',
          el('div', { class: 'feed-list feed-attention' }, ...anomalies))
      : null,
    !inert ? routineSection(activity, titleOf) : null,
    !inert ? footerLinks() : null,
  );
}

// ─── Hero: lo stato dell'agente in una frase ────────────────────────────────────

function heroSection(checkin, now, jobCount, schedCount) {
  const presence = checkin == null
    ? 'This is the start of your record — your agent begins keeping watch now.'
    : `You were last here ${ago(now - checkin)} ago. Your agent kept your computer awake since.`;
  const armed = schedCount
    ? `${schedCount} armed to run in your absence`
    : 'nothing armed yet';
  return el('div', { class: 'feed-hero' },
    el('h1', {}, 'Your sovereign computer'),
    el('p', { class: 'feed-hero-sub' }, presence),
    el('p', { class: 'muted', style: 'font-size:0.82rem; margin:0.4rem 0 0;' },
      `${jobCount} ${plural(jobCount, 'automation')} · ${armed}.`),
  );
}

// ─── Orizzonte (futuro): prossimi run armati + countdown capsula ─────────────────

function collectHorizon(jobs, schedByJob, delivery, checkin, now, titleOf) {
  const items = [];

  // Capsula in outbound-push: countdown finché è armata e non ancora consegnata (gemello Control Room).
  if (delivery && !delivery.delivered && checkin != null) {
    const window = Number(delivery.window_secs);
    const silence = now - checkin;
    if (silence <= window) {
      items.push(feedLine('🜍',
        el('span', {}, `In ${ago(window - silence)} of further silence, your agent delivers the time capsule to `,
          el('span', { class: 'mono' }, delivery.channel), '.'),
        'Each time you visit, the timer resets — silence is what sends it.'));
    }
  } else if (delivery && !delivery.delivered && checkin == null) {
    items.push(feedLine('🜍', 'A time capsule is armed, waiting for the first heartbeat to start its clock.', null));
  }

  // Job armati: ordina per prossimo run (il più imminente prima).
  const armed = jobs
    .filter((j) => schedByJob.has(j.job_id))
    .map((j) => ({ j, s: schedByJob.get(j.job_id) }))
    .sort((a, b) => Number(a.s.next_run_secs) - Number(b.s.next_run_secs));

  for (const { j, s } of armed) {
    const inSecs = Math.max(0, Number(s.next_run_secs) - now);
    items.push(feedLine('↻',
      el('span', {}, el('strong', {}, titleOf(j.job_id)), ` runs again in ${ago(inSecs)}`),
      `every ${ago(Number(s.interval_secs))}`));
  }
  return items;
}

// ─── Attenzione (anomalie): fallimenti + capsula aperta ──────────────────────────

function collectAnomalies(activity, titleOf, delivery, checkin, now) {
  const items = [];

  // Capsula = l'evento più forte: il dead-man's switch è scattato. Due stati:
  //  - già CONSEGNATA (delivered): l'agente l'ha spinta fuori.
  //  - DOVUTA ma non ancora consegnata (silenzio scaduto fra due tick): consegna imminente, ancora fermabile.
  if (delivery && delivery.delivered) {
    items.push(feedLine('📤',
      el('span', {}, 'Your time capsule was ', el('strong', {}, 'delivered'), ' — the silence window elapsed and your agent pushed it to ',
        el('span', { class: 'mono' }, delivery.channel), '.'),
      'If this is unexpected, your absence triggered it. Re-seal on the capsule page to arm a new one.', 'danger'));
  } else if (delivery && checkin != null && now - checkin > Number(delivery.window_secs)) {
    items.push(feedLine('🔓',
      el('span', {}, 'Your time capsule is ', el('strong', {}, 'due to deliver'), ' — the silence window elapsed; your agent pushes it to ',
        el('span', { class: 'mono' }, delivery.channel), ' at its next tick.'),
      'If this is unexpected, check in now to hold it back.', 'danger'));
  }

  // Fallimenti: un job che ha errato merita lo sguardo (≠ routine verde).
  for (const [jobId, a] of activity) {
    if (a.failed > 0) {
      items.push(feedLine('⚠',
        el('span', {}, el('strong', {}, titleOf(jobId)), ` failed ${a.failed}×`),
        a.lastStatus.startsWith('Failed') ? `last: ${a.lastStatus}` : null, 'danger'));
    }
    // Consegna respinta (G3, Rilievo 4): la richiesta è partita ma il destinatario l'ha rifiutata
    // (4xx/5xx) — il job risulta "fatto" ma l'avviso NON è arrivato. Non muore muto: sale qui.
    if (a.delivery > 0) {
      items.push(feedLine('📵',
        el('span', {}, el('strong', {}, titleOf(jobId)),
          ` couldn’t deliver — a destination rejected the request ${a.delivery}×`),
        `${a.lastDelivery || 'non-2xx response'} · check the channel’s webhook in the Control Room`, 'danger'));
    }
  }
  return items;
}

// ─── Routine collassata (una riga calma, non un log) ─────────────────────────────

function routineSection(activity, titleOf) {
  // Solo gli esiti benigni (Completed/Skipped); i Failed sono già saliti in "attenzione".
  const benign = [...activity.entries()].filter(([, a]) => a.completed + a.skipped > 0);
  if (!benign.length) {
    return section('Quietly handled', null,
      el('p', { class: 'muted' }, 'Nothing has run yet — once your jobs are armed, their routine lives here.'));
  }
  const totalRuns = benign.reduce((n, [, a]) => n + a.completed + a.skipped, 0);
  const lines = benign
    .sort((x, y) => (y[1].completed + y[1].skipped) - (x[1].completed + x[1].skipped))
    .map(([jobId, a]) => {
      const runs = a.completed + a.skipped;
      const tail = a.skipped
        ? `${a.completed} done · ${a.skipped} skipped (guard held)`
        : 'all completed';
      return el('li', {},
        el('strong', {}, titleOf(jobId)), ` — ${runs} ${plural(runs, 'run')}, ${tail}.`);
    });
  return section('Quietly handled',
    `While you were away, your agent did its rounds — ${totalRuns} ${plural(totalRuns, 'run')}, nothing needing you.`,
    el('ul', { class: 'feed-routine' }, ...lines));
}

// ─── First-run "Start here": l'agente è vergine → i 3 verbi della shell ───────────
//
// Doppio volto della Home (F3): qui l'agente non ha ancora nulla (nessuna mini-app, automazione
// o capsula). Invece del digest, mostriamo le tre cose che il computer sa fare — nominate per
// RISULTATO, non per mattone — riusando il vocabolario visivo delle ricette (recipe-card).

function emptyState() {
  const verb = (icon, title, desc, route) =>
    el('div', { class: 'card recipe-card' },
      el('div', { class: 'recipe-icon' }, icon),
      el('h3', {}, title),
      el('p', { class: 'muted', style: 'font-size:0.85rem;' }, desc),
      el('div', { class: 'card-actions' },
        el('button', { class: 'btn-primary', onclick: () => navigate(route) }, title)));

  return section('Start here', 'Your computer can do three kinds of things — pick one to begin.',
    el('div', { class: 'grid' },
      verb('🧩', 'Install a mini-app',
        'Add a small app — to-dos, bookmarks, habits — sandboxed and verified by hash.', '#mini-apps'),
      verb('🛰', 'Create an automation',
        'Have your computer watch something and act on its own, even while you’re away.', '#automations'),
      verb('🜍', 'Seal a time capsule',
        'Leave a sealed message your computer delivers to someone you trust if you go silent.', '#capsule')));
}

function footerLinks() {
  return el('p', { class: 'muted feed-footer', style: 'font-size:0.82rem;' },
    'Every line above is read from on-chain state, never invented. ',
    el('a', { href: '#control-room' }, 'See it all in the Control Room →'));
}

// ─── Resa del log ────────────────────────────────────────────────────────────────

/** Le entry del log sono `"{ts} {job_id} {status}"` (vedi cap-automation `log_push`). */
function summarizeLog(log) {
  const m = new Map();
  for (const line of log) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;
    const { ts, jobId, status } = parsed;
    const a = m.get(jobId) || { total: 0, completed: 0, skipped: 0, failed: 0, delivery: 0, lastDelivery: null, lastStatus: status, lastTs: ts };
    // "Outbound HTTP NNN" (G3, Rilievo 4) è una NOTA accanto all'esito, non un esito: la richiesta è
    // partita ma il peer l'ha respinta (4xx/5xx). Non conta come run né tocca lastStatus.
    if (status.startsWith('Outbound')) {
      a.delivery += 1;
      a.lastDelivery = status;
    } else {
      a.total += 1;
      if (status === 'Completed') a.completed += 1;
      else if (status === 'Skipped') a.skipped += 1;
      else if (status.startsWith('Failed')) a.failed += 1;
      if (ts >= a.lastTs) { a.lastTs = ts; a.lastStatus = status; }
    }
    m.set(jobId, a);
  }
  return m;
}

/** `"1700000000 daily-backup Completed"` → {ts, jobId, status}. status può essere `Failed:<msg>`. */
function parseLogLine(line) {
  const mt = /^(\d+)\s+(.+?)\s+(Completed|Skipped|Failed.*|Outbound.*)$/.exec(line);
  if (!mt) return null;
  return { ts: Number(mt[1]), jobId: mt[2], status: mt[3] };
}

/** job_id → titolo umano (se il Job lo dichiara) o l'id stesso. Robusto ai job cancellati. */
function makeTitleLookup(jobs) {
  const m = new Map(jobs.map((j) => [j.job_id, j.title && j.title.length ? j.title[0] : j.job_id]));
  return (jobId) => m.get(jobId) || jobId;
}

// ─── Mattoni UI ───────────────────────────────────────────────────────────────────

function section(title, sub, ...body) {
  return el('div', { class: 'section feed-section' },
    el('h2', {}, title),
    sub ? el('p', { class: 'muted', style: 'margin:0 0 0.7rem;' }, sub) : null,
    ...body);
}

/** Una riga di racconto: glifo + frase + dettaglio scommesso. `tone` colora le anomalie. */
function feedLine(glyph, body, detail, tone) {
  return el('div', { class: `feed-line ${tone === 'danger' ? 'feed-danger' : ''}` },
    el('span', { class: 'feed-glyph' }, glyph),
    el('div', { class: 'feed-body' },
      el('div', {}, body),
      detail ? el('div', { class: 'muted', style: 'font-size:0.78rem; margin-top:0.15rem;' }, detail) : null));
}

function plural(n, word) { return n === 1 ? word : `${word}s`; }

/** Durata in secondi → stringa umana compatta (gemella della Control Room). */
function ago(secs) {
  secs = Math.max(0, Math.floor(secs));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}
