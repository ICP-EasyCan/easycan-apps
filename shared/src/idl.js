/**
 * idl.js — Candid IDL factory condivisa per le app.
 *
 * Definisce l'interfaccia JavaScript del canister.
 * Generata a mano dal file .did — da aggiornare se cambiano gli endpoint.
 *
 * Ogni app ha la propria idl.js con le capability che usa.
 * Questo file è l'equivalente frontend del canister host backend.
 */

import { IDL } from '@dfinity/candid';

// ─── Tipi condivisi ────────────────────────────────────────────────────────────

const Result = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
const ResultU64 = IDL.Variant({ Ok: IDL.Nat64, Err: IDL.Text });
const ResultText = IDL.Variant({ Ok: IDL.Text, Err: IDL.Text });

const PresenceInfo = IDL.Record({ online: IDL.Bool, last_seen_ns: IDL.Nat64 });
const ResultPresence = IDL.Variant({ Ok: PresenceInfo, Err: IDL.Text });

const LeaveMessageResult = IDL.Record({ id: IDL.Nat64, is_first: IDL.Bool });
const ResultLeaveMessage = IDL.Variant({ Ok: LeaveMessageResult, Err: IDL.Text });

const FetchedMessage = IDL.Record({
  id: IDL.Nat64,
  payload: IDL.Vec(IDL.Nat8),
  timestamp: IDL.Nat64,
});

const WebRtcSignalType = IDL.Variant({
  Offer: IDL.Null,
  Answer: IDL.Null,
  IceCandidate: IDL.Null,
});

const SignalEntry = IDL.Record({
  id: IDL.Nat64,
  to: IDL.Principal,
  sig_type: WebRtcSignalType,
  data: IDL.Text,
  timestamp: IDL.Nat64,
});

const ArchiveInput = IDL.Record({
  from_me: IDL.Bool,
  payload: IDL.Vec(IDL.Nat8),
  timestamp: IDL.Nat64,
});

const ArchivedMessage = IDL.Record({
  id: IDL.Nat64,
  peer: IDL.Principal,
  from_me: IDL.Bool,
  payload: IDL.Vec(IDL.Nat8),
  timestamp: IDL.Nat64,
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
  status_code: IDL.Nat16,
  headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
  body: IDL.Vec(IDL.Nat8),
  upgrade: IDL.Opt(IDL.Bool),
});

// ─── IDL Factory ──────────────────────────────────────────────────────────────

export const idlFactory = () => IDL.Service({
  // ── Auth ────────────────────────────────────────────────────────────────
  get_owner:             IDL.Func([], [IDL.Principal], ['query']),
  get_user_principal:    IDL.Func([], [IDL.Opt(IDL.Principal)], ['query']),
  allow_claim:           IDL.Func([], [Result], []),
  claim_user_principal:  IDL.Func([], [Result], []),
  add_to_whitelist:      IDL.Func([IDL.Principal], [Result], []),
  remove_from_whitelist: IDL.Func([IDL.Principal], [Result], []),
  is_whitelisted:        IDL.Func([IDL.Principal], [IDL.Bool], ['query']),

  // ── Presence ────────────────────────────────────────────────────────────
  set_presence: IDL.Func([IDL.Bool], [Result], []),
  get_presence: IDL.Func([], [ResultPresence], ['query']),

  // ── Messaging ───────────────────────────────────────────────────────────
  leave_message:     IDL.Func([IDL.Principal, IDL.Vec(IDL.Nat8), IDL.Nat64], [ResultLeaveMessage], []),
  fetch_my_messages: IDL.Func([], [IDL.Vec(FetchedMessage)], ['query']),
  count_my_messages: IDL.Func([], [IDL.Nat64], ['query']),
  ack_messages:      IDL.Func([IDL.Vec(IDL.Nat64)], [Result], []),

  // ── Signaling ───────────────────────────────────────────────────────────
  post_signal:    IDL.Func([IDL.Principal, WebRtcSignalType, IDL.Text], [Result], []),
  get_my_signals: IDL.Func([], [IDL.Vec(SignalEntry)], ['query']),
  ack_signals:    IDL.Func([IDL.Vec(IDL.Nat64)], [Result], []),

  // ── Notify ──────────────────────────────────────────────────────────────
  notify_pending_message: IDL.Func([IDL.Principal], [Result], []),
  get_pending_senders:    IDL.Func([], [IDL.Vec(IDL.Principal)], ['query']),
  clear_pending_sender:   IDL.Func([IDL.Principal], [Result], []),
  notify_pending_call:    IDL.Func([IDL.Principal], [Result], []),
  get_pending_callers:    IDL.Func([], [IDL.Vec(IDL.Principal)], ['query']),
  clear_pending_caller:   IDL.Func([IDL.Principal], [Result], []),

  // ── Archive ─────────────────────────────────────────────────────────────
  archive_messages:         IDL.Func([IDL.Principal, IDL.Vec(ArchiveInput)], [ResultU64], []),
  get_archived_messages:    IDL.Func([IDL.Principal], [IDL.Vec(ArchivedMessage)], ['query']),
  set_chat_persistent:      IDL.Func([IDL.Principal, IDL.Bool], [Result], []),
  is_chat_persistent:       IDL.Func([IDL.Principal], [IDL.Bool], ['query']),
  get_all_persistent_chats: IDL.Func([], [IDL.Vec(IDL.Principal)], ['query']),

  // ── Crypto ──────────────────────────────────────────────────────────────
  get_verification_key: IDL.Func([IDL.Text], [ResultText], []),
  derive_encrypted_key: IDL.Func([IDL.Text, DerivationContext, IDL.Vec(IDL.Nat8)], [ResultText], []),

  // ── Assets ──────────────────────────────────────────────────────────────
  upload_asset:        IDL.Func([IDL.Text, IDL.Text, IDL.Vec(IDL.Nat8)], [Result], []),
  http_request:        IDL.Func([HttpRequest], [HttpResponse], ['query']),
  http_request_update: IDL.Func([HttpRequest], [HttpResponse], []),
});
