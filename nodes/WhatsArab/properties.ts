import type { INodeProperties } from 'n8n-workflow';

import { MEDIA_KINDS } from './media';
import type { MediaKind } from './requests';

/** Contact resource fields (POST/GET /api/contacts..., API key scope `send`). */
export const contactProperties: INodeProperties[] = [
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

const INTERACTIVE_OPERATIONS = ['sendButtons', 'sendList', 'sendCtaUrl'];

const MEDIA_KIND_NAMES: Record<MediaKind, string> = {
	audio: 'Audio',
	document: 'Document',
	image: 'Image',
	sticker: 'Sticker',
	video: 'Video',
};

/** Message resource fields (POST /api/messages, API key scope `send`). */
export const messageProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['message'] } },
		options: [
			{
				name: 'Send Buttons',
				value: 'sendButtons',
				description:
					"Send a message with up to 3 reply buttons. The customer's tap arrives as a Message Received event. Only delivered inside the 24-hour window.",
				action: 'Send a message with reply buttons',
			},
			{
				name: 'Send Link Button',
				value: 'sendCtaUrl',
				description: 'Send a message with one button that opens a URL. Only delivered inside the 24-hour window.',
				action: 'Send a message with a link button',
			},
			{
				name: 'Send List',
				value: 'sendList',
				description:
					"Send a menu of up to 10 options behind one button. The customer's pick arrives as a Message Received event. Only delivered inside the 24-hour window.",
				action: 'Send a list message',
			},
			{
				name: 'Send Media',
				value: 'sendMedia',
				description:
					'Send an image, video, audio, document or sticker from a file, a URL or a media ID. Only delivered inside the 24-hour window.',
				action: 'Send a media message',
			},
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
			"An approved template on the sending number's WhatsApp Business Account. Choose from the list, or specify an ID using an <a href=\"https://docs.n8n.io/code/expressions/\">expression</a>.",
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
	// ── Send Media ─────────────────────────────────────────────────────────
	{
		displayName: 'Media Type',
		name: 'mediaKind',
		type: 'options',
		displayOptions: { show: { resource: ['message'], operation: ['sendMedia'] } },
		options: MEDIA_KINDS.map((kind) => ({ name: MEDIA_KIND_NAMES[kind], value: kind })),
		default: 'image',
		description: 'How WhatsApp shows the file. Stickers must be WebP.',
	},
	{
		displayName: 'Media Source',
		name: 'mediaSource',
		type: 'options',
		displayOptions: { show: { resource: ['message'], operation: ['sendMedia'] } },
		options: [
			{
				name: 'Binary File',
				value: 'binary',
				description: 'A file from a previous node (read from disk, downloaded, generated)',
			},
			{
				name: 'Media ID',
				value: 'id',
				description:
					'A WhatsApp media ID from Media → Upload (upload once, send to many), or the media of a Message Received event',
			},
			{
				name: 'URL',
				value: 'url',
				description: 'A public file URL. n8n downloads it, then uploads it to WhatsApp.',
			},
		],
		default: 'binary',
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaSource: ['binary'] } },
		default: 'data',
		hint: 'The name of the input binary field containing the file to send',
	},
	{
		displayName: 'File URL',
		name: 'mediaUrl',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaSource: ['url'] } },
		default: '',
		placeholder: 'https://example.com/menu.pdf',
	},
	{
		displayName: 'Media ID',
		name: 'mediaId',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaSource: ['id'] } },
		default: '',
		placeholder: '1234567890123456',
		description:
			'WhatsApp ties an uploaded media ID to the number that uploaded it: send from that same number (Media → Upload outputs it as from.number_id)',
	},
	{
		displayName: 'Caption',
		name: 'caption',
		type: 'string',
		typeOptions: { rows: 2 },
		displayOptions: {
			show: { resource: ['message'], operation: ['sendMedia'], mediaKind: ['image', 'video', 'document'] },
		},
		default: '',
		description: 'Text shown under the image, video or document',
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		displayOptions: { show: { resource: ['message'], operation: ['sendMedia'], mediaKind: ['document'] } },
		default: '',
		placeholder: 'invoice-1042.pdf',
		description: "The document's name in the chat. Leave empty to use the file's own name.",
	},
	// ── Interactive: buttons, list, link button ─────────────────────────────
	{
		displayName: 'Body Text',
		name: 'bodyText',
		type: 'string',
		required: true,
		typeOptions: { rows: 4 },
		displayOptions: { show: { resource: ['message'], operation: INTERACTIVE_OPERATIONS } },
		default: '',
		description: 'The message text above the buttons (WhatsApp allows up to 1024 characters, 4096 in a list)',
	},
	{
		displayName: 'Buttons',
		name: 'buttons',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		displayOptions: { show: { resource: ['message'], operation: ['sendButtons'] } },
		default: {},
		placeholder: 'Add Button',
		description: 'One to three reply buttons, each with a unique title',
		options: [
			{
				displayName: 'Button',
				name: 'button',
				values: [
					{
						displayName: 'Title',
						name: 'title',
						type: 'string',
						default: '',
						description: 'The button label, up to 20 characters',
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
						default: '',
						description:
							'Sent back in the Message Received event (under interactive.button_reply) when the customer taps it. Leave empty to use the title.',
					},
				],
			},
		],
	},
	{
		displayName: 'Button Text',
		name: 'buttonText',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['message'], operation: ['sendList', 'sendCtaUrl'] } },
		default: '',
		placeholder: 'Choose',
		description: 'The label of the button, up to 20 characters',
	},
	{
		displayName: 'Rows',
		name: 'rows',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		displayOptions: { show: { resource: ['message'], operation: ['sendList'] } },
		default: {},
		placeholder: 'Add Row',
		description:
			'Up to 10 options. Rows with the same Section are grouped under that heading, in the order the sections first appear.',
		options: [
			{
				displayName: 'Row',
				name: 'row',
				values: [
					{
						displayName: 'Title',
						name: 'title',
						type: 'string',
						default: '',
						description: 'Up to 24 characters',
					},
					{
						displayName: 'Description',
						name: 'description',
						type: 'string',
						default: '',
						description: 'Optional second line, up to 72 characters',
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
						default: '',
						description:
							'Sent back in the Message Received event (under interactive.list_reply) when the customer picks it. Leave empty to use the title.',
					},
					{
						displayName: 'Section',
						name: 'section',
						type: 'string',
						default: '',
						description:
							'Optional heading, up to 24 characters. Rows without one share a section titled with the Button Text.',
					},
				],
			},
		],
	},
	{
		displayName: 'URL',
		name: 'ctaUrl',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['message'], operation: ['sendCtaUrl'] } },
		default: '',
		placeholder: 'https://example.com/book',
		description: 'The page the button opens',
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
					'Whether to only validate the request. Nothing is sent or uploaded and no quota is used; for free-form messages the response says whether the 24-hour window is open.',
			},
			{
				displayName: 'Footer Text',
				name: 'footerText',
				type: 'string',
				default: '',
				displayOptions: { show: { '/operation': INTERACTIVE_OPERATIONS } },
				description: 'Small grey text under the body, up to 60 characters',
			},
			{
				displayName: 'Header Text',
				name: 'headerText',
				type: 'string',
				default: '',
				displayOptions: { show: { '/operation': INTERACTIVE_OPERATIONS } },
				description: 'Bold title above the body, up to 60 characters',
			},
		],
	},
];

