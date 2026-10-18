import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IHookFunctions,
	INodeCredentialTestResult,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { WEBHOOKS_PATH } from '../WhatsArab/api';
import { apiErrorInfo, isScopeRefusal } from '../WhatsArab/apiErrors';
import { whatsArabRequest } from '../WhatsArab/transport';
import { eventPasses, WHATSARAB_EVENTS } from './events';
import { DEFAULT_TOLERANCE_SECONDS, verifySignature } from './signature';
import {
	type ApiSubscription,
	clearSlot,
	readSlot,
	subscriptionEvents,
	subscriptionLabel,
	subscriptionMatches,
	type SubscriptionStaticData,
	writeSlot,
} from './subscription';

/** The shape WhatsArab gives every subscription secret. */
export const SECRET_FORMAT = /^whsec_[0-9a-f]{64}$/;

/**
 * The node's Subscription setting: 'api' = the node subscribes itself through
 * /api/webhooks; 'dashboard' = the user made the subscription in WhatsArab.
 * (Named apart from n8n's own execution mode 'manual', which isTestMode reads.)
 */
export type SubscriptionMode = 'api' | 'dashboard';

/**
 * The saved parameter → SubscriptionMode. Pre-release builds saved
 * 'automatic' / 'manual'; those still resolve (and the credential
 * displayOptions list them too, so n8n still hands the right credential over).
 */
export function subscriptionModeOf(value: unknown): SubscriptionMode {
	return value === 'dashboard' || value === 'manual' ? 'dashboard' : 'api';
}

/** Shown in Automatic mode. */
export const AUTOMATIC_NOTICE =
	'This trigger subscribes itself in WhatsArab when the workflow is activated (or while it listens for a test event) and deletes the subscription when it is deactivated. It needs an API key with the "full" scope, and n8n must be reachable at a public https:// URL. Deliveries without a valid signature are rejected with 401.';

/** Shown in Manual mode: the user registers this node's URL in the dashboard. */
export const SETUP_NOTICE =
	"Manual mode: copy the Production URL above, then in WhatsArab open Developers → Webhooks, add a subscription with that URL and the events you want, and paste the signing secret it shows (once) into this node's credential. Deliveries without a valid signature are rejected with 401, and signed deliveries that are not a WhatsArab event object with 400.";

/** Raised when the API key's scope is too low to manage webhook subscriptions (403 INSUFFICIENT_SCOPE). */
export const SCOPE_MESSAGE = 'This WhatsArab API key cannot manage webhooks: automatic subscription needs the "full" scope';
export const SCOPE_DESCRIPTION =
	'Use an API key with the "full" scope (WhatsArab → Developers → API keys), or set Subscription to "Manual (Signing Secret)", add the subscription in WhatsArab yourself and paste its signing secret.';

/** Added to a refused create when WhatsArab rejected the input (most often the URL). */
export const URL_HINT =
	'WhatsArab only delivers to a public https:// URL. An n8n on localhost or a private address cannot receive WhatsArab webhooks: set n8n\'s WEBHOOK_URL to a public HTTPS address (for example through a tunnel).';

/** A signed body must still be what WhatsArab sends: a JSON object with a string `event`. */
export function isWhatsArabDelivery(body: unknown): body is IDataObject & { event: string } {
	return (
		typeof body === 'object' &&
		body !== null &&
		!Array.isArray(body) &&
		typeof (body as { event?: unknown }).event === 'string' &&
		(body as { event: string }).event.length > 0
	);
}

function modeOf(ctx: IHookFunctions | IWebhookFunctions): SubscriptionMode {
	return subscriptionModeOf(ctx.getNodeParameter('subscriptionMode', 'api'));
}

function staticDataOf(ctx: IHookFunctions | IWebhookFunctions): SubscriptionStaticData {
	return ctx.getWorkflowStaticData('node') as SubscriptionStaticData;
}

/** n8n runs test-event listening (and its deliveries) in mode "manual"; production is anything else. */
function isTestMode(ctx: IHookFunctions | IWebhookFunctions): boolean {
	return typeof ctx.getMode === 'function' && ctx.getMode() === 'manual';
}

