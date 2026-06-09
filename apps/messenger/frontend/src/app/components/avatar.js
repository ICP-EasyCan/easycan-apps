/**
 * avatar.js — Avatar con iniziali e colore derivato dall'ID.
 *
 * Uso:
 *   const div = avatarEl('Alice', principalId);
 *   // → <div class="avatar" style="--avatar-color:#...">AL</div>
 *
 * Il colore è stabile per lo stesso ID (hash deterministico).
 * La classe CSS `.avatar` può essere estesa con `.sm` per dimensione ridotta.
 * Predisposto per background-image (immagine profilo futura).
 */

const PALETTE = ['#6c63ff', '#4ecdc4', '#fc5c65', '#fd9644', '#26de81', '#a29bfe', '#fd79a8', '#00b894'];

function _hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * @param {string} alias         — alias del contatto ('' se assente)
 * @param {string} principalOrCid — principal o canister ID (per derivare il colore)
 * @returns {HTMLElement}
 */
export function avatarEl(alias, principalOrCid) {
  const color    = PALETTE[_hash(principalOrCid || '') % PALETTE.length];
  const initials = alias
    ? alias.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
    : (principalOrCid || '?')[0].toUpperCase();

  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.setProperty('--avatar-color', color);
  div.textContent = initials;
  return div;
}
