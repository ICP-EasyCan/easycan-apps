/**
 * settings.js — Vault settings page.
 *
 * La sovranità (Platform + Controllers) vive ora nella sottopagina condivisa
 * `#sovereignty` (`@shared/capabilities/sovereignty/page.js`): qui mettiamo solo
 * la voce di accesso. Le statistiche vault si aggiornano async dopo il render.
 */

import { renderSettings as _renderSettings } from '@shared/capabilities/settings/index.js';
import { sovereigntyLinkSection } from '@shared/capabilities/sovereignty/page.js';
import { verifyLinkSection } from '@shared/capabilities/verify/page.js';
import { updateLinkSection } from '@shared/capabilities/update/page.js';
import { el } from '@shared/ui/dom.js';
import { CANISTER_ID } from '@shared/core/config.js';
import { countEncryptedRecords } from '../../lib/encrypted-crud.js';

// ── Static sections (no async data needed) ──────────────────────────────────

function makeStaticSections() {
  return [
    {
      title: 'Vault Statistics',
      content: [
        el('div', { class: 'settings-row', id: 'stat-passwords' },
          el('span', { class: 'settings-label' }, 'Passwords'),
          el('span', { class: 'settings-value' }, '…'),
        ),
        el('div', { class: 'settings-row', id: 'stat-files' },
          el('span', { class: 'settings-label' }, 'Files'),
          el('span', { class: 'settings-value' }, '…'),
        ),
        el('div', { class: 'settings-row', id: 'stat-notes' },
          el('span', { class: 'settings-label' }, 'Notes'),
          el('span', { class: 'settings-value' }, '…'),
        ),
      ],
    },
    {
      title: 'Security',
      content: [
        el('div', { class: 'settings-row' },
          el('span', { class: 'settings-label' }, 'Encryption'),
          el('span', { class: 'settings-value' }, 'AES-256-GCM (VetKeys)'),
        ),
        el('div', { class: 'settings-row' },
          el('span', { class: 'settings-label' }, 'Keys'),
          el('span', { class: 'settings-value' }, 'Client-side derived (E2E)'),
        ),
      ],
    },
  ];
}

function startCountUpdates() {
  for (const ns of ['passwords', 'files', 'notes']) {
    countEncryptedRecords(ns).then(count => {
      const row = document.getElementById(`stat-${ns}`);
      if (row) {
        const val = row.querySelector('.settings-value');
        if (val) val.textContent = String(count);
      }
    }).catch(() => {});
  }
}

// ── Main render ──────────────────────────────────────────────────────────────

export function renderSettings(container) {
  _renderSettings(container, {
    canisterId: CANISTER_ID,
    extraSections: [
      sovereigntyLinkSection(),
      verifyLinkSection(),
      updateLinkSection(),
      ...makeStaticSections(),
    ],
  });
  startCountUpdates();
}
