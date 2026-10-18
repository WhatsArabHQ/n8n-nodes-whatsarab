'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
	addContactTagRequest,
	buildCustomFields,
	getContactRequest,
	removeContactTagRequest,
	splitTags,
	upsertContactRequest,
} = require('../dist/nodes/WhatsArab/contacts');

describe('Contact → Create or Update (POST /api/contacts)', () => {
	it('sends only the phone when nothing else is set (the API keeps every omitted field)', () => {
		assert.deepEqual(upsertContactRequest({ phone: '+20 100 000 0001' }), {
			ok: true,
			value: { method: 'POST', path: '/api/contacts', body: { phone: '201000000001' } },
		});
	});

	it('builds the full body with the API field names', () => {
		const result = upsertContactRequest({
			phone: '+٢٠١٠٠٠٠٠٠٠٠١',
			name: ' Sara ',
			customFields: [
				{ key: 'city', type: 'string', value: 'Cairo' },
				{ key: 'order_count', type: 'number', value: '٣' },
				{ key: 'vip', type: 'boolean', value: 'true' },
				{ key: 'old_field', type: 'remove', value: 'ignored' },
			],
			tags: 'lead, vip،lead',
			consent: 'optIn',
			from: ' 7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10 ',
		});
		assert.deepEqual(result, {
			ok: true,
			value: {
				method: 'POST',
				path: '/api/contacts',
				body: {
					phone: '201000000001',
					name: 'Sara',
					custom_fields: { city: 'Cairo', order_count: 3, vip: true, old_field: null },
					tags: ['lead', 'vip'],
					opted_in: true,
					from: '7d0d8b2e-4c3a-4f0e-9c6b-2b1f9a8e5d10',
				},
			},
		});
	});

	it('maps consent: opt out → opted_in false, unchanged → field left out', () => {
		const out = upsertContactRequest({ phone: '201000000001', consent: 'optOut' });
		assert.equal(out.ok && out.value.body.opted_in, false);
		const same = upsertContactRequest({ phone: '201000000001', consent: 'unchanged' });
		assert.equal(same.ok && 'opted_in' in same.value.body, false);
	});

	it('leaves out an empty name, empty tags and an empty number', () => {
		const result = upsertContactRequest({ phone: '201000000001', name: '  ', tags: ' , ', from: '' });
		assert.deepEqual(result.ok && result.value.body, { phone: '201000000001' });
	});

	it('refuses an empty phone instead of calling the API', () => {
		assert.deepEqual(upsertContactRequest({ phone: ' ' }), { ok: false, message: 'Phone Number is required' });
	});

	it('passes a bad custom field error through', () => {
		const result = upsertContactRequest({ phone: '201000000001', customFields: [{ key: 'n', type: 'number', value: 'abc' }] });
		assert.deepEqual(result, { ok: false, message: 'Custom field "n" is not a number' });
	});
});