/** Scope refusals become one clear message; anything else keeps WhatsArab's own error. */
function subscriptionError(ctx: IHookFunctions, error: unknown, action: string): Error {
	if (isScopeRefusal(error)) {
		return new NodeOperationError(ctx.getNode(), SCOPE_MESSAGE, { description: SCOPE_DESCRIPTION });
	}
	const info = apiErrorInfo(error);
	if (info.status === undefined && info.code === undefined) {
		// Not an HTTP answer (network, DNS...): n8n's own wrapping says it best.
		return new NodeApiError(ctx.getNode(), error as JsonObject);
	}
	// A NodeOperationError, not NodeApiError: n8n hands NodeApiErrors back
	// unchanged when re-wrapped, which would drop this message.
	const parts = [info.message, info.code === 'INVALID_INPUT' ? URL_HINT : undefined].filter(Boolean);
	return new NodeOperationError(
		ctx.getNode(),
		`WhatsArab refused to ${action} the webhook subscription (${info.code ?? `HTTP ${info.status}`})`,
		{ description: parts.join(' ') || undefined },
	);
}

async function deleteRemote(ctx: IHookFunctions, id: string): Promise<boolean> {
	try {
		await whatsArabRequest.call(ctx, 'DELETE', `${WEBHOOKS_PATH}/${encodeURIComponent(id)}`);
		return true;
	} catch (error) {
		const info = apiErrorInfo(error);
		// Already gone (deleted in the dashboard): that is what we wanted.
		if (info.status === 404) return true;
		// n8n only gets `false` back from a webhook method, so say why here.
		const reason =
			[info.code ?? (info.status ? `HTTP ${info.status}` : undefined), info.message ?? (error as Error)?.message]
				.filter(Boolean)
				.join(': ') || 'unknown error';
		ctx.logger.warn(
			`WhatsArab Trigger: could not delete webhook subscription ${id} (${reason}). If it is still listed in WhatsArab → Developers → Webhooks, delete it there.`,
			{ webhookId: id, status: info.status, code: info.code },
		);
		return false;
	}
}

