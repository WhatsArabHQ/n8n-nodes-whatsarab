/**
 * Reading a failed WhatsArab API call, whatever shape n8n hands it over in.
 *
 * WhatsArab answers errors as `{ success: false, error: { code, message } }`
 * with the HTTP status. Depending on the n8n version and helper, the thrown
 * value is a NodeApiError (status in `httpCode`, body in `context.data`), an
 * Axios-style error (`response.status`, `response.data`) or one wrapping the
 * other in `cause`. This module looks in all of them.
 */

export interface ApiErrorInfo {
	/** HTTP status, when one could be found. */
	status?: number;
	/** WhatsArab error code from the body, e.g. INSUFFICIENT_SCOPE. */
	code?: string;
	/** WhatsArab error message from the body. */
	message?: string;
	/** Where the owner subscribes: sent with PLAN_REQUIRED (402, a stopped workspace). */
	manageUrl?: string;
}

type Loose = { [key: string]: unknown };

function asObject(value: unknown): Loose | undefined {
	return typeof value === 'object' && value !== null ? (value as Loose) : undefined;
}

function asStatus(value: unknown): number | undefined {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

function bodyError(raw: unknown): { code?: string; message?: string; manageUrl?: string } {
	// A binary download (GET /api/media/{id}) fails with its JSON error body as bytes.
	let body: unknown = raw;
	if (body instanceof ArrayBuffer) body = Buffer.from(body);
	if (Buffer.isBuffer(body)) body = body.toString('utf8');
	let parsed: unknown = body;
	if (typeof body === 'string') {
		try {
			parsed = JSON.parse(body);
		} catch {
			return {};
		}
	}
	const err = asObject(asObject(parsed)?.error);
	if (!err) return {};
	return {
		code: typeof err.code === 'string' ? err.code : undefined,
		message: typeof err.message === 'string' ? err.message : undefined,
		manageUrl: typeof err.manage_url === 'string' && /^https:\/\//.test(err.manage_url) ? err.manage_url : undefined,
	};
}

export function apiErrorInfo(error: unknown): ApiErrorInfo {
	const info: ApiErrorInfo = {};
	const seen = new Set<unknown>();
	let current = asObject(error);
	// Walk the error and its `cause` chain (bounded: a cycle must not hang a hook).
	for (let depth = 0; current && depth < 5 && !seen.has(current); depth++) {
		seen.add(current);
		const response = asObject(current.response);
		const status =
			asStatus(current.httpCode) ??
			asStatus(current.statusCode) ??
			asStatus(response?.status) ??
			asStatus(response?.statusCode) ??
			asStatus(current.status);
		if (info.status === undefined && status !== undefined) info.status = status;
		for (const body of [asObject(current.context)?.data, response?.data, response?.body, current.error]) {
			const fromBody = bodyError(body);
			if (info.code === undefined && fromBody.code !== undefined) info.code = fromBody.code;
			if (info.message === undefined && fromBody.message !== undefined) info.message = fromBody.message;
			if (info.manageUrl === undefined && fromBody.manageUrl !== undefined) info.manageUrl = fromBody.manageUrl;
		}
		current = asObject(current.cause);
	}
	return info;
}

/**
 * A stopped workspace (402 PLAN_REQUIRED: its free period or subscription
 * ended with no plan) answers every call this way. WhatsArab's message says
 * why; this adds what to do, with the owner's subscribe link when it came.
 */
export function planRequiredHint(info: ApiErrorInfo): string {
	if (info.code !== 'PLAN_REQUIRED') return '';
	const where = info.manageUrl ? `at ${info.manageUrl}` : 'in WhatsArab → Settings → Billing';
	return `The workspace owner can choose a plan ${where}. The API key and this workflow keep working the moment the workspace subscribes: nothing needs to change in n8n.`;
}

/**
 * True when WhatsArab refused the call because the API key's scope is too
 * low (403 INSUFFICIENT_SCOPE). A 403 with another code (NUMBER_NOT_ALLOWED
 * for a key restricted to numbers) is NOT a scope refusal. A bare 403 whose
 * body n8n did not keep counts as one: on /api/webhooks (the only place this
 * is asked) the node never sends the field that could cause another 403.
 */
export function isScopeRefusal(error: unknown): boolean {
	const info = apiErrorInfo(error);
	if (info.code) return info.code === 'INSUFFICIENT_SCOPE';
	return info.status === 403;
}
