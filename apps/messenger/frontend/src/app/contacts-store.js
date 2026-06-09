/**
 * contacts-store.js — Gestione contatti in localStorage
 *
 * Condiviso tra chats.js e settings.js.
 * Ogni contatto: { canisterId, principalId, alias }
 */

const STORAGE_KEY = 'sm_contacts';

export function loadContacts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

export function saveContacts(contacts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts));
}

export function addContact(canisterId, principalId, alias = '') {
  const contacts = loadContacts();
  if (contacts.some(c => c.canisterId === canisterId)) return false;
  contacts.push({ canisterId, principalId, alias });
  saveContacts(contacts);
  return true;
}

export function removeContact(canisterId) {
  const contacts = loadContacts().filter(c => c.canisterId !== canisterId);
  saveContacts(contacts);
}

export function getContactAlias(canisterId) {
  const c = loadContacts().find(c => c.canisterId === canisterId);
  return c?.alias || '';
}

export function updateContactAlias(canisterId, alias) {
  const contacts = loadContacts();
  const c = contacts.find(c => c.canisterId === canisterId);
  if (c) { c.alias = alias; saveContacts(contacts); }
}
