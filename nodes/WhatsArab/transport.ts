import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
} from 'n8n-workflow';

import { joinUrl } from './requests';

/** Every n8n context this package calls the WhatsArab API from. */
export type WhatsArabRequestContext = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions;

/**
 * One authenticated call to the WhatsArab public API with the WhatsArab API
 * credential (X-API-Key). Errors are left to the caller: the action node
 * wraps them in NodeApiError, the trigger reads the status first (403 scope
 * refusal, 404 already gone).
 */
export async function whatsArabRequest(
	this: WhatsArabRequestContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const credentials = await this.getCredentials('whatsArabApi');
	return (await this.helpers.httpRequestWithAuthentication.call(this, 'whatsArabApi', {
		method,
		url: joinUrl(String(credentials.baseUrl ?? ''), path),
		body,
		qs,
		json: true,
	})) as IDataObject;
}
