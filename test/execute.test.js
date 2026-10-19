'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { describe, it } = require('node:test');

const { WhatsArab } = require('../dist/nodes/WhatsArab/WhatsArab.node');

const NODE = {
	id: '00000000-0000-4000-8000-000000000010',
	name: 'WhatsArab',
	type: '@whatsarab/n8n-nodes-whatsarab.whatsArab',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** An error shaped like the one n8n's HTTP helper throws for a 4xx (Axios-style). */
function httpError(status, code, message, { binary = false } = {}) {
	const body = JSON.stringify({ success: false, error: { code, message } });
	return Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status, data: binary ? Buffer.from(body) : JSON.parse(body) },
	});
}

/**
 * The smallest IExecuteFunctions the action node touches. `params` holds the
 * node parameters for every item (dotted names as n8n resolves them);
 * `respond(request)` answers each WhatsArab call; `binary` is the input
 * item's binary data; `download(url)` answers a File URL fetch.
 */
function fakeExecuteContext({ params, respond = () => ({ success: true, data: {} }), binary, download, continueOnFail = false, items = 1 }) {
	const calls = [];
	const downloads = [];
	const ctx = {
		getInputData: () => Array.from({ length: items }, () => ({ json: {} })),
		getNode: () => NODE,
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({ baseUrl: '' }),
		getNodeParameter: (name, i, fallback) => {
			const value = typeof params === 'function' ? params(i)[name] : params[name];
			if (value !== undefined) return value;
			if (fallback !== undefined) return fallback;
			throw new Error(`Parameter "${name}" was not set in the test`);
		},
		helpers: {
			httpRequestWithAuthentication: async (credentialType, options) => {
				assert.equal(credentialType, 'whatsArabApi');
				calls.push(options);
				return await respond(options);
			},
			httpRequest: async (options) => {
				downloads.push(options);
				return await download(options);
			},
			assertBinaryData: (i, property) => {
				if (!binary || !binary[property]) throw new Error(`No binary data in "${property}"`);
				return binary[property].meta;
			},
			getBinaryDataBuffer: async (i, property) => binary[property].data,
			prepareBinaryData: async (data, fileName, mimeType) => ({
				data: data.toString('base64'),
				fileName,
				mimeType,
			}),
		},
	};
	return { ctx, calls, downloads };
}

const run = (ctx) => new WhatsArab().execute.call(ctx);

const PHONE = { recipientType: 'phone', phone: '+20 100 000 0001', from: '', options: {} };

describe('Message → Send Text (unchanged)', () => {
	it('still posts the same body to /api/messages and outputs data', async () => {
		const { ctx, calls } = fakeExecuteContext({
			params: { resource: 'message', operation: 'sendText', ...PHONE, text: 'أهلًا' },
			respond: () => ({ success: true, data: { message_id: 'wamid.1', status: 'sent' } }),
		});
		const [out] = await run(ctx);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, 'POST');
		assert.equal(calls[0].url, 'https://whatsarab.com/api/messages');
		assert.deepEqual(calls[0].body, { to: '201000000001', text: 'أهلًا' });
		assert.equal(calls[0].json, true);
		assert.deepEqual(out, [{ json: { message_id: 'wamid.1', status: 'sent' }, pairedItem: { item: 0 } }]);
	});
});

describe('Message → Send Buttons / List / Link Button', () => {
	it('sends the interactive object with header and footer from Options', async () => {
		const { ctx, calls } = fakeExecuteContext({
			params: {
				resource: 'message',
				operation: 'sendButtons',
				...PHONE,
				bodyText: 'Confirm your booking?',
				'buttons.button': [{ title: 'Confirm', id: 'confirm' }, { title: 'Change' }],
				options: { headerText: 'Clinic', footerText: 'Reply anytime' },
			},
		});
		await run(ctx);
		assert.deepEqual(calls[0].body, {
			to: '201000000001',
			interactive: {
				type: 'button',
				header: { type: 'text', text: 'Clinic' },
				body: { text: 'Confirm your booking?' },
				footer: { text: 'Reply anytime' },
				action: {
					buttons: [
						{ type: 'reply', reply: { id: 'confirm', title: 'Confirm' } },
						{ type: 'reply', reply: { id: 'Change', title: 'Change' } },
					],
				},
			},
		});
	});

	it('refuses four buttons before calling WhatsArab', async () => {
		const { ctx, calls } = fakeExecuteContext({
			params: {
				resource: 'message',
				operation: 'sendButtons',
				...PHONE,
				bodyText: 'Pick',
				'buttons.button': [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }],
			},
		});
		await assert.rejects(run(ctx), /at most 3 reply buttons/);
		assert.equal(calls.length, 0);
	});

	it('sends a list and a link button', async () => {
		const list = fakeExecuteContext({
			params: {
				resource: 'message',
				operation: 'sendList',
				...PHONE,
				bodyText: 'Our services',
				buttonText: 'Services',
				'rows.row': [{ title: 'Check-up' }],
			},
		});
		await run(list.ctx);
		assert.equal(list.calls[0].body.interactive.type, 'list');
		assert.deepEqual(list.calls[0].body.interactive.action.sections, [
			{ title: 'Services', rows: [{ id: 'Check-up', title: 'Check-up' }] },
		]);

		const cta = fakeExecuteContext({
			params: {
				resource: 'message',
				operation: 'sendCtaUrl',
				...PHONE,
				bodyText: 'Book online',
				buttonText: 'Book',
				ctaUrl: 'https://example.com/book',
			},
		});
		await run(cta.ctx);
		assert.deepEqual(cta.calls[0].body.interactive.action, {
			name: 'cta_url',
			parameters: { display_text: 'Book', url: 'https://example.com/book' },
		});
	});
});

