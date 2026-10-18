/**
 * The WhatsArab public API surface this package uses, in one place so the
 * credential test and the node can never drift apart.
 * Source of truth: the WhatsArab API reference (https://whatsarab.com/docs).
 */

/** Used whenever the credential's Base URL is left empty. */
export const DEFAULT_BASE_URL = 'https://whatsarab.com';

export const NUMBERS_PATH = '/api/numbers';
export const TEMPLATES_PATH = '/api/templates';
export const MESSAGES_PATH = '/api/messages';
/** POST upsert; /{phone} read; /{phone}/tags add; /{phone}/tags/{tag} remove. Scope `send` (read: `read` or `send`). */
export const CONTACTS_PATH = '/api/contacts';
/** GET list, POST subscribe (secret returned once), DELETE /{id} unsubscribe. Scope `full`. */
export const WEBHOOKS_PATH = '/api/webhooks';

/**
 * The same base-URL rule as an n8n expression, for places that only accept
 * expressions (the credential test): empty → DEFAULT_BASE_URL, trailing
 * slashes stripped. Must stay equivalent to joinUrl() in requests.ts.
 */
export const BASE_URL_EXPRESSION = `={{ String($credentials.baseUrl || "${DEFAULT_BASE_URL}").replace(/\\/{1,256}$/, "") }}`;
