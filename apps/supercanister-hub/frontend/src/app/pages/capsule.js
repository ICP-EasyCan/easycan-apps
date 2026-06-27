/**
 * capsule.js — Time Capsule (dead-man's switch) in OUTBOUND-PUSH, lato OWNER.
 *
 * La hero dell'Arco 1, riconvertita al modello outbound-only ([[outbound_only]]): l'agente NON si fa
 * "ritirare" il segreto da un estraneo (era #open, l'unica rotta inbound). Al SILENZIO è l'AGENTE a
 * CONSEGNARE FUORI l'envelope cifrato verso un canale d'uscita dell'erede (un `__secrets`, send-only).
 *
 * Sigillatura a STRATEGIA (oggi solo passphrase, Fase 1): il messaggio è cifrato nel browser con una
 * passphrase forte (PBKDF2 → AES-GCM) e diventa un envelope-metodo autodescrittivo (opaco al canister).
 * La passphrase si consegna all'erede OUT-OF-BAND (mai sulla subnet) — il canister tiene solo ciphertext,
 * nulla di decifrabile. L'erede apre con un decryptor puramente client-side (#decrypt), zero chiamate.
 *
 * Compone i mattoni già provati:
 *  - crypto a passphrase (F1): sealStringWithPassphrase → envelope opaco; nessun roundtrip a cap-crypto.
 *  - consegna outbound (F2 backend): setReleaseCapsule(envelope) + setDeliveryConfig(channel, window).
 *    Al tick, se armata + non-consegnata + silenzio scaduto, il backend spinge l'envelope sul canale.
 *  - heartbeat (F1): ogni apertura della shell timbra `checkin()` → resetta il timer del silenzio.
 */

import { el, render } from '@shared/ui/dom.js';
import { generatePassphrase, sealStringWithPassphrase, sealFileWithPassphrase } from '@shared/core/crypto.js';
import {
  setReleaseCapsule, setDeliveryConfig, getDeliveryConfig, clearDeliveryConfig,
  listSecrets, setSecret, checkin, lastCheckin, kvGet, kvSet,
} from '../../lib/hub-api.js';
import { toast, pageHeader } from '../../lib/ui.js';

const META_NS = 'capsule';       // namespace KV proprio della shell (owner-only)
const META_KEY = 'meta';

// Cap secco sul plaintext: l'agente spinge l'envelope FUORI con un outcall HTTP
// dell'IC (tetto ~2 MB sul corpo), e il base64 dell'envelope gonfia del +33%.
// 1 MB lascia headroom. Niente chunking: capsula = una busta, non un disco.
const MAX_FILE_BYTES = 1024 * 1024;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const HEADER_TITLE = 'Time Capsule';
const HEADER_SUB = 'A sealed message your sovereign computer delivers to someone you trust — pushed out the moment you go silent.';

const UNITS = [
  ['minutes', 60],
  ['hours', 3600],
  ['days', 86400],
  ['weeks', 604800],
];

function fmtDuration(secs) {
  for (const [name, mult] of [...UNITS].reverse()) {
    if (secs >= mult && secs % mult === 0) return `${secs / mult} ${name}`;
  }
  if (secs % 3600 === 0) return `${secs / 3600} hours`;
  if (secs % 60 === 0) return `${secs / 60} minutes`;
  return `${secs} seconds`;
}

function fmtAgo(secsAgo) {
  if (secsAgo < 60) return `${Math.round(secsAgo)}s ago`;
  if (secsAgo < 3600) return `${Math.round(secsAgo / 60)}m ago`;
  if (secsAgo < 86400) return `${Math.round(secsAgo / 3600)}h ago`;
  return `${Math.round(secsAgo / 86400)}d ago`;
}

function unitFor(secs) {
  for (const u of [...UNITS].reverse()) if (secs >= u[1] && secs % u[1] === 0) return u;
  return UNITS[0];
}

