/**
 * Pure request builders for the WhatsArab public REST API. No n8n context in
 * here, so every body the node sends can be unit-tested byte for byte.
 *
 * Source of truth for every shape below: the platform's API catalog
 * (POST /api/messages, GET /api/numbers, GET /api/templates).
 */

import { DEFAULT_BASE_URL } from './api';

export type RecipientType = 'phone' | 'userId';

export interface Recipient {
	type: RecipientType;
	value: string;
}

export interface CommonSendOptions {
	/** Workspace number id, Meta phone_number_id or E.164 phone. Omitted: the workspace default. */
	from?: string;
	/** Validate only. Nothing reaches Meta and no quota is reserved. */
	dryRun?: boolean;
}

export type ApiJsonObject = { [key: string]: ApiJsonValue };
export type ApiJsonValue = string | number | boolean | null | ApiJsonValue[] | ApiJsonObject;

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic-Indic and Persian digits → ASCII 0-9. */
export function toAsciiDigits(input: string): string {
	let out = '';
	for (const ch of input) {
		const a = ARABIC_INDIC.indexOf(ch);
		const p = PERSIAN.indexOf(ch);
		out += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
	}
	return out;
}

/**
 * Characters stripped from a phone before sending:
 *   \s            whitespace
 *   -  ( )  .     dash, parentheses, dot
 *   \u200E        LEFT-TO-RIGHT MARK
 *   \u200F        RIGHT-TO-LEFT MARK
 *   \u061C        ARABIC LETTER MARK
 *   \u202A-\u202E LRE, RLE, PDF, LRO, RLO (embeddings and overrides)
 *   \u2066-\u2069 LRI, RLI, FSI, PDI (isolates)
 */
const PHONE_NOISE = /[\s\-().\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;

/**
 * The API wants E.164 digits with no leading "+" (it tolerates the "+").
 * Spreadsheet and CRM values often carry spaces, dashes, dots, parentheses,
 * invisible direction marks (pasted from Arabic text), a 00 prefix or Arabic
 * digits, so those are cleaned here. Anything else (letters,
 * a local number without country code) is passed through for the API to
 * reject with INVALID_PHONE rather than guessed at.
 */
export function normalizePhone(input: string): string {
	let s = toAsciiDigits(String(input ?? '').trim()).replace(PHONE_NOISE, '');
	if (s.startsWith('+')) s = s.slice(1);
	else if (s.startsWith('00')) s = s.slice(2);
	return s;
}

function recipientFields(recipient: Recipient): ApiJsonObject {
	const value = String(recipient.value ?? '').trim();
	if (recipient.type === 'userId') return { recipient: value };
	return { to: normalizePhone(value) };
}

function commonFields(options: CommonSendOptions): ApiJsonObject {
	const out: ApiJsonObject = {};
	const from = options.from?.trim();
	if (from) out.from = from;
	if (options.dryRun) out.dry_run = true;
	return out;
}

export function buildSendTextBody(recipient: Recipient, text: string, options: CommonSendOptions = {}): ApiJsonObject {
	return { ...recipientFields(recipient), text, ...commonFields(options) };
}

export interface TemplateInput {
	name: string;
	language: string;
	/** Ordered values for the template body's {{1}}, {{2}}, ... placeholders. */
	bodyParameters?: string[];
	/** Full Meta `components` array. When set it wins over bodyParameters. */
	components?: ApiJsonValue[];
}

export function buildTemplateComponents(input: TemplateInput): ApiJsonValue[] | undefined {
	if (input.components && input.components.length > 0) return input.components;
	const params = (input.bodyParameters ?? []).map((text) => ({ type: 'text', text: String(text) }));
	if (params.length === 0) return undefined;
	return [{ type: 'body', parameters: params }];
}

export function buildSendTemplateBody(
	recipient: Recipient,
	template: TemplateInput,
	options: CommonSendOptions = {},
): ApiJsonObject {
	const body: ApiJsonObject = {
		...recipientFields(recipient),
		template: template.name.trim(),
		...commonFields(options),
	};
	const language = template.language?.trim();
	if (language) body.language = language;
	const components = buildTemplateComponents(template);
	if (components) body.components = components;
	return body;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Parse the "Components (JSON)" field. Accepts an array, or a string holding
 * one. An empty value is `{ ok: true, value: undefined }`; anything else that
 * is not an array comes back with a readable message for the node to raise.
 */
export function parseComponentsJson(value: unknown): ParseResult<ApiJsonValue[] | undefined> {
	if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
	let parsed: unknown = value;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return { ok: true, value: undefined };
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return { ok: false, message: 'Components (JSON) is not valid JSON' };
		}
	}
	if (!Array.isArray(parsed)) {
		return { ok: false, message: 'Components (JSON) must be a JSON array of template components' };
	}
	return { ok: true, value: parsed as ApiJsonValue[] };
}

export interface ApiNumber {
	id: string;
	phone_number_id?: string | null;
	display_number?: string | null;
	label?: string | null;
	is_default?: boolean;
	status?: string;
}

export function numberOptionName(n: ApiNumber): string {
	const phone = n.display_number || n.phone_number_id || n.id;
	const label = n.label ? `${n.label} · ` : '';
	return `${label}${phone}${n.is_default ? ' (default)' : ''}`;
}

export interface ApiTemplate {
	name?: string;
	language?: string;
	status?: string;
	category?: string;
}

/** Approved templates, one option per name, with its languages in the description. */
export function templateOptions(templates: ApiTemplate[]): Array<{ name: string; value: string; description: string }> {
	const byName = new Map<string, Set<string>>();
	for (const t of templates) {
		if (!t.name || String(t.status ?? '').toUpperCase() !== 'APPROVED') continue;
		const langs = byName.get(t.name) ?? new Set<string>();
		if (t.language) langs.add(t.language);
		byName.set(t.name, langs);
	}
	return [...byName.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, langs]) => ({
			name,
			value: name,
			description: langs.size ? `Approved languages: ${[...langs].sort().join(', ')}` : 'Approved',
		}));
}

/** Empty base URL → DEFAULT_BASE_URL; trailing slashes stripped (same rule as BASE_URL_EXPRESSION). */
export function joinUrl(baseUrl: string, path: string): string {
	return `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/{1,256}$/, '')}${path}`;
}
