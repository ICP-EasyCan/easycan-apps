/**
 * add-contact.js — Route #add-contact: home unica per aggiungere contatti.
 *
 * Tre tab: Paste (default), Scan QR, Manual.
 * Tutte e tre confluiscono in confirmAdd(): preview → add_to_whitelist → save.
 */

import { CANISTER_ID }    from '@shared/core/config.js';
import { call }            from '@shared/core/icp.js';
import { el, render, truncate }
                           from '@shared/ui/dom.js';
import { navigate }        from '@shared/ui/router.js';
import { loadContacts, saveContacts }
                           from '../contacts-store.js';
import { avatarEl }        from '../components/avatar.js';
import { parseContactInput } from '../lib/parse-contact.js';

let _activeTab = 'paste';
let _stopScanner = null;

export function renderAddContact(container) {
  _stopScannerIfAny();
  _render(container);
}

function _render(container) {
  const tabBtn = (id, label) => el('button', {
    class: `add-tab${_activeTab === id ? ' active' : ''}`,
    onclick: () => { _activeTab = id; _render(container); },
  }, label);

  const body = _activeTab === 'paste'  ? _pasteView(container)
             : _activeTab === 'scan'   ? _scanView(container)
             : _manualView(container);

  render(container,
    el('div', { class: 'page page-add-contact' },
      el('header', { class: 'topbar' },
        el('button', {
          class: 'btn-icon', title: 'Back',
          onclick: () => navigate('#chats'),
        }, '←'),
        el('span', { class: 'topbar-title' }, 'Add contact'),
      ),
      el('div', { class: 'add-tabs' },
        tabBtn('paste',  'Paste'),
        tabBtn('scan',   'Scan QR'),
        tabBtn('manual', 'Manual'),
      ),
      el('div', { class: 'add-body' }, body),
    ),
  );
}

// ─── Paste tab ──────────────────────────────────────────────────────────────

function _pasteView(container) {
  const status  = el('p', { class: 'status' });
  const preview = el('div', { class: 'add-preview' });
  const ta = el('textarea', {
    class: 'form-input add-paste-input',
    placeholder: 'Paste a contact code, link, or text containing canister id + principal id',
    rows: 4,
  });

  const tryParse = () => {
    const res = parseContactInput(ta.value);
    if (res.error) {
      preview.innerHTML = '';
      status.textContent = ta.value.trim() ? res.error : '';
      return null;
    }
    status.textContent = '';
    _renderPreview(preview, res, container);
    return res;
  };

  ta.addEventListener('input', tryParse);

  const scanBtn = el('button', {
    class: 'btn-primary add-scan-cta',
    onclick: () => { _activeTab = 'scan'; _render(container); },
  }, '\u{1F4F7}  Scan QR code');

  return el('div', { class: 'add-section' },
    scanBtn,
    el('div', { class: 'add-divider' }, 'or paste'),
    ta,
    status,
    preview,
  );
}

// ─── Scan tab ───────────────────────────────────────────────────────────────

function _scanView(container) {
  const status  = el('p', { class: 'status' });
  const preview = el('div', { class: 'add-preview' });

  if (!('BarcodeDetector' in window)) {
    return el('div', { class: 'add-section' },
      el('p', { class: 'hint' },
        'Your browser does not support native QR scanning. Use the Paste tab and paste the contact code instead.'),
      el('button', {
        class: 'btn-primary',
        onclick: () => { _activeTab = 'paste'; _render(container); },
      }, 'Go to Paste'),
    );
  }

  const video = el('video', { class: 'add-video', autoplay: true, playsinline: true, muted: true });

  (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      video.srcObject = stream;
      await video.play().catch(() => {});

      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      let stopped = false;
      _stopScanner = () => {
        stopped = true;
        stream.getTracks().forEach(t => t.stop());
        _stopScanner = null;
      };

      const loop = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length > 0) {
            const raw = codes[0].rawValue || '';
            const res = parseContactInput(raw);
            if (!res.error) {
              _stopScannerIfAny();
              status.textContent = 'QR decoded.';
              _renderPreview(preview, res, container);
              return;
            }
            status.textContent = 'QR found but unrecognized format.';
          }
        } catch { /* ignore frame errors */ }
        if (!stopped) setTimeout(loop, 250);
      };
      loop();
    } catch (e) {
      status.textContent = `Camera error: ${e.message}`;
    }
  })();

  return el('div', { class: 'add-section' },
    video,
    el('p', { class: 'hint' }, 'Point camera at a contact QR code.'),
    status,
    preview,
  );
}

