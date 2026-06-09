/**
 * Capability: Contacts
 *
 * Gestione contatti in localStorage. Nessuna dipendenza da canister.
 *
 * Exports:
 *   loadContacts()                      → [{ canisterId, principalId, alias }]
 *   saveContacts(list)                  → void
 *   addContact(cid, pid, alias)         → boolean (false se già esiste)
 *   removeContact(cid)                  → void
 *   getContactAlias(cid)                → string (alias o cid troncato)
 *   getContactByPrincipal(pid)          → contact | null
 *   getContactByCanister(cid)           → contact | null
 *   updateContactAlias(cid, alias)      → void
 */

import { truncate } from '../../ui/dom.js';

const LS_KEY = 'sm_contacts';

export function loadContacts() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]'); }
  catch { return []; }
}

export function saveContacts(list) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

export function addContact(canisterId, principalId, alias) {
  const contacts = loadContacts();
  if (contacts.some(c => c.canisterId === canisterId)) return false;
  contacts.push({ canisterId, principalId, alias: alias || '' });
  saveContacts(contacts);
  return true;
}

export function removeContact(canisterId) {
  const contacts = loadContacts().filter(c => c.canisterId !== canisterId);
  saveContacts(contacts);
}

export function getContactAlias(canisterId) {
  const contact = loadContacts().find(c => c.canisterId === canisterId);
  return contact?.alias || truncate(canisterId);
}

export function getContactByPrincipal(pid) {
  return loadContacts().find(c => c.principalId === pid) || null;
}

export function getContactByCanister(cid) {
  return loadContacts().find(c => c.canisterId === cid) || null;
}

export function updateContactAlias(canisterId, alias) {
  const contacts = loadContacts();
  const contact = contacts.find(c => c.canisterId === canisterId);
  if (contact) {
    contact.alias = alias;
    saveContacts(contacts);
  }
}