describe('buildCustomFields', () => {
	it('is "not set" when there are no rows', () => {
		assert.deepEqual(buildCustomFields(undefined), { ok: true, value: undefined });
		assert.deepEqual(buildCustomFields([]), { ok: true, value: undefined });
	});

	it('sends null for Remove Field: the API deletes that key', () => {
		assert.deepEqual(buildCustomFields([{ key: 'city', type: 'remove' }]), { ok: true, value: { city: null } });
	});

	it('defaults to text and keeps an empty text value', () => {
		assert.deepEqual(buildCustomFields([{ key: 'note', value: '' }]), { ok: true, value: { note: '' } });
	});

	it('reads booleans and numbers strictly', () => {
		assert.deepEqual(
			buildCustomFields([
				{ key: 'a', type: 'boolean', value: 'No' },
				{ key: 'b', type: 'boolean', value: true },
				{ key: 'c', type: 'number', value: '-2.5' },
				{ key: 'd', type: 'number', value: 7 },
			]),
			{ ok: true, value: { a: false, b: true, c: -2.5, d: 7 } },
		);
		assert.equal(buildCustomFields([{ key: 'a', type: 'boolean', value: 'maybe' }]).ok, false);
		assert.equal(buildCustomFields([{ key: 'c', type: 'number', value: '' }]).ok, false);
	});

	it('sends keys named like Object.prototype members as ordinary fields', () => {
		const result = buildCustomFields([
			{ key: 'toString', value: 'a' },
			{ key: 'constructor', value: 'b' },
			{ key: 'hasOwnProperty', type: 'number', value: '1' },
			{ key: 'prototype', type: 'remove' },
		]);
		assert.equal(result.ok, true);
		assert.deepEqual(Object.keys(result.value), ['toString', 'constructor', 'hasOwnProperty', 'prototype']);
		assert.equal(
			JSON.stringify(result.value),
			'{"toString":"a","constructor":"b","hasOwnProperty":1,"prototype":null}',
		);
		// The body as a whole still serialises to exactly those fields.
		const body = upsertContactRequest({ phone: '201000000001', customFields: [{ key: 'toString', value: 'a' }] });
		assert.equal(JSON.stringify(body.value.body), '{"phone":"201000000001","custom_fields":{"toString":"a"}}');
	});

	it('still catches a real duplicate of such a key', () => {
		assert.deepEqual(
			buildCustomFields([
				{ key: 'toString', value: 'a' },
				{ key: 'toString', value: 'b' },
			]),
			{ ok: false, message: 'Custom field "toString" is listed more than once' },
		);
	});

	it('refuses __proto__, which the API would silently drop', () => {
		assert.deepEqual(buildCustomFields([{ key: '__proto__', value: 'x' }]), {
			ok: false,
			message: '"__proto__" cannot be used as a custom field key',
		});
		assert.equal(upsertContactRequest({ phone: '201000000001', customFields: [{ key: ' __proto__ ', value: 'x' }] }).ok, false);
	});

	it('refuses an empty or repeated key', () => {
		assert.deepEqual(buildCustomFields([{ key: ' ', value: 'x' }]), { ok: false, message: 'Every custom field needs a key' });
		assert.deepEqual(
			buildCustomFields([
				{ key: 'city', value: 'Cairo' },
				{ key: ' city ', value: 'Giza' },
			]),
			{ ok: false, message: 'Custom field "city" is listed more than once' },
		);
	});
});

describe('splitTags', () => {
	it('splits on Latin and Arabic commas, trims and de-duplicates', () => {
		assert.deepEqual(splitTags('lead, دعم ،vip,,lead'), ['lead', 'دعم', 'vip']);
		assert.deepEqual(splitTags(['a', ' a ', 'b']), ['a', 'b']);
		assert.deepEqual(splitTags(undefined), []);
	});
});

describe('Contact → Get (GET /api/contacts/{phone})', () => {
	it('puts the cleaned phone in the path', () => {
		assert.deepEqual(getContactRequest('(+20) 100-000-0001'), {
			ok: true,
			value: { method: 'GET', path: '/api/contacts/201000000001' },
		});
	});

	it('URL-encodes whatever is left, so a value cannot reach another route', () => {
		const result = getContactRequest('201/../../numbers');
		assert.equal(result.ok, true);
		assert.equal(result.value.path, '/api/contacts/201%2F%2F%2Fnumbers');
	});

	it('refuses an empty phone', () => {
		assert.equal(getContactRequest('').ok, false);
	});
});

describe('Contact → Add Tag (POST /api/contacts/{phone}/tags)', () => {
	it('sends the tag, and the number only when chosen', () => {
		assert.deepEqual(addContactTagRequest('+201000000001', ' lead '), {
			ok: true,
			value: { method: 'POST', path: '/api/contacts/201000000001/tags', body: { tag: 'lead' } },
		});
		assert.deepEqual(addContactTagRequest('201000000001', 'دعم', '113456789012345'), {
			ok: true,
			value: {
				method: 'POST',
				path: '/api/contacts/201000000001/tags',
				body: { tag: 'دعم', from: '113456789012345' },
			},
		});
	});

	it('refuses an empty tag', () => {
		assert.deepEqual(addContactTagRequest('201000000001', '  '), { ok: false, message: 'Tag is required' });
	});
});

describe('Contact → Remove Tag (DELETE /api/contacts/{phone}/tags/{tag})', () => {
	it('URL-encodes the tag (Arabic, spaces, slashes)', () => {
		assert.deepEqual(removeContactTagRequest('201000000001', 'عميل مهم'), {
			ok: true,
			value: {
				method: 'DELETE',
				path: `/api/contacts/201000000001/tags/${encodeURIComponent('عميل مهم')}`,
			},
		});
		assert.equal(removeContactTagRequest('201000000001', 'a/b').value.path, '/api/contacts/201000000001/tags/a%2Fb');
	});

	it('refuses dot-only tags, which a URL would resolve to another route', () => {
		assert.equal(removeContactTagRequest('201000000001', '..').ok, false);
		assert.equal(removeContactTagRequest('201000000001', '').ok, false);
	});
});
