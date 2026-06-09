/**
 * sovereignty.js — L1: modello di stato puro della sovranità (no DOM, no rete).
 *
 * L'UNICO posto che codifica il modello binario sovrano-di-default e i suoi
 * sotto-stati (support on/off, portale rimosso, controllo EasyCan). Riusato da vault,
 * future app marketplace e (per la parte pura) dal portale.
 *
 * Frugalità cicli garantita per costruzione: queste funzioni NON fanno alcuna
 * chiamata IC. Ricevono `(meta, controllers)` già fetchati dal chiamante, che
 * deve fare al più UNA `canister_status` per card.
 *
 * `meta` grezzo = risultato di `platform_metadata` (candid AppMetadata): tutti
 * gli `Opt(Principal)` arrivano come array `[]` (None) o `[principal]` (Some).
 * `parseMetadata` li normalizza una volta sola. Tollera campi assenti (vecchi
 * metadata) trattandoli come `None` → backward-compat stable memory.
 *
 * Modello di riferimento: docs/catalog/cap-platform.md §Modello di sovranità.
 */

/**
 * Normalizza un `Opt` candid in `Principal | null`.
 * @param {unknown} opt  array candid: `[]` (None) o `[principal]` (Some)
 * @returns {import('@dfinity/principal').Principal | null}
 */
export function optPrincipal(opt) {
  return Array.isArray(opt) && opt.length > 0 ? opt[0] : null;
}

/**
 * Predicato "principal è tra i controller", null-safe.
 * @param {import('@dfinity/principal').Principal[] | null} controllers
 * @param {import('@dfinity/principal').Principal | null} principal
 * @returns {boolean}
 */
export function controllersInclude(controllers, principal) {
  if (principal == null || !Array.isArray(controllers)) return false;
  const t = principal.toText();
  return controllers.some((c) => c.toText() === t);
}

/**
 * Normalizza il metadata grezzo di `platform_metadata`. Esegue l'unwrap degli
 * `Opt` una volta sola; campi assenti → `null` (backward-compat).
 *
 * @param {Record<string, any> | null | undefined} rawMeta
 * @returns {{
 *   isStandalone: boolean,
 *   ejected: boolean,
 *   admin: import('@dfinity/principal').Principal | null,
 *   spawner: import('@dfinity/principal').Principal | null,
 *   portalOwner: import('@dfinity/principal').Principal | null,
 *   originalSpawner: import('@dfinity/principal').Principal | null,
 *   originalPortalOwner: import('@dfinity/principal').Principal | null,
 *   tier: number,
 *   wasmHash: string | null,
 * } | null}  null se `rawMeta` è assente
 */
export function parseMetadata(rawMeta) {
  if (!rawMeta) return null;
  return {
    isStandalone: rawMeta.is_standalone === true,
    ejected: rawMeta.ejected === true,
    admin: optPrincipal(rawMeta.admin),
    spawner: optPrincipal(rawMeta.spawner),
    portalOwner: optPrincipal(rawMeta.portal_owner),
    originalSpawner: optPrincipal(rawMeta.original_spawner),
    originalPortalOwner: optPrincipal(rawMeta.original_portal_owner),
    tier: Number(rawMeta.tier ?? 0),
    wasmHash: (Array.isArray(rawMeta.wasm_hash) && rawMeta.wasm_hash.length > 0)
      ? rawMeta.wasm_hash[0]
      : null,
  };
}

/**
 * Deriva lo stato di sovranità dal metadata normalizzato + lista controller live.
 *
 * `mode` e `portalRemoved` dipendono solo dal metadata (sempre noti). I sotto-stati
 * che dipendono dalla lista controller (`supportGranted`, `easycanControls`)
 * richiedono `canister_status`: se questa fallisce, il chiamante passa
 * `controllers = null` e tali campi diventano `null` (sconosciuto), NON `false`.
 * `statusKnown` distingue "status non disponibile" da "emancipated puro" (evita
 * la degradazione silenziosa: badge che spariscono invece di restare ignoti).
 *
 * @param {ReturnType<typeof parseMetadata>} meta  metadata normalizzato
 * @param {import('@dfinity/principal').Principal[] | null} controllers
 *        lista controller live, o `null` se `canister_status` è fallita
 * @returns {{
 *   mode: 'standalone' | 'managed' | 'emancipated',
 *   statusKnown: boolean,
 *   supportGranted: boolean | null,
 *   portalRemoved: boolean,
 *   easycanControls: boolean | null,
 * } | null}  null se `meta` è assente
 */
export function deriveSovereignty(meta, controllers) {
  if (!meta) return null;

  const statusKnown = Array.isArray(controllers);

  /** @type {'standalone' | 'managed' | 'emancipated'} */
  let mode;
  if (meta.isStandalone) mode = 'standalone';
  else if (!meta.ejected) mode = 'managed';
  else mode = 'emancipated';

  const portalRemoved = meta.portalOwner == null && meta.originalPortalOwner != null;

  if (!statusKnown) {
    return { mode, statusKnown: false, supportGranted: null, portalRemoved, easycanControls: null };
  }

  const supportGranted = mode === 'emancipated'
    && controllersInclude(controllers, meta.originalSpawner);

  const easycanControls = controllersInclude(controllers, meta.spawner)
    || controllersInclude(controllers, meta.originalSpawner);

  return { mode, statusKnown: true, supportGranted, portalRemoved, easycanControls };
}
