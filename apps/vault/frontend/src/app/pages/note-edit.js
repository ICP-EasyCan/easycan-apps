/**
 * note-edit.js — Create/edit an encrypted note
 */

import { el, render } from '@shared/ui/dom.js';
import { navigate } from '@shared/ui/router.js';
import {
  createEncryptedRecord,
  getEncryptedRecord,
  updateEncryptedRecord,
  deleteEncryptedRecord,
} from '../../lib/encrypted-crud.js';

const NS = 'notes';

export async function renderNoteEdit(container, idParam) {
  const isNew = idParam === 'new';
  let record = null;

  render(container,
    el('div', { class: 'page-vault' },
      el('div', { class: 'topbar' },
        el('button', { class: 'btn-icon', onClick: () => navigate('#notes') }, '\u2190'),
        el('span', { class: 'topbar-title' }, isNew ? 'New Note' : 'Edit Note'),
      ),
      el('div', { class: 'vault-content vault-form-container', id: 'note-form' },
        isNew ? null : el('p', { class: 'hint', style: 'padding:1rem' }, 'Loading...'),
      ),
    ),
  );

  if (!isNew) {
    try {
      record = await getEncryptedRecord(NS, idParam);
    } catch (e) {
      const f = document.getElementById('note-form');
      if (f) render(f, el('p', { class: 'error', style: 'padding:1rem' }, `Error: ${e.message}`));
      return;
    }
  }

  const data = record?.data || {};
  renderForm(data, record);
}

function renderForm(data, record) {
  const formEl = document.getElementById('note-form');
  if (!formEl) return;

  const isEdit = record != null;

  const titleInput = el('input', { class: 'form-input', type: 'text', placeholder: 'Title', value: data.title || '' });
  const bodyInput = el('textarea', { class: 'form-input note-body', placeholder: 'Write here...', rows: '12' }, data.body || '');
  const statusEl = el('p', { class: 'status' });

  async function handleSave() {
    const newData = {
      title: titleInput.value.trim(),
      body: bodyInput.value,
    };
    if (!newData.title) { statusEl.textContent = 'Title is required'; return; }

    statusEl.textContent = 'Encrypting and saving...';
    try {
      if (isEdit) {
        await updateEncryptedRecord(NS, record.id, newData);
      } else {
        await createEncryptedRecord(NS, newData);
      }
      navigate('#notes');
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    statusEl.textContent = 'Deleting...';
    try {
      await deleteEncryptedRecord(record.id);
      navigate('#notes');
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
    el('div', { class: 'vault-form note-form' },
      el('div', { class: 'form-group' }, el('label', {}, 'Title'), titleInput),
      el('div', { class: 'form-group h-full' }, el('label', {}, 'Content'), bodyInput),
      el('div', { class: 'form-footer' },
        statusEl,
        el('div', { class: 'form-actions' }, ...buttons)
      )
    )
  );
}
