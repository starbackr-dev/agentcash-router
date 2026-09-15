import { HEADERS } from '../../headers.js';
import type { HandlerPaymentContext } from '../../types.js';
import type { SettleArgs, SettleOutcome, VerifyArgs, VerifySuccess } from '../types.js';
import type { MppCredentialInfo } from './credential.js';

/** Carries the settled mppx result from verify → settle so the receipt attaches once. */
export interface PicocashModeToken {
  mode: 'picocash';
  withReceipt: (response: Response) => Response;
}

/**
 * picocash charge (eCash proofs) — settle-first.
 *
 * Unlike tempo tx/hash mode (verify → handler → broadcast), picocash finalizes
 * at verify time: the mppx charge middleware runs the method's offline checks
 * (challenge single-use, PC-BIND / P2PK binding, DLEQ, exact amount, duplicate
 * proof) AND swaps the proofs at the mint in one call. A forged, unbound, or
 * double-spent credential therefore returns 402 here, before the handler runs —
 * no resource is served for a bad credential, and payment is captured before
 * work begins. The settle step only re-attaches the receipt.
 */
export async function verifyPicocashMode(
  args: VerifyArgs,
  info: MppCredentialInfo,
): Promise<VerifySuccess | { ok: false; kind: 'invalid' } | { ok: false; kind: 'config'; message: string }> {
  const { deps, price, report } = args;
  if (!deps.picocashMethod || !deps.mppx) {
    return { ok: false, kind: 'config', message: 'picocash not configured' };
  }

  let result: { status: number; withReceipt?: (r: Response) => Response };
  try {
    // The shared `charge` compose dispatches this picocash credential to the
    // picocash method (by name), which validates offline then settles at the mint.
    result = (await deps.mppx.charge({ amount: price })(args.request)) as typeof result;
  } catch (err) {
    report('warn', `picocash settle-first failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, kind: 'invalid' };
  }

  if (result.status === 402 || typeof result.withReceipt !== 'function') {
    return { ok: false, kind: 'invalid' };
  }

  const payment: HandlerPaymentContext = {
    protocol: 'mpp',
    status: 'settled',
    payer: info.wallet,
    amount: price,
    network: 'tempo:4217',
  };

  return {
    ok: true,
    wallet: info.wallet,
    payment,
    token: { mode: 'picocash', withReceipt: result.withReceipt } satisfies PicocashModeToken,
    alreadySettled: true,
  };
}

/** Attaches the receipt captured during verify. No second settlement. */
export async function settlePicocashMode(args: SettleArgs): Promise<SettleOutcome> {
  const token = args.token as PicocashModeToken;
  const receiptResponse = token.withReceipt(args.response);
  receiptResponse.headers.set('Cache-Control', 'private');
  const receiptHeader = receiptResponse.headers.get(HEADERS.MPP_PAYMENT_RECEIPT) ?? undefined;

  const settledPayment: HandlerPaymentContext & { status: 'settled' } = {
    ...args.payment,
    status: 'settled',
    ...(receiptHeader ? { receipt: receiptHeader } : {}),
  };
  return { ok: true, response: receiptResponse, settledPayment };
}