// ─── Manual tab ─────────────────────────────────────────────────────────────

function _manualView(container) {
  const status  = el('p', { class: 'status' });
  const cid     = el('input', { type: 'text', class: 'form-input', placeholder: 'Peer Canister ID' });
  const pid     = el('input', { type: 'text', class: 'form-input', placeholder: 'Peer Principal ID' });
  const alias   = el('input', { type: 'text', class: 'form-input', placeholder: 'Alias (optional)' });

  const submit = el('button', { class: 'btn-primary', onclick: async () => {
    const c = cid.value.trim(); const p = pid.value.trim();
    if (!c || !p) { status.textContent = 'Canister ID and Principal ID are required.'; return; }
    const res = parseContactInput(`${c} ${p}`);
    if (res.error) { status.textContent = res.error; return; }
    await _confirmAdd({ ...res, alias: alias.value.trim() }, status, container);
  } }, 'Add contact');

  return el('div', { class: 'add-section' },
    cid, pid, alias, submit, status,
  );
}

// ─── Preview + confirm ──────────────────────────────────────────────────────

function _renderPreview(host, contact, container) {
  const aliasInput = el('input', {
    type: 'text', class: 'form-input', placeholder: 'Alias (optional)',
    value: contact.alias || '',
  });
  const status = el('p', { class: 'status' });

  render(host,
    el('div', { class: 'add-preview-card' },
      el('div', { class: 'contact-card' },
        avatarEl(contact.alias || '', contact.principalId),
        el('div', { class: 'contact-info' },
          el('span', { class: 'contact-name' }, contact.alias || truncate(contact.principalId, 16)),
          el('span', { class: 'contact-cid small hint' }, truncate(contact.canisterId, 28)),
          el('span', { class: 'contact-cid small hint' }, truncate(contact.principalId, 28)),
        ),
      ),
      aliasInput,
      el('button', {
        class: 'btn-primary',
        onclick: () => _confirmAdd({ ...contact, alias: aliasInput.value.trim() }, status, container),
      }, 'Add contact'),
      status,
    ),
  );
}

async function _confirmAdd(contact, statusEl, container, opts = {}) {
  const contacts0 = loadContacts();
  const dup = contacts0.find(c => c.canisterId === contact.canisterId && c.principalId === contact.principalId);
  if (dup && !opts.overwrite) {
    _renderDupPrompt(statusEl, dup, contact, container);
    return;
  }

  statusEl.textContent = 'Adding to whitelist...';
  try {
    const { Principal } = await import('@dfinity/principal');
    const result = await call(CANISTER_ID, 'add_to_whitelist', Principal.fromText(contact.principalId));
    if (result?.Err) throw new Error(result.Err);

    const contacts = loadContacts();
    const existing = contacts.find(c => c.canisterId === contact.canisterId && c.principalId === contact.principalId);
    if (existing) {
      existing.alias = contact.alias || existing.alias || '';
      saveContacts(contacts);
      statusEl.textContent = '✓ Contact already in list — alias updated.';
    } else {
      contacts.push({
        canisterId: contact.canisterId,
        principalId: contact.principalId,
        alias: contact.alias || '',
      });
      saveContacts(contacts);
      statusEl.textContent = '✓ Contact added.';
    }
    _stopScannerIfAny();
    setTimeout(() => navigate('#chats'), 700);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

function _renderDupPrompt(statusEl, dup, contact, container) {
  const oldAlias = dup.alias || '(no alias)';
  const newAlias = contact.alias || '(no alias)';
  render(statusEl,
    el('div', { class: 'dup-prompt' },
      el('p', {}, `Contact already in list (alias: "${oldAlias}"). Overwrite with "${newAlias}"?`),
      el('div', { class: 'dup-actions' },
        el('button', {
          class: 'btn-primary',
          onclick: () => _confirmAdd(contact, statusEl, container, { overwrite: true }),
        }, 'Overwrite'),
        el('button', {
          class: 'btn-secondary',
          onclick: () => { statusEl.textContent = 'Cancelled.'; },
        }, 'Cancel'),
      ),
    ),
  );
}

function _stopScannerIfAny() {
  if (typeof _stopScanner === 'function') {
    try { _stopScanner(); } catch { /* ignore */ }
  }
  _stopScanner = null;
}
