import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { MESSAGES_PATH, NUMBERS_PATH, TEMPLATES_PATH } from './api';
import {
	addContactTagRequest,
	type ApiRequest,
	type ConsentChoice,
	type CustomFieldInput,
	getContactRequest,
	removeContactTagRequest,
	upsertContactRequest,
} from './contacts';
import {
	type ApiJsonObject,
	type ApiNumber,
	type ApiTemplate,
	buildSendTemplateBody,
	buildSendTextBody,
	numberOptionName,
	parseComponentsJson,
	type ParseResult,
	type Recipient,
	type RecipientType,
	templateOptions,
} from './requests';
import { whatsArabRequest } from './transport';

/** Contact resource fields (POST/GET /api/contacts..., API key scope `send`). */
const contactProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['contact'] } },
		options: [
			{
				name: 'Add Tag',
				value: 'addTag',
				description:
					'Tag a contact as an agent would in the inbox: tag rules, tag-triggered flows and sequences, and the Tag Added webhook event all run',
				action: 'Add a tag to a contact',
			},
			{
				name: 'Create or Update',
				value: 'upsert',
				description: 'Create a new record, or update the current one if it already exists (upsert)',
				action: 'Create or update a contact',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Read one contact by phone number',
				action: 'Get a contact',
			},
			{
				name: 'Remove Tag',
				value: 'removeTag',
				description: 'Remove a tag from the contact and from every one of its conversations that carries it',
				action: 'Remove a tag from a contact',
			},
		],
		default: 'upsert',
	},
	{
		displayName: 'Phone Number',
		name: 'phone',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['contact'] } },
		default: '',
		placeholder: '201000000001',
		description:
			'International format with country code. Spaces, dashes, a leading + or 00 and Arabic digits are cleaned automatically.',
	},
	{
		displayName: 'Tag',
		name: 'tag',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['contact'], operation: ['addTag', 'removeTag'] } },
		default: '',
		placeholder: 'lead',
		description:
			'Normalized like every tag in WhatsArab (at most 40 characters once normalized). Adding a tag the contact already has, or removing one it does not have, succeeds and changes nothing.',
	},
	{
		displayName: 'Number Name or ID',
		name: 'from',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getNumbers' },
		displayOptions: { show: { resource: ['contact'], operation: ['upsert', 'addTag'] } },
		default: '',
		description:
			'Create or Update: whose audience the contact joins (audiences are only added, never removed). Add Tag: whose conversation with the customer gets the tag (Workspace Default: their most recent one). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		displayOptions: { show: { resource: ['contact'], operation: ['upsert'] } },
		default: {},
		options: [
			{
				displayName: 'Consent',
				name: 'consent',
				type: 'options',
				options: [
					{
						name: 'Leave Unchanged',
						value: 'unchanged',
					},
					{
						name: 'Opt In (Record Consent)',
						value: 'optIn',
						description:
							'Records consent only on a contact that is not opted out. It never lifts an opt-out: a customer who opted out, or a block your team set, stays opted out (opted_out in the output says so).',
					},
					{
						name: 'Opt Out',
						value: 'optOut',
						description:
							'Opts the contact out. The API cannot lift an opt-out again; that is done deliberately in the WhatsArab dashboard.',
					},
				],
				default: 'unchanged',
				description: 'Opt-out is one-way through the API: it can be set, never lifted',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				description: 'Display name, 1 to 120 characters. Left empty, the current name is kept.',
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				placeholder: 'lead, vip',
				description:
					'Comma-separated, up to 20. Tags are added to the ones the contact already has, never replacing them; use Remove Tag to take one off.',
			},
		],
	},
	{
		displayName: 'Custom Fields',
		name: 'customFields',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		displayOptions: { show: { resource: ['contact'], operation: ['upsert'] } },
		default: {},
		placeholder: 'Add Custom Field',
		description:
			"Merged into the contact's custom fields key by key, up to 50 keys per call. Keys you do not list keep their value; Type Remove Field deletes a key.",
		options: [
			{
				displayName: 'Field',
				name: 'field',
				values: [
					{
						displayName: 'Key',
						name: 'key',
						type: 'string',
						default: '',
						placeholder: 'city',
						description: 'Custom field key, 1 to 64 characters',
					},
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						options: [
							{
								name: 'Boolean',
								value: 'boolean',
								description: 'Value must be true or false',
							},
							{
								name: 'Number',
								value: 'number',
							},
							{
								name: 'Remove Field',
								value: 'remove',
								description: 'Delete this key from the contact (sent as null). Value is ignored.',
							},
							{
								name: 'Text',
								value: 'string',
								description: 'Up to 1000 characters',
							},
						],
						default: 'string',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'Ignored when Type is Remove Field',
					},
				],
			},
		],
	},
];