describe('Message → Send Media', () => {
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const binary = { data: { data: PNG, meta: { fileName: 'menu.png', mimeType: 'image/png', data: '' } } };
	const mediaParams = {
		resource: 'message',
		operation: 'sendMedia',
		...PHONE,
		mediaKind: 'image',
		mediaSource: 'binary',
		binaryPropertyName: 'data',
		caption: 'Our menu',
	};

	it('uploads the binary file, then sends from the number the upload belongs to', async () => {
		const { ctx, calls } = fakeExecuteContext({
			params: { ...mediaParams, from: 'num-picked' },
			binary,
			respond: (req) =>
				req.url.endsWith('/api/media')
					? JSON.stringify({
							success: true,
							data: { media_id: '1234567890', mime_type: 'image/png', size_bytes: 8, from: { number_id: 'num-owner' } },
						})
					: { success: true, data: { message_id: 'wamid.2', status: 'sent' } },
		});
		const [out] = await run(ctx);
		assert.equal(calls.length, 2);

		const upload = calls[0];
		assert.equal(upload.method, 'POST');
		assert.equal(upload.url, 'https://whatsarab.com/api/media');
		assert.equal(upload.json, false);
		const boundary = upload.headers['Content-Type'].match(/^multipart\/form-data; boundary=(.+)$/)[1];
		const raw = upload.body.toString('latin1');
		assert.ok(raw.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="from"\r\n\r\nnum-picked\r\n`));
		assert.match(raw, /name="file"; filename="menu.png"\r\nContent-Type: image\/png\r\n\r\n/);
		assert.ok(upload.body.includes(PNG));

		assert.deepEqual(calls[1].body, {
			to: '201000000001',
			media: { id: '1234567890', kind: 'image', caption: 'Our menu' },
			from: 'num-owner',
		});
		assert.deepEqual(out[0].json, { message_id: 'wamid.2', status: 'sent', media_id: '1234567890' });
	});

	it('a dry run checks the file but uploads nothing', async () => {
		const { ctx, calls } = fakeExecuteContext({
			params: { ...mediaParams, options: { dryRun: true } },
			binary,
			respond: () => ({ success: true, data: { status: 'dry_run', window_open: true } }),
		});
		const [out] = await run(ctx);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, 'https://whatsarab.com/api/messages');
		assert.deepEqual(calls[0].body, {
			to: '201000000001',
			media: { id: '0', kind: 'image', caption: 'Our menu' },
			dry_run: true,
		});
		assert.deepEqual(out[0].json, { status: 'dry_run', window_open: true });
	});

	it('sends an existing media ID without uploading, and refuses a malformed one', async () => {
		const good = fakeExecuteContext({
			params: { ...mediaParams, mediaSource: 'id', mediaId: ' 998877 ', mediaKind: 'document', fileName: 'عرض.pdf' },
		});
		await run(good.ctx);
		assert.equal(good.calls.length, 1);
		assert.deepEqual(good.calls[0].body.media, { id: '998877', kind: 'document', caption: 'Our menu', filename: 'عرض.pdf' });

		const bad = fakeExecuteContext({ params: { ...mediaParams, mediaSource: 'id', mediaId: 'https://x/y.png' } });
		await assert.rejects(run(bad.ctx), /digits only/);
		assert.equal(bad.calls.length, 0);
	});

	it('fetches a File URL, then uploads it with the URL\'s file name and type', async () => {
		const pdf = Buffer.from('%PDF-1.7 test');
		const { ctx, calls, downloads } = fakeExecuteContext({
			params: {
				...mediaParams,
				mediaKind: 'document',
				mediaSource: 'url',
				mediaUrl: 'https://cdn.example.com/files/%D9%85%D9%86%D9%8A%D9%88.pdf',
				caption: '',
				fileName: '',
			},
			download: () => ({ body: pdf, headers: { 'content-type': 'application/pdf' } }),
			respond: (req) =>
				req.url.endsWith('/api/media')
					? { success: true, data: { media_id: '555', from: null } }
					: { success: true, data: { status: 'sent' } },
		});
		await run(ctx);
		assert.equal(downloads[0].encoding, 'stream');
		const raw = calls[0].body.toString('utf8');
		assert.match(raw, /filename\*=UTF-8''%D9%85%D9%86%D9%8A%D9%88\.pdf/);
		assert.match(raw, /Content-Type: application\/pdf/);
		// No number on the upload answer (legacy workspace): the send keeps the chosen one (none).
		assert.deepEqual(calls[1].body, { to: '201000000001', media: { id: '555', kind: 'document', filename: 'منيو.pdf' } });
	});

	it('stops reading a File URL at 16 MB, without buffering the rest', async () => {
		let produced = 0;
		const endless = Readable.from(
			(function* () {
				for (let n = 0; n < 64; n++) {
					produced++;
					yield Buffer.alloc(1024 * 1024);
				}
			})(),
		);
		const { ctx, calls, downloads } = fakeExecuteContext({
			params: { ...mediaParams, mediaSource: 'url', mediaUrl: 'https://example.com/huge.mp4', mediaKind: 'video' },
			download: () => ({ body: endless, headers: { 'content-type': 'video/mp4' } }),
		});
		await assert.rejects(run(ctx), /up to 16 MB/);
		assert.equal(calls.length, 0);
		assert.ok(produced <= 18, `read ${produced} MB before stopping`);
		assert.equal(downloads[0].abortSignal.aborted, true);
	});

	it('refuses a File URL whose Content-Length is over 16 MB before reading it', async () => {
		let read = false;
		const body = new Readable({ read() { read = true; this.push(null); } });
		const { ctx, calls, downloads } = fakeExecuteContext({
			params: { ...mediaParams, mediaSource: 'url', mediaUrl: 'https://example.com/huge.mp4', mediaKind: 'video' },
			download: () => ({ body, headers: { 'content-type': 'video/mp4', 'content-length': String(40 * 1024 * 1024) } }),
		});
		await assert.rejects(run(ctx), /40\.0 MB/);
		assert.equal(read, false);
		assert.equal(calls.length, 0);
		assert.equal(downloads[0].abortSignal.aborted, true);
	});

	it('fails clearly when the upload answer has no media_id, and sends nothing', async () => {
		const { ctx, calls } = fakeExecuteContext({
			params: mediaParams,
			binary,
			respond: () => ({ success: true, data: { from: { number_id: 'num-owner' } } }),
		});
		await assert.rejects(run(ctx), /returned no media_id/);
		assert.equal(calls.length, 1);
	});

	it('when the send fails after the upload, the error names the uploaded media ID for reuse', async () => {
		const { ctx } = fakeExecuteContext({
			params: mediaParams,
			binary,
			respond: (req) => {
				if (req.url.endsWith('/api/media')) return { success: true, data: { media_id: '4455', from: { number_id: 'num-owner' } } };
				throw httpError(409, 'OUTSIDE_CSW', 'Use a template instead.');
			},
		});
		await assert.rejects(run(ctx), (error) => {
			assert.equal(error.message, 'Use a template instead.');
			assert.match(error.description, /OUTSIDE_CSW/);
			assert.match(error.description, /media ID 4455 on number num-owner/);
			return true;
		});
	});

	it('refuses a file over 16 MB before uploading', async () => {
		const big = { data: { data: Buffer.alloc(16 * 1024 * 1024 + 1), meta: { fileName: 'big.mp4', mimeType: 'video/mp4' } } };
		const { ctx, calls } = fakeExecuteContext({ params: { ...mediaParams, mediaKind: 'video' }, binary: big });
		await assert.rejects(run(ctx), /up to 16 MB/);
		assert.equal(calls.length, 0);
	});
});

describe('Media → Download', () => {
	it('outputs the file as binary data, named and typed from the response', async () => {
		const ogg = Buffer.from('OggS fake voice note');
		const { ctx, calls } = fakeExecuteContext({
			params: { resource: 'media', operation: 'download', mediaId: '424242', binaryPropertyName: 'voice' },
			respond: () => ({ body: ogg, headers: { 'content-type': 'audio/ogg; codecs=opus' }, statusCode: 200 }),
		});
		const [out] = await run(ctx);
		assert.equal(calls[0].method, 'GET');
		assert.equal(calls[0].url, 'https://whatsarab.com/api/media/424242');
		assert.equal(calls[0].encoding, 'arraybuffer');
		assert.equal(calls[0].returnFullResponse, true);
		assert.deepEqual(out[0].json, {
			media_id: '424242',
			mime_type: 'audio/ogg',
			size_bytes: ogg.length,
			file_name: 'whatsapp-424242.ogg',
		});
		assert.deepEqual(out[0].binary.voice, {
			data: ogg.toString('base64'),
			fileName: 'whatsapp-424242.ogg',
			mimeType: 'audio/ogg',
		});
	});

	it('fails clearly on an empty download instead of outputting a 0-byte file', async () => {
		const { ctx } = fakeExecuteContext({
			params: { resource: 'media', operation: 'download', mediaId: '9', binaryPropertyName: 'data' },
			respond: () => ({ body: Buffer.alloc(0), headers: { 'content-type': 'image/jpeg' } }),
		});
		await assert.rejects(run(ctx), /no bytes for media ID 9/);
	});

	it('reports WhatsArab\'s own error even though a download\'s error body arrives as bytes', async () => {
		const { ctx } = fakeExecuteContext({
			params: { resource: 'media', operation: 'download', mediaId: '1', binaryPropertyName: 'data' },
			respond: () => {
				throw httpError(404, 'MEDIA_NOT_FOUND', 'Media not found or expired', { binary: true });
			},
		});
		await assert.rejects(run(ctx), (error) => {
			assert.equal(error.message, 'Media not found or expired');
			assert.match(error.description, /MEDIA_NOT_FOUND/);
			return true;
		});
	});
});

describe('Media → Upload', () => {
	it('uploads from the chosen number and outputs the media ID', async () => {
		const binary = { data: { data: Buffer.from('RIFF....WEBP'), meta: { fileName: 'sticker.webp', mimeType: 'image/webp' } } };
		const { ctx, calls } = fakeExecuteContext({
			params: { resource: 'media', operation: 'upload', from: 'num-2', binaryPropertyName: 'data' },
			binary,
			respond: () => Buffer.from(JSON.stringify({ success: true, data: { media_id: '777', from: { number_id: 'num-2' } } })),
		});
		const [out] = await run(ctx);
		assert.match(calls[0].body.toString('utf8'), /name="from"\r\n\r\nnum-2\r\n/);
		assert.deepEqual(out[0].json, { media_id: '777', from: { number_id: 'num-2' } });
	});
});

describe('Template and Number → Get Many', () => {
	it('returns one item per template, and only approved ones when asked', async () => {
		const templates = [
			{ name: 'welcome', language: 'ar', status: 'APPROVED' },
			{ name: 'promo', language: 'ar', status: 'REJECTED' },
		];
		const all = fakeExecuteContext({
			params: { resource: 'template', operation: 'getAll', from: 'num-1', approvedOnly: false },
			respond: () => ({ success: true, data: templates }),
		});
		const [allOut] = await run(all.ctx);
		assert.deepEqual(all.calls[0].qs, { from: 'num-1' });
		assert.equal(allOut.length, 2);

		const approved = fakeExecuteContext({
			params: { resource: 'template', operation: 'getAll', from: '', approvedOnly: true },
			respond: () => ({ success: true, data: templates }),
		});
		const [approvedOut] = await run(approved.ctx);
		assert.equal(approved.calls[0].qs, undefined);
		assert.deepEqual(approvedOut, [{ json: templates[0], pairedItem: { item: 0 } }]);
	});

	it('returns one item per number', async () => {
		const numbers = [{ id: 'a', is_default: true }, { id: 'b' }];
		const { ctx, calls } = fakeExecuteContext({
			params: { resource: 'number', operation: 'getAll' },
			respond: () => ({ success: true, data: numbers, total: 2 }),
		});
		const [out] = await run(ctx);
		assert.equal(calls[0].url, 'https://whatsarab.com/api/numbers');
		assert.deepEqual(out.map((o) => o.json), numbers);
	});
});

describe('errors per item', () => {
	it('with Continue On Fail, a refused item becomes an error item and the next one still runs', async () => {
		const { ctx, calls } = fakeExecuteContext({
			items: 2,
			continueOnFail: true,
			params: (i) => ({ resource: 'message', operation: 'sendText', ...PHONE, text: i === 0 ? 'first' : 'second' }),
			respond: (req) => {
				if (req.body.text === 'first') throw httpError(409, 'OUTSIDE_CSW', 'Use a template instead.');
				return { success: true, data: { status: 'sent' } };
			},
		});
		const [out] = await run(ctx);
		assert.equal(calls.length, 2);
		assert.deepEqual(out, [
			{ json: { error: 'Use a template instead.' }, pairedItem: { item: 0 } },
			{ json: { status: 'sent' }, pairedItem: { item: 1 } },
		]);
	});
});