export async function renderCapsule(container) {
  render(container,
    pageHeader(HEADER_TITLE, HEADER_SUB),
    el('p', { class: 'muted' }, 'Loading…'));

  let config = null, last = null, meta = null, secrets = [];
  try {
    [config, last, secrets] = await Promise.all([
      getDeliveryConfig(),
      lastCheckin(),
      listSecrets().catch(() => []),
    ]);
    const metaRaw = await kvGet(META_NS, META_KEY);
    if (metaRaw) { try { meta = JSON.parse(metaRaw); } catch { meta = null; } }
  } catch (e) {
    render(container, pageHeader(HEADER_TITLE), el('p', { class: 'error' }, `Failed to load: ${e.message}`));
    return;
  }

  render(container,
    pageHeader(HEADER_TITLE, HEADER_SUB),
    config ? statusCard(container, config, last, meta) : null,
    formCard(container, config, meta, secrets),
  );
}

// ─── Status della capsula armata ────────────────────────────────────────────────

function statusCard(container, config, last, meta) {
  const channel = config.channel;
  const windowSecs = Number(config.window_secs);
  const delivered = config.delivered;
  const nowS = Date.now() / 1000;
  const silence = last != null ? (nowS - last) : null;
  const elapsed = silence != null && silence > windowSecs;

  let line;
  if (delivered) {
    line = el('p', { class: 'capsule-open-flag' },
      '📤 Delivered — your agent pushed the sealed capsule out. Re-seal below to arm a new one.');
  } else if (elapsed) {
    line = el('p', { class: 'muted' },
      '⏳ Silence window elapsed — your agent delivers the capsule at its next check (within ~2 min).');
  } else if (last != null) {
    const remaining = Math.max(0, windowSecs - silence);
    line = el('p', { class: 'muted' },
      `🔒 Armed. Delivers after ${fmtDuration(windowSecs)} of silence. Last check-in ${fmtAgo(silence)} — `,
      el('strong', {}, `~${fmtDuration(Math.round(remaining))} left`),
      '.');
  } else {
    line = el('p', { class: 'muted' }, '🔒 Armed. No check-in recorded yet — delivery waits for the first heartbeat.');
  }

  return el('div', { class: 'card capsule-status' },
    el('h3', {}, meta?.title ? `“${meta.title}”` : 'Your capsule'),
    meta?.kind === 'file'
      ? el('p', { class: 'meta' }, '📎 A sealed file', meta.fileName ? el('span', { class: 'mono' }, ` · ${meta.fileName}`) : '')
      : null,
    line,
    el('div', { class: 'meta' }, 'Delivery channel'),
    el('div', { class: 'mono' }, channel),
    el('p', { class: 'hint small', style: 'margin-top:0.6rem;' },
      'Every time you open EasyHub your check-in resets the timer. The capsule is pushed out only if you stop coming back. ' +
      'The passphrase that opens it lives only with you and your heir — never in the canister.'),
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn-danger', onclick: () => doDisarm(container) }, 'Disarm delivery')),
  );
}

async function doDisarm(container) {
  if (!confirm('Disarm the capsule delivery? The sealed message stays stored, but the agent will not push it out.')) return;
  try {
    await clearDeliveryConfig();
    toast('Delivery disarmed', 'ok');
    renderCapsule(container);
  } catch (e) { toast(`Disarm failed: ${e.message}`, 'err'); }
}

// ─── Form di sigillatura (seal/re-seal) ──────────────────────────────────────────

