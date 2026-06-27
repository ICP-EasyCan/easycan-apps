/**
 * idl.js — Candid IDL factory per EasyHub (supercanister-hub).
 *
 * F0: storage = KV `namespace:key` (cap-store). Host bundle / automazioni
 * aggiungono i loro metodi nelle fasi successive (F1+).
 */

import { IDL } from '@dfinity/candid';
import { platformMethods } from '@shared/core/platform-idl.js';

// ─── Tipi ───────────────────────────────────────────────────────────────────

const Result = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
const ResultText = IDL.Variant({ Ok: IDL.Text, Err: IDL.Text });
// cap-store — KV per-attore (F4 bridge): Actor::Bundle confinato ai namespace dichiarati
const Actor = IDL.Variant({ Owner: IDL.Null, Bundle: IDL.Text });
const ResultOptBlob = IDL.Variant({ Ok: IDL.Opt(IDL.Vec(IDL.Nat8)), Err: IDL.Text });
const ResultVecText = IDL.Variant({ Ok: IDL.Vec(IDL.Text), Err: IDL.Text });
// Capsula in OUTBOUND-PUSH: canale d'uscita (__secrets) + finestra di silenzio + flag fire-once.
const DeliveryConfig = IDL.Record({ channel: IDL.Text, window_secs: IDL.Nat64, delivered: IDL.Bool });

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

// cap-store — host bundle (gate hash)
const BundlePermissions = IDL.Record({
  storage_namespaces: IDL.Vec(IDL.Text),
  http_outcall_hosts: IDL.Vec(IDL.Text),
  inter_canister: IDL.Vec(IDL.Text),
  uses_crypto: IDL.Bool,
  uses_timer: IDL.Bool,
});

const BundleFile = IDL.Record({
  path: IDL.Text,
  content_type: IDL.Text,
  size: IDL.Nat64,
  total_chunks: IDL.Nat32,
});

const BundleMeta = IDL.Record({
  module_id: IDL.Text,
  version: IDL.Text,
  sha256: IDL.Text,
  size_bytes: IDL.Nat64,
  installed_at: IDL.Nat64,
  files: IDL.Vec(BundleFile),
  permissions: BundlePermissions,
});

const ResultBundle = IDL.Variant({ Ok: BundleMeta, Err: IDL.Text });

// cap-automation — azioni-primitiva + job + scheduler persistente
const Action = IDL.Variant({
  KvSet: IDL.Record({ namespace: IDL.Text, key: IDL.Text, value: IDL.Text }),
  KvGet: IDL.Record({ namespace: IDL.Text, key: IDL.Text }),
  KvDel: IDL.Record({ namespace: IDL.Text, key: IDL.Text }),
  CryptoHash: IDL.Record({ input: IDL.Text }),
  // F3b: HTTP outcall (esterna, permission-gated). headers = vec record { text; text }.
  Http: IDL.Record({
    method: IDL.Text,
    url: IDL.Text,
    headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    body: IDL.Text,
    max_response_bytes: IDL.Nat64,
  }),
  // F3c: chiamata inter-canister (esterna, permission-gated). arg_hex = args candid raw in hex.
  CanisterCall: IDL.Record({
    canister_id: IDL.Text,
    method: IDL.Text,
    arg_hex: IDL.Text,
  }),
});

const Guard = IDL.Record({ field: IDL.Text, op: IDL.Text, value: IDL.Text });

const Job = IDL.Record({
  job_id: IDL.Text,
  owning_bundle: IDL.Opt(IDL.Text),
  actions: IDL.Vec(Action),
  guard: IDL.Opt(Guard),
  title: IDL.Opt(IDL.Text), // F5: etichetta umana per il Feed-home (additivo, opt)
});

const Schedule = IDL.Record({
  schedule_id: IDL.Text,
  job_id: IDL.Text,
  interval_secs: IDL.Nat64,
  next_run_secs: IDL.Nat64,
});

const JobOutcome = IDL.Variant({ Completed: IDL.Null, Skipped: IDL.Null });
const ResultOutcome = IDL.Variant({ Ok: JobOutcome, Err: IDL.Text });

// G1 credenziali d'uscita — nome + valore mascherato (mai il chiaro)
const SecretInfo = IDL.Record({ name: IDL.Text, masked: IDL.Text });

// ─── Service ────────────────────────────────────────────────────────────────

