'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { describe, it } = require('node:test');

const { verifySignature } = require('../dist/nodes/WhatsArabTrigger/signature');

// A placeholder, not a real secret: the platform's shape is whsec_ + 64 hex.
const SECRET = 'whsec_' + 'ab'.repeat(32);
const NOW_MS = 1_800_000_000_000;
const TS = String(Math.floor(NOW_MS / 1000));
// Exactly what the platform serialises (event, deliveryId, webhookId, timestamp, data).
const BODY = JSON.stringify({
	event: 'message.received',
	deliveryId: '00000000-0000-4000-8000-000000000001',
	webhookId: '00000000-0000-4000-8000-000000000002',
	timestamp: Number(TS),
	data: { from: '201000000001', text: 'مرحبا' },
});

/** Signed independently of the code under test, the way the platform does it. */
function platformSign(secret, ts, body) {
	return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

describe('verifySignature', () => {
	it('accepts a delivery signed the way WhatsArab signs it', () => {
		const result = verifySignature({
			secret: SECRET,
			rawBody: BODY,
			signatureHeader: platformSign(SECRET, TS, BODY),
			timestampHeader: TS,
			nowMs: NOW_MS,
		});
		assert.deepEqual(result, { valid: true });
	});

	it('accepts the raw body as a Buffer (what n8n hands the trigger)', () => {
		const result = verifySignature({
			secret: SECRET,
			rawBody: Buffer.from(BODY, 'utf8'),
			signatureHeader: platformSign(SECRET, TS, BODY),
			timestampHeader: TS,
			nowMs: NOW_MS,
		});
		assert.equal(result.valid, true);
	});

	it('accepts a signature without the sha256= prefix and header arrays', () => {
		const bare = platformSign(SECRET, TS, BODY).slice('sha256='.length);
		const result = verifySignature({
			secret: SECRET,
			rawBody: BODY,
			signatureHeader: [bare],
			timestampHeader: [TS],
			nowMs: NOW_MS,
		});
		assert.equal(result.valid, true);
	});

	it('rejects a tampered body', () => {
		const tampered = BODY.replace('201000000001', '201000000002');
		const result = verifySignature({
			secret: SECRET,
			rawBody: tampered,
			signatureHeader: platformSign(SECRET, TS, BODY),
			timestampHeader: TS,
			nowMs: NOW_MS,
		});
		assert.deepEqual(result, { valid: false, reason: 'mismatch' });
	});

	it('rejects a body that was parsed and re-serialised with different spacing', () => {
		const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
		const result = verifySignature({
			secret: SECRET,
			rawBody: reserialised,
			signatureHeader: platformSign(SECRET, TS, BODY),
			timestampHeader: TS,
			nowMs: NOW_MS,
		});
		assert.equal(result.valid, false);
	});

	it('rejects a signature made with another secret', () => {
		const result = verifySignature({
			secret: SECRET,
			rawBody: BODY,
			signatureHeader: platformSign('whsec_' + 'cd'.repeat(32), TS, BODY),
			timestampHeader: TS,
			nowMs: NOW_MS,
		});
		assert.deepEqual(result, { valid: false, reason: 'mismatch' });
	});

	it('rejects a signature bound to a different timestamp', () => {
		const otherTs = String(Number(TS) - 10);
		const result = verifySignature({
			secret: SECRET,
			rawBody: BODY,
			signatureHeader: platformSign(SECRET, otherTs, BODY),
			timestampHeader: TS,
			nowMs: NOW_MS,
		});
		assert.deepEqual(result, { valid: false, reason: 'mismatch' });
	});

	it('rejects a truncated signature without throwing', () => {
		const result = verifySignature({
			secret: SECRET,
			rawBody: BODY,
			signatureHeader: platformSign(SECRET, TS, BODY).slice(0, 40),
			timestampHeader: TS,
			nowMs: NOW_MS,
		});
		assert.deepEqual(result, { valid: false, reason: 'mismatch' });
	});

	it('rejects deliveries outside the replay window, both directions', () => {
		for (const offset of [301, -301]) {
			const ts = String(Number(TS) + offset);
			const result = verifySignature({
				secret: SECRET,
				rawBody: BODY,
				signatureHeader: platformSign(SECRET, ts, BODY),
				timestampHeader: ts,
				nowMs: NOW_MS,
			});
			assert.deepEqual(result, { valid: false, reason: 'stale' }, `offset ${offset}`);
		}
	});

	it('accepts a delivery right at the edge of the window, and any age when the window is 0', () => {
		const edge = String(Number(TS) - 300);
		assert.equal(
			verifySignature({
				secret: SECRET,
				rawBody: BODY,
				signatureHeader: platformSign(SECRET, edge, BODY),
				timestampHeader: edge,
				nowMs: NOW_MS,
			}).valid,
			true,
		);
		const old = String(Number(TS) - 86_400);
		assert.equal(
			verifySignature({
				secret: SECRET,
				rawBody: BODY,
				signatureHeader: platformSign(SECRET, old, BODY),
				timestampHeader: old,
				toleranceSeconds: 0,
				nowMs: NOW_MS,
			}).valid,
			true,
		);
	});

	it('rejects missing secret, missing headers and a non-numeric timestamp', () => {
		const sig = platformSign(SECRET, TS, BODY);
		assert.deepEqual(
			verifySignature({ secret: '', rawBody: BODY, signatureHeader: sig, timestampHeader: TS, nowMs: NOW_MS }),
			{ valid: false, reason: 'missing_secret' },
		);
		assert.deepEqual(
			verifySignature({ secret: SECRET, rawBody: BODY, signatureHeader: undefined, timestampHeader: TS, nowMs: NOW_MS }),
			{ valid: false, reason: 'missing_headers' },
		);
		assert.deepEqual(
			verifySignature({ secret: SECRET, rawBody: BODY, signatureHeader: sig, timestampHeader: null, nowMs: NOW_MS }),
			{ valid: false, reason: 'missing_headers' },
		);
		assert.deepEqual(
			verifySignature({ secret: SECRET, rawBody: BODY, signatureHeader: sig, timestampHeader: '17e8', nowMs: NOW_MS }),
			{ valid: false, reason: 'bad_timestamp' },
		);
	});
});
