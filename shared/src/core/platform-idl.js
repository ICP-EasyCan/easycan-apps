/**
 * platform-idl.js — Frammento IDL condiviso per cap-platform.
 *
 * Ogni app marketplace ha un service IDL diverso (core/cap propri), ma il blocco
 * cap-platform è identico: si condivide SOLO questo frammento, non l'intero
 * service. Il consumer fa lo spread di `platformMethods()` dentro la propria
 * `IDL.Service({ ... })`.
 *
 * Deve restare byte-faithful col blocco platform_* precedentemente inline nelle
 * app (stesse firme, stesso AppMetadata).
 */

import { IDL } from '@dfinity/candid';

/** Record metadata restituito da `platform_metadata`. */
export const AppMetadata = IDL.Record({
  is_standalone: IDL.Bool,
  admin: IDL.Opt(IDL.Principal),
  spawner: IDL.Opt(IDL.Principal),
  ejected: IDL.Bool,
  wasm_hash: IDL.Opt(IDL.Text),
  tier: IDL.Nat8,
  portal_owner: IDL.Opt(IDL.Principal),
  original_spawner: IDL.Opt(IDL.Principal),
  original_portal_owner: IDL.Opt(IDL.Principal),
});

/**
 * Metodi cap-platform da spreddare nella `IDL.Service` di un'app marketplace.
 * @returns {Record<string, any>}
 */
export function platformMethods() {
  const Result = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  return {
    platform_claim:             IDL.Func([IDL.Vec(IDL.Nat8)], [IDL.Variant({ Ok: IDL.Principal, Err: IDL.Text })], []),
    platform_get_admin:         IDL.Func([], [IDL.Opt(IDL.Principal)], ['query']),
    platform_eject:             IDL.Func([IDL.Bool], [Result], []),
    platform_remove_portal:     IDL.Func([], [Result], []),
    platform_restore_portal:    IDL.Func([], [Result], []),
    platform_re_enroll:         IDL.Func([IDL.Principal], [Result], []),
    platform_add_controller:    IDL.Func([IDL.Principal], [Result], []),
    platform_remove_controller: IDL.Func([IDL.Principal], [Result], []),
    platform_metadata:          IDL.Func([], [AppMetadata], ['query']),
    platform_is_standalone:     IDL.Func([], [IDL.Bool], ['query']),
  };
}
