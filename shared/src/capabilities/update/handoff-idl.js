/**
 * handoff-idl.js — IDL minimi per il ricevitore di handoff in-app (Arco B, cambio-app L2).
 *
 * Il ricevitore (`handoff.js`) parla con DUE canister della piattaforma che NON sono
 * l'app stessa, quindi servono service IDL dedicati (non l'idl dell'app):
 *   - spawner: `get_app_info` (→ factory_canister_id) + `consume_install_token`
 *     (brucia il token one-time e ritorna l'app_id autentico da reinstallare);
 *   - factory: `get_wasm_sha256` (l'àncora SHA-256 on-chain, B0-slice).
 *
 * Sono frammenti deliberatamente sottili: il browsing/marketplace resta nel portale.
 */

import { IDL } from '@dfinity/candid';

/** Sottoinsieme di AppInfo che ci serve. Candid ignora i campi extra sul wire. */
const AppInfo = IDL.Record({
  app_id: IDL.Text,
  developer_principal: IDL.Principal,
  developer_name: IDL.Text,
  price_e8s_xdr: IDL.Nat64,
  is_active: IDL.Bool,
  factory_canister_id: IDL.Principal,
  short_description: IDL.Text,
  category: IDL.Text,
});

const ResultText = IDL.Variant({ Ok: IDL.Text, Err: IDL.Text });

/** IDL spawner — solo i metodi che tocca il ricevitore. */
export const spawnerHandoffIdl = () => IDL.Service({
  get_app_info:          IDL.Func([IDL.Text], [IDL.Opt(AppInfo)], ['query']),
  consume_install_token: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Principal], [ResultText], []),
});

/** IDL factory — solo l'àncora SHA-256 on-chain (B0-slice). */
export const factoryAnchorIdl = () => IDL.Service({
  get_wasm_sha256: IDL.Func([], [IDL.Opt(IDL.Vec(IDL.Nat8))], ['query']),
});