export class WhatsArabTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'WhatsArab Trigger',
		name: 'whatsArabTrigger',
		icon: { light: 'file:../../icons/whatsarab.svg', dark: 'file:../../icons/whatsarab.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].length ? $parameter["events"].join(", ") : "All events"}}',
		description: 'Starts the workflow when WhatsArab delivers a signed webhook event',
		defaults: {
			name: 'WhatsArab Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'whatsArabApi',
				required: true,
				displayOptions: { show: { subscriptionMode: ['api', 'automatic'] } },
			},
			{
				name: 'whatsArabWebhookApi',
				required: true,
				testedBy: 'whatsArabWebhookSecretTest',
				displayOptions: { show: { subscriptionMode: ['dashboard', 'manual'] } },
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Subscription',
				name: 'subscriptionMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Automatic (API Key)',
						value: 'api',
						description:
							'Subscribe through the WhatsArab API on activation and unsubscribe on deactivation. Needs an API key with the "full" scope.',
					},
					{
						name: 'Manual (Signing Secret)',
						value: 'dashboard',
						description:
							'Add the subscription in the WhatsArab dashboard yourself and paste its signing secret. For API keys without the "full" scope.',
					},
				],
				default: 'api',
			},
			{
				displayName: AUTOMATIC_NOTICE,
				name: 'automaticNotice',
				type: 'notice',
				displayOptions: { show: { subscriptionMode: ['api', 'automatic'] } },
				default: '',
			},
			{
				displayName: SETUP_NOTICE,
				name: 'setupNotice',
				type: 'notice',
				displayOptions: { show: { subscriptionMode: ['dashboard', 'manual'] } },
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: [...WHATSARAB_EVENTS],
				default: [],
				description:
					'Only start the workflow for these events. Automatic mode subscribes to exactly these (empty: every event). Manual mode filters what your subscription sends (empty: accept all).',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Replay Window (Seconds)',
						name: 'toleranceSeconds',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: DEFAULT_TOLERANCE_SECONDS,
						description:
							'Reject deliveries whose signed timestamp is further than this from now. 0 turns the check off (not recommended).',
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			async whatsArabWebhookSecretTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const secret = String(credential.data?.secret ?? '').trim();
				if (SECRET_FORMAT.test(secret)) {
					return { status: 'OK', message: 'The secret has the expected WhatsArab format' };
				}
				return {
					status: 'Error',
					message: 'A WhatsArab signing secret starts with whsec_ followed by 64 hex characters',
				};
			},
		},
	};

	/**
	 * Automatic mode: REST-hook lifecycle against /api/webhooks (scope `full`).
	 * The subscription id and its once-returned signing secret live in the
	 * node's static data. Manual mode registers nothing: the user created the
	 * subscription in the dashboard.
	 */
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				if (modeOf(this) === 'dashboard') return true;
				const data = staticDataOf(this);
				const test = isTestMode(this);
				const slot = readSlot(data, test);
				if (!slot.id) return false;

				let rows: ApiSubscription[];
				try {
					const response = await whatsArabRequest.call(this, 'GET', WEBHOOKS_PATH);
					rows = (Array.isArray(response.data) ? response.data : []) as ApiSubscription[];
				} catch (error) {
					throw subscriptionError(this, error, 'list');
				}

				const url = this.getNodeWebhookUrl('default') ?? '';
				const events = subscriptionEvents(this.getNodeParameter('events', []) as string[]);
				const existing = rows.find((row) => row.id === slot.id);
				if (existing && slot.secret && subscriptionMatches(existing, url, events)) return true;

				// Stale (other URL, other events, switched off, or no secret to verify
				// with): remove ours so create() replaces it instead of leaving an orphan.
				if (existing) await deleteRemote(this, slot.id);
				clearSlot(data, test);
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				if (modeOf(this) === 'dashboard') return true;
				const url = this.getNodeWebhookUrl('default') ?? '';
				const workflow = this.getWorkflow();
				const body: IDataObject = {
					label: subscriptionLabel(workflow.name, workflow.id),
					url,
					events: subscriptionEvents(this.getNodeParameter('events', []) as string[]),
				};

				let response: IDataObject;
				try {
					response = await whatsArabRequest.call(this, 'POST', WEBHOOKS_PATH, body);
				} catch (error) {
					throw subscriptionError(this, error, 'create');
				}

				const created = (response.data ?? {}) as IDataObject;
				const id = typeof created.id === 'string' ? created.id : '';
				const secret = typeof created.secret === 'string' ? created.secret : '';
				if (!id || !secret) {
					// Nothing usable is stored, so a subscription left behind here is an
					// orphan that only the dashboard can remove: make it visible.
					if (!id) {
						this.logger.warn(
							`WhatsArab Trigger: the subscription for ${url} came back without an id, so it could not be removed. Check WhatsArab → Developers → Webhooks for an orphaned subscription.`,
							{ url },
						);
					} else if (!(await deleteRemote(this, id))) {
						this.logger.warn(
							`WhatsArab Trigger: orphaned webhook subscription ${id} (created without a signing secret, cleanup failed). Delete it in WhatsArab → Developers → Webhooks.`,
							{ webhookId: id, url },
						);
					}
					throw new NodeOperationError(
						this.getNode(),
						'WhatsArab created the subscription but did not return its id and signing secret',
					);
				}
				writeSlot(staticDataOf(this), isTestMode(this), id, secret);
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				if (modeOf(this) === 'dashboard') return true;
				const data = staticDataOf(this);
				const test = isTestMode(this);
				const slot = readSlot(data, test);
				if (slot.id && !(await deleteRemote(this, slot.id))) return false;
				clearSlot(data, test);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		if (!req.rawBody && typeof req.readRawBody === 'function') {
			await req.readRawBody();
		}
		const headers = this.getHeaderData();
		const options = this.getNodeParameter('options', {}) as { toleranceSeconds?: number };

		// Automatic: the secret WhatsArab returned when this node subscribed
		// (the test-event subscription's while the editor listens).
		// Manual: the secret the user pasted into the credential.
		const secret =
			modeOf(this) === 'dashboard'
				? String((await this.getCredentials('whatsArabWebhookApi')).secret ?? '')
				: String(readSlot(staticDataOf(this), isTestMode(this)).secret ?? '');

		const check = verifySignature({
			secret,
			rawBody: req.rawBody ?? '',
			signatureHeader: headers['x-whatsarab-signature'],
			timestampHeader: headers['x-whatsarab-timestamp'],
			toleranceSeconds: options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
		});
		if (!check.valid) {
			const res = this.getResponseObject();
			res.status(401).json({ error: 'invalid_signature', reason: check.reason });
			return { noWebhookResponse: true };
		}

		const body: unknown = this.getBodyData();
		if (!isWhatsArabDelivery(body)) {
			const res = this.getResponseObject();
			res.status(400).json({ error: 'invalid_body', reason: 'expected a JSON object with a string "event"' });
			return { noWebhookResponse: true };
		}
		const events = this.getNodeParameter('events', []) as string[];
		if (!eventPasses(events, body.event)) {
			return { webhookResponse: { received: true, ignored: true } };
		}

		const item: IDataObject = {
			event: body.event,
			deliveryId: body.deliveryId,
			webhookId: body.webhookId,
			timestamp: body.timestamp,
			data: body.data,
		};
		return { workflowData: [this.helpers.returnJsonArray([item])] };
	}
}
