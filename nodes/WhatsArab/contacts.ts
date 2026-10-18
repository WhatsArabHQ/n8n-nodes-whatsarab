/**
 * Pure request builders for the Contact resource. No n8n context in here, so
 * every request the node sends can be unit-tested byte for byte.
 *
 * Source of truth: the platform's API catalog (upsertApiContact,
 * getApiContact, addApiContactTag, removeApiContactTag):
 *
 *   POST   /api/contacts                    upsert by phone      (scope send)
 *   GET    /api/contacts/{phone}            read one             (scope read or send)
 *   POST   /api/contacts/{phone}/tags       add a tag            (scope send)
 *   DELETE /api/contacts/{phone}/tags/{tag} remove a tag         (scope send)
 *
 * The API's merge rules, which the node must not paper over:
 *   - a field left out keeps its value;
 *   - custom_fields merge key by key, and a key set to null is REMOVED;
 *   - tags are ADDED to the contact's tags, never replacing them;
 *   - opted_in: false opts out; opted_in: true records consent only on a
 *     contact that is not opted out and never lifts an opt-out.
 */

import { CONTACTS_PATH } from './api';
import { type ApiJsonObject, type ApiJsonValue, normalizePhone, type ParseResult, toAsciiDigits } from './requests';

export interface ApiRequest {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	body?: ApiJsonObject;
}

/** How the node's "Custom Fields" rows say what to do with each key. */
export type CustomFieldType = 'string' | 'number' | 'boolean' | 'remove';

export interface CustomFieldInput {
	key: string;
	type?: CustomFieldType;
	value?: unknown;
}

/** "Consent" option: leave alone, record consent (never lifts an opt-out), or opt out. */
export type ConsentChoice = 'unchanged' | 'optIn' | 'optOut';

export interface UpsertContactInput {
	phone: string;
	name?: string;
	customFields?: CustomFieldInput[];
	/** Comma-separated (Latin or Arabic comma) or an array. */
	tags?: string | string[];
	consent?: ConsentChoice;
	/** Number whose audience the contact joins. Omitted: the workspace default. */
	from?: string;
}

