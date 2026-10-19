/**
 * Pure helpers for the media endpoints. No n8n context in here.
 *
 *   POST /api/media       multipart field `file` (+ optional `from`) → { media_id, mime_type, size_bytes, from }
 *   GET  /api/media/{id}  the bytes of an incoming message's media, with its Content-Type
 *
 * The package has no runtime dependencies (n8n's rule for verified nodes), so
 * the multipart body is assembled here by hand instead of with `form-data`.
 */

import type { MediaKind, ParseResult } from './requests';

/** The upload limit of POST /api/media (the same as the WhatsArab inbox). */
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export const MEDIA_KINDS: MediaKind[] = ['image', 'video', 'audio', 'document', 'sticker'];

/** What POST /api/messages accepts as `media.id`. */
const MEDIA_ID_RE = /^\d{1,40}$/;

export function checkMediaId(value: unknown): ParseResult<string> {
	const id = String(value ?? '').trim();
	if (!MEDIA_ID_RE.test(id)) {
		return {
			ok: false,
			message:
				'Media ID must be a WhatsApp media id (digits only), from Media → Upload or the media.id of a Message Received event',
		};
	}
	return { ok: true, value: id };
}

export function checkMediaSize(bytes: number): ParseResult<number> {
	if (bytes <= 0) return { ok: false, message: 'The file is empty' };
	if (bytes > MAX_MEDIA_BYTES) {
		const mb = (bytes / 1024 / 1024).toFixed(1);
		return { ok: false, message: `The file is ${mb} MB; WhatsArab accepts up to 16 MB` };
	}
	return { ok: true, value: bytes };
}

export interface MultipartFile {
	data: Buffer;
	fileName: string;
	mimeType: string;
}

export interface MultipartBody {
	body: Buffer;
	contentType: string;
}

/** Strips characters that would break out of a quoted header parameter. */
function headerSafe(value: string): string {
	return value.replace(/["\\\r\n]/g, '_');
}

/**
 * Content-Disposition parameters for a file name. A plain ASCII name goes in
 * `filename`. Any other name (Arabic, accented) also gets RFC 5987
 * `filename*=UTF-8''…`, which multer/busboy prefer; without it they read the
 * bytes as latin1 and the customer sees mojibake.
 */
export function fileNameParams(fileName: string): string {
	const name = fileName.trim() || 'file';
	if (/^[\x20-\x7e]+$/.test(name)) return `filename="${headerSafe(name)}"`;
	const ascii = headerSafe(name.replace(/[^\x20-\x7e]/g, '_'));
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** One multipart/form-data body: the text fields first, then the file as field `file`. */
export function buildMultipart(fields: Record<string, string>, file: MultipartFile, boundary: string): MultipartBody {
	const crlf = '\r\n';
	const parts: Buffer[] = [];
	for (const [name, value] of Object.entries(fields)) {
		parts.push(
			Buffer.from(
				`--${boundary}${crlf}Content-Disposition: form-data; name="${headerSafe(name)}"${crlf}${crlf}${value}${crlf}`,
				'utf8',
			),
		);
	}
	parts.push(
		Buffer.from(
			`--${boundary}${crlf}Content-Disposition: form-data; name="file"; ${fileNameParams(file.fileName)}${crlf}` +
				`Content-Type: ${headerSafe(file.mimeType || 'application/octet-stream')}${crlf}${crlf}`,
			'utf8',
		),
	);
	parts.push(file.data);
	parts.push(Buffer.from(`${crlf}--${boundary}--${crlf}`, 'utf8'));
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** File extensions for the media types WhatsApp delivers. */
const EXTENSIONS: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'video/mp4': 'mp4',
	'video/3gpp': '3gp',
	'audio/ogg': 'ogg',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/aac': 'aac',
	'audio/amr': 'amr',
	'application/pdf': 'pdf',
	'text/plain': 'txt',
	'application/msword': 'doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.ms-excel': 'xls',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'application/vnd.ms-powerpoint': 'ppt',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** The bare mime type of a Content-Type header (`audio/ogg; codecs=opus` → `audio/ogg`). */
export function bareMimeType(contentType: unknown): string {
	return String(contentType ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}

/** A file name for downloaded media: `whatsapp-<id>.<ext>`, no extension for an unknown type. */
export function mediaFileName(mediaId: string, mimeType: string): string {
	const ext = EXTENSIONS[bareMimeType(mimeType)];
	return ext ? `whatsapp-${mediaId}.${ext}` : `whatsapp-${mediaId}`;
}

/** The last path segment of a URL, decoded, for a file fetched by URL. Empty when there is none. */
export function fileNameFromUrl(url: string): string {
	try {
		const segment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
		return decodeURIComponent(segment);
	} catch {
		return '';
	}
}