/** Media resource fields (/api/media). */
export const mediaProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['media'] } },
		options: [
			{
				name: 'Download',
				value: 'download',
				description:
					'Download the file of an incoming message (the media of a Message Received event) as binary data',
				action: 'Download media',
			},
			{
				name: 'Upload',
				value: 'upload',
				description:
					'Upload a file once and get a media ID to send with Message → Send Media. WhatsApp keeps it about 30 days.',
				action: 'Upload media',
			},
		],
		default: 'upload',
	},
	{
		displayName: 'From Number Name or ID',
		name: 'from',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getNumbers' },
		displayOptions: { show: { resource: ['media'], operation: ['upload'] } },
		default: '',
		description:
			'The number the media ID will belong to: WhatsApp only accepts it in sends from this same number. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['media'], operation: ['upload'] } },
		default: 'data',
		hint: 'The name of the input binary field containing the file to upload',
	},
	{
		displayName: 'Media ID',
		name: 'mediaId',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['media'], operation: ['download'] } },
		default: '',
		placeholder: '1234567890123456',
		description: "The media ID of a Message Received event: a customer's photo, voice note or document",
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		displayOptions: { show: { resource: ['media'], operation: ['download'] } },
		default: 'data',
		hint: 'The name of the output binary field to put the file in',
	},
];

/** Template resource fields (GET /api/templates, scope `read` or `send`). */
export const templateProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['template'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				description: "List the templates of a number's WhatsApp Business Account, one item per template and language",
				action: 'Get many templates',
			},
		],
		default: 'getAll',
	},
	{
		displayName: 'Number Name or ID',
		name: 'from',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getNumbers' },
		displayOptions: { show: { resource: ['template'] } },
		default: '',
		description:
			"Whose WhatsApp Business Account to list (Workspace Default: the default number's). Choose from the list, or specify an ID using an <a href=\"https://docs.n8n.io/code/expressions/\">expression</a>.",
	},
	{
		displayName: 'Approved Only',
		name: 'approvedOnly',
		type: 'boolean',
		displayOptions: { show: { resource: ['template'] } },
		default: false,
		description: 'Whether to return only templates WhatsApp approved (the ones you can send)',
	},
];

/** Number resource fields (GET /api/numbers, scope `read` or `send`). */
export const numberProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['number'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				description:
					'List your WhatsArab numbers (the default first), one item per number. A key restricted to some numbers sees only those.',
				action: 'Get many numbers',
			},
		],
		default: 'getAll',
	},
];