function formCard(container, config, meta, secrets) {
  const titleIn = el('input', { type: 'text', placeholder: 'A name for this capsule (optional)', value: meta?.title ?? '' });

  // ── Modalità ESCLUSIVA: un messaggio di testo OPPURE un file (qualsiasi formato). ──
  // Lo stato vive qui in chiusura; doSeal lo legge via f.getMode()/f.getFile().
  let mode = 'text';        // 'text' | 'file'
  let pickedFile = null;    // File scelto in modalità 'file'

  const msgIn = el('textarea', { placeholder: 'The message to seal. It is encrypted in your browser; the plaintext never leaves your device unencrypted.' });

  const fileIn = el('input', { type: 'file' });
  const fileInfo = el('p', { class: 'hint small' }, 'Any format. Encrypted in your browser before it leaves your device.');
  fileIn.onchange = (e) => {
    pickedFile = e.target.files?.[0] ?? null;
    if (!pickedFile) { fileInfo.textContent = 'Any format. Encrypted in your browser before it leaves your device.'; fileInfo.className = 'hint small'; return; }
    const tooBig = pickedFile.size > MAX_FILE_BYTES;
    fileInfo.textContent = tooBig
      ? `${pickedFile.name} — ${fmtBytes(pickedFile.size)}. Too large: max ${fmtBytes(MAX_FILE_BYTES)} (a capsule is a small sealed envelope, not a disk).`
      : `${pickedFile.name} — ${fmtBytes(pickedFile.size)}.`;
    fileInfo.className = tooBig ? 'error small' : 'hint small';
  };

  const msgField = el('label', { class: 'field' },
    el('span', {}, config ? 'New message (re-seals with a new passphrase)' : 'Message'), msgIn);
  const fileField = el('label', { class: 'field', style: 'display:none;' },
    el('span', {}, config ? 'New file (re-seals with a new passphrase)' : 'File'), fileIn, fileInfo);

  const tabText = el('button', { class: 'btn-secondary', type: 'button' }, '✍ Message');
  const tabFile = el('button', { class: 'btn-ghost', type: 'button' }, '📎 File');
  const applyMode = (m) => {
    mode = m;
    const isText = m === 'text';
    msgField.style.display = isText ? '' : 'none';
    fileField.style.display = isText ? 'none' : '';
    tabText.className = isText ? 'btn-secondary' : 'btn-ghost';
    tabFile.className = isText ? 'btn-ghost' : 'btn-secondary';
  };
  tabText.onclick = () => applyMode('text');
  tabFile.onclick = () => applyMode('file');
  const modeToggle = el('div', { class: 'form-row', style: 'gap:0.4rem;' }, tabText, tabFile);

  // ── Passphrase: generata forte di default, copiabile, rigenerabile o sostituibile a mano. ──
  // È L'UNICA CHIAVE: il canister tiene solo ciphertext. La si consegna all'erede out-of-band.
  const passIn = el('input', { type: 'text', class: 'mono', value: generatePassphrase() });
  const regenBtn = el('button', { class: 'btn-ghost', type: 'button',
    onclick: () => { passIn.value = generatePassphrase(); toast('New passphrase generated', 'ok'); } }, '↻ Regenerate');
  const copyPassBtn = el('button', { class: 'btn-secondary', type: 'button',
    onclick: () => navigator.clipboard?.writeText(passIn.value).then(() => toast('Passphrase copied', 'ok')) }, 'Copy');

  // ── Canale d'uscita dal registro __secrets (riuso del pattern G3: dropdown + add inline). ──
  const channelSel = el('select', {},
    el('option', { value: '' }, secrets.length ? '— pick a channel —' : '— no channels yet —'),
    ...secrets.map((s) => el('option', { value: s.name, selected: config && config.channel === s.name }, s.name)));

  const newChanName = el('input', { type: 'text', placeholder: 'NAME (e.g. HEIR_INBOX)', style: 'max-width:170px;' });
  const newChanUrl = el('input', { type: 'password', placeholder: 'webhook URL of your heir', style: 'flex:2;' });
  const addChannel = async () => {
    const name = newChanName.value.trim();
    const url = newChanUrl.value;
    if (!name || !url) { toast('Channel name and webhook URL required', 'err'); return; }
    try {
      await setSecret(name, url);
      channelSel.append(el('option', { value: name, selected: true }, name));
      channelSel.value = name;
      newChanName.value = ''; newChanUrl.value = '';
      addForm.style.display = 'none';
      toast('Channel saved', 'ok');
    } catch (e) { toast(`Save failed: ${e.message}`, 'err'); }
  };
  const addForm = el('div', { class: 'form-row', style: 'display:none; margin-top:0.4rem;' },
    newChanName, newChanUrl, el('button', { class: 'btn-secondary', type: 'button', onclick: addChannel }, 'Save channel'));
  const addToggle = el('button', { class: 'btn-ghost', type: 'button', onclick: () => {
    addForm.style.display = addForm.style.display === 'none' ? 'flex' : 'none';
  } }, '+ add a channel');

  // ── Finestra di silenzio ──
  const winSecs = config ? Number(config.window_secs) : null;
  const winIn = el('input', { type: 'number', min: '1',
    value: winSecs != null ? String(winSecs / unitFor(winSecs)[1]) : '7' });
  const unitSel = el('select', {},
    ...UNITS.map(([name]) => el('option', { value: name, selected: winSecs != null && unitFor(winSecs)[0] === name }, name)));

  const sealBtn = el('button', { class: 'btn-primary' }, config ? 'Re-seal capsule' : 'Seal capsule');
  sealBtn.onclick = () => doSeal(container, {
    titleIn, msgIn, passIn, channelSel, winIn, unitSel, sealBtn,
    getMode: () => mode, getFile: () => pickedFile,
  });

  return el('div', { class: 'card' },
    el('h3', {}, config ? 'Re-seal capsule' : 'Create a capsule'),
    el('label', { class: 'field' }, el('span', {}, 'Name'), titleIn),
    el('div', { class: 'field' }, el('span', {}, 'What to seal'), modeToggle),
    msgField,
    fileField,

    el('div', { class: 'field' },
      el('span', {}, 'Passphrase — the only key'),
      el('div', { class: 'form-row' }, el('div', { style: 'flex:2;' }, passIn), copyPassBtn, regenBtn),
      el('p', { class: 'hint small' },
        'This is the single key to the capsule. The canister stores only ciphertext — if this is lost, no one can ever open it. ' +
        'Deliver it to your heir out-of-band (in person, a separate secure channel), apart from the delivery channel below.')),

    el('div', { class: 'field' },
      el('span', {}, 'Deliver to channel'),
      el('div', { class: 'form-row' }, el('div', { style: 'flex:1;' }, channelSel), addToggle),
      addForm,
      el('p', { class: 'hint small' },
        'At silence, the agent pushes the sealed envelope here — a send-only webhook credential kept in the Control Room. ' +
        'It carries only ciphertext; without the passphrase it is unreadable.')),

    el('div', { class: 'field' },
      el('span', {}, 'Deliver after silence of'),
      el('div', { class: 'form-row' }, winIn, unitSel)),

    el('div', { class: 'card-actions' }, sealBtn),
  );
}

