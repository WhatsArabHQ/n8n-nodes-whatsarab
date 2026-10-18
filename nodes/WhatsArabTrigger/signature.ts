import { createHmac, timingSafeEqual } from 'crypto';

/**
 * WhatsArab signs every webhook delivery like this (server side:
 * signWebhookPayload in the platform's customer-webhooks service):
 *
 *   X-Whatsarab-Timestamp: <unix seconds>
 *   X-Whatsarab-Signature: sha256=<hex>
 *   signature = HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
 *
 * A receiver must recompute the HMAC over the EXACT bytes it received (a
 * parsed and re-serialised body will not match), compare in constant time,
 * and reject deliveries whose timestamp is outside the replay window.
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureCheck =
	| { valid: true }
	| { valid: false; reason: 'missing_secret' | 'missing_headers' | 'bad_timestamp' | 'stale' | 'mismatch' };

export interface VerifySignatureInput {
	secret: string;
	rawBody: string | Uint8Array;
	signatureHeader: string | string[] | undefined | null;
	timestampHeader: string | string[] | undefined | null;
	/** Replay window in seconds. 0 disables the timestamp check. */
	toleranceSeconds?: number;
	/** Current time in milliseconds (injected by tests). */
	nowMs?: number;
}

function firstHeader(value: string | string[] | undefined | null): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value ?? undefined;
}

export function computeSignature(secret: string, timestamp: string, rawBody: string | Uint8Array): string {
	const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
	return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifySignature(input: VerifySignatureInput): SignatureCheck {
	const secret = input.secret?.trim();
	if (!secret) return { valid: false, reason: 'missing_secret' };

	const signatureHeader = firstHeader(input.signatureHeader)?.trim();
	const timestampHeader = firstHeader(input.timestampHeader)?.trim();
	if (!signatureHeader || !timestampHeader) return { valid: false, reason: 'missing_headers' };

	if (!/^\d{1,12}$/.test(timestampHeader)) return { valid: false, reason: 'bad_timestamp' };

	const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
	if (tolerance > 0) {
		const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
		if (Math.abs(nowSeconds - Number(timestampHeader)) > tolerance) {
			return { valid: false, reason: 'stale' };
		}
	}

	const provided = signatureHeader.startsWith('sha256=')
		? signatureHeader.slice('sha256='.length)
		: signatureHeader;
	const expected = computeSignature(secret, timestampHeader, input.rawBody);

	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(provided.toLowerCase(), 'utf8');
	// timingSafeEqual throws on a length mismatch, so compare lengths first.
	if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
	return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
}
