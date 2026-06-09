/**
 * config.js — configurazione runtime per qualsiasi app ICP.
 *
 * Canister ID rilevato dall'hostname (abc123.localhost → abc123).
 * Funziona sia in locale (dfx) che in mainnet (abc123.icp0.io).
 */

function detectCanisterId() {
  const host = window.location.hostname;
  const candidate = host.split('.')[0];
  if (candidate === 'localhost' || candidate === '127') {
    return import.meta.env.CANISTER_ID ?? '';
  }
  return candidate;
}

export const CANISTER_ID = detectCanisterId();

export const DFX_NETWORK = import.meta.env.DFX_NETWORK ?? 'local';
export const IS_LOCAL = DFX_NETWORK === 'local';

export const CANISTER_URL = IS_LOCAL
  ? `http://${CANISTER_ID}.localhost:4943`
  : `https://${CANISTER_ID}.icp0.io`;

export const II_URL = IS_LOCAL
  ? 'http://rdmx6-jaaaa-aaaaa-aaadq-cai.localhost:4943'
  : 'https://identity.ic0.app';

export const IC_HOST = IS_LOCAL
  ? 'http://127.0.0.1:4943'
  : 'https://ic0.app';

// ─── Configurazione ICE/WebRTC ────────────────────────────────────────────────
// TODO(TURN): aggiungere un server TURN per NAT symmetric
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
