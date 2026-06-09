/**
 * Typed errors for messaging and calls.
 *
 * Codes are stable and meant to be mapped to UI strings by the consumer.
 *
 * MessagingError.code:
 *   - 'not_in_whitelist'      → recipient has not added the sender
 *   - 'canister_unreachable'  → network / certificate / canister rejected the call
 *   - 'unknown'               → unmapped failure (see `message`)
 *
 * CallError.code:
 *   - 'not_in_whitelist'      → peer has not added the caller
 *   - 'peer_offline'          → peer did not respond in time (no signal received)
 *   - 'canister_unreachable'  → network / certificate failure
 *   - 'webrtc_failed'         → WebRTC pc went to failed/closed/disconnected
 *   - 'mic_denied'            → user denied microphone permission
 *   - 'busy'                  → another call already in progress
 *   - 'unknown'               → unmapped failure
 */

export class MessagingError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'MessagingError';
    this.code = code;
  }
}

export class CallError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'CallError';
    this.code = code;
  }
}

/** Heuristic: classify a raw thrown error from an ICP call into a code. */
export function classifyIcpError(err) {
  const msg = String(err?.message || err || '');
  if (/whitelist|Unauthorized/i.test(msg)) return 'not_in_whitelist';
  if (/agent|network|fetch|certificate|reject|destination|canister/i.test(msg)) return 'canister_unreachable';
  return 'unknown';
}