/** Tags from a comma-separated string (`,` or Arabic `،`) or an array: trimmed, empties dropped, de-duplicated. */
export function splitTags(input: unknown): string[] {
	const parts = Array.isArray(input) ? input.map((t) => String(t ?? '')) : String(input ?? '').split(/[,،]/);
	const out: string[] = [];
	for (const raw of parts) {
		const tag = raw.trim();
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out;
}

const TRUE_WORDS = ['true', 'yes', '1'];
const FALSE_WORDS = ['false', 'no', '0'];

/**
 * A key the API would accept but silently drop: its validator (zod) skips
 * `__proto__` when it rebuilds the object, so the field would vanish without
 * an error. Refused here with a clear message instead. Every other name,
 * `constructor`, `prototype` and `toString` included, is stored normally.
 */
const DROPPED_BY_API = '__proto__';

/**
 * The node's custom-field rows → the API's `custom_fields` object.
 * Type "Remove Field" sends null, which the API reads as "delete this key".
 * Returns `value: undefined` when there are no rows (the field is then left out).
 *
 * Collected in a Map, not a plain object: `key in {}` sees inherited names
 * (`toString`, `constructor`) and `obj.__proto__ = v` sets the prototype
 * instead of a field. Object.fromEntries then defines own properties only.
 */
export function buildCustomFields(fields: CustomFieldInput[] | undefined): ParseResult<ApiJsonObject | undefined> {
	if (!fields || fields.length === 0) return { ok: true, value: undefined };
	const out = new Map<string, ApiJsonValue>();
	for (const field of fields) {
		const key = String(field.key ?? '').trim();
		if (!key) return { ok: false, message: 'Every custom field needs a key' };
		if (key === DROPPED_BY_API) {
			return { ok: false, message: `"${key}" cannot be used as a custom field key` };
		}
		if (out.has(key)) return { ok: false, message: `Custom field "${key}" is listed more than once` };
		const value = customFieldValue(key, field);
		if (!value.ok) return value;
		out.set(key, value.value);
	}
	return { ok: true, value: Object.fromEntries(out) as ApiJsonObject };
}

function customFieldValue(key: string, field: CustomFieldInput): ParseResult<ApiJsonValue> {
	const type = field.type ?? 'string';
	if (type === 'remove') return { ok: true, value: null };
	if (type === 'number') {
		let n: number;
		if (typeof field.value === 'number') {
			n = field.value;
		} else {
			const text = toAsciiDigits(String(field.value ?? '')).trim();
			n = text === '' ? NaN : Number(text);
		}
		if (!Number.isFinite(n)) return { ok: false, message: `Custom field "${key}" is not a number` };
		return { ok: true, value: n };
	}
	if (type === 'boolean') {
		if (typeof field.value === 'boolean') return { ok: true, value: field.value };
		const word = String(field.value ?? '').trim().toLowerCase();
		if (TRUE_WORDS.includes(word)) return { ok: true, value: true };
		if (FALSE_WORDS.includes(word)) return { ok: true, value: false };
		return { ok: false, message: `Custom field "${key}" must be true or false` };
	}
	return { ok: true, value: String(field.value ?? '') };
}

/** The phone as a path segment: cleaned like every phone the node sends, then URL-encoded. */
export function phoneSegment(phone: string): ParseResult<string> {
	const normalized = normalizePhone(phone);
	if (!normalized) return { ok: false, message: 'Phone Number is required' };
	return { ok: true, value: encodeURIComponent(normalized) };
}

function tagValue(tag: string): ParseResult<string> {
	const value = String(tag ?? '').trim();
	if (!value) return { ok: false, message: 'Tag is required' };
	// "." and ".." would be resolved away as path segments and hit another route.
	if (/^\.+$/.test(value)) return { ok: false, message: `"${value}" is not a valid tag` };
	return { ok: true, value };
}

export function upsertContactRequest(input: UpsertContactInput): ParseResult<ApiRequest> {
	const phone = normalizePhone(input.phone);
	if (!phone) return { ok: false, message: 'Phone Number is required' };
	const body: ApiJsonObject = { phone };

	const name = input.name?.trim();
	if (name) body.name = name;

	const customFields = buildCustomFields(input.customFields);
	if (!customFields.ok) return customFields;
	if (customFields.value) body.custom_fields = customFields.value;

	const tags = splitTags(input.tags);
	if (tags.length > 0) body.tags = tags;

	if (input.consent === 'optIn') body.opted_in = true;
	else if (input.consent === 'optOut') body.opted_in = false;

	const from = input.from?.trim();
	if (from) body.from = from;

	return { ok: true, value: { method: 'POST', path: CONTACTS_PATH, body } };
}

export function getContactRequest(phone: string): ParseResult<ApiRequest> {
	const segment = phoneSegment(phone);
	if (!segment.ok) return segment;
	return { ok: true, value: { method: 'GET', path: `${CONTACTS_PATH}/${segment.value}` } };
}

export function addContactTagRequest(phone: string, tag: string, from?: string): ParseResult<ApiRequest> {
	const segment = phoneSegment(phone);
	if (!segment.ok) return segment;
	const value = tagValue(tag);
	if (!value.ok) return value;
	const body: ApiJsonObject = { tag: value.value };
	const fromValue = from?.trim();
	if (fromValue) body.from = fromValue;
	return { ok: true, value: { method: 'POST', path: `${CONTACTS_PATH}/${segment.value}/tags`, body } };
}

export function removeContactTagRequest(phone: string, tag: string): ParseResult<ApiRequest> {
	const segment = phoneSegment(phone);
	if (!segment.ok) return segment;
	const value = tagValue(tag);
	if (!value.ok) return value;
	return {
		ok: true,
		value: { method: 'DELETE', path: `${CONTACTS_PATH}/${segment.value}/tags/${encodeURIComponent(value.value)}` },
	};
}
