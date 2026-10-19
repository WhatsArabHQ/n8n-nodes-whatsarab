import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * The signing secret of ONE WhatsArab webhook subscription. WhatsArab shows it
 * once, when the subscription is created (Developers → Webhooks).
 * There is nothing to call on the API to check it, so the WhatsArab Trigger
 * node tests it locally (format only) through `testedBy`.
 */
export class WhatsArabWebhookApi implements ICredentialType {
	name = 'whatsArabWebhookApi';

	displayName = 'WhatsArab Webhook API';

	icon: Icon = { light: 'file:../icons/whatsarab.svg', dark: 'file:../icons/whatsarab.dark.svg' };

	documentationUrl = 'https://whatsarab.com/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'Signing Secret',
			name: 'secret',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'The secret WhatsArab showed once when you created the webhook subscription (it starts with whsec_)',
		},
	];
}
