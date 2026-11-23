/**
 * Pure helpers for the trigger's automatic subscription (REST hooks):
 *
 *   activate   → POST   /api/webhooks { label, url, events }  → { id, secret }
 *   deactivate → DELETE /api/webhooks/{id}
 *   check      → GET    /api/webhooks (find our id)
 *
 * All three need an API key with the `full` scope. The secret comes back
 * ONCE, in the create response; the node keeps it in its static data and
 * verifies every delivery with it.
 */

import { WHATSARAB_EVENTS } from './events';

/**
 * What the trigger keeps in `getWorkflowStaticData('node')` while subscribed.
 * Two slots: the production subscription (active workflow) and the one made
 * while the editor listens for a test event, so testing an active workflow
 * never replaces or deletes its production subscription.
 */
export interface SubscriptionStaticData {
	webhookId?: string;
	webhookSecret?: string;
	/** The URL the production subscription delivers to (see isTestHook). */
	webhookUrl?: string;
	testWebhookId?: string;
	testWebhookSecret?: string;
	/** The URL the test subscription delivers to (see isTestHook). */
	testWebhookUrl?: string;
}

export interface SubscriptionSlot {
	id?: string;
	secret?: string;
}

export function readSlot(data: SubscriptionStaticData, test: boolean): SubscriptionSlot {
	return test
		? { id: data.testWebhookId, secret: data.testWebhookSecret }
		: { id: data.webhookId, secret: data.webhookSecret };
}

export function writeSlot(
	data: SubscriptionStaticData,
	test: boolean,
	id: string,
	secret: string,
	url?: string,
): void {
	if (test) {
		data.testWebhookId = id;
		data.testWebhookSecret = secret;
		if (url) data.testWebhookUrl = url;
		else delete data.testWebhookUrl;
	} else {
		data.webhookId = id;
		data.webhookSecret = secret;
		if (url) data.webhookUrl = url;
		else delete data.webhookUrl;
	}
}

/**
 * n8n's DEFAULT path for test webhooks. Best effort only: it serves just the
 * subscriptions stored by 0.2.2 (no URL kept), and misses an n8n that changed
 * N8N_ENDPOINT_WEBHOOK_TEST. Every subscription made from 0.2.3 on keeps its
 * URL and never reaches this fallback.
 */
const N8N_TEST_PATH = /\/webhook-test\//;

/**
 * Whether this hook call is about the test-event subscription.
 *
 * n8n CREATES the test subscription in mode "manual", but TEARS IT DOWN in
 * mode "internal" (cli test-webhooks.ts deactivateWebhooks →
 * deleteWebhook(..., 'internal', 'update')). The mode alone therefore sent the
 * teardown to the PRODUCTION slot: it deleted the active workflow's
 * subscription and left the test one behind, delivering to a test URL that
 * n8n no longer serves (404) until WhatsArab switched it off. Seen live Nov 2026.
 *
 * The hook's URL is the reliable signal: n8n builds it from the webhook's own
 * isTest flag in every mode. So: "manual" mode, or the URL the test slot
 * subscribed, is the test subscription; the production slot's URL is
 * production. Subscriptions stored before the URL was kept fall back to n8n's
 * default test path.
 */
export function isTestHook(data: SubscriptionStaticData, mode: string | undefined, url: string): boolean {
	if (mode === 'manual') return true;
	if (url && data.testWebhookUrl === url) return true;
	if (url && data.webhookUrl === url) return false;
	return N8N_TEST_PATH.test(url);
}

/** One row of GET /api/webhooks (the fields the trigger reads). */
export interface ApiSubscription {
	id?: string;
	url?: string;
	events?: unknown;
	active?: boolean;
}

const ALL_EVENTS: string[] = WHATSARAB_EVENTS.map((e) => e.value);

/**
 * The node's Events filter → the subscription's events list. The API needs at
 * least one event, so an empty filter ("every event") subscribes to all of them.
 */
export function subscriptionEvents(filter: readonly string[] | undefined): string[] {
	const picked = (filter ?? []).filter((e) => typeof e === 'string' && e.length > 0);
	if (picked.length === 0) return [...ALL_EVENTS];
	return [...new Set(picked)];
}

/** Shown in the WhatsArab dashboard next to the subscription (the API caps labels at 120 characters). */
export function subscriptionLabel(workflowName: string | undefined, workflowId: string | undefined): string {
	const name = String(workflowName ?? '').trim() || (workflowId ? `workflow ${workflowId}` : 'workflow');
	return `n8n: ${name}`.slice(0, 120);
}

function sameEvents(a: unknown, b: readonly string[]): boolean {
	if (!Array.isArray(a)) return false;
	const left = new Set(a.map(String));
	return left.size === new Set(b).size && b.every((e) => left.has(e));
}

/**
 * Whether an existing subscription still serves this node as is: same URL,
 * same events, and switched on. WhatsArab switches a subscription off after
 * repeated failed deliveries (an n8n that was down, say); re-activating the
 * workflow then replaces it with a fresh one instead of staying silent.
 */
export function subscriptionMatches(sub: ApiSubscription | undefined, url: string, events: readonly string[]): boolean {
	return !!sub && sub.url === url && sub.active !== false && sameEvents(sub.events, events);
}

export function clearSlot(data: SubscriptionStaticData, test: boolean): void {
	if (test) {
		delete data.testWebhookId;
		delete data.testWebhookSecret;
		delete data.testWebhookUrl;
	} else {
		delete data.webhookId;
		delete data.webhookSecret;
		delete data.webhookUrl;
	}
}
