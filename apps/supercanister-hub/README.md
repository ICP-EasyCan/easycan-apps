# EasyHub — your sovereign computer

> *A personal sovereign computer, awake when you're not, that guards what only you can see
> and DOES what you told it — and of which you can prove what it is running.*

EasyHub is a single canister you **own** after claim. It controls itself — no backdoor, no admin
recovery, no controller but you. It is not a launcher of mini-apps: it is an **agent** built on three
superpowers that nothing else on the marketplace combines.

## The three superpowers

- **It acts (automation).** Scheduled jobs run with your browser closed — fetch, store, call, notify.
  The agent does what you armed it to do, in your absence.
- **It guards (crypto).** VetKeys encryption keeps what only you can see, and *releases* secrets only
  on the conditions you set (e.g. to a designated recipient after a window of silence). Plaintext never
  lives in the canister.
- **It is verifiable.** What the agent can do is an **enumerable, hash-verified manifest** — not a
  black box. This is possible because every action is a closed, declared sequence (no opaque DSL): you
  can read, and prove, exactly what it runs.

Mini-apps are how the computer **extends itself**: hash-verified, installable, each confined to the
permissions you approved and isolated in an opaque sandbox. They are a capability of the computer, not
the product.

## The model of power (two levels)

- **Bridge live** — a mini-app acts *while you watch*: benign powers, gated by the manifest (today only
  KV, confined to its own namespace, enforced in-canister).
- **Armed job** — a mini-app acts *in your absence*, or *reaches outside* (HTTP, inter-canister,
  crypto): gated by your **arming**. What acts in your absence or goes outside requires arming; what is
  benign while you're present needs only the manifest.

The unit you govern is the **armed job**, not the manifest permission. "Revoke the card" = disarm the
job.

## What stays invariant (the promise)

Verifiability / hash gate · no owner II identity in any bundle · no backdoor, no admin recovery · claim
from the app's own origin, per-origin principal · per-namespace confinement enforced **in-canister** ·
one canister per buyer who claims it · the marketplace/portal is off-limits to the live canister.

---

This directory is the **source** (REGOLA D'ORO): the public app artifact and the bundle store are
generated from here, never edited by hand. Build/architecture details live in the monorepo docs and in
the project memory (`supercanister_hub_costruzione`, `supercanister_hub_rivoluzione`). Authoring kit for
mini-apps → `bundles/README.md`.
