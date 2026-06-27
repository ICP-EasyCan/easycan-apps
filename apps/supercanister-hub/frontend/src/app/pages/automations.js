/**
 * automations.js — la scheda "Automations", organizzata a 3 strati (facile → tecnico):
 *
 *  ① Recipe gallery — card grandi a nome-risultato (Time Capsule, Watch & Notify, …): ogni card è
 *     un oggetto preconfezionato che fa qualcosa, componibile senza scrivere azioni/JSON.
 *  ② Active — ciò che il computer sta facendo da solo, in linguaggio-da-risultato (titolo umano +
 *     cadenza + prossima esecuzione; include la capsula armata). Niente job/guard/KvSet/ns.
 *  ③ ▸ Advanced — il builder grezzo: New job + griglia Jobs tecnica + Activity log + how-it-works.
 *     Resta intatto e potente, ma chiuso e invisibile al neofita.
 *
 * Un job = job_id + sequenza di azioni + guardia opzionale, eseguito sotto i permessi di
 * `owning_bundle` (vuoto = contesto Owner). Azioni interne KvSet/KvGet/KvDel/CryptoHash (F3) +
 * esterne permission-gated Http (F3b) e CanisterCall (F3c). Lo scheduler NON crea timer per-job:
 * gli schedule vivono in stable, eseguiti dal tick unico di core-timer (run_due).
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate }   from '@shared/ui/router.js';
import {
  listJobs, createJob, deleteJob, listSchedules, scheduleJob, unschedule,
  runJobNow, jobStatus, automationLog, listSecrets, setSecret,
  getDeliveryConfig, lastCheckin,
} from '../../lib/hub-api.js';
import { toast, pageHeader } from '../../lib/ui.js';

const OPS = ['KvSet', 'KvGet', 'KvDel', 'CryptoHash', 'Http', 'CanisterCall'];
const HTTP_METHODS = ['GET', 'POST', 'HEAD'];

export async function renderAutomations(container) {
  render(container, pageHeader('Automations'), el('p', { class: 'muted' }, 'Loading…'));

  let jobs = [];
  let schedules = [];
  try {
    [jobs, schedules] = await Promise.all([listJobs(), listSchedules()]);
  } catch (e) {
    render(container, pageHeader('Automations'), el('p', { class: 'error' }, `Failed to load: ${e.message}`));
    return;
  }
  // Accessori: se uno fallisce, la pagina resta in piedi (il log era la vecchia sezione Insights).
  // capsule/last = lo stato della Time Capsule, mostrato in "Active" come una cosa che gira.
  const [log, secrets, capsule, last] = await Promise.all([
    automationLog().catch(() => []),
    listSecrets().catch(() => []),
    getDeliveryConfig().catch(() => null),
    lastCheckin().catch(() => null),
  ]);

  const schedByJob = new Map(schedules.map((s) => [s.job_id, s]));

  render(container,
    pageHeader('Automations', 'Ready-made things your computer does for you — and a builder for your own.'),
    gallerySection(container, secrets),
    activeSection(container, jobs, schedByJob, capsule, last),
    advancedDetails(container, jobs, schedByJob, log),
  );
}

// ─── ① Recipe gallery ─────────────────────────────────────────────────────────
//
// Card grandi a nome-risultato. Ogni card è un "oggetto preconfezionato che fa cose": la Capsula
// vive nella sua pagina (#capsule), Watch & Notify apre il suo wizard inline qui sotto.

function gallerySection(container, secrets) {
  // Il wizard Watch & Notify è renderizzato nascosto: la card lo rivela (toggle + scroll).
  const watchWizard = el('div', { style: 'display:none; margin-top:1rem;' }, recipeSection(container, secrets));
  const revealWatch = () => {
    const open = watchWizard.style.display === 'none';
    watchWizard.style.display = open ? 'block' : 'none';
    if (open) watchWizard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const recipe = (icon, title, desc, onclick, disabled) =>
    el('div', { class: `card recipe-card${disabled ? ' disabled' : ''}` },
      el('div', { class: 'recipe-icon' }, icon),
      el('h3', {}, title),
      el('p', { class: 'muted', style: 'font-size:0.85rem;' }, desc),
      disabled
        ? el('div', { class: 'meta muted' }, 'Coming soon')
        : el('div', { class: 'card-actions' }, el('button', { class: 'btn-primary', onclick }, 'Set it up')));

  return el('div', { class: 'section' },
    el('h2', {}, 'Recipes'),
    el('div', { class: 'grid' },
      recipe('🜍', 'Time Capsule',
        'A sealed message your computer delivers to someone you trust if you go silent.',
        () => navigate('#capsule'), false),
      recipe('🛰', 'Watch & Notify',
        'Keep an eye on a value and reach out to you the moment it crosses a line.',
        revealWatch, false),
      recipe('✨', 'More coming',
        'New ready-made automations land here over time.',
        null, true)),
    watchWizard,
  );
}

// ─── ② Active — ciò che il computer fa da solo, in linguaggio-da-risultato ──────

function activeSection(container, jobs, schedByJob, capsule, last) {
  const cards = [];

  // I job schedulati = le automazioni che girano (gli altri sono bozze → vivono in Advanced).
  for (const job of jobs) {
    const schedule = schedByJob.get(job.job_id);
    if (schedule) cards.push(activeJobCard(job, schedule, container));
  }
  // La capsula armata è una cosa che gira: una riga read-only che porta alla sua pagina.
  if (capsule) cards.push(activeCapsuleCard(capsule, last));

  const body = cards.length
    ? el('div', { class: 'grid' }, ...cards)
    : el('div', { class: 'empty' }, el('p', {}, 'Nothing running yet — start from a recipe above ↑'));

  return el('div', { class: 'section' },
    el('h2', {}, `Active${cards.length ? ` (${cards.length})` : ''}`),
    body);
}

function activeJobCard(job, schedule, container) {
  const title = job.title && job.title.length ? job.title[0] : job.job_id;
  const cadence = fmtEvery(Number(schedule.interval_secs));
  const nextIn = Math.max(0, Number(schedule.next_run_secs) - Math.floor(Date.now() / 1000));

  return el('div', { class: 'card cr-armed' },
    el('h3', {}, title),
    el('p', { class: 'muted', style: 'font-size:0.88rem; margin:0.2rem 0 0;' },
      `Runs ${cadence} · next in ~${fmtIn(nextIn)}`),
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn-secondary', onclick: () => doRun(job.job_id, container) }, 'Run now'),
      el('button', { class: 'btn-secondary', onclick: () => doPause(schedule.schedule_id, container) }, 'Pause')),
  );
}

function activeCapsuleCard(capsule, last) {
  const windowSecs = Number(capsule.window_secs);
  let line;
  if (capsule.delivered) {
    line = '📤 Delivered — re-seal to arm a new one.';
  } else if (last != null) {
    const remaining = Math.max(0, windowSecs - (Date.now() / 1000 - last));
    line = `🔒 Delivers after ~${fmtEverySecs(Math.round(remaining))} of further silence.`;
  } else {
    line = '🔒 Armed — waiting for the first heartbeat to start its clock.';
  }
  return el('div', { class: 'card cr-armed' },
    el('h3', {}, 'Time Capsule'),
    el('p', { class: 'muted', style: 'font-size:0.88rem; margin:0.2rem 0 0;' }, line),
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn-secondary', onclick: () => navigate('#capsule') }, 'Manage')),
  );
}

async function doPause(scheduleId, container) {
  if (!confirm('Pause this automation? It stops running until you set it up again.')) return;
  try { await unschedule(scheduleId); toast('Paused', 'ok'); renderAutomations(container); }
  catch (e) { toast(`Pause failed: ${e.message}`, 'err'); }
}

/** "every 15 minutes" / "every hour" — cadenza in linguaggio-da-risultato (no secondi grezzi). */
function fmtEvery(secs) {
  const e = fmtEverySecs(secs);
  return e.startsWith('1 ') ? `every ${e.slice(2)}` : `every ${e}`;
}
function fmtEverySecs(secs) {
  const units = [['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, mult] of units) {
    if (secs >= mult && secs % mult === 0) { const n = secs / mult; return `${n} ${name}${n === 1 ? '' : 's'}`; }
  }
  return `${secs} second${secs === 1 ? '' : 's'}`;
}
function fmtIn(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

// ─── ③ Advanced — il builder grezzo, chiuso e fuori dalla vista del neofita ─────

function advancedDetails(container, jobs, schedByJob, log) {
  return el('details', { class: 'section' },
    el('summary', {}, 'Advanced — raw automation builder'),
    el('p', { class: 'muted', style: 'font-size:0.85rem;' },
      'Declared action sequences (store reads/writes, hashing, HTTP, canister calls), scheduled to run while your browser is closed.'),
    introSection(),
    createSection(container),
    el('div', { class: 'section' },
      el('h2', {}, `Jobs (${jobs.length})`),
      jobs.length
        ? el('div', { class: 'grid' }, ...jobs.map((j) => jobCard(j, schedByJob.get(j.job_id), container)))
        : el('div', { class: 'empty' }, 'No jobs yet.')),
    el('div', { class: 'section' },
      el('h2', {}, `Activity log (${log.length})`),
      log.length
        ? el('div', { class: 'log' }, log.slice().reverse().join('\n'))
        : el('div', { class: 'empty' }, 'No automation activity yet.')),
  );
}

// ─── Ricetta guidata "Sorveglia X → avvisami" (G3) ───────────────────────────
//
// Il percorso canonico del modello outbound-only, componibile da un non-tecnico SENZA scrivere
// azioni/JSON: l'agente esce a leggere un valore (Http GET), lo confronta con una soglia (guardia),
// e SOLO se la condizione vale consegna un avviso a un canale preso dal registro __secrets
// ({{secret:NAME}} risolto solo in uscita). Emette esattamente lo stesso payload del builder grezzo
// (create_job + schedule_job) — è zucchero ergonomico, non una primitiva nuova.

function recipeSection(container, secrets) {
  const nameIn = el('input', { type: 'text', placeholder: 'e.g. Watch BTC price' });
  const urlIn = el('input', { type: 'text', placeholder: 'https://api.example.com/value', style: 'flex:2;' });
  const fieldIn = el('input', { type: 'text', placeholder: 'JSON field, e.g. price (optional)' });
  const opSel = el('select', {}, ...['>', '>=', '<', '<=', '==', '!=', 'contains'].map((o) => el('option', { value: o }, o)));
  const thresholdIn = el('input', { type: 'text', placeholder: 'value, e.g. 100000' });
  const msgIn = el('input', { type: 'text', value: 'Heads up — the value you are watching is now {{step0}}.', style: 'flex:2;' });
  const everyIn = el('input', { type: 'number', value: '15', style: 'max-width:90px;' });
  const unitSel = el('select', {}, el('option', { value: '60' }, 'minutes'), el('option', { value: '3600' }, 'hours'));

  // ── Canale di consegna: scelto dal registro __secrets (un webhook salvato come segreto). ──
  const channelSel = el('select', {},
    el('option', { value: '' }, secrets.length ? '— pick a channel —' : '— no channels yet —'),
    ...secrets.map((s) => el('option', { value: s.name }, s.name)));

  // Aggiunta inline di un canale, così il non-tecnico non rimbalza alla Control Room.
  const newChanName = el('input', { type: 'text', placeholder: 'NAME (e.g. DISCORD)', style: 'max-width:160px;' });
  const newChanUrl = el('input', { type: 'password', placeholder: 'webhook URL', style: 'flex:2;' });
  const addChannel = async () => {
    const name = newChanName.value.trim();
    const url = newChanUrl.value;
    if (!name || !url) { toast('Channel name and webhook URL required', 'err'); return; }
    try {
      await setSecret(name, url);
      // In-place: aggiungo l'opzione e la seleziono, senza re-render (preservo la ricetta in corso).
      channelSel.append(el('option', { value: name }, name));
      channelSel.value = name;
      newChanName.value = ''; newChanUrl.value = '';
      addForm.style.display = 'none';
      toast('Channel saved', 'ok');
    } catch (e) { toast(`Save failed: ${e.message}`, 'err'); }
  };
  const addForm = el('div', { class: 'form-row', style: 'display:none; margin-top:0.4rem;' },
    newChanName, newChanUrl, el('button', { class: 'btn-secondary', onclick: addChannel }, 'Save channel'));
  const addToggle = el('button', { class: 'btn-ghost', onclick: () => {
    addForm.style.display = addForm.style.display === 'none' ? 'flex' : 'none';
  } }, '+ add a channel');

  async function arm() {
    const name = nameIn.value.trim();
    const url = urlIn.value.trim();
    const channel = channelSel.value;
    const threshold = thresholdIn.value.trim();
    const message = msgIn.value;
    if (!name) { toast('Give your watch a name', 'err'); return; }
    if (!url) { toast('Enter the URL to watch', 'err'); return; }
    if (!channel) { toast('Pick a delivery channel (or add one)', 'err'); return; }
    if (!threshold) { toast('Enter the value to compare against', 'err'); return; }

    const jobId = slugify(name);
    if (!jobId) { toast('Name must contain letters or numbers', 'err'); return; }
    const interval = Math.max(1, (parseInt(everyIn.value, 10) || 0) * parseInt(unitSel.value, 10));
    const field = fieldIn.value.trim() ? `step0.${fieldIn.value.trim()}` : 'step0';

    // step0 = leggi il valore esterno; step1 = consegna l'avviso al canale (solo se la guardia tiene).
    const job = {
      job_id: jobId,
      owning_bundle: [],
      actions: [
        { Http: { method: 'GET', url, headers: [], body: '', max_response_bytes: 0n } },
        { Http: { method: 'POST', url: `{{secret:${channel}}}`, headers: [], body: message, max_response_bytes: 0n } },
      ],
      guard: [{ field, op: opSel.value, value: threshold }],
      title: [name],
    };
    try {
      await createJob(job);
      await scheduleJob(jobId, interval);
      toast('Watch armed — it runs on the canister, even while you are away', 'ok');
      renderAutomations(container);
    } catch (e) { toast(`Couldn’t arm the watch: ${e.message}`, 'err'); }
  }

  const labelled = (text, ...kids) => el('div', { style: 'flex:1;' }, el('label', {}, text), ...kids);

  return el('div', { class: 'section recipe' },
    el('h2', {}, '🛰  Watch something → get notified'),
    el('p', { class: 'muted', style: 'margin:0 0 0.9rem;' },
      'Your agent checks a value on a schedule and reaches out to you when it crosses a line — no code, no JSON.'),
    el('div', { class: 'form-row' }, labelled('Name this watch', nameIn)),
    el('div', { class: 'form-row' },
      labelled('Watch this URL', urlIn),
      labelled('Look at this field', fieldIn)),
    el('div', { class: 'form-row' },
      el('div', {}, el('label', {}, 'Notify me when the value is'), opSel),
      labelled('…this', thresholdIn)),
    el('div', { class: 'form-row' }, labelled('Message to send', msgIn)),
    el('div', { class: 'recipe-channel', style: 'margin-top:0.2rem;' },
      el('label', {}, 'Reach me through'),
      el('div', { class: 'form-row' }, el('div', { style: 'flex:1;' }, channelSel), addToggle),
      addForm,
      el('p', { class: 'muted', style: 'font-size:0.78rem; margin:0.3rem 0 0;' },
        'A channel is a webhook URL kept as a send-only credential. It lives on the subnet that runs your code; revoke it anytime in the Control Room.')),
    el('div', { class: 'form-row', style: 'margin-top:0.6rem; align-items:flex-end;' },
      el('div', {}, el('label', {}, 'Check every'), el('div', { class: 'form-row' }, everyIn, unitSel)),
      el('button', { class: 'btn-primary', style: 'margin-left:auto;', onclick: arm }, 'Arm this watch')),
  );
}

/** "Watch BTC price" → "watch-btc-price" (charset job_id: minuscole/cifre/trattino). */
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// ─── Help / intro ───────────────────────────────────────────────────────────

/** Spiega il modello: cos'è un job, il templating, la guardia, lo scheduling. */
function introSection() {
  const li = (strong, rest) => el('li', {}, el('strong', {}, strong), rest);
  return el('details', { class: 'section help' },
    el('summary', {}, 'How automations work'),
    el('ul', { class: 'help-list' },
      li('A job is a sequence of actions ', 'run top-to-bottom: store reads/writes (KvGet/KvSet/KvDel), a hash (CryptoHash), an HTTP request (Http), or a call to another canister (CanisterCall).'),
      li('Chaining ', 'a later action can reuse an earlier step\'s output with {{step0}} (or {{step0.field}} for a JSON field).'),
      li('Guard ', 'an optional single condition checked before the effect — if it\'s false, the remaining actions are skipped.'),
      li('Owning bundle ', 'leave empty to run as the owner; set a bundle id to confine the job to that bundle\'s declared permissions.'),
      li('Schedule ', 'set an interval and the job runs on the canister\'s timer — even while your browser is closed.'),
    ),
  );
}

// ─── Job card ─────────────────────────────────────────────────────────────────

function jobCard(job, schedule, container) {
  const ctx = job.owning_bundle.length ? `bundle ${job.owning_bundle[0]}` : 'owner';
  const actionsDesc = job.actions.map((a) => Object.keys(a)[0]).join(' → ');

  const schedLine = schedule
    ? el('div', { class: 'meta ok' }, `scheduled every ${Number(schedule.interval_secs)}s (next: ${Number(schedule.next_run_secs)})`)
    : el('div', { class: 'meta muted' }, 'not scheduled');

  const intervalIn = el('input', { type: 'number', placeholder: 'interval (s)', value: '60', style: 'max-width:120px;' });

  const title = job.title && job.title.length ? job.title[0] : null;
  return el('div', { class: 'card' },
    el('h3', {}, title || job.job_id),
    title ? el('div', { class: 'mono muted', style: 'font-size:0.72rem;' }, job.job_id) : null,
    el('div', { class: 'meta' }, `${ctx} · ${job.actions.length} actions${job.guard.length ? ' · guarded' : ''}`),
    el('div', { class: 'mono muted', style: 'font-size:0.78rem; margin-top:0.3rem;' }, actionsDesc || '(no actions)'),
    schedLine,
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn-secondary', onclick: () => doRun(job.job_id, container) }, 'Run now'),
      schedule
        ? el('button', { class: 'btn-secondary', onclick: () => doUnschedule(schedule.schedule_id, container) }, 'Unschedule')
        : el('div', { class: 'form-row', style: 'flex:1;' },
            intervalIn,
            el('button', { class: 'btn-primary', onclick: () => doSchedule(job.job_id, intervalIn.value, container) }, 'Schedule')),
      el('button', { class: 'btn-danger', onclick: () => doDelete(job.job_id, container) }, 'Delete'),
    ),
  );
}

async function doRun(jobId, container) {
  try {
    const outcome = await runJobNow(jobId);
    const status = await jobStatus(jobId);
    toast(`Ran: ${Object.keys(outcome)[0]}${status ? ` — ${status}` : ''}`, 'ok');
    renderAutomations(container);
  } catch (e) { toast(`Run failed: ${e.message}`, 'err'); }
}
async function doSchedule(jobId, interval, container) {
  const secs = parseInt(interval, 10);
  if (!secs || secs < 1) { toast('Interval must be a positive number', 'err'); return; }
  try { await scheduleJob(jobId, secs); toast('Scheduled', 'ok'); renderAutomations(container); }
  catch (e) { toast(`Schedule failed: ${e.message}`, 'err'); }
}
async function doUnschedule(scheduleId, container) {
  try { await unschedule(scheduleId); toast('Unscheduled', 'ok'); renderAutomations(container); }
  catch (e) { toast(`Unschedule failed: ${e.message}`, 'err'); }
}
async function doDelete(jobId, container) {
  if (!confirm(`Delete job "${jobId}"?`)) return;
  try { await deleteJob(jobId); toast('Deleted', 'ok'); renderAutomations(container); }
  catch (e) { toast(`Delete failed: ${e.message}`, 'err'); }
}

// ─── Create form (action sequence builder) ────────────────────────────────────

function createSection(container) {
  const idIn = el('input', { type: 'text', placeholder: 'daily-backup' });
  const titleIn = el('input', { type: 'text', placeholder: 'e.g. Watch my websites' });
  const bundleIn = el('input', { type: 'text', placeholder: '(empty = owner context)' });
  const actionsBox = el('div', {});

  function actionRow(op0) {
    const opSel = el('select', {}, ...OPS.map((o) => el('option', { value: o }, o)));
    opSel.value = op0;
    // I campi sono ricostruiti per-op: KV/CryptoHash restano semplici; Http e CanisterCall
    // (azioni esterne F3b/F3c, permission-gated) hanno i loro campi dedicati.
    const fieldsBox = el('div', { class: 'form-row', style: 'flex:1; flex-wrap:wrap;' });

    const syncFields = () => {
      const op = opSel.value;
      const ins = {};
      const mk = (key, attrs) => { const i = el('input', attrs); ins[key] = i; return i; };
      fieldsBox.replaceChildren();
      if (op === 'KvSet') {
        fieldsBox.append(
          mk('ns', { type: 'text', placeholder: 'namespace' }),
          mk('key', { type: 'text', placeholder: 'key' }),
          mk('value', { type: 'text', placeholder: 'value' }));
      } else if (op === 'KvGet' || op === 'KvDel') {
        fieldsBox.append(
          mk('ns', { type: 'text', placeholder: 'namespace' }),
          mk('key', { type: 'text', placeholder: 'key' }));
      } else if (op === 'CryptoHash') {
        fieldsBox.append(mk('input', { type: 'text', placeholder: 'input (templatable)' }));
      } else if (op === 'Http') {
        const method = el('select', { style: 'max-width:90px;' }, ...HTTP_METHODS.map((m) => el('option', { value: m }, m)));
        ins.method = method;
        fieldsBox.append(
          method,
          mk('url', { type: 'text', placeholder: 'https://host/path', style: 'flex:2;' }),
          mk('body', { type: 'text', placeholder: 'body (optional, templatable)' }),
          mk('headers', { type: 'text', placeholder: 'headers: Name: value, Name2: value2', style: 'flex:2;' }),
          mk('max', { type: 'number', placeholder: 'max bytes (0=default)', value: '0', style: 'max-width:140px;' }));
      } else if (op === 'CanisterCall') {
        fieldsBox.append(
          mk('cid', { type: 'text', placeholder: 'canister id (principal)' }),
          mk('method', { type: 'text', placeholder: 'method' }),
          mk('arg', { type: 'text', placeholder: 'arg_hex (candid raw, hex)', style: 'flex:2;' }));
      }
      rowEl._read = () => readAction(op, ins);
    };
    opSel.addEventListener('change', syncFields);
    const rowEl = el('div', { class: 'form-row', style: 'margin-top:0.5rem;' },
      opSel, fieldsBox,
      el('button', { class: 'btn-ghost', onclick: () => rowEl.remove() }, '✕'));
    syncFields();
    return rowEl;
  }
  // primo row di default
  actionsBox.append(actionRow('KvSet'));

  let guardOn = false;
  const gField = el('input', { type: 'text', placeholder: 'field (e.g. step0)' });
  const gOp = el('select', {}, ...['==', '!=', '>', '>=', '<', '<=', 'contains'].map((o) => el('option', { value: o }, o)));
  const gVal = el('input', { type: 'text', placeholder: 'value' });
  // I campi della guardia compaiono solo quando la si attiva, via bottone (non più checkbox).
  const gFields = el('div', { class: 'form-row', style: 'display:none; margin-top:0.5rem;' }, gField, gOp, gVal);
  const guardBtn = el('button', { class: 'btn-secondary' }, '+ Add a guard');
  guardBtn.addEventListener('click', () => {
    guardOn = !guardOn;
    gFields.style.display = guardOn ? 'flex' : 'none';
    guardBtn.textContent = guardOn ? '− Remove guard' : '+ Add a guard';
  });

  async function submit() {
    const jobId = idIn.value.trim();
    if (!jobId) { toast('Job id is required', 'err'); return; }
    const rows = [...actionsBox.querySelectorAll('.form-row')].filter((r) => r._read);
    const actions = [];
    for (const r of rows) {
      const a = r._read();
      if (a) actions.push(a);
    }
    if (!actions.length) { toast('At least one action is required', 'err'); return; }

    const title = titleIn.value.trim();
    const job = {
      job_id: jobId,
      owning_bundle: bundleIn.value.trim() ? [bundleIn.value.trim()] : [],
      actions,
      guard: guardOn ? [{ field: gField.value, op: gOp.value, value: gVal.value }] : [],
      title: title ? [title] : [], // F5: nome umano per il Feed (opt → [] = nessuno)
    };
    try {
      await createJob(job);
      toast('Job created', 'ok');
      renderAutomations(container);
    } catch (e) { toast(`Create failed: ${e.message}`, 'err'); }
  }

  return el('div', { class: 'section' },
    el('h2', {}, 'New job'),
    el('div', { class: 'form-row' },
      el('div', {}, el('label', {}, 'Job id'), idIn),
      el('div', { style: 'flex:1;' }, el('label', {}, 'Title (optional — shown in the feed)'), titleIn),
      el('div', {}, el('label', {}, 'Owning bundle (optional)'), bundleIn)),
    el('label', {}, 'Actions (run in sequence)'),
    actionsBox,
    el('button', { class: 'btn-secondary', style: 'margin-top:0.5rem;', onclick: () => actionsBox.append(actionRow('KvSet')) }, '+ action'),
    el('div', { class: 'guard-group', style: 'margin-top:0.9rem;' },
      el('div', { style: 'display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;' },
        guardBtn,
        el('span', { class: 'muted', style: 'font-size:0.8rem;' }, 'run the effect only if a condition holds')),
      gFields),
    el('div', { style: 'margin-top:0.9rem;' }, el('button', { class: 'btn-primary', onclick: submit }, 'Create job')),
  );
}

function readAction(op, ins) {
  const v = (k) => (ins[k] ? ins[k].value : '');
  switch (op) {
    case 'KvSet': return { KvSet: { namespace: v('ns'), key: v('key'), value: v('value') } };
    case 'KvGet': return { KvGet: { namespace: v('ns'), key: v('key') } };
    case 'KvDel': return { KvDel: { namespace: v('ns'), key: v('key') } };
    case 'CryptoHash': return { CryptoHash: { input: v('input') } };
    case 'Http': return { Http: {
      method: v('method'),
      url: v('url').trim(),
      headers: parseHeaders(v('headers')),
      body: v('body'),
      max_response_bytes: BigInt(parseInt(v('max'), 10) || 0),
    } };
    case 'CanisterCall': return { CanisterCall: {
      canister_id: v('cid').trim(),
      method: v('method').trim(),
      arg_hex: v('arg').replace(/\s+/g, ''),
    } };
    default: return null;
  }
}

/** "Name: value, Name2: value2" → vec record { text; text } (parti vuote/senza ':' ignorate). */
function parseHeaders(raw) {
  return (raw || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.includes(':'))
    .map((part) => {
      const i = part.indexOf(':');
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
    });
}
