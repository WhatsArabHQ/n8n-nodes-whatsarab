import { randomBytes } from 'crypto';
import type {
	IBinaryData,
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { MEDIA_PATH, MESSAGES_PATH, NUMBERS_PATH, TEMPLATES_PATH } from './api';
import { apiErrorInfo } from './apiErrors';
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
	buildCtaUrl,
	buildList,
	buildReplyButtons,
	type InteractiveFrame,
	type ListRowInput,
	type ReplyButtonInput,
} from './interactive';
import {
	bareMimeType,
	buildMultipart,
	checkMediaId,
	checkMediaSize,
	fileNameFromUrl,
	MAX_MEDIA_BYTES,
	mediaFileName,
	type MultipartFile,
} from './media';
import {
	contactProperties,
	mediaProperties,
	messageProperties,
	numberProperties,
	templateProperties,
} from './properties';
import {
	type ApiJsonObject,
	type ApiNumber,
	type ApiTemplate,
	buildSendInteractiveBody,
	buildSendMediaBody,
	buildSendTemplateBody,
	buildSendTextBody,
	type CommonSendOptions,
	type MediaKind,
	numberOptionName,
	parseComponentsJson,
	type ParseResult,
	type Recipient,
	type RecipientType,
	templateOptions,
} from './requests';
import { type RawRequest, whatsArabRawRequest, whatsArabRequest } from './transport';

export class WhatsArab implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'WhatsArab',
		name: 'whatsArab',
		icon: { light: 'file:../../icons/whatsarab.svg', dark: 'file:../../icons/whatsarab.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		// Shown wherever this node stands alone (the AI-tool picker, the tool's default
		// description). In the node search n8n shows the TRIGGER's description for the pair.
		description:
			'Send WhatsApp messages, media, buttons, lists and templates, and manage contacts and tags with WhatsArab',
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
						name: 'Media',
						value: 'media',
					},
					{
						name: 'Message',
						value: 'message',
					},
					{
						name: 'Number',
						value: 'number',
					},
					{
						name: 'Template',
						value: 'template',
					},
				],
				default: 'message',
			},
			...contactProperties,
			...messageProperties,
			...mediaProperties,
			...templateProperties,
			...numberProperties,
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
			try {
				for (const out of await runItem(this, i)) returnData.push({ ...out, pairedItem: { item: i } });
			} catch (error) {
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				if (this.continueOnFail()) {
					returnData.push({ json: { error: nodeError.message }, pairedItem: { item: i } });
					continue;
				}
				throw nodeError;
			}
		}

		return [returnData];
	}
}

type Resource = 'contact' | 'media' | 'message' | 'number' | 'template';

/** Runs the operation for item `i`. Most operations return one item; Get Many returns one per record. */
async function runItem(ctx: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const resource = ctx.getNodeParameter('resource', i) as Resource;
	switch (resource) {
		case 'contact':
			return [{ json: dataOf(await callJson(ctx, i, buildContactRequest(ctx, i))) }];
		case 'message':
			return [{ json: await sendMessage(ctx, i) }];
		case 'media':
			return await runMedia(ctx, i);
		case 'template': {
			const from = String(ctx.getNodeParameter('from', i, '') ?? '').trim();
			const response = await callJson(ctx, i, {
				method: 'GET',
				path: TEMPLATES_PATH,
				qs: from ? { from } : undefined,
			});
			const approvedOnly = ctx.getNodeParameter('approvedOnly', i, false) as boolean;
			return listOf(response)
				.filter((t) => !approvedOnly || String(t.status ?? '').toUpperCase() === 'APPROVED')
				.map((json) => ({ json }));
		}
		case 'number':
			return listOf(await callJson(ctx, i, { method: 'GET', path: NUMBERS_PATH })).map((json) => ({ json }));
		default: {
			// Compile-time exhaustiveness: a new Resource without a case fails to build.
			const unsupported: never = resource;
			throw new NodeOperationError(ctx.getNode(), `Unsupported resource "${String(unsupported)}"`, {
				itemIndex: i,
			});
		}
	}
}

/**
 * A failed WhatsArab call as an n8n error that leads with WhatsArab's own
 * message (also for a binary download, whose error body arrives as bytes)
 * and names the error code, so a workflow can be fixed from the error alone.
 */
