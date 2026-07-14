/**
 * DB-free smoke test of the pure engine logic. Proves the quote math, the
 * state-machine transition rules, and webhook signing actually run — without
 * needing a database connection. Run: `npm run smoke`.
 */
import assert from 'node:assert/strict';
import { buildQuote, isQuoteExpired } from '../src/engine/quoteEngine.js';
import { canTransition } from '../src/engine/stateMachine.js';
import { signPayload, verifySignature } from '../src/auth/hmac.js';
import { PaymentStatus, type Payment } from '../src/types.js';

let passed = 0;
const ok = (label: string) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

// --- State machine --------------------------------------------------------
console.log('state machine:');
assert.equal(canTransition(PaymentStatus.CREATED, PaymentStatus.QUOTE_LOCKED), true);
ok('CREATED → QUOTE_LOCKED allowed');
assert.equal(canTransition(PaymentStatus.CREATED, PaymentStatus.COMPLETED), false);
ok('CREATED → COMPLETED rejected (no skipping)');
assert.equal(canTransition(PaymentStatus.SETTLING, PaymentStatus.COMPLETED), true);
ok('SETTLING → COMPLETED allowed');
assert.equal(canTransition(PaymentStatus.COMPLETED, PaymentStatus.FAILED), false);
ok('COMPLETED is terminal');
assert.equal(canTransition(PaymentStatus.CONFIRMING, PaymentStatus.FAILED), true);
ok('any active state → FAILED allowed');

// --- Quote engine ---------------------------------------------------------
console.log('quote engine:');
const fakePayment = {
  id: 'pay_test',
  status: PaymentStatus.CREATED,
  settlement_currency: 'EUR',
  amount_fiat: '100.00',
} as unknown as Payment;

const quote = await buildQuote(fakePayment, 'ETH', 'ethereum');
assert.equal(quote.pay_currency, 'ETH');
assert.equal(quote.provider, 'zero_hash');
ok(`routes ETH→EUR via ${quote.provider}`);
assert.equal(quote.pays_fee, '2.00'); // 2% of 100.00
ok(`PayS fee = ${quote.pays_fee} EUR (2% take rate)`);
assert.ok(Number(quote.amount_crypto) > 0 && Number(quote.amount_crypto) < 1);
ok(`amount_crypto = ${Number(quote.amount_crypto).toFixed(6)} ETH (sane)`);
assert.ok(quote.deposit_address.startsWith('0x'));
ok(`deposit address is ETH-shaped (${quote.deposit_address.slice(0, 10)}…)`);
assert.equal(isQuoteExpired(quote), false);
ok('fresh quote not expired');
assert.equal(
  isQuoteExpired({ ...quote, expires_at: new Date(Date.now() - 1000).toISOString() }),
  true,
);
ok('past-TTL quote reported expired');

await assert.rejects(() => buildQuote(fakePayment, 'BTC', 'ethereum'));
ok('BTC on Ethereum rejected (network validation)');

// --- Webhook HMAC ---------------------------------------------------------
console.log('webhook signatures:');
const secret = 'whsec_demo';
const body = JSON.stringify({ type: 'payment.completed' });
const t = Math.floor(Date.now() / 1000);
const sig = signPayload(secret, body, t);
assert.equal(verifySignature(secret, body, sig), true);
ok('valid signature verifies');
assert.equal(verifySignature('whsec_wrong', body, sig), false);
ok('wrong secret rejected');
assert.equal(verifySignature(secret, body + 'x', sig), false);
ok('tampered body rejected');

console.log(`\n${passed} checks passed ✓`);