export const idlFactory = () => {
  return IDL.Service({
    // app version (self-upgrade §B)
    app_version:          IDL.Func([], [IDL.Text], ['query']),

    // core-auth
    get_owner:            IDL.Func([], [IDL.Principal], ['query']),
    get_user_principal:   IDL.Func([], [IDL.Opt(IDL.Principal)], ['query']),
    allow_claim:          IDL.Func([], [Result], []),
    claim_user_principal: IDL.Func([], [Result], []),

    // core-assets
    upload_asset:         IDL.Func([IDL.Text, IDL.Text, IDL.Vec(IDL.Nat8)], [Result], []),
    upload_asset_batch:   IDL.Func([IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text, IDL.Vec(IDL.Nat8)))], [Result], []),
    finalize_assets:      IDL.Func([], [Result], []),
    clear_assets:         IDL.Func([], [Result], []),
    http_request:         IDL.Func([HttpRequest], [HttpResponse], ['query']),
    http_request_update:  IDL.Func([HttpRequest], [HttpResponse], []),

    // presenza-owner / heartbeat (F1) — battito server-stamped nel namespace riservato __presence
    checkin:              IDL.Func([], [Result], []),
    last_checkin:         IDL.Func([], [IDL.Opt(IDL.Nat64)], ['query']),

    // credenziali d'uscita (G1) — registro __secrets, mai il chiaro on-the-wire (no get_secret)
    set_secret:           IDL.Func([IDL.Text, IDL.Text], [Result], []),
    list_secrets:         IDL.Func([], [IDL.Vec(SecretInfo)], ['query']),
    delete_secret:        IDL.Func([IDL.Text], [Result], []),

    // cap-store (KV namespace:key)
    kv_set:               IDL.Func([IDL.Text, IDL.Text, IDL.Vec(IDL.Nat8)], [Result], []),
    kv_get:               IDL.Func([IDL.Text, IDL.Text], [IDL.Opt(IDL.Vec(IDL.Nat8))], ['query']),
    kv_delete:            IDL.Func([IDL.Text, IDL.Text], [Result], []),
    kv_list:              IDL.Func([IDL.Text], [IDL.Vec(IDL.Text)], ['query']),

    // cap-store (KV per-attore — bridge shell→bundle, enforcement F2 in-canister)
    kv_set_as:            IDL.Func([Actor, IDL.Text, IDL.Text, IDL.Vec(IDL.Nat8)], [Result], []),
    kv_get_as:            IDL.Func([Actor, IDL.Text, IDL.Text], [ResultOptBlob], ['query']),
    kv_delete_as:         IDL.Func([Actor, IDL.Text, IDL.Text], [Result], []),
    kv_list_as:           IDL.Func([Actor, IDL.Text], [ResultVecText], ['query']),

    // cap-store (host bundle — gate hash)
    install_bundle:       IDL.Func([IDL.Text, IDL.Vec(IDL.Nat8), IDL.Text, IDL.Text, BundlePermissions], [ResultBundle], []),
    uninstall_bundle:     IDL.Func([IDL.Text], [Result], []),
    list_bundles:         IDL.Func([], [IDL.Vec(BundleMeta)], ['query']),

    // cap-automation (azioni interne + scheduler persistente)
    create_job:           IDL.Func([Job], [Result], []),
    delete_job:           IDL.Func([IDL.Text], [Result], []),
    list_jobs:            IDL.Func([], [IDL.Vec(Job)], ['query']),
    schedule_job:         IDL.Func([IDL.Text, IDL.Nat64], [ResultText], []),
    unschedule:           IDL.Func([IDL.Text], [Result], []),
    list_schedules:       IDL.Func([], [IDL.Vec(Schedule)], ['query']),
    run_job_now:          IDL.Func([IDL.Text], [ResultOutcome], []),
    job_status:           IDL.Func([IDL.Text], [IDL.Opt(IDL.Text)], ['query']),
    automation_log:       IDL.Func([], [IDL.Vec(IDL.Text)], ['query']),

    // cap-crypto
    get_verification_key: IDL.Func([IDL.Text], [ResultText], []),
    derive_encrypted_key: IDL.Func([IDL.Text, DerivationContext, IDL.Vec(IDL.Nat8)], [ResultText], []),

    // Capsula del tempo: deposito dell'envelope (sigillato off-canister, opaco al canister)
    set_release_capsule:  IDL.Func([IDL.Vec(IDL.Nat8)], [Result], []),

    // Capsula in OUTBOUND-PUSH (l'agente consegna fuori al silenzio) — endpoint owner
    set_delivery_config:   IDL.Func([IDL.Text, IDL.Nat64], [Result], []),
    clear_delivery_config: IDL.Func([], [Result], []),
    get_delivery_config:   IDL.Func([], [IDL.Opt(DeliveryConfig)], ['query']),

    // cap-platform (frammento IDL condiviso)
    ...platformMethods(),
  });
};