function apiError(ctx: IExecuteFunctions, error: unknown, i: number, note?: string): NodeApiError {
	const info = apiErrorInfo(error);
	// Meta never answered the send: it may have gone out. Said in the error, so
	// nobody turns on Retry On Fail for it and messages the customer twice.
	const unknownOutcome =
		info.code === 'SEND_OUTCOME_UNKNOWN'
			? 'The message may already have been delivered: do not retry this item automatically — check its status (the WhatsArab trigger\'s message status events) first.'
			: '';
	const description = [info.code ? `WhatsArab error code: ${info.code}.` : '', unknownOutcome, note ?? ''].filter(Boolean).join(' ');
	const nodeError = new NodeApiError(ctx.getNode(), error as JsonObject, {
		itemIndex: i,
		...(info.message ? { message: info.message } : {}),
		...(info.status ? { httpCode: String(info.status) } : {}),
	});
	// Set after construction: for a JSON error body NodeApiError replaces a passed
	// description with the body's message, then drops it as equal to the message.
	if (description) nodeError.description = description;
	return nodeError;
}

/** `note` is appended to the error's description when the call fails. */
async function callRaw(ctx: IExecuteFunctions, i: number, request: RawRequest, note?: string): Promise<unknown> {
	try {
		return await whatsArabRawRequest.call(ctx, request);
	} catch (error) {
		throw apiError(ctx, error, i, note);
	}
}

async function callJson(
	ctx: IExecuteFunctions,
	i: number,
	request: ApiRequest | RawRequest,
	note?: string,
): Promise<IDataObject> {
	return (await callRaw(ctx, i, { ...request, json: true }, note)) as IDataObject;
}

/** The `data` object of a WhatsArab answer (`{ success, data }`). */
function dataOf(response: IDataObject): IDataObject {
	return (response.data ?? response) as IDataObject;
}

function listOf(response: IDataObject): IDataObject[] {
	return (Array.isArray(response.data) ? response.data : []) as IDataObject[];
}

