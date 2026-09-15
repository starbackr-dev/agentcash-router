# picocash charge method

Adds [picocash](https://github.com/picocash) — Chaumian eCash proofs backed by a
TIP-20 stablecoin vault on Tempo — as a charge method alongside `tempo` and
`x402`. Enable it with one config block:

```ts
createRouter({
  baseUrl: 'https://api.example.com',
  protocols: ['mpp'],
  mpp: {
    secretKey: process.env.MPP_SECRET_KEY!,
    currency: '0x20c0…',            // backing token
    picocash: { mintUrl: 'https://mint.picocash.dev' },
  },
  discovery: { serviceName: 'my-api' },
});
```

The router then advertises `method="picocash"` on charge 402s and settles those
credentials by swapping the proofs at the mint (**settle-first** — the swap is
the finality point). picocash needs **no payee or operator key on the server**:
settlement is a mint HTTP call, not an on-chain transfer, and the credential
carries no payer address.

## How it fits the existing MPP plumbing

- **`src/init/picocash.ts`** reads the mint's keyset (`GET {mintUrl}/v1/keys`),
  derives the unit, builds the service wallet + a `PicocashAcceptor` (backed by
  the router's KV store as its replay store), and returns the mppx `charge`
  method.
- **`src/init/mppx.ts`** adds that method to the same `Mppx.create({ methods })`
  array as `tempo.charge`, so one 402 offers both.
- **`src/protocols/mpp/picocash-mode.ts`** is a new settlement mode parallel to
  tx/hash/session: verify runs the method's offline checks and swaps at the mint
  (settle-first, before the handler); settle attaches the receipt.

## Run the end-to-end demo

`examples/picocash/e2e.mts` builds a real router with `mpp.picocash`, funds a
wallet with one on-chain deposit, and pays a gated route — proving the flow
against the live testnet mint:

```sh
PICOCASH_E2E_PAYER_KEY=0x… tsx examples/picocash/e2e.mts
# [e2e] call 1: 200 · settlement=settled method=picocash · balance 40000
# [e2e] double-spend: first 200, replay 402
# [e2e] PASS — picocash paid through the AgentCash router, settle-first; double-spend refused.
```

## Status

Proven end to end on Tempo Moderato (testnet). Merging upstream needs
`@picocash/mppx-method` and `@picocash/sdk` published to npm (currently
developed in the picocash monorepo); this branch links them locally. Everything
picocash is pre-alpha, testnet-only, unaudited.
