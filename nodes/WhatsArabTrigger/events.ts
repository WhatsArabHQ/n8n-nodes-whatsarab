/**
 * Every event a WhatsArab webhook subscription can carry — the platform's
 * `customerWebhookEventTypes` list (also served by GET /tenant/webhooks/_meta).
 * Keep in step with it: an event missing here can still be delivered, but it
 * cannot be picked in the node's filter.
 */
export const WHATSARAB_EVENTS = [
	{ name: 'Broadcast Finished', value: 'broadcast.finished', description: 'A campaign finished sending' },
	{ name: 'Contact Created', value: 'contact.created', description: 'A new contact was created' },
	{ name: 'Conversation Closed', value: 'conversation.closed', description: 'A conversation was closed in the inbox' },
	{ name: 'Conversation Opened', value: 'conversation.opened', description: 'A new conversation was opened' },
	{ name: 'Message Delivered', value: 'message.delivered', description: 'WhatsApp reported a message as delivered' },
	{ name: 'Message Failed', value: 'message.failed', description: 'WhatsApp reported a message as failed' },
	{ name: 'Message Read', value: 'message.read', description: 'WhatsApp reported a message as read' },
	{ name: 'Message Received', value: 'message.received', description: 'A customer sent a message to one of your numbers' },
	{ name: 'Message Sent', value: 'message.sent', description: 'WhatsApp accepted an outgoing message' },
	{ name: 'Tag Added', value: 'tag.added', description: 'A tag was added to a conversation' },
	{ name: 'Tag Removed', value: 'tag.removed', description: 'A tag was removed from a conversation' },
	{ name: 'Template Status Changed', value: 'template.status_changed', description: 'Meta approved, rejected or paused a template' },
] as const;

export type WhatsArabEvent = (typeof WHATSARAB_EVENTS)[number]['value'];

/** An empty filter means "every event". */
export function eventPasses(filter: readonly string[] | undefined, event: unknown): boolean {
	if (!filter || filter.length === 0) return true;
	return typeof event === 'string' && filter.includes(event);
}
