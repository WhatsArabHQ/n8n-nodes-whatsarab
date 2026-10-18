import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { BASE_URL_EXPRESSION, DEFAULT_BASE_URL, NUMBERS_PATH } from '../nodes/WhatsArab/api';

export class WhatsArabApi implements ICredentialType {
	name = 'whatsArabApi';

	displayName = 'WhatsArab API';

	icon: Icon = { light: 'file:../icons/whatsarab.svg', dark: 'file:../icons/whatsarab.svg' };

	documentationUrl = 'https://whatsarab.com/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'An API key from WhatsArab: Developers → API keys. Messages and contacts need the "send" scope (or "full"); the WhatsArab Trigger\'s automatic subscription needs "full".',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: DEFAULT_BASE_URL,
			description: 'Leave as is unless WhatsArab support gave you a different API host',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: BASE_URL_EXPRESSION,
			url: NUMBERS_PATH,
			method: 'GET',
		},
	};
}
