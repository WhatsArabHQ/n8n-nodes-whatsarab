'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
	buildSendTemplateBody,
	buildSendTextBody,
	joinUrl,
	normalizePhone,
	numberOptionName,
	parseComponentsJson,
	templateOptions,
} = require('../dist/nodes/WhatsArab/requests');
const { BASE_URL_EXPRESSION, DEFAULT_BASE_URL, NUMBERS_PATH } = require('../dist/nodes/WhatsArab/api');

describe('normalizePhone', () => {
	it('cleans the formats spreadsheets and CRMs produce', () => {
		assert.equal(normalizePhone('201000000001'), '201000000001');
		assert.equal(normalizePhone('+20 100 000 0001'), '201000000001');
		assert.equal(normalizePhone('(+20) 100-000-0001'), '201000000001');
		assert.equal(normalizePhone('00201000000001'), '201000000001');
		assert.equal(normalizePhone(' +966.50.000.0001 '), '966500000001');
	});

	it('strips invisible direction marks pasted from Arabic text', () => {
		assert.equal(normalizePhone('\u200F+20 100 000 0001\u200E'), '201000000001');
		assert.equal(normalizePhone('\u2066+٢٠١٠٠٠٠٠٠٠٠١\u2069'), '201000000001');
		assert.equal(normalizePhone('\u061C\u202B966500000001\u202C'), '966500000001');
	});

	it('converts Arabic-Indic and Persian digits', () => {
		assert.equal(normalizePhone('+٢٠١٠٠٠٠٠٠٠٠١'), '201000000001');
		assert.equal(normalizePhone('۹۶۶۵۰۰۰۰۰۰۰۱'), '966500000001');
	});

	it('does not guess: letters and local numbers pass through for the API to reject', () => {
		assert.equal(normalizePhone('01000000001'), '01000000001');
		assert.equal(normalizePhone('abc'), 'abc');
	});
});

describe('buildSendTextBody', () => {
	it('sends to a phone with only the fields the API needs', () => {
		assert.deepEqual(buildSendTextBody({ type: 'phone', value: '+20 100 000 0001' }, 'أهلًا'), {
			to: '201000000001',
			text: 'أهلًا',
		});
	});

	it('sends to a WhatsApp user id as `recipient`, never `to`', () => {
		const body = buildSendTextBody({ type: 'userId', value: ' EG.13491208655302741918 ' }, 'hi');
		assert.deepEqual(body, { recipient: 'EG.13491208655302741918', text: 'hi' });
		assert.equal('to' in body, false);
	});

	it('adds from and dry_run only when set', () => {
		assert.deepEqual(
			buildSendTextBody({ type: 'phone', value: '201000000001' }, 'hi', { from: ' 113456789012345 ', dryRun: true }),
			{ to: '201000000001', text: 'hi', from: '113456789012345', dry_run: true },
		);
		const plain = buildSendTextBody({ type: 'phone', value: '201000000001' }, 'hi', { from: '', dryRun: false });
		assert.equal('from' in plain, false);
		assert.equal('dry_run' in plain, false);
	});
});

describe('buildSendTemplateBody', () => {
	it('turns ordered body parameters into a body component', () => {
		assert.deepEqual(
			buildSendTemplateBody(
				{ type: 'phone', value: '201000000001' },
				{ name: ' order_confirmation ', language: 'ar', bodyParameters: ['Sara', '1042'] },
			),
			{
				to: '201000000001',
				template: 'order_confirmation',
				language: 'ar',
				components: [
					{
						type: 'body',
						parameters: [
							{ type: 'text', text: 'Sara' },
							{ type: 'text', text: '1042' },
						],
					},
				],
			},
		);
	});

	it('lets a full components array win over body parameters', () => {
		const components = [{ type: 'header', parameters: [{ type: 'text', text: 'X' }] }];
		const body = buildSendTemplateBody(
			{ type: 'userId', value: 'EG.13491208655302741918' },
			{ name: 'promo', language: 'en', bodyParameters: ['ignored'], components },
			{ from: '7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10' },
		);
		assert.deepEqual(body, {
			recipient: 'EG.13491208655302741918',
			template: 'promo',
			from: '7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10',
			language: 'en',
			components,
		});
	});

	it('omits components when the template has no parameters, and language when empty', () => {
		const body = buildSendTemplateBody({ type: 'phone', value: '201000000001' }, { name: 'hello', language: ' ' });
		assert.deepEqual(body, { to: '201000000001', template: 'hello' });
	});
});

describe('parseComponentsJson', () => {
	it('treats empty values as "not set"', () => {
		assert.deepEqual(parseComponentsJson(''), { ok: true, value: undefined });
		assert.deepEqual(parseComponentsJson('  '), { ok: true, value: undefined });
		assert.deepEqual(parseComponentsJson(undefined), { ok: true, value: undefined });
	});

	it('accepts an array or a JSON string holding one', () => {
		const arr = [{ type: 'body', parameters: [] }];
		assert.deepEqual(parseComponentsJson(arr), { ok: true, value: arr });
		assert.deepEqual(parseComponentsJson(JSON.stringify(arr)), { ok: true, value: arr });
	});

	it('explains invalid JSON and non-arrays', () => {
		assert.deepEqual(parseComponentsJson('{oops'), { ok: false, message: 'Components (JSON) is not valid JSON' });
		const notArray = parseComponentsJson('{"type":"body"}');
		assert.equal(notArray.ok, false);
	});
});

describe('load-options helpers', () => {
	it('lists only approved templates, one option per name, sorted, with languages', () => {
		assert.deepEqual(
			templateOptions([
				{ name: 'welcome', language: 'en', status: 'APPROVED' },
				{ name: 'welcome', language: 'ar', status: 'APPROVED' },
				{ name: 'draft_offer', language: 'ar', status: 'PENDING' },
				{ name: 'abandoned_cart', language: 'ar', status: 'approved' },
				{ name: 'old', language: 'en', status: 'REJECTED' },
			]),
			[
				{ name: 'abandoned_cart', value: 'abandoned_cart', description: 'Approved languages: ar' },
				{ name: 'welcome', value: 'welcome', description: 'Approved languages: ar, en' },
			],
		);
	});

	it('names numbers by label and phone, marking the default', () => {
		assert.equal(
			numberOptionName({ id: 'n1', display_number: '+20 10 0000 0001', label: 'Sales', is_default: true }),
			'Sales · +20 10 0000 0001 (default)',
		);
		assert.equal(numberOptionName({ id: 'n2', phone_number_id: '113456789012345' }), '113456789012345');
	});

	it('joins the base URL without doubling slashes', () => {
		assert.equal(joinUrl('https://whatsarab.com/', '/api/messages'), 'https://whatsarab.com/api/messages');
		assert.equal(joinUrl('', '/api/numbers'), 'https://whatsarab.com/api/numbers');
	});

	it('the credential test resolves the base URL exactly like joinUrl (empty → default)', () => {
		assert.ok(BASE_URL_EXPRESSION.startsWith('={{') && BASE_URL_EXPRESSION.endsWith('}}'));
		// Evaluate the expression body the way n8n would, with $credentials in scope.
		const evaluate = new Function('$credentials', `return ${BASE_URL_EXPRESSION.slice(3, -2)};`);
		for (const baseUrl of ['', undefined, 'https://whatsarab.com', 'https://api.example.test//']) {
			assert.equal(evaluate({ baseUrl }) + NUMBERS_PATH, joinUrl(baseUrl, NUMBERS_PATH), `baseUrl=${baseUrl}`);
		}
		assert.equal(evaluate({ baseUrl: '' }), DEFAULT_BASE_URL);
	});
});
