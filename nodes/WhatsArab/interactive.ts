/**
 * Pure builders for interactive messages (POST /api/messages `interactive`).
 * No n8n context in here, so every body the node sends can be unit-tested
 * byte for byte.
 *
 * WhatsArab passes `interactive` to WhatsApp in Meta's own shape and only
 * checks `type` and `body.text`; WhatsApp enforces its size limits and its
 * errors come back translated. So the builders check only what makes a
 * message impossible to build (a missing body, no buttons, more buttons or
 * rows than WhatsApp ever allows, two buttons with the same title) and leave
 * character limits to WhatsApp, where they can change without a release.
 *
 * Meta reference (checked Oct 2026): reply buttons 1 to 3 (title 20 chars,
 * id 256, unique titles); list up to 10 rows in total over up to 10 sections
 * (section title required, 24 chars; row title 24, description 72, id 200;
 * button 20); CTA URL button label 20. Header text 60, footer 60, body 1024
 * (4096 for lists).
 */

import type { ApiJsonObject, ApiJsonValue, ParseResult } from './requests';

export const MAX_REPLY_BUTTONS = 3;
export const MAX_LIST_ROWS = 10;
export const MAX_LIST_SECTIONS = 10;

/** Optional text header and footer, shared by the three kinds. */
export interface InteractiveFrame {
	headerText?: string;
	footerText?: string;
}

export interface ReplyButtonInput {
	title?: string;
	/** Defaults to the title, so a reply can be routed on the text the customer tapped. */
	id?: string;
}

export interface ListRowInput {
	title?: string;
	/** Defaults to the title. */
	id?: string;
	description?: string;
	/** Rows sharing a section title are grouped, in the order the sections first appear. */
	section?: string;
}

const trim = (value: unknown): string => (value === undefined || value === null ? '' : String(value).trim());

function frame(type: string, body: string, input: InteractiveFrame): ApiJsonObject {
	const out: ApiJsonObject = { type };
	const header = trim(input.headerText);
	if (header) out.header = { type: 'text', text: header };
	out.body = { text: body };
	const footer = trim(input.footerText);
	if (footer) out.footer = { text: footer };
	return out;
}

function requireBody(body: unknown): ParseResult<string> {
	// Kept as typed (not trimmed): line breaks and spacing are part of the message.
	const text = body === undefined || body === null ? '' : String(body);
	if (!text.trim()) return { ok: false, message: 'Body Text is required' };
	return { ok: true, value: text };
}

export function buildReplyButtons(
	body: unknown,
	buttons: ReplyButtonInput[],
	input: InteractiveFrame = {},
): ParseResult<ApiJsonObject> {
	const text = requireBody(body);
	if (!text.ok) return text;
	if (buttons.length === 0) return { ok: false, message: 'Add at least one button' };
	if (buttons.length > MAX_REPLY_BUTTONS) {
		return { ok: false, message: `WhatsApp allows at most ${MAX_REPLY_BUTTONS} reply buttons (got ${buttons.length})` };
	}
	const seenTitles = new Set<string>();
	const seenIds = new Set<string>();
	const out: ApiJsonValue[] = [];
	for (const [index, button] of buttons.entries()) {
		const title = trim(button.title);
		if (!title) return { ok: false, message: `Button ${index + 1} has no title` };
		const id = trim(button.id) || title;
		if (seenTitles.has(title)) return { ok: false, message: `Two buttons are titled "${title}": WhatsApp needs unique titles` };
		if (seenIds.has(id)) return { ok: false, message: `Two buttons have the ID "${id}": button IDs must be unique` };
		seenTitles.add(title);
		seenIds.add(id);
		out.push({ type: 'reply', reply: { id, title } });
	}
	return { ok: true, value: { ...frame('button', text.value, input), action: { buttons: out } } };
}

export function buildList(
	body: unknown,
	buttonText: unknown,
	rows: ListRowInput[],
	input: InteractiveFrame = {},
): ParseResult<ApiJsonObject> {
	const text = requireBody(body);
	if (!text.ok) return text;
	const button = trim(buttonText);
	if (!button) return { ok: false, message: 'Button Text is required: it is the label that opens the list' };
	if (rows.length === 0) return { ok: false, message: 'Add at least one row' };
	if (rows.length > MAX_LIST_ROWS) {
		return { ok: false, message: `WhatsApp allows at most ${MAX_LIST_ROWS} rows in a list (got ${rows.length})` };
	}

	// Group by section title, keeping first-appearance order. WhatsApp requires a
	// title on every section; rows with no section share one titled after the button.
	const sections = new Map<string, ApiJsonValue[]>();
	const seenIds = new Set<string>();
	for (const [index, row] of rows.entries()) {
		const title = trim(row.title);
		if (!title) return { ok: false, message: `Row ${index + 1} has no title` };
		const id = trim(row.id) || title;
		if (seenIds.has(id)) return { ok: false, message: `Two rows have the ID "${id}": row IDs must be unique` };
		seenIds.add(id);
		const entry: ApiJsonObject = { id, title };
		const description = trim(row.description);
		if (description) entry.description = description;
		const section = trim(row.section) || button;
		const list = sections.get(section) ?? [];
		list.push(entry);
		sections.set(section, list);
	}
	if (sections.size > MAX_LIST_SECTIONS) {
		return { ok: false, message: `WhatsApp allows at most ${MAX_LIST_SECTIONS} sections in a list (got ${sections.size})` };
	}
	return {
		ok: true,
		value: {
			...frame('list', text.value, input),
			action: {
				button,
				sections: [...sections.entries()].map(([title, sectionRows]) => ({ title, rows: sectionRows })),
			},
		},
	};
}

export function buildCtaUrl(
	body: unknown,
	buttonText: unknown,
	url: unknown,
	input: InteractiveFrame = {},
): ParseResult<ApiJsonObject> {
	const text = requireBody(body);
	if (!text.ok) return text;
	const label = trim(buttonText);
	if (!label) return { ok: false, message: 'Button Text is required' };
	const link = trim(url);
	if (!/^https?:\/\/\S+$/i.test(link)) {
		return { ok: false, message: 'URL must be a full http:// or https:// address' };
	}
	return {
		ok: true,
		value: {
			...frame('cta_url', text.value, input),
			action: { name: 'cta_url', parameters: { display_text: label, url: link } },
		},
	};
}