/** A builder's refusal becomes a NodeOperationError on the item. */
function unwrap<T>(ctx: IExecuteFunctions, i: number, result: ParseResult<T>): T {
	if (!result.ok) throw new NodeOperationError(ctx.getNode(), result.message, { itemIndex: i });
	return result.value;
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

/** The Message operation values declared in messageProperties. */
type MessageOperation = 'sendText' | 'sendTemplate' | 'sendMedia' | 'sendButtons' | 'sendList' | 'sendCtaUrl';

interface MessageOptions {
	components?: unknown;
	dryRun?: boolean;
	headerText?: string;
	footerText?: string;
}

type Send = (body: ApiJsonObject, errorNote?: string) => Promise<IDataObject>;

/** Sends one message for item `i` and returns the API's `data` object. */
async function sendMessage(ctx: IExecuteFunctions, i: number): Promise<IDataObject> {
	const operation = ctx.getNodeParameter('operation', i) as MessageOperation;
	const recipientType = ctx.getNodeParameter('recipientType', i) as RecipientType;
	const recipient: Recipient = {
		type: recipientType,
		value: ctx.getNodeParameter(recipientType === 'userId' ? 'userId' : 'phone', i) as string,
	};
	const options = ctx.getNodeParameter('options', i, {}) as MessageOptions;
	const common: CommonSendOptions = {
		from: ctx.getNodeParameter('from', i, '') as string,
		dryRun: options.dryRun === true,
	};
	const frame: InteractiveFrame = { headerText: options.headerText, footerText: options.footerText };
	const send: Send = async (body, errorNote) =>
		dataOf(await callJson(ctx, i, { method: 'POST', path: MESSAGES_PATH, body }, errorNote));

	switch (operation) {
		case 'sendText':
			return await send(buildSendTextBody(recipient, ctx.getNodeParameter('text', i) as string, common));
		case 'sendTemplate': {
			const params = ctx.getNodeParameter('bodyParameters.parameter', i, []) as Array<{ value: string }>;
			const components = unwrap(ctx, i, parseComponentsJson(options.components));
			return await send(
				buildSendTemplateBody(
					recipient,
					{
						name: ctx.getNodeParameter('template', i) as string,
						language: ctx.getNodeParameter('language', i) as string,
						bodyParameters: params.map((p) => p.value),
						components,
					},
					common,
				),
			);
		}
		case 'sendButtons': {
			const buttons = ctx.getNodeParameter('buttons.button', i, []) as ReplyButtonInput[];
			const interactive = unwrap(ctx, i, buildReplyButtons(ctx.getNodeParameter('bodyText', i), buttons, frame));
			return await send(buildSendInteractiveBody(recipient, interactive, common));
		}
		case 'sendList': {
			const rows = ctx.getNodeParameter('rows.row', i, []) as ListRowInput[];
			const interactive = unwrap(
				ctx,
				i,
				buildList(ctx.getNodeParameter('bodyText', i), ctx.getNodeParameter('buttonText', i), rows, frame),
			);
			return await send(buildSendInteractiveBody(recipient, interactive, common));
		}
		case 'sendCtaUrl': {
			const interactive = unwrap(
				ctx,
				i,
				buildCtaUrl(
					ctx.getNodeParameter('bodyText', i),
					ctx.getNodeParameter('buttonText', i),
					ctx.getNodeParameter('ctaUrl', i),
					frame,
				),
			);
			return await send(buildSendInteractiveBody(recipient, interactive, common));
		}
		case 'sendMedia':
			return await sendMedia(ctx, i, recipient, common, send);
		default: {
			// Compile-time exhaustiveness: a new MessageOperation without a case fails to build.
			const unsupported: never = operation;
			throw new NodeOperationError(ctx.getNode(), `Unsupported operation "${String(unsupported)}"`, {
				itemIndex: i,
			});
		}
	}
}

type MediaSource = 'binary' | 'url' | 'id';

/**
 * Send Media. A file (binary or URL) is first uploaded through POST
 * /api/media from the chosen number, then sent from THE NUMBER THE UPLOAD
 * BELONGS TO: WhatsApp refuses a media id in a send from any other number.
 * A dry run reads and checks the file but uploads nothing.
 */
async function sendMedia(
	ctx: IExecuteFunctions,
	i: number,
	recipient: Recipient,
	common: CommonSendOptions,
	send: Send,
): Promise<IDataObject> {
	const kind = ctx.getNodeParameter('mediaKind', i) as MediaKind;
	const source = ctx.getNodeParameter('mediaSource', i) as MediaSource;
	const caption = ctx.getNodeParameter('caption', i, '') as string;
	const typedName = String(ctx.getNodeParameter('fileName', i, '') ?? '').trim();

	if (source === 'id') {
		const id = unwrap(ctx, i, checkMediaId(ctx.getNodeParameter('mediaId', i)));
		return await send(buildSendMediaBody(recipient, { kind, id, caption, filename: typedName }, common));
	}

	const file = source === 'url' ? await fileFromUrl(ctx, i) : await fileFromBinary(ctx, i);
	unwrap(ctx, i, checkMediaSize(file.data.length));
	const filename = typedName || file.fileName;

	if (common.dryRun) {
		// Nothing is uploaded on a dry run. POST /api/messages validates a dry run
		// without looking the media id up, so a placeholder id stands in for it.
		return await send(buildSendMediaBody(recipient, { kind, id: '0', caption, filename }, common));
	}

	const uploaded = await uploadFile(ctx, i, file, common.from);
	const mediaId = String(uploaded.media_id ?? '').trim();
	if (!mediaId) {
		throw new NodeOperationError(ctx.getNode(), 'WhatsArab accepted the upload but returned no media_id', {
			itemIndex: i,
		});
	}
	const owner = (uploaded.from as IDataObject | null | undefined)?.number_id;
	const from = typeof owner === 'string' && owner ? owner : common.from;
	// If the send fails, the file is already on WhatsApp: the error says so, so a
	// retry can reuse it (Media Source: Media ID) instead of uploading again.
	const reuse = `The file was uploaded first: media ID ${mediaId} on number ${from || 'Workspace Default'}, kept by WhatsApp for about 30 days.`;
	const sent = await send(buildSendMediaBody(recipient, { kind, id: mediaId, caption, filename }, { ...common, from }), reuse);
	return { ...sent, media_id: mediaId };
}

async function fileFromBinary(ctx: IExecuteFunctions, i: number): Promise<MultipartFile> {
	const property = ctx.getNodeParameter('binaryPropertyName', i) as string;
	const binary: IBinaryData = ctx.helpers.assertBinaryData(i, property);
	const data = await ctx.helpers.getBinaryDataBuffer(i, property);
	return {
		data,
		fileName: binary.fileName || `file${binary.fileExtension ? `.${binary.fileExtension}` : ''}`,
		mimeType: binary.mimeType || 'application/octet-stream',
	};
}

async function fileFromUrl(ctx: IExecuteFunctions, i: number): Promise<MultipartFile> {
	const url = String(ctx.getNodeParameter('mediaUrl', i) ?? '').trim();
	if (!/^https?:\/\/\S+$/i.test(url)) {
		throw new NodeOperationError(ctx.getNode(), 'File URL must be a full http:// or https:// address', {
			itemIndex: i,
		});
	}
	// Streamed, so a file over the upload limit is cut off at 16 MB instead of
	// being buffered whole in the n8n worker first.
	const abort = new AbortController();
	const failed = (error: unknown) =>
		new NodeOperationError(ctx.getNode(), `Could not download the file from ${url}: ${(error as Error).message}`, {
			itemIndex: i,
		});
	let response: { body: unknown; headers?: IDataObject };
	try {
		response = (await ctx.helpers.httpRequest({
			method: 'GET',
			url,
			encoding: 'stream',
			returnFullResponse: true,
			abortSignal: abort.signal,
		})) as { body: unknown; headers?: IDataObject };
	} catch (error) {
		throw failed(error);
	}
	const declared = Number(response.headers?.['content-length']);
	if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
		abort.abort();
		unwrap(ctx, i, checkMediaSize(declared));
	}
	let data: Buffer;
	try {
		data = await readCapped(response.body, MAX_MEDIA_BYTES + 1, () => abort.abort());
	} catch (error) {
		throw failed(error);
	}
	return {
		data,
		fileName: fileNameFromUrl(url) || 'file',
		mimeType: bareMimeType(response.headers?.['content-type']),
	};
}

