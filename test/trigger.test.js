'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { describe, it } = require('node:test');

const { eventPasses } = require('../dist/nodes/WhatsArabTrigger/events');
const { WhatsArabTrigger } = require('../dist/nodes/WhatsArabTrigger/WhatsArabTrigger.node');

const SECRET = 'whsec_' + 'ab'.repeat(32);

/**
 * The smallest IWebhookFunctions the trigger touches.
 * opts: { body, rawBody?, headers, events?, toleranceSeconds?, mode?, staticData? }
 */
function fakeWebhookContext(opts) {
	const res = {};
	const raw = opts.rawBody ?? JSON.stringify(opts.body);
	const response = {
		status(code) {
			res.status = code;
			return response;
		},
		json(payload) {
			res.json = payload;
			return response;
		},
	};
	const ctx = {
		getRequestObject: () => ({ rawBody: Buffer.from(raw, 'utf8') }),
		getResponseObject: () => response,
		getHeaderData: () => opts.headers,
		getBodyData: () => opts.body,
		getCredentials: async () => ({ secret: SECRET }),
		getWorkflowStaticData: () => opts.staticData ?? {},
		getNodeParameter: (name, fallback) => {
			// These tests cover Manual mode (secret from the credential) unless told otherwise.
			if (name === 'subscriptionMode') return opts.mode ?? 'dashboard';
			if (name === 'events') return opts.events ?? [];
			if (name === 'options') {
				return opts.toleranceSeconds === undefined ? {} : { toleranceSeconds: opts.toleranceSeconds };
			}
			return fallback;
		},
		helpers: {
			returnJsonArray: (items) => items.map((json) => ({ json })),
		},
	};
	return { ctx, res };
}

function signedHeaders(raw, secret = SECRET, ts = String(Math.floor(Date.now() / 1000))) {
	return {
		'x-whatsarab-timestamp': ts,
		'x-whatsarab-signature': 'sha256=' + createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex'),
		'x-whatsarab-event': 'message.received',
	};
}

const DELIVERY = {
	event: 'message.received',
	deliveryId: '00000000-0000-4000-8000-000000000001',
	webhookId: '00000000-0000-4000-8000-000000000002',
	timestamp: 1_800_000_000,
	data: { from: '201000000001', text: 'hello' },
};

describe('WhatsArab Trigger webhook()', () => {
	const node = new WhatsArabTrigger();

	it('starts the workflow with the delivery when the signature is valid', async () => {
		const raw = JSON.stringify(DELIVERY);
		const { ctx, res } = fakeWebhookContext({ body: DELIVERY, headers: signedHeaders(raw) });
		const result = await node.webhook.call(ctx);
		assert.equal(res.status, undefined);
		assert.deepEqual(result.workflowData, [[{ json: DELIVERY }]]);
	});

	it('answers 401 and starts nothing when the signature is wrong', async () => {
		const raw = JSON.stringify(DELIVERY);
		const { ctx, res } = fakeWebhookContext({
			body: DELIVERY,
			headers: signedHeaders(raw, 'whsec_' + 'cd'.repeat(32)),
		});
		const result = await node.webhook.call(ctx);
		assert.equal(res.status, 401);
		assert.deepEqual(res.json, { error: 'invalid_signature', reason: 'mismatch' });
		assert.deepEqual(result, { noWebhookResponse: true });
	});

	it('answers 401 when the headers are missing', async () => {
		const { ctx, res } = fakeWebhookContext({ body: DELIVERY, headers: {} });
		const result = await node.webhook.call(ctx);
		assert.equal(res.status, 401);
		assert.equal(result.workflowData, undefined);
	});

	it('answers 401 for a replayed (stale) delivery', async () => {
		const raw = JSON.stringify(DELIVERY);
		const old = String(Math.floor(Date.now() / 1000) - 3600);
		const { ctx, res } = fakeWebhookContext({ body: DELIVERY, headers: signedHeaders(raw, SECRET, old) });
		await node.webhook.call(ctx);
		assert.equal(res.status, 401);
		assert.deepEqual(res.json, { error: 'invalid_signature', reason: 'stale' });
	});

	it('answers 400 and starts nothing for a signed body that is not a WhatsArab event object', async () => {
		for (const body of [[], { deliveryId: 'x' }, { event: 42 }, { event: '' }]) {
			const raw = JSON.stringify(body);
			const { ctx, res } = fakeWebhookContext({ body, headers: signedHeaders(raw) });
			const result = await node.webhook.call(ctx);
			assert.equal(res.status, 400, JSON.stringify(body));
			assert.equal(res.json.error, 'invalid_body');
			assert.deepEqual(result, { noWebhookResponse: true });
		}
	});

	it('acknowledges but does not start the workflow for an event outside the filter', async () => {
		const raw = JSON.stringify(DELIVERY);
		const { ctx, res } = fakeWebhookContext({
			body: DELIVERY,
			headers: signedHeaders(raw),
			events: ['message.failed'],
		});
		const result = await node.webhook.call(ctx);
		assert.equal(res.status, undefined);
		assert.equal(result.workflowData, undefined);
		assert.deepEqual(result.webhookResponse, { received: true, ignored: true });
	});
});

describe('signing-secret credential test', () => {
	const node = new WhatsArabTrigger();
	const test = (secret) =>
		node.methods.credentialTest.whatsArabWebhookSecretTest.call({}, { data: { secret } });

	it('accepts the platform format and rejects anything else', async () => {
		assert.equal((await test(SECRET)).status, 'OK');
		assert.equal((await test(` ${SECRET} `)).status, 'OK');
		assert.equal((await test('whsec_short')).status, 'Error');
		assert.equal((await test('wa_live_' + 'ab'.repeat(32))).status, 'Error');
	});
});

describe('eventPasses', () => {
	it('lets everything through with an empty filter, and only listed events otherwise', () => {
		assert.equal(eventPasses([], 'tag.added'), true);
		assert.equal(eventPasses(undefined, 'tag.added'), true);
		assert.equal(eventPasses(['tag.added'], 'tag.added'), true);
		assert.equal(eventPasses(['tag.added'], 'tag.removed'), false);
		assert.equal(eventPasses(['tag.added'], undefined), false);
	});
});