async function doSeal(container, f) {
  const title = f.titleIn.value.trim();
  const passphrase = f.passIn.value;
  const channel = f.channelSel.value;
  const unitMult = UNITS.find(([n]) => n === f.unitSel.value)?.[1] ?? 60;
  const windowSecs = Math.round(Number(f.winIn.value) * unitMult);
  const mode = f.getMode();
  const file = f.getFile();

  // Validazioni comuni + specifiche del modo.
  if (mode === 'text' && !f.msgIn.value.trim()) return toast('Write a message to seal', 'err');
  if (mode === 'file') {
    if (!file) return toast('Pick a file to seal', 'err');
    if (file.size > MAX_FILE_BYTES) return toast(`File too large: max ${fmtBytes(MAX_FILE_BYTES)}`, 'err');
    if (file.size === 0) return toast('That file is empty', 'err');
  }
  if (!passphrase || passphrase.length < 8) return toast('Passphrase too short (min 8 chars)', 'err');
  if (!channel) return toast('Pick a delivery channel (or add one)', 'err');
  if (!(windowSecs > 0)) return toast('Silence window must be > 0', 'err');

  f.sealBtn.disabled = true;
  f.sealBtn.textContent = 'Sealing…';
  try {
    // Sigilla nel browser → envelope-metodo opaco (method='passphrase'), identico in forma
    // tra testo e file: il canister vede solo ciphertext. Nessun roundtrip a cap-crypto.
    let envelope, kind, fileName = null;
    if (mode === 'file') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = file.type || 'application/octet-stream';
      envelope = await sealFileWithPassphrase(bytes, { name: file.name, mime }, passphrase);
      kind = 'file';
      fileName = file.name;
    } else {
      envelope = await sealStringWithPassphrase(f.msgIn.value, passphrase);
      kind = 'text';
    }
    // Ordine: l'envelope prima (mai una config che punta a una capsula assente), poi arma la consegna.
    // setReleaseCapsule riazzera il flag `delivered` → re-sigillare ri-arma la consegna.
    await setReleaseCapsule(envelope);
    await setDeliveryConfig(channel, windowSecs);
    await kvSet(META_NS, META_KEY, JSON.stringify({
      title, method: 'passphrase', kind, fileName, sealedAt: Math.floor(Date.now() / 1000),
    }));
    // Sigillare è un segno di vita: timbra la presenza così la finestra parte DAL sigillo, non dall'ultimo login.
    await checkin().catch(() => {});
    showSealedConfirmation(container, { title, passphrase, channel, windowSecs, kind, fileName });
  } catch (e) {
    toast(`Seal failed: ${e.message}`, 'err');
    f.sealBtn.disabled = false;
    f.sealBtn.textContent = 'Seal capsule';
  }
}