export class WhatsArab implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'WhatsArab',
		name: 'whatsArab',
		icon: { light: 'file:../../icons/whatsarab.svg', dark: 'file:../../icons/whatsarab.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send WhatsApp messages and manage contacts through the WhatsArab API',
		defaults: {
			name: 'WhatsArab',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'whatsArabApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Contact',
						value: 'contact',
					},
					{
						name: 'Message',
						value: 'message',
					},
				],
				default: 'message',
			},
			...contactProperties,
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{
						name: 'Send Template',
						value: 'sendTemplate',
						description: 'Send an approved template. Works outside the 24-hour window.',
						action: 'Send a template message',
					},
					{
						name: 'Send Text',
						value: 'sendText',
						description: "Send free-form text. Only delivered inside the customer's 24-hour window.",
						action: 'Send a text message',
					},
				],
				default: 'sendText',
			},
			{
				displayName: 'From Number Name or ID',
				name: 'from',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getNumbers' },
				displayOptions: { show: { resource: ['message'] } },
				default: '',
				description:
					'Which of your WhatsArab numbers sends. Leave on Workspace Default to let WhatsArab choose. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Recipient Type',
				name: 'recipientType',
				type: 'options',
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{
						name: 'Phone Number',
						value: 'phone',
					},
					{
						name: 'WhatsApp User ID',
						value: 'userId',
						description:
							'For a customer who wrote with a WhatsApp username and no phone: the fromUserId of a Message Received event',
					},
				],
				default: 'phone',
			},
			{
				displayName: 'Phone Number',
				name: 'phone',
				type: 'string',
				required: true,
				displayOptions: { show: { resource: ['message'], recipientType: ['phone'] } },
				default: '',
				placeholder: '201000000001',
				description:
					'International format with country code. Spaces, dashes, a leading + or 00 and Arabic digits are cleaned automatically.',
			},
			{
				displayName: 'WhatsApp User ID',
				name: 'userId',
				type: 'string',
				required: true,
				displayOptions: { show: { resource: ['message'], recipientType: ['userId'] } },
				default: '',
				placeholder: 'EG.13491208655302741918',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				required: true,
				typeOptions: { rows: 4 },
				displayOptions: { show: { resource: ['message'], operation: ['sendText'] } },
				default: '',
				description: 'Message body, up to 4096 characters',
			},
			{
				displayName: 'Template Name or ID',
				name: 'template',
				type: 'options',
				required: true,
				typeOptions: { loadOptionsMethod: 'getTemplates', loadOptionsDependsOn: ['from'] },
				displayOptions: { show: { resource: ['message'], operation: ['sendTemplate'] } },
				default: '',
				description:
					`An approved template on the sending number's WhatsApp Business Account. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.`,
			},
			{
				displayName: 'Language',
				name: 'language',
				type: 'string',
				required: true,
				displayOptions: { show: { resource: ['message'], operation: ['sendTemplate'] } },
				default: 'en',
				placeholder: 'ar',
				description: 'Language code of one approved language of the template, for example ar or en',
			},
			{
				displayName: 'Body Parameters',
				name: 'bodyParameters',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				displayOptions: { show: { resource: ['message'], operation: ['sendTemplate'] } },
				default: {},
				placeholder: 'Add Parameter',
				description: 'Values for the template body placeholders, in order: the first fills {{1}}, the second {{2}}',
				options: [
					{
						displayName: 'Parameter',
						name: 'parameter',
						values: [
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				displayOptions: { show: { resource: ['message'] } },
				default: {},
				options: [
					{
						displayName: 'Components (JSON)',
						name: 'components',
						type: 'json',
						default: '',
						displayOptions: { show: { '/operation': ['sendTemplate'] } },
						description:
							'Full template components array (header, body and button parameters) in WhatsApp format. When set, it replaces Body Parameters.',
					},
					{
						displayName: 'Dry Run',
						name: 'dryRun',
						type: 'boolean',
						default: false,
						description:
							'Whether to only validate the request. Nothing is sent and no quota is used; for text the response says whether the 24-hour window is open.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getNumbers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await whatsArabRequest.call(this, 'GET', NUMBERS_PATH);
				const numbers = (Array.isArray(response.data) ? response.data : []) as ApiNumber[];
				return [
					{ name: 'Workspace Default', value: '' },
					...numbers.map((n) => ({ name: numberOptionName(n), value: n.id })),
				];
			},
			async getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const from = String(this.getCurrentNodeParameter('from') ?? '').trim();
				const response = await whatsArabRequest.call(
					this,
					'GET',
					TEMPLATES_PATH,
					undefined,
					from ? { from } : undefined,
				);
				const templates = (Array.isArray(response.data) ? response.data : []) as ApiTemplate[];
				return templateOptions(templates);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			let request: ApiRequest;
			try {
				request = buildRequest(this, i);
			} catch (error) {
				const nodeError = new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				if (this.continueOnFail()) {
					returnData.push({ json: { error: nodeError.message }, pairedItem: { item: i } });
					continue;
				}
				throw nodeError;
			}

			try {
				const response = await whatsArabRequest.call(this, request.method, request.path, request.body);
				const data = (response.data ?? response) as IDataObject;
				returnData.push({ json: data, pairedItem: { item: i } });
			} catch (error) {
				const apiError = new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
				if (this.continueOnFail()) {
					returnData.push({ json: { error: apiError.message }, pairedItem: { item: i } });
					continue;
				}
				throw apiError;
			}
		}

		return [returnData];
	}
}

/** A builder's refusal becomes a NodeOperationError on the item. */
function unwrap(ctx: IExecuteFunctions, i: number, result: ParseResult<ApiRequest>): ApiRequest {
	if (!result.ok) throw new NodeOperationError(ctx.getNode(), result.message, { itemIndex: i });
	return result.value;
}

/** Reads the node's parameters for item `i` and builds the API request. */
function buildRequest(ctx: IExecuteFunctions, i: number): ApiRequest {
	const resource = ctx.getNodeParameter('resource', i) as string;
	if (resource === 'contact') return buildContactRequest(ctx, i);
	return { method: 'POST', path: MESSAGES_PATH, body: buildMessageBody(ctx, i) };
}

/** The Contact operation values declared in contactProperties. */
type ContactOperation = 'upsert' | 'get' | 'addTag' | 'removeTag';

function buildContactRequest(ctx: IExecuteFunctions, i: number): ApiRequest {
	const operation = ctx.getNodeParameter('operation', i) as ContactOperation;
	const phone = ctx.getNodeParameter('phone', i) as string;

	switch (operation) {
		case 'upsert': {
			const fields = ctx.getNodeParameter('updateFields', i, {}) as {
				name?: string;
				tags?: string;
				consent?: ConsentChoice;
			};
			return unwrap(
				ctx,
				i,
				upsertContactRequest({
					phone,
					name: fields.name,
					tags: fields.tags,
					consent: fields.consent,
					customFields: ctx.getNodeParameter('customFields.field', i, []) as CustomFieldInput[],
					from: ctx.getNodeParameter('from', i, '') as string,
				}),
			);
		}
		case 'get':
			return unwrap(ctx, i, getContactRequest(phone));
		case 'addTag':
			return unwrap(
				ctx,
				i,
				addContactTagRequest(
					phone,
					ctx.getNodeParameter('tag', i) as string,
					ctx.getNodeParameter('from', i, '') as string,
				),
			);
		case 'removeTag':
			return unwrap(ctx, i, removeContactTagRequest(phone, ctx.getNodeParameter('tag', i) as string));
		default: {
			// Compile-time exhaustiveness: a new ContactOperation without a case fails to build.
			const unsupported: never = operation;
			throw new NodeOperationError(ctx.getNode(), `Unsupported operation "${String(unsupported)}"`, {
				itemIndex: i,
			});
		}
	}
}

/** Reads the node's parameters for item `i` and builds the POST /api/messages body. */
function buildMessageBody(ctx: IExecuteFunctions, i: number): ApiJsonObject {
	const operation = ctx.getNodeParameter('operation', i) as string;
	const recipientType = ctx.getNodeParameter('recipientType', i) as RecipientType;
	const recipient: Recipient = {
		type: recipientType,
		value: ctx.getNodeParameter(recipientType === 'userId' ? 'userId' : 'phone', i) as string,
	};
	const from = ctx.getNodeParameter('from', i, '') as string;
	const options = ctx.getNodeParameter('options', i, {}) as { components?: unknown; dryRun?: boolean };
	const common = { from, dryRun: options.dryRun === true };

	if (operation === 'sendText') {
		return buildSendTextBody(recipient, ctx.getNodeParameter('text', i) as string, common);
	}
	if (operation === 'sendTemplate') {
		const params = ctx.getNodeParameter('bodyParameters.parameter', i, []) as Array<{ value: string }>;
		const components = parseComponentsJson(options.components);
		if (!components.ok) {
			throw new NodeOperationError(ctx.getNode(), components.message, { itemIndex: i });
		}
		return buildSendTemplateBody(
			recipient,
			{
				name: ctx.getNodeParameter('template', i) as string,
				language: ctx.getNodeParameter('language', i) as string,
				bodyParameters: params.map((p) => p.value),
				components: components.value,
			},
			common,
		);
	}
	throw new NodeOperationError(ctx.getNode(), `Unsupported operation "${operation}"`, { itemIndex: i });
}