/**
 * Reads a response body into memory, stopping at `limit` bytes: past it the
 * stream is destroyed and what was read is returned (its length then fails
 * checkMediaSize). A body that is already a Buffer or string passes through.
 */
async function readCapped(body: unknown, limit: number, onLimit: () => void): Promise<Buffer> {
	if (!isReadable(body)) return toBuffer(body);
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of body) {
		const buffer = toBuffer(chunk);
		chunks.push(buffer);
		total += buffer.length;
		if (total >= limit) {
			onLimit();
			body.destroy();
			break;
		}
	}
	return Buffer.concat(chunks);
}

function isReadable(body: unknown): body is AsyncIterable<unknown> & { destroy: () => void } {
	return (
		typeof body === 'object' &&
		body !== null &&
		typeof (body as { destroy?: unknown }).destroy === 'function' &&
		typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
	);
}

function toBuffer(body: unknown): Buffer {
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (typeof body === 'string') return Buffer.from(body, 'utf8');
	if (body instanceof Uint8Array) return Buffer.from(body);
	return Buffer.alloc(0);
}

/** POST /api/media with one file; returns the API's `data` (media_id, mime_type, size_bytes, from). */
async function uploadFile(ctx: IExecuteFunctions, i: number, file: MultipartFile, from?: string): Promise<IDataObject> {
	const fields: Record<string, string> = {};
	const sender = from?.trim();
	if (sender) fields.from = sender;
	const multipart = buildMultipart(fields, file, `----WhatsArabN8n${randomBytes(12).toString('hex')}`);
	const response = await callRaw(ctx, i, {
		method: 'POST',
		path: MEDIA_PATH,
		headers: { 'Content-Type': multipart.contentType },
		body: multipart.body,
		json: false,
	});
	return dataOf(parseJson(response));
}

/** A JSON answer to a request sent without `json: true` (a raw body) can arrive as a string or bytes. */
function parseJson(response: unknown): IDataObject {
	if (Buffer.isBuffer(response)) return JSON.parse(response.toString('utf8')) as IDataObject;
	if (typeof response === 'string') return JSON.parse(response) as IDataObject;
	return (response ?? {}) as IDataObject;
}

type MediaOperation = 'upload' | 'download';

async function runMedia(ctx: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const operation = ctx.getNodeParameter('operation', i) as MediaOperation;
	const property = ctx.getNodeParameter('binaryPropertyName', i) as string;

	if (operation === 'upload') {
		const file = await fileFromBinary(ctx, i);
		unwrap(ctx, i, checkMediaSize(file.data.length));
		return [{ json: await uploadFile(ctx, i, file, ctx.getNodeParameter('from', i, '') as string) }];
	}

	const mediaId = String(ctx.getNodeParameter('mediaId', i) ?? '').trim();
	if (!mediaId) throw new NodeOperationError(ctx.getNode(), 'Media ID is required', { itemIndex: i });
	const response = (await callRaw(ctx, i, {
		method: 'GET',
		path: `${MEDIA_PATH}/${encodeURIComponent(mediaId)}`,
		encoding: 'arraybuffer',
		returnFullResponse: true,
		json: false,
	})) as { body: unknown; headers?: IDataObject };
	const data = toBuffer(response.body);
	if (data.length === 0) {
		throw new NodeOperationError(ctx.getNode(), `WhatsArab returned no bytes for media ID ${mediaId}`, {
			itemIndex: i,
		});
	}
	const mimeType = bareMimeType(response.headers?.['content-type']);
	const fileName = mediaFileName(mediaId, mimeType);
	const binary = await ctx.helpers.prepareBinaryData(data, fileName, mimeType);
	return [
		{
			json: { media_id: mediaId, mime_type: mimeType, size_bytes: data.length, file_name: fileName },
			binary: { [property]: binary },
		},
	];
}