// ─── Conferma post-seal: la passphrase è l'unica copia → la si mostra UNA volta + come si apre. ──

function showSealedConfirmation(container, { title, passphrase, channel, windowSecs, kind, fileName }) {
  const isFile = kind === 'file';
  const decryptLink = `${window.location.origin}/#decrypt`;

  // STEP 2 — dove l'erede apre. Onesto per tipo:
  //  · testo → il decryptor #decrypt (puramente client-side) apre già.
  //  · file  → #decrypt NON apre i file: l'apertura è il decryptor STANDALONE (in arrivo).
  //    Non promettere un opener che oggi non c'è. Cfr. piano: GATE pubblicazione.
  const openStep = isFile
    ? el('div', { class: 'field' },
        el('span', {}, '2 · How your heir opens it'),
        el('p', { class: 'hint small' },
          'This capsule holds a file. Your heir opens it with the standalone capsule decryptor — a small offline page ' +
          'that rebuilds the original file in their browser, with no login and no call to your computer. ' +
          'Hand it to them together with the passphrase, out-of-band.'),
        el('p', { class: 'hint small' },
          'Make sure your heir has that opener page (you provide it) alongside the passphrase. ' +
          'Until they do, keep the sealed envelope and the passphrase safe.'))
    : el('div', { class: 'field' },
        el('span', {}, '2 · The decryptor link — where your heir opens it'),
        el('div', { class: 'form-row' },
          el('input', { type: 'text', readonly: true, value: decryptLink, onclick: (e) => e.target.select() }),
          el('button', { class: 'btn-secondary',
            onclick: () => navigator.clipboard?.writeText(decryptLink).then(() => toast('Link copied', 'ok')) }, 'Copy link')),
        el('p', { class: 'hint small' },
          'When the capsule arrives on the channel, your heir opens this page, pastes the delivered envelope and the passphrase, ' +
          'and reads the message — entirely in their browser, no login, no call to your computer.'));

  render(container,
    pageHeader('Capsule sealed', 'Hand these to your heir — separately. Then keep coming back to hold the timer.'),
    el('div', { class: 'card capsule-status' },
      el('h3', {}, title ? `“${title}” is armed` : 'Your capsule is armed'),
      el('p', { class: 'muted' },
        `At ${fmtDuration(windowSecs)} of silence, your agent pushes the sealed envelope to `,
        el('span', { class: 'mono' }, channel),
        isFile && fileName ? el('span', {}, ' — it carries ', el('span', { class: 'mono' }, fileName), ', encrypted.') : '.'),

      el('div', { class: 'field', style: 'margin-top:1rem;' },
        el('span', {}, '1 · The passphrase — give it out-of-band (this is shown only now)'),
        el('div', { class: 'form-row' },
          el('input', { type: 'text', class: 'mono', readonly: true, value: passphrase, onclick: (e) => e.target.select() }),
          el('button', { class: 'btn-secondary',
            onclick: () => navigator.clipboard?.writeText(passphrase).then(() => toast('Passphrase copied', 'ok')) }, 'Copy')),
        el('p', { class: 'hint small' },
          'The canister never sees it. If you lose it, the capsule is unrecoverable — store it where your heir will find it.')),

      openStep,

      el('div', { class: 'card-actions' },
        el('button', { class: 'btn-primary', onclick: () => renderCapsule(container) }, 'Done')),
    ),
  );
}
