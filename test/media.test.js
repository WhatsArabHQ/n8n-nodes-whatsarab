'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
	MAX_MEDIA_BYTES,
	bareMimeType,
	buildMultipart,
	checkMediaId,
	checkMediaSize,
	fileNameFromUrl,
	fileNameParams,
	mediaFileName,
} = require('../dist/nodes/WhatsArab/media');

describe('buildMultipart', () => {
	it('writes the fields, then the file as field "file", byte for byte', () => {
		const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		const { body, contentType } = buildMultipart(
			{ from: 'num-1' },
			{ data, fileName: 'menu.png', mimeType: 'image/png' },
			'BOUNDARY',
		);
		assert.equal(contentType, 'multipart/form-data; boundary=BOUNDARY');
		const expected = Buffer.concat([
			Buffer.from(
				'--BOUNDARY\r\nContent-Disposition: form-data; name="from"\r\n\r\nnum-1\r\n' +
					'--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="menu.png"\r\nContent-Type: image/png\r\n\r\n',
			),
			data,
			Buffer.from('\r\n--BOUNDARY--\r\n'),
		]);
		assert.ok(body.equals(expected), body.toString('latin1'));
	});

	it('keeps binary bytes untouched (no utf8 round trip)', () => {
		const data = Buffer.from(Array.from({ length: 256 }, (_, n) => n));
		const { body } = buildMultipart({}, { data, fileName: 'a.bin', mimeType: '' }, 'B');
		assert.ok(body.includes(data));
		assert.match(body.toString('latin1'), /Content-Type: application\/octet-stream/);
	});

	it('cannot be broken out of by a quote or a line break in a name', () => {
		const { body } = buildMultipart({}, { data: Buffer.from('x'), fileName: 'a"\r\nX-Evil: 1.pdf', mimeType: 'application/pdf' }, 'B');
		const head = body.toString('utf8');
		assert.doesNotMatch(head, /\r\nX-Evil/);
		assert.match(head, /filename="a___X-Evil: 1.pdf"/);
	});
});

describe('fileNameParams', () => {
	it('sends an ASCII name as is', () => {
		assert.equal(fileNameParams('invoice-1042.pdf'), 'filename="invoice-1042.pdf"');
	});

	it('adds RFC 5987 filename* for an Arabic name, with an ASCII fallback', () => {
		assert.equal(
			fileNameParams('فاتورة 1.pdf'),
			`filename="______ 1.pdf"; filename*=UTF-8''${encodeURIComponent('فاتورة 1.pdf')}`,
		);
	});

	it('falls back to "file" for an empty name', () => {
		assert.equal(fileNameParams('  '), 'filename="file"');
	});
});

describe('media checks', () => {
	it('accepts only digit media ids, as POST /api/messages does', () => {
		assert.deepEqual(checkMediaId(' 1234567890 '), { ok: true, value: '1234567890' });
		for (const bad of ['', 'abc', '12a', '1'.repeat(41), 'https://x/y.jpg']) {
			assert.equal(checkMediaId(bad).ok, false, bad);
		}
	});

	it('refuses an empty file and one over 16 MB, saying the size', () => {
		assert.equal(checkMediaSize(1).ok, true);
		assert.equal(checkMediaSize(MAX_MEDIA_BYTES).ok, true);
		assert.match(checkMediaSize(0).message, /empty/);
		assert.match(checkMediaSize(MAX_MEDIA_BYTES + 1).message, /16\.0 MB.*up to 16 MB/);
	});
});

describe('file names and types', () => {
	it('names a download after its id with the extension of its type', () => {
		assert.equal(mediaFileName('77', 'audio/ogg; codecs=opus'), 'whatsapp-77.ogg');
		assert.equal(mediaFileName('77', 'image/jpeg'), 'whatsapp-77.jpg');
		assert.equal(mediaFileName('77', 'application/x-unknown'), 'whatsapp-77');
	});

	it('reads the bare mime type of a Content-Type header', () => {
		assert.equal(bareMimeType('Audio/OGG; codecs=opus'), 'audio/ogg');
		assert.equal(bareMimeType(undefined), 'application/octet-stream');
	});

	it('takes a file name from the URL path', () => {
		assert.equal(fileNameFromUrl('https://cdn.example.com/files/%D9%85%D9%86%D9%8A%D9%88.pdf?v=2'), 'منيو.pdf');
		assert.equal(fileNameFromUrl('https://example.com/'), '');
		assert.equal(fileNameFromUrl('not a url'), '');
	});
});
