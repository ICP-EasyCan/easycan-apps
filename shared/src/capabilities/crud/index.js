/**
 * Capability: CRUD
 *
 * Storage generico namespace-based con UI schema-driven.
 * Il backend salva blob (Vec<u8>), il frontend li interpreta come JSON.
 *
 * Exports:
 *   createRecord(ownCid, namespace, data)    → CrudRecord
 *   getRecord(ownCid, id)                     → CrudRecord | null
 *   listRecords(ownCid, namespace, offset, limit) → { records, total }
 *   updateRecord(ownCid, id, data)            → CrudRecord
 *   deleteRecord(ownCid, id)                  → void
 *   countRecords(ownCid, namespace)            → number
 *
 *   renderCrudList(container, options)  → UI lista paginata
 *   renderCrudForm(container, options)  → UI form crea/modifica
 *
 * Backend:
 *   create_record (update), get_record (query), list_records (query),
 *   update_record (update), delete_record (update), count_records (query)
 */

import { call, query } from '../../core/icp.js';

// ─── Encoder/Decoder ──────────────────────────────────────────────────────

/** Codifica un oggetto JS in Vec<u8> (JSON → UTF-8 bytes). */
function encodeData(obj) {
  return Array.from(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Decodifica Vec<u8> in oggetto JS. */
function decodeData(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
  } catch {
    return null;
  }
}

// ─── API ──────────────────────────────────────────────────────────────────

/**
 * Crea un record nel namespace specificato.
 * @param {string} ownCid - Canister ID dell'utente
 * @param {string} namespace - Namespace del record (es. "notes", "tasks")
 * @param {Object} data - Dati da salvare (serializzati come JSON)
 * @returns {Promise<Object>} Record creato con id, data (decodificato), timestamps
 */
export async function createRecord(ownCid, namespace, data) {
  const result = await call(ownCid, 'create_record', {
    namespace,
    data: encodeData(data),
  });
  if (result.Err !== undefined) throw new Error(result.Err);
  const rec = result.Ok ?? result;
  return { ...rec, data: decodeData(rec.data) };
}

/**
 * Recupera un record per ID.
 * @returns {Promise<Object|null>}
 */
export async function getRecord(ownCid, id) {
  const result = await query(ownCid, 'get_record', BigInt(id));
  if (!result || result.length === 0) return null;
  const rec = result[0] ?? result;
  return { ...rec, data: decodeData(rec.data) };
}

/**
 * Lista paginata dei record in un namespace.
 * @returns {Promise<{ records: Object[], total: number }>}
 */
export async function listRecords(ownCid, namespace, offset = 0, limit = 50) {
  const result = await query(ownCid, 'list_records', namespace, BigInt(offset), BigInt(limit));
  return {
    records: (result.records || []).map(r => ({ ...r, data: decodeData(r.data) })),
    total: Number(result.total || 0),
  };
}

/**
 * Aggiorna i dati di un record esistente.
 * @returns {Promise<Object>} Record aggiornato
 */
export async function updateRecord(ownCid, id, data) {
  const result = await call(ownCid, 'update_record', BigInt(id), {
    data: encodeData(data),
  });
  if (result.Err !== undefined) throw new Error(result.Err);
  const rec = result.Ok ?? result;
  return { ...rec, data: decodeData(rec.data) };
}

/**
 * Elimina un record per ID.
 */
export async function deleteRecord(ownCid, id) {
  const result = await call(ownCid, 'delete_record', BigInt(id));
  if (result.Err !== undefined) throw new Error(result.Err);
}

/**
 * Conta i record in un namespace.
 * @returns {Promise<number>}
 */
export async function countRecords(ownCid, namespace) {
  const result = await query(ownCid, 'count_records', namespace);
  return Number(result);
}

// ─── UI: Lista ────────────────────────────────────────────────────────────

/**
 * Renderizza una lista CRUD paginata.
 *
 * @param {HTMLElement} container
 * @param {{
 *   canisterId: string,
 *   namespace: string,
 *   schema: Array<{ name: string, type: string, label: string }>,
 *   title?: string,
 *   pageSize?: number,
 *   onSelect?: (record) => void,
 *   onNew?: () => void,
 * }} options
 */
export async function renderCrudList(container, options) {
  const { el, render } = await import('../../ui/dom.js');

  const {
    canisterId,
    namespace,
    schema,
    title = namespace,
    pageSize = 20,
    onSelect = null,
    onNew = null,
  } = options;

  let currentPage = 0;

  async function loadPage() {
    const offset = currentPage * pageSize;
    const { records, total } = await listRecords(canisterId, namespace, offset, pageSize);
    const totalPages = Math.ceil(total / pageSize) || 1;

    const rows = records.map(rec => {
      const cells = schema.map(field =>
        el('td', {}, String(rec.data?.[field.name] ?? ''))
      );
      const row = el('tr', { class: 'crud-row' }, ...cells);
      if (onSelect) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => onSelect(rec));
      }
      return row;
    });

    const headerCells = schema.map(f => el('th', {}, f.label));
    const thead = el('thead', {}, el('tr', {}, ...headerCells));
    const tbody = el('tbody', {}, ...rows);
    const table = el('table', { class: 'crud-table' }, thead, tbody);

    const pagination = el('div', { class: 'crud-pagination' },
      el('button', {
        class: 'btn-icon',
        onclick: () => { if (currentPage > 0) { currentPage--; loadPage(); } },
        ...(currentPage === 0 ? { disabled: 'disabled' } : {}),
      }, '\u2190'),
      el('span', {}, `${currentPage + 1} / ${totalPages} (${total})`),
      el('button', {
        class: 'btn-icon',
        onclick: () => { if (currentPage < totalPages - 1) { currentPage++; loadPage(); } },
        ...(currentPage >= totalPages - 1 ? { disabled: 'disabled' } : {}),
      }, '\u2192'),
    );

    const header = el('div', { class: 'crud-header' },
      el('h2', {}, title),
      onNew ? el('button', { class: 'btn-primary', onclick: onNew }, '+ Nuovo') : null,
    );

    render(container,
      el('div', { class: 'crud-list' },
        header,
        records.length === 0
          ? el('p', { class: 'hint' }, 'Nessun record.')
          : table,
        total > pageSize ? pagination : null,
      )
    );
  }

  await loadPage();
}

