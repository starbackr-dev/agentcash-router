/**
 * Proves the router patch: a real @agentcash/router instance with
 * mpp.picocash configured, gating a paid route, paid end-to-end by a picocash
 * wallet against the live testnet mint. Server + client both use THIS repo's
 * mppx (version-matched).
 *
 *   node --import tsx picocash-e2e.mts        # from the fork root
 * needs PICOCASH_E2E_PAYER_KEY in env (a faucet-funded testnet key).
 */
import { serve } from '@hono/node-server';
import { createRouter } from '../../src/index.js';
import { Fetch } from 'mppx/client';
import { Wallet, sumProofs, type Proof } from '@picocash/sdk';
import { picocash } from '@picocash/mppx-method/mppx';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const MINT_URL = 'https://mint.picocash.dev';
const PORT = 8455;
const payerKey = process.env.PICOCASH_E2E_PAYER_KEY as `0x${string}` | undefined;
if (!payerKey) throw new Error('PICOCASH_E2E_PAYER_KEY not set');

// 1. Build the PATCHED router with picocash enabled, x402 off, mpp on.
const router = createRouter({
  baseUrl: `http://localhost:${PORT}`,
  payeeAddress: '0x000000000000000000000000000000000000dEaD',
  protocols: ['mpp'],
  mpp: {
    secretKey: 'picocash-router-e2e-secret-key-0123456789',
    currency: '0x20c0000000000000000000000000000000000000',
    picocash: { mintUrl: MINT_URL },
  },
  discovery: { serviceName: 'fortune', tags: ['demo'] },
});
router.route('fortune').paid('0.01').handler(async () => ({ fortune: 'paid via picocash through the AgentCash router' }));

const server = serve({ fetch: router.fetch, port: PORT });
await new Promise((r) => setTimeout(r, 500));

// 2. Fund a picocash wallet (one on-chain deposit).
const wallet = new Wallet({ mintUrl: MINT_URL });
const keyset = await wallet.getKeyset();
let proofs: Proof[] = [];
{
  const quote = await wallet.requestMintQuote(50_000);
  const dep = (quote as any).deposit;
  const chain = defineChain({ id: dep.chain_id, name: 'tempo', nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: { default: { http: [process.env.PICOCASH_TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'] } } });
  const acct = privateKeyToAccount(payerKey);
  const wc = createWalletClient({ account: acct, chain, transport: http() });
  const pub = createPublicClient({ chain, transport: http() });
  const tx = await wc.writeContract({ address: dep.token, abi: parseAbi(['function transferWithMemo(address to, uint256 amount, bytes32 memo)']), functionName: 'transferWithMemo', args: [dep.to, 50_000n, dep.memo] });
  await pub.waitForTransactionReceipt({ hash: tx });
  let state = (quote as any).state;
  const t0 = Date.now();
  while (state !== 'PAID') { if (Date.now() - t0 > 120000) throw new Error('deposit timeout'); await new Promise((r) => setTimeout(r, 1500)); state = (await wallet.getMintQuote((quote as any).quote_id)).state; }
  proofs = await wallet.mintProofs((quote as any).quote_id, 50_000);
  console.log(`[e2e] funded: ${sumProofs(proofs)} ${keyset.unit}`);
}

// 3. Pay the router-gated route with picocash.
const pay = Fetch.from({
  methods: [picocash({ wallet, getProofs: () => proofs, onChange: (c) => { proofs = c; } })],
  onChallenge: async (_c, { createCredential }) => createCredential(),
});

let ok = 0;
for (let i = 1; i <= 2; i++) {
  const res = await pay(`http://localhost:${PORT}/api/fortune`, { method: 'POST' });
  const body = (await res.json()) as any;
  const receipt = res.headers.get('Payment-Receipt');
  const decoded = receipt ? JSON.parse(Buffer.from(receipt.split(' ').pop()!, 'base64url').toString()) : null;
  console.log(`[e2e] call ${i}: ${res.status} · "${body.fortune ?? JSON.stringify(body)}" · settlement=${decoded?.settlement} method=${decoded?.method} · balance ${sumProofs(proofs)}`);
  if (res.status === 200 && decoded?.method === 'picocash' && decoded?.settlement === 'settled') ok++;
}

// 4. Double-spend: build one credential, submit it twice. The mint swap in the
//    first settlement voids the proofs; the replay must be refused (402), not served.
const { Challenge } = await import('mppx');
const clientMethod = picocash({ wallet, getProofs: () => proofs, onChange: (c) => { proofs = c; } });
const chalRes = await fetch(`http://localhost:${PORT}/api/fortune`, { method: 'POST' });
const offers = Challenge.fromHeadersList(chalRes.headers as Headers);
const challenge = offers.find((c: any) => c.method === 'picocash');
if (!challenge) throw new Error('router did not offer picocash');
const credential = await clientMethod.createCredential({ challenge: challenge as never });
const first = await fetch(`http://localhost:${PORT}/api/fortune`, { method: 'POST', headers: { Authorization: credential } });
const replay = await fetch(`http://localhost:${PORT}/api/fortune`, { method: 'POST', headers: { Authorization: credential } });
console.log(`[e2e] double-spend: first ${first.status} (expect 200), replay ${replay.status} (expect 402)`);

server.close();
const pass = ok === 2 && first.status === 200 && replay.status === 402;
console.log(pass ? '\n[e2e] PASS — picocash paid through the AgentCash router, settle-first; double-spend refused.' : '\n[e2e] FAIL');
process.exit(pass ? 0 : 1);
