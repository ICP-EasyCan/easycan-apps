/**
 * idl.js — Candid IDL factory per Sovereign Vault.
 */

import { IDL } from '@dfinity/candid';
import { platformMethods } from '@shared/core/platform-idl.js';

// ─── Tipi ───────────────────────────────────────────────────────────────────

const Result = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
const ResultText = IDL.Variant({ Ok: IDL.Text, Err: IDL.Text });

const CrudRecord = IDL.Record({
  id: IDL.Nat64,
  namespace: IDL.Text,
  data: IDL.Vec(IDL.Nat8),
  created_at: IDL.Nat64,
  updated_at: IDL.Nat64,
});

const ResultCrudRecord = IDL.Variant({ Ok: CrudRecord, Err: IDL.Text });

const CreateInput = IDL.Record({
  namespace: IDL.Text,
  data: IDL.Vec(IDL.Nat8),
});

const UpdateInput = IDL.Record({
  data: IDL.Vec(IDL.Nat8),
});

const ListResult = IDL.Record({
  records: IDL.Vec(CrudRecord),
  total: IDL.Nat64,
});

const DerivationContext = IDL.Variant({
  PeerConversation: IDL.Record({ peer: IDL.Principal }),
  StoredData: IDL.Record({ data_id: IDL.Text }),
  Custom: IDL.Record({ context: IDL.Vec(IDL.Nat8) }),
});

const HttpRequest = IDL.Record({
  url: IDL.Text,
  method: IDL.Text,
  body: IDL.Vec(IDL.Nat8),
  headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
});

const HttpResponse = IDL.Record({
  body: IDL.Vec(IDL.Nat8),
  headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
  upgrade: IDL.Opt(IDL.Bool),
  status_code: IDL.Nat16,
});

// ─── Service ────────────────────────────────────────────────────────────────

export const idlFactory = ({ IDL: _IDL }) => {
  return IDL.Service({
    // app version (self-upgrade §B)
    app_version:          IDL.Func([], [IDL.Text], ['query']),

    // core-auth
    get_owner:            IDL.Func([], [IDL.Principal], ['query']),
    get_user_principal:   IDL.Func([], [IDL.Opt(IDL.Principal)], ['query']),
    allow_claim:          IDL.Func([], [Result], []),
    claim_user_principal: IDL.Func([], [Result], []),
    add_to_whitelist:     IDL.Func([IDL.Principal], [Result], []),
    remove_from_whitelist:IDL.Func([IDL.Principal], [Result], []),
    is_whitelisted:       IDL.Func([IDL.Principal], [IDL.Bool], ['query']),

    // core-assets
    upload_asset:         IDL.Func([IDL.Text, IDL.Text, IDL.Vec(IDL.Nat8)], [Result], []),
    upload_asset_batch:   IDL.Func([IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text, IDL.Vec(IDL.Nat8)))], [Result], []),
    finalize_assets:      IDL.Func([], [Result], []),
    clear_assets:         IDL.Func([], [Result], []),
    http_request:         IDL.Func([HttpRequest], [HttpResponse], ['query']),
    http_request_update:  IDL.Func([HttpRequest], [HttpResponse], []),

    // cap-crud
    create_record:        IDL.Func([CreateInput], [ResultCrudRecord], []),
    get_record:           IDL.Func([IDL.Nat64], [IDL.Opt(CrudRecord)], ['query']),
    list_records:         IDL.Func([IDL.Text, IDL.Nat64, IDL.Nat64], [ListResult], ['query']),
    update_record:        IDL.Func([IDL.Nat64, UpdateInput], [ResultCrudRecord], []),
    delete_record:        IDL.Func([IDL.Nat64], [Result], []),
    count_records:        IDL.Func([IDL.Text], [IDL.Nat64], ['query']),

    // cap-crypto
    get_verification_key: IDL.Func([IDL.Text], [ResultText], []),
    derive_encrypted_key: IDL.Func([IDL.Text, DerivationContext, IDL.Vec(IDL.Nat8)], [ResultText], []),

    // cap-platform (frammento IDL condiviso)
    ...platformMethods(),
  });
};
