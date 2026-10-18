'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { describe, it } = require('node:test');
const { NodeApiError } = require('n8n-workflow');

const {
	SCOPE_MESSAGE,
	URL_HINT,
	subscriptionModeOf,
	WhatsArabTrigger,
} = require('../dist/nodes/WhatsArabTrigger/WhatsArabTrigger.node');
const { WHATSARAB_EVENTS } = require('../dist/nodes/WhatsArabTrigger/events');
const {
	subscriptionEvents,
	subscriptionLabel,
	subscriptionMatches,
} = require('../dist/nodes/WhatsArabTrigger/subscription');
const { apiErrorInfo, isScopeRefusal } = require('../dist/nodes/WhatsArab/apiErrors');

// Placeholders, not real values: the platform's secret shape is whsec_ + 64 hex.
const SECRET = 'whsec_' + 'ab'.repeat(32);
const OTHER_SECRET = 'whsec_' + 'cd'.repeat(32);
const SUB_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const BASE_URL = 'https://api.example.test';
const HOOK_URL = 'https://n8n.example.test/webhook/0b1c2d3e/webhook';
const ALL_EVENTS = WHATSARAB_EVENTS.map((e) => e.value);
const NODE = {
	id: '00000000-0000-4000-8000-0000000000aa',
	name: 'WhatsArab Trigger',
	type: '@whatsarab/n8n-nodes-whatsarab.whatsArabTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** A WhatsArab error the way n8n hands it to a node: a NodeApiError around the HTTP failure. */
function apiError(status, code, message = `${code} message`) {
	return new NodeApiError(NODE, {
		message: `Request failed with status code ${status}`,
		httpCode: String(status),
		response: { status, data: { success: false, error: { code, message } } },
	});
}

/**
 * The smallest IHookFunctions + IWebhookFunctions the trigger touches, with
 * httpRequestWithAuthentication mocked by `respond(request)`.
 */
function fakeContext({ mode = 'api', test = false, events = [], url = HOOK_URL, staticData = {}, respond } = {}) {
	const calls = [];
	const credentialsAsked = [];
	const warnings = [];
	const res = {};
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
	let delivery = { raw: '', body: undefined, headers: {} };
	const ctx = {
		getNode: () => NODE,
		logger: {
			warn: (message, meta) => warnings.push({ message, meta }),
			error: () => {},
			info: () => {},
			debug: () => {},
		},
		// n8n: "manual" while the editor listens for a test event; "trigger" / "webhook" in production.
		getMode: () => (test ? 'manual' : 'trigger'),
		getWorkflow: () => ({ id: 'wf-1', name: 'New leads', active: true }),
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => url,
		getNodeParameter: (name, fallback) => {
			if (name === 'subscriptionMode') return mode;
			if (name === 'events') return events;
			return fallback;
		},
		getCredentials: async (name) => {
			credentialsAsked.push(name);
			if (name === 'whatsArabWebhookApi') return { secret: OTHER_SECRET };
			return { apiKey: 'wa_test_placeholder', baseUrl: BASE_URL };
		},
		getRequestObject: () => ({ rawBody: Buffer.from(delivery.raw, 'utf8') }),
		getResponseObject: () => response,
		getHeaderData: () => delivery.headers,
		getBodyData: () => delivery.body,
		helpers: {
			async httpRequestWithAuthentication(credentialName, request) {
				calls.push({ credentialName, ...request });
				if (!respond) throw new Error(`unexpected request ${request.method} ${request.url}`);
				return respond(request);
			},
			returnJsonArray: (items) => items.map((json) => ({ json })),
		},
	};
	const deliver = (body, secret) => {
		const raw = JSON.stringify(body);
		const ts = String(Math.floor(Date.now() / 1000));
		delivery = {
			raw,
			body,
			headers: {
				'x-whatsarab-timestamp': ts,
				'x-whatsarab-signature': 'sha256=' + createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex'),
			},
		};
		res.status = undefined;
		res.json = undefined;
	};
	return { ctx, calls, credentialsAsked, warnings, staticData, res, deliver };
}

const DELIVERY = {
	event: 'message.received',
	deliveryId: '00000000-0000-4000-8000-000000000001',
	webhookId: SUB_ID,
	timestamp: 1_800_000_000,
	data: { from: '201000000001', text: 'hello' },
};

const createdResponse = (overrides = {}) => ({
	success: true,
	data: {
		id: SUB_ID,
		label: 'n8n: New leads',
		url: HOOK_URL,
		events: ALL_EVENTS,
		number_ids: null,
		active: true,
		secret: SECRET,
		...overrides,
	},
});

describe('automatic subscription: activate → deliveries → deactivate', () => {
	const hooks = new WhatsArabTrigger().webhookMethods.default;
	const node = new WhatsArabTrigger();

	it('subscribes on activation, verifies deliveries with the stored secret, unsubscribes on deactivation', async () => {
		const f = fakeContext({
			respond: (req) => {
				if (req.method === 'POST') return createdResponse();
				if (req.method === 'DELETE') return { success: true, data: { id: SUB_ID, deleted: true } };
				throw new Error('unexpected');
			},
		});

		// Nothing stored yet: checkExists says "create" without calling the API.
		assert.equal(await hooks.checkExists.call(f.ctx), false);
		assert.equal(f.calls.length, 0);

		assert.equal(await hooks.create.call(f.ctx), true);
		assert.equal(f.calls.length, 1);
		assert.deepEqual(f.calls[0], {
			credentialName: 'whatsArabApi',
			method: 'POST',
			url: `${BASE_URL}/api/webhooks`,
			body: { label: 'n8n: New leads', url: HOOK_URL, events: ALL_EVENTS },
			qs: undefined,
			json: true,
		});
		assert.deepEqual(f.staticData, { webhookId: SUB_ID, webhookSecret: SECRET });

		// A delivery signed with the returned secret starts the workflow...
		f.deliver(DELIVERY, SECRET);
		const ok = await node.webhook.call(f.ctx);
		assert.equal(f.res.status, undefined);
		assert.deepEqual(ok.workflowData, [[{ json: DELIVERY }]]);
		// ...without ever reading the manual-mode credential.
		assert.equal(f.credentialsAsked.includes('whatsArabWebhookApi'), false);

		// ...one signed with any other secret does not.
		f.deliver(DELIVERY, OTHER_SECRET);
		const bad = await node.webhook.call(f.ctx);
		assert.equal(f.res.status, 401);
		assert.deepEqual(f.res.json, { error: 'invalid_signature', reason: 'mismatch' });
		assert.equal(bad.workflowData, undefined);

		assert.equal(await hooks.delete.call(f.ctx), true);
		assert.deepEqual(f.calls[1], {
			credentialName: 'whatsArabApi',
			method: 'DELETE',
			url: `${BASE_URL}/api/webhooks/${SUB_ID}`,
			body: undefined,
			qs: undefined,
			json: true,
		});
		assert.deepEqual(f.staticData, {});

		// After deactivation the old secret no longer opens the door.
		f.deliver(DELIVERY, SECRET);
		await node.webhook.call(f.ctx);
		assert.equal(f.res.status, 401);
		assert.deepEqual(f.res.json, { error: 'invalid_signature', reason: 'missing_secret' });
	});

	it('maps the Events filter to the subscription events', async () => {
		const f = fakeContext({
			events: ['tag.added', 'message.received', 'tag.added'],
			respond: () => createdResponse({ events: ['tag.added', 'message.received'] }),
		});
		await hooks.create.call(f.ctx);
		assert.deepEqual(f.calls[0].body.events, ['tag.added', 'message.received']);
	});

	it('refuses to keep a subscription it cannot verify (no secret returned) and removes it', async () => {
		const f = fakeContext({
			respond: (req) => (req.method === 'POST' ? createdResponse({ secret: undefined }) : { success: true }),
		});
		await assert.rejects(hooks.create.call(f.ctx), /did not return its id and signing secret/);
		assert.equal(f.calls[1].method, 'DELETE');
		assert.deepEqual(f.staticData, {});
		assert.deepEqual(f.warnings, [], 'cleanup worked: nothing to warn about');
	});

	it('warns about the orphan when that cleanup fails', async () => {
		const f = fakeContext({
			respond: (req) => {
				if (req.method === 'POST') return createdResponse({ secret: undefined });
				throw apiError(503, 'SERVICE_UNAVAILABLE', 'try again later');
			},
		});
		await assert.rejects(hooks.create.call(f.ctx), /did not return its id and signing secret/);
		assert.ok(
			f.warnings.some((w) => w.message.includes(`orphaned webhook subscription ${SUB_ID}`)),
			JSON.stringify(f.warnings),
		);
	});
});

describe('automatic subscription: listening for a test event on an active workflow', () => {
	const hooks = new WhatsArabTrigger().webhookMethods.default;
	const node = new WhatsArabTrigger();
	const TEST_URL = 'https://n8n.example.test/webhook-test/0b1c2d3e/webhook';
	const TEST_ID = '1a2b3c4d-0000-4000-8000-000000000003';

	it('subscribes the test URL separately and never touches the production subscription', async () => {
		const staticData = { webhookId: SUB_ID, webhookSecret: SECRET };
		const f = fakeContext({
			test: true,
			url: TEST_URL,
			staticData,
			respond: (req) => {
				if (req.method === 'POST') return createdResponse({ id: TEST_ID, url: TEST_URL, secret: OTHER_SECRET });
				if (req.method === 'DELETE') return { success: true, data: { id: TEST_ID, deleted: true } };
				throw new Error('unexpected');
			},
		});

		assert.equal(await hooks.checkExists.call(f.ctx), false);
		assert.equal(f.calls.length, 0, 'no test subscription yet: nothing to look up, production left alone');
		assert.equal(await hooks.create.call(f.ctx), true);
		assert.equal(f.calls[0].body.url, TEST_URL);
		assert.deepEqual(staticData, {
			webhookId: SUB_ID,
			webhookSecret: SECRET,
			testWebhookId: TEST_ID,
			testWebhookSecret: OTHER_SECRET,
		});

		// The test delivery is verified with the test subscription's secret.
		f.deliver(DELIVERY, OTHER_SECRET);
		assert.deepEqual((await node.webhook.call(f.ctx)).workflowData, [[{ json: DELIVERY }]]);

		assert.equal(await hooks.delete.call(f.ctx), true);
		assert.deepEqual(
			f.calls.map((c) => `${c.method} ${c.url}`),
			[`POST ${BASE_URL}/api/webhooks`, `DELETE ${BASE_URL}/api/webhooks/${TEST_ID}`],
		);
		assert.deepEqual(staticData, { webhookId: SUB_ID, webhookSecret: SECRET });

		// Production deliveries still verify with the production secret.
		const prod = fakeContext({ staticData });
		prod.deliver(DELIVERY, SECRET);
		assert.deepEqual((await node.webhook.call(prod.ctx)).workflowData, [[{ json: DELIVERY }]]);
	});
});

describe('automatic subscription: checkExists', () => {
	const hooks = new WhatsArabTrigger().webhookMethods.default;
	const row = (overrides = {}) => ({ id: SUB_ID, url: HOOK_URL, events: ALL_EVENTS, active: true, ...overrides });

	it('keeps a subscription that still matches (same URL, events, switched on)', async () => {
		const f = fakeContext({
			staticData: { webhookId: SUB_ID, webhookSecret: SECRET },
			respond: () => ({ success: true, data: [row({ events: [...ALL_EVENTS].reverse() })] }),
		});
		assert.equal(await hooks.checkExists.call(f.ctx), true);
		assert.deepEqual(
			f.calls.map((c) => `${c.method} ${c.url}`),
			[`GET ${BASE_URL}/api/webhooks`],
		);
		assert.deepEqual(f.staticData, { webhookId: SUB_ID, webhookSecret: SECRET });
	});

	for (const [why, stale] of [
		['the URL changed', row({ url: 'https://old.example.test/webhook/x' })],
		['the events changed', row({ events: ['message.received'] })],
		['WhatsArab switched it off after failed deliveries', row({ active: false })],
	]) {
		it(`replaces it when ${why}: deletes the old one, clears the stored secret`, async () => {
			const f = fakeContext({
				staticData: { webhookId: SUB_ID, webhookSecret: SECRET },
				respond: (req) => (req.method === 'GET' ? { success: true, data: [stale] } : { success: true }),
			});
			assert.equal(await hooks.checkExists.call(f.ctx), false);
			assert.deepEqual(
				f.calls.map((c) => `${c.method} ${c.url}`),
				[`GET ${BASE_URL}/api/webhooks`, `DELETE ${BASE_URL}/api/webhooks/${SUB_ID}`],
			);
			assert.deepEqual(f.staticData, {});
		});
	}

	it('forgets a subscription deleted in the dashboard', async () => {
		const f = fakeContext({
			staticData: { webhookId: SUB_ID, webhookSecret: SECRET },
			respond: () => ({ success: true, data: [] }),
		});
		assert.equal(await hooks.checkExists.call(f.ctx), false);
		assert.equal(f.calls.length, 1);
		assert.deepEqual(f.staticData, {});
	});
});

describe('automatic subscription: deactivation errors', () => {
	const hooks = new WhatsArabTrigger().webhookMethods.default;

	it('treats 404 as already unsubscribed', async () => {
		const f = fakeContext({
			staticData: { webhookId: SUB_ID, webhookSecret: SECRET },
			respond: () => {
				throw apiError(404, 'NOT_FOUND');
			},
		});
		assert.equal(await hooks.delete.call(f.ctx), true);
		assert.deepEqual(f.staticData, {});
	});

	it('reports failure and keeps the id when WhatsArab could not delete it', async () => {
		const f = fakeContext({
			staticData: { webhookId: SUB_ID, webhookSecret: SECRET },
			respond: () => {
				throw apiError(500, 'INTERNAL_ERROR');
			},
		});
		assert.equal(await hooks.delete.call(f.ctx), false);
		assert.deepEqual(f.staticData, { webhookId: SUB_ID, webhookSecret: SECRET });
		// n8n only sees `false`, so the reason goes to the log.
		assert.equal(f.warnings.length, 1);
		assert.ok(f.warnings[0].message.includes(SUB_ID));
		assert.ok(f.warnings[0].message.includes('INTERNAL_ERROR: INTERNAL_ERROR message'));
		assert.deepEqual(f.warnings[0].meta, { webhookId: SUB_ID, status: 500, code: 'INTERNAL_ERROR' });
	});

	it('does not warn when the subscription was already gone (404)', async () => {
		const f = fakeContext({
			staticData: { webhookId: SUB_ID, webhookSecret: SECRET },
			respond: () => {
				throw apiError(404, 'NOT_FOUND');
			},
		});
		assert.equal(await hooks.delete.call(f.ctx), true);
		assert.deepEqual(f.warnings, []);
	});
});

describe('Subscription setting values', () => {
	const hooks = new WhatsArabTrigger().webhookMethods.default;
	const description = new WhatsArabTrigger().description;

	it('offers api / dashboard, api by default', () => {
		const prop = description.properties.find((p) => p.name === 'subscriptionMode');
		assert.deepEqual(
			prop.options.map((o) => [o.name, o.value]),
			[
				['Automatic (API Key)', 'api'],
				['Manual (Signing Secret)', 'dashboard'],
			],
		);
		assert.equal(prop.default, 'api');
	});

	it('still reads the pre-release values automatic / manual', () => {
		assert.equal(subscriptionModeOf('api'), 'api');
		assert.equal(subscriptionModeOf('dashboard'), 'dashboard');
		assert.equal(subscriptionModeOf('automatic'), 'api');
		assert.equal(subscriptionModeOf('manual'), 'dashboard');
		assert.equal(subscriptionModeOf(undefined), 'api');
	});

	it('shows each credential for both its new and its old value, so n8n still hands it over', () => {
		const shown = Object.fromEntries(description.credentials.map((c) => [c.name, c.displayOptions.show.subscriptionMode]));
		assert.deepEqual(shown, {
			whatsArabApi: ['api', 'automatic'],
			whatsArabWebhookApi: ['dashboard', 'manual'],
		});
	});

	it('a workflow saved with the old value behaves the same', async () => {
		const legacyManual = fakeContext({ mode: 'manual' });
		assert.equal(await hooks.create.call(legacyManual.ctx), true);
		assert.equal(legacyManual.calls.length, 0);

		const legacyAutomatic = fakeContext({ mode: 'automatic', respond: () => createdResponse() });
		assert.equal(await hooks.create.call(legacyAutomatic.ctx), true);
		assert.equal(legacyAutomatic.calls[0].method, 'POST');
		assert.deepEqual(legacyAutomatic.staticData, { webhookId: SUB_ID, webhookSecret: SECRET });
	});
});

describe('automatic subscription: refusals', () => {
	const hooks = new WhatsArabTrigger().webhookMethods.default;

	it('explains a key without the full scope (403 INSUFFICIENT_SCOPE) on activation', async () => {
		const f = fakeContext({
			respond: () => {
				throw apiError(403, 'INSUFFICIENT_SCOPE', "This API key has scope 'send'. Required: full.");
			},
		});
		await assert.rejects(hooks.create.call(f.ctx), (error) => {
			assert.equal(error.message, SCOPE_MESSAGE);
			assert.match(error.description, /Manual \(Signing Secret\)/);
			return true;
		});
		assert.deepEqual(f.staticData, {});
	});

	it('explains the scope refusal when checking an existing subscription too', async () => {
		const f = fakeContext({
			staticData: { webhookId: SUB_ID, webhookSecret: SECRET },
			respond: () => {
				throw { response: { status: 403, data: { success: false, error: { code: 'INSUFFICIENT_SCOPE' } } } };
			},
		});
		await assert.rejects(hooks.checkExists.call(f.ctx), (error) => error.message === SCOPE_MESSAGE);
	});

	it('passes other refusals through with WhatsArab\'s code, and a URL hint for INVALID_INPUT', async () => {
		const f = fakeContext({
			respond: () => {
				throw apiError(400, 'INVALID_INPUT', 'url: must be a public https URL');
			},
		});
		await assert.rejects(hooks.create.call(f.ctx), (error) => {
			assert.match(error.message, /INVALID_INPUT/);
			assert.ok(error.description.includes('must be a public https URL'));
			assert.ok(error.description.includes(URL_HINT));
			return true;
		});
	});
});

describe('manual subscription mode', () => {
	const hooks = new WhatsArabTrigger().webhookMethods.default;
	const node = new WhatsArabTrigger();

	it('registers nothing remotely', async () => {
		const f = fakeContext({ mode: 'dashboard' });
		assert.equal(await hooks.checkExists.call(f.ctx), true);
		assert.equal(await hooks.create.call(f.ctx), true);
		assert.equal(await hooks.delete.call(f.ctx), true);
		assert.equal(f.calls.length, 0);
	});

	it('verifies with the credential secret, not with a stored one', async () => {
		const f = fakeContext({ mode: 'dashboard', staticData: { webhookId: SUB_ID, webhookSecret: SECRET } });
		f.deliver(DELIVERY, OTHER_SECRET);
		const ok = await node.webhook.call(f.ctx);
		assert.deepEqual(ok.workflowData, [[{ json: DELIVERY }]]);
		f.deliver(DELIVERY, SECRET);
		await node.webhook.call(f.ctx);
		assert.equal(f.res.status, 401);
	});
});

describe('subscription helpers', () => {
	it('subscribes to every event when the filter is empty', () => {
		assert.deepEqual(subscriptionEvents([]), ALL_EVENTS);
		assert.deepEqual(subscriptionEvents(undefined), ALL_EVENTS);
		assert.deepEqual(subscriptionEvents(['tag.added']), ['tag.added']);
	});

	it('labels the subscription after the workflow, within 120 characters', () => {
		assert.equal(subscriptionLabel('New leads', 'wf-1'), 'n8n: New leads');
		assert.equal(subscriptionLabel('', 'wf-1'), 'n8n: workflow wf-1');
		assert.equal(subscriptionLabel('x'.repeat(300), 'wf-1').length, 120);
	});

	it('matches on URL, events as a set, and active', () => {
		const sub = { id: SUB_ID, url: HOOK_URL, events: ['a', 'b'], active: true };
		assert.equal(subscriptionMatches(sub, HOOK_URL, ['b', 'a']), true);
		assert.equal(subscriptionMatches(sub, HOOK_URL, ['a']), false);
		assert.equal(subscriptionMatches(sub, HOOK_URL, ['a', 'b', 'c']), false);
		assert.equal(subscriptionMatches(undefined, HOOK_URL, ['a']), false);
	});
});

describe('apiErrorInfo / isScopeRefusal', () => {
	it('reads status and code from a NodeApiError, an Axios-style error and a wrapped cause', () => {
		assert.deepEqual(apiErrorInfo(apiError(403, 'INSUFFICIENT_SCOPE', 'm')), {
			status: 403,
			code: 'INSUFFICIENT_SCOPE',
			message: 'm',
		});
		const axiosLike = { response: { status: 404, data: { success: false, error: { code: 'NOT_FOUND', message: 'x' } } } };
		assert.deepEqual(apiErrorInfo(axiosLike), { status: 404, code: 'NOT_FOUND', message: 'x' });
		assert.equal(apiErrorInfo({ message: 'outer', cause: axiosLike }).code, 'NOT_FOUND');
	});

	it('only a scope refusal is a scope refusal', () => {
		assert.equal(isScopeRefusal(apiError(403, 'INSUFFICIENT_SCOPE')), true);
		assert.equal(isScopeRefusal(apiError(403, 'NUMBER_NOT_ALLOWED')), false);
		assert.equal(isScopeRefusal(apiError(400, 'INVALID_INPUT')), false);
		assert.equal(isScopeRefusal({ httpCode: '403' }), true);
		assert.equal(isScopeRefusal(new Error('socket hang up')), false);
	});

	it('does not loop forever on a cyclic cause', () => {
		const a = { message: 'a' };
		a.cause = a;
		assert.deepEqual(apiErrorInfo(a), {});
	});
});
