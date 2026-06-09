/**
 * password-edit.js — Create/edit a password entry
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate } from '@shared/ui/router.js';
import {
  createEncryptedRecord,
  getEncryptedRecord,
  updateEncryptedRecord,
  deleteEncryptedRecord,
} from '../../lib/encrypted-crud.js';

const NS = 'passwords';

export async function renderPasswordEdit(container, idParam) {
  const isNew = idParam === 'new';
  let record = null;

  render(container,
    el('div', { class: 'page-vault' },
      el('div', { class: 'topbar' },
        el('button', { class: 'btn-icon', onClick: () => navigate('#passwords') }, '\u2190'),
        el('span', { class: 'topbar-title' }, isNew ? 'New Password' : 'Edit Password'),
      ),
      el('div', { class: 'vault-content vault-form-container', id: 'pw-form' },
        isNew ? null : el('p', { class: 'hint', style: 'padding:1rem' }, 'Loading...'),
      ),
    ),
  );

  if (!isNew) {
    try {
      record = await getEncryptedRecord(NS, idParam);
    } catch (e) {
      const f = document.getElementById('pw-form');
      if (f) render(f, el('p', { class: 'error', style: 'padding:1rem' }, `Error: ${e.message}`));
      return;
    }
  }

  const data = record?.data || {};
  renderForm(data, record);
}

function renderForm(data, record) {
  const formEl = document.getElementById('pw-form');
  if (!formEl) return;

  const isEdit = record != null;
  let showPw = false;

  const siteInput = el('input', { class: 'form-input', type: 'text', placeholder: 'e.g. github.com', value: data.site || '' });
  const userInput = el('input', { class: 'form-input', type: 'text', placeholder: 'username or email', value: data.username || '' });
  const pwInput = el('input', { class: 'form-input', type: 'password', placeholder: 'password', value: data.password || '', id: 'pw-input' });
  const notesInput = el('textarea', { class: 'form-input', placeholder: 'Optional notes', rows: '3' }, data.notes || '');
  const statusEl = el('p', { class: 'status' });

  const togglePw = el('button', { class: 'btn-icon small', type: 'button', onClick: () => {
    showPw = !showPw;
    pwInput.type = showPw ? 'text' : 'password';
    togglePw.textContent = showPw ? '\u{1F648}' : '\u{1F441}';
  }}, '\u{1F441}');

  async function handleSave() {
    const newData = {
      site: siteInput.value.trim(),
      username: userInput.value.trim(),
      password: pwInput.value,
      notes: notesInput.value.trim(),
    };
    if (!newData.site) { statusEl.textContent = 'Site is required'; return; }

    statusEl.textContent = 'Encrypting and saving...';
    try {
      if (isEdit) {
        await updateEncryptedRecord(NS, record.id, newData);
      } else {
        await createEncryptedRecord(NS, newData);
      }
      navigate('#passwords');
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    statusEl.textContent = 'Deleting...';
    try {
      await deleteEncryptedRecord(record.id);
      navigate('#passwords');
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    }
  }

  const buttons = [
    el('button', { class: 'btn-primary', onClick: handleSave }, isEdit ? 'Save' : 'Create'),
  ];
  if (isEdit) {
    buttons.push(el('button', { class: 'btn-danger', onClick: handleDelete }, 'Delete'));
  }

  render(formEl,
    el('div', { class: 'vault-form password-form' },
      el('div', { class: 'form-column' },
        el('div', { class: 'form-group' }, el('label', {}, 'Site'), siteInput),
        el('div', { class: 'form-group' }, el('label', {}, 'Username'), userInput),
        el('div', { class: 'form-group' }, el('label', {}, 'Password'), el('div', { class: 'input-with-action' }, pwInput, togglePw))
      ),
      el('div', { class: 'form-column' },
        el('div', { class: 'form-group h-full' }, el('label', {}, 'Notes'), notesInput)
      ),
      el('div', { class: 'form-footer' },
        statusEl,
        el('div', { class: 'form-actions' }, ...buttons)
      )
    )
  );
}
