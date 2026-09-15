import type { KvStore } from '../kv-store/index.js';

/**
 * Builds the picocash charge method for `Mppx.create`, from just a mint URL.
 *
 * Reads the mint's active keyset (`GET {mintUrl}/v1/keys`) to derive the unit
 * (`tip20:<chainId>:<currency>`), then constructs the service wallet (receives
 * swapped proofs — needs no balance), a `PicocashAcceptor` backed by the shared
 * KV replay store when one is configured, and the router-shaped `charge()`
 * method. The returned `method` is added to the same `Mppx.create` methods
 * array as `tempo.charge`, so the charge 402 advertises both.
 */
export interface PicocashInitResult {
  method: import('mppx').Method.AnyServer;
  mintUrl: string;
  unit: string;
}

export async function initPicocash(
  config: { mintUrl: string },
  realm: string,
  kvStore: KvStore | undefined,
): Promise<PicocashInitResult> {
  const { Wallet } = await import('@picocash/sdk');
  const { PicocashAcceptor, KvAcceptorStore } = await import('@picocash/mppx-method');
  const { charge } = await import('@picocash/mppx-method/mppx');

  const mintUrl = config.mintUrl.replace(/\/$/, '');
  const wallet = new Wallet({ mintUrl });
  const keyset = await wallet.getKeyset();
  const [, chainId, currency] = keyset.unit.split(':');
  if (!chainId || !currency) {
    throw new Error(`picocash: unexpected mint unit "${keyset.unit}" (want tip20:<chainId>:<address>)`);
  }

  // The KV store the router already provisions for MPP replay doubles as the
  // shared AcceptorStore: same durability guarantees, one backing store.
  const store = kvStore ? new KvAcceptorStore(kvStore, { prefix: 'picocash:' }) : undefined;

  const acceptor = new PicocashAcceptor({
    realm,
    mints: [{ url: mintUrl, keyset }],
    ...(store ? { store } : {}),
  });

  const method = charge({
    acceptor,
    wallet,
    currency,
    chainId: Number(chainId),
    mints: [{ url: mintUrl, keysetIds: [keyset.id] }],
  });

  return { method, mintUrl, unit: keyset.unit };
}
