'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildCtaUrl, buildList, buildReplyButtons } = require('../dist/nodes/WhatsArab/interactive');
const { buildSendInteractiveBody, buildSendMediaBody } = require('../dist/nodes/WhatsArab/requests');

const ok = (result) => {
	assert.equal(result.ok, true, result.message);
	return result.value;
};
const refused = (result, pattern) => {
	assert.equal(result.ok, false);
	assert.match(result.message, pattern);
};

describe('buildReplyButtons', () => {
	it('builds Meta\'s button shape, an untitled ID defaulting to the title', () => {
		assert.deepEqual(ok(buildReplyButtons('تحب نكلمك امتى؟', [{ title: 'الصبح' }, { title: 'بالليل', id: 'evening' }])), {
			type: 'button',
			body: { text: 'تحب نكلمك امتى؟' },
			action: {
				buttons: [
					{ type: 'reply', reply: { id: 'الصبح', title: 'الصبح' } },
					{ type: 'reply', reply: { id: 'evening', title: 'بالليل' } },
				],
			},
		});
	});

	it('adds a text header and a footer only when set, around the body', () => {
		const value = ok(buildReplyButtons('Body', [{ title: 'Yes' }], { headerText: ' Booking ', footerText: 'Reply anytime' }));
		assert.deepEqual(Object.keys(value), ['type', 'header', 'body', 'footer', 'action']);
		assert.deepEqual(value.header, { type: 'text', text: 'Booking' });
		assert.deepEqual(value.footer, { text: 'Reply anytime' });
		const bare = ok(buildReplyButtons('Body', [{ title: 'Yes' }], { headerText: '  ', footerText: '' }));
		assert.equal('header' in bare, false);
		assert.equal('footer' in bare, false);
	});

	it('keeps the body exactly as typed (line breaks are part of the message)', () => {
		assert.equal(ok(buildReplyButtons('  Line 1\nLine 2  ', [{ title: 'A' }])).body.text, '  Line 1\nLine 2  ');
	});

	it('refuses what WhatsApp can never send', () => {
		refused(buildReplyButtons(' ', [{ title: 'A' }]), /Body Text is required/);
		refused(buildReplyButtons('Hi', []), /at least one button/);
		refused(buildReplyButtons('Hi', [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]), /at most 3/);
		refused(buildReplyButtons('Hi', [{ title: 'A' }, { title: ' ' }]), /Button 2 has no title/);
		refused(buildReplyButtons('Hi', [{ title: 'Yes' }, { title: 'Yes', id: 'y2' }]), /unique titles/);
		refused(buildReplyButtons('Hi', [{ title: 'Yes', id: 'x' }, { title: 'No', id: 'x' }]), /must be unique/);
	});

	it('leaves character limits to WhatsApp (they change without a release here)', () => {
		ok(buildReplyButtons('x'.repeat(5000), [{ title: 'a title longer than twenty characters' }]));
	});
});

describe('buildList', () => {
	it('puts rows without a section under one section titled with the button text', () => {
		assert.deepEqual(ok(buildList('اختار الخدمة', 'الخدمات', [{ title: 'كشف' }, { title: 'متابعة', description: 'خلال أسبوعين', id: 'follow' }])), {
			type: 'list',
			body: { text: 'اختار الخدمة' },
			action: {
				button: 'الخدمات',
				sections: [
					{
						title: 'الخدمات',
						rows: [
							{ id: 'كشف', title: 'كشف' },
							{ id: 'follow', title: 'متابعة', description: 'خلال أسبوعين' },
						],
					},
				],
			},
		});
	});

	it('groups rows by section in first-appearance order', () => {
		const value = ok(
			buildList('Pick', 'Menu', [
				{ title: 'Latte', section: 'Coffee' },
				{ title: 'Green', section: 'Tea' },
				{ title: 'Mocha', section: 'Coffee' },
			]),
		);
		assert.deepEqual(
			value.action.sections.map((s) => [s.title, s.rows.map((r) => r.title)]),
			[
				['Coffee', ['Latte', 'Mocha']],
				['Tea', ['Green']],
			],
		);
	});

	it('refuses what WhatsApp can never send', () => {
		refused(buildList('', 'Menu', [{ title: 'A' }]), /Body Text is required/);
		refused(buildList('Pick', ' ', [{ title: 'A' }]), /Button Text is required/);
		refused(buildList('Pick', 'Menu', []), /at least one row/);
		refused(
			buildList('Pick', 'Menu', Array.from({ length: 11 }, (_, n) => ({ title: `Row ${n}` }))),
			/at most 10 rows/,
		);
		refused(buildList('Pick', 'Menu', [{ title: 'A' }, { title: '' }]), /Row 2 has no title/);
		refused(buildList('Pick', 'Menu', [{ title: 'A' }, { title: 'A' }]), /row IDs must be unique/);
	});
});

describe('buildCtaUrl', () => {
	it('builds Meta\'s cta_url shape', () => {
		assert.deepEqual(ok(buildCtaUrl('Book your slot', 'Book', ' https://example.com/book?x=1 ', { footerText: 'Clinic' })), {
			type: 'cta_url',
			body: { text: 'Book your slot' },
			footer: { text: 'Clinic' },
			action: { name: 'cta_url', parameters: { display_text: 'Book', url: 'https://example.com/book?x=1' } },
		});
	});

	it('wants a full http(s) URL and a label', () => {
		refused(buildCtaUrl('Hi', 'Open', 'example.com'), /full http/);
		refused(buildCtaUrl('Hi', 'Open', 'javascript:alert(1)'), /full http/);
		refused(buildCtaUrl('Hi', '', 'https://example.com'), /Button Text is required/);
	});
});

describe('message bodies', () => {
	it('wraps an interactive object with the recipient and common fields', () => {
		const interactive = ok(buildReplyButtons('Hi', [{ title: 'A' }]));
		assert.deepEqual(
			buildSendInteractiveBody({ type: 'phone', value: '+20 100 000 0001' }, interactive, { from: 'num-1', dryRun: true }),
			{ to: '201000000001', interactive, from: 'num-1', dry_run: true },
		);
	});

	it('sends a caption only for kinds WhatsApp shows one on, and a file name only for documents', () => {
		const to = { type: 'phone', value: '201000000001' };
		assert.deepEqual(buildSendMediaBody(to, { kind: 'image', id: ' 123 ', caption: 'Menu', filename: 'x.jpg' }), {
			to: '201000000001',
			media: { id: '123', kind: 'image', caption: 'Menu' },
		});
		assert.deepEqual(buildSendMediaBody(to, { kind: 'audio', id: '123', caption: 'ignored' }).media, {
			id: '123',
			kind: 'audio',
		});
		assert.deepEqual(buildSendMediaBody(to, { kind: 'document', id: '9', caption: ' ', filename: 'فاتورة.pdf' }).media, {
			id: '9',
			kind: 'document',
			filename: 'فاتورة.pdf',
		});
	});
});