// ─── UI: Form ─────────────────────────────────────────────────────────────

/**
 * Renderizza un form CRUD per creare o modificare un record.
 *
 * @param {HTMLElement} container
 * @param {{
 *   canisterId: string,
 *   namespace: string,
 *   schema: Array<{ name: string, type: string, label: string, required?: boolean }>,
 *   record?: Object|null,
 *   onSave?: (record) => void,
 *   onCancel?: () => void,
 *   onDelete?: (id) => void,
 * }} options
 */
export async function renderCrudForm(container, options) {
  const { el, render } = await import('../../ui/dom.js');

  const {
    canisterId,
    namespace,
    schema,
    record = null,
    onSave = null,
    onCancel = null,
    onDelete = null,
  } = options;

  const isEdit = record != null && record.id != null;

  const fields = schema.map(field => {
    const value = isEdit ? (record.data?.[field.name] ?? '') : '';
    let input;

    switch (field.type) {
      case 'textarea':
        input = el('textarea', {
          id: `crud-${field.name}`,
          class: 'form-input',
          placeholder: field.label,
          rows: '4',
        }, String(value));
        break;
      case 'number':
        input = el('input', {
          id: `crud-${field.name}`,
          type: 'number',
          class: 'form-input',
          placeholder: field.label,
          value: String(value),
        });
        break;
      case 'checkbox':
        input = el('input', {
          id: `crud-${field.name}`,
          type: 'checkbox',
          ...(value ? { checked: 'checked' } : {}),
        });
        break;
      default: // text
        input = el('input', {
          id: `crud-${field.name}`,
          type: 'text',
          class: 'form-input',
          placeholder: field.label,
          value: String(value),
        });
    }

    return el('div', { class: 'crud-field' },
      el('label', { for: `crud-${field.name}` }, field.label),
      input,
    );
  });

  const statusEl = el('p', { class: 'status', id: 'crud-status' });

  async function handleSave() {
    const data = {};
    for (const field of schema) {
      const inputEl = document.getElementById(`crud-${field.name}`);
      if (!inputEl) continue;

      if (field.type === 'checkbox') {
        data[field.name] = inputEl.checked;
      } else if (field.type === 'number') {
        data[field.name] = Number(inputEl.value) || 0;
      } else {
        data[field.name] = inputEl.value;
      }

      if (field.required && !data[field.name]) {
        statusEl.textContent = `Campo "${field.label}" obbligatorio`;
        return;
      }
    }

    statusEl.textContent = 'Salvataggio...';
    try {
      let saved;
      if (isEdit) {
        saved = await updateRecord(canisterId, record.id, data);
      } else {
        saved = await createRecord(canisterId, namespace, data);
      }
      statusEl.textContent = '\u2713 Salvato!';
      if (onSave) setTimeout(() => onSave(saved), 500);
    } catch (e) {
      statusEl.textContent = `Errore: ${e.message}`;
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    statusEl.textContent = 'Eliminazione...';
    try {
      await deleteRecord(canisterId, record.id);
      statusEl.textContent = '\u2713 Eliminato!';
      if (onDelete) setTimeout(() => onDelete(record.id), 500);
    } catch (e) {
      statusEl.textContent = `Errore: ${e.message}`;
    }
  }

  const buttons = [
    el('button', { class: 'btn-primary', onclick: handleSave }, isEdit ? 'Salva' : 'Crea'),
  ];
  if (isEdit && onDelete) {
    buttons.push(el('button', { class: 'btn-danger', onclick: handleDelete }, 'Elimina'));
  }
  if (onCancel) {
    buttons.push(el('button', { class: 'btn-icon', onclick: onCancel }, 'Annulla'));
  }

  render(container,
    el('div', { class: 'crud-form' },
      el('h2', {}, isEdit ? 'Modifica' : 'Nuovo record'),
      ...fields,
      el('div', { class: 'crud-actions' }, ...buttons),
      statusEl,
    )
  );
}
