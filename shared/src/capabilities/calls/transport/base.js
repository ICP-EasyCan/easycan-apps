/**
 * P2PTransport — Classe astratta base per il trasporto P2P.
 *
 * Interfaccia comune per WebRTC (e future implementazioni come Hyperswarm).
 * Non modificare l'interfaccia — le implementazioni la estendono.
 */
export class P2PTransport {
  constructor(peerCanisterId, peerPrincipal) {
    if (new.target === P2PTransport) {
      throw new Error('P2PTransport è una classe astratta');
    }
    this.peerCanisterId = peerCanisterId;
    this.peerPrincipal  = peerPrincipal;

    /** @type {((message: string) => void) | null} */
    this.onMessage = null;
    /** @type {(() => void) | null} */
    this.onConnected = null;
    /** @type {((reason: string) => void) | null} */
    this.onDisconnected = null;
    /** @type {((error: Error) => void) | null} */
    this.onError = null;
  }

  async connect() { throw new Error('connect() non implementato'); }
  async accept() { throw new Error('accept() non implementato'); }
  async send(message) { throw new Error('send() non implementato'); }
  disconnect() { throw new Error('disconnect() non implementato'); }
  get state() { throw new Error('state non implementato'); }
}
