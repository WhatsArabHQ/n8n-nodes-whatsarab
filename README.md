# @whatsarab/n8n-nodes-whatsarab

n8n community nodes for [WhatsArab](https://whatsarab.com): send WhatsApp messages and manage contacts through the WhatsArab API, and start n8n workflows from signed WhatsArab webhooks.

> **Status: not published yet.** This package has not been released to npm or submitted to n8n. Until it is, install it from a local build (see [Development](#development)).

Source: [github.com/WhatsArabHQ/n8n-nodes-whatsarab](https://github.com/WhatsArabHQ/n8n-nodes-whatsarab).

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Trigger setup](#trigger-setup)
- [Development](#development)
- [Publishing](#publishing)

## Installation

Once published, install it in n8n from **Settings → Community Nodes → Install** with the package name `@whatsarab/n8n-nodes-whatsarab`. See the n8n [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

### WhatsArab API (WhatsArab node, and the trigger in Automatic mode)

1. In WhatsArab, open **Developers → API keys** and create a key with the scope you need (see below).
2. In n8n, create a **WhatsArab API** credential and paste the key. Leave **Base URL** as `https://whatsarab.com`.

The key is sent in the `X-API-Key` header. n8n tests the credential by calling `GET /api/numbers`.

Required API-key scopes:

| What | Endpoints | Scope |
| --- | --- | --- |
| Message → Send Text / Send Template | `POST /api/messages` | `send` (or `full`) |
| Contact → Create or Update, Add Tag, Remove Tag | `POST /api/contacts`, `POST /api/contacts/{phone}/tags`, `DELETE /api/contacts/{phone}/tags/{tag}` | `send` (or `full`) |
| Contact → Get | `GET /api/contacts/{phone}` | `read` or `send` (or `full`) |
| WhatsArab Trigger, Automatic mode | `GET /api/webhooks`, `POST /api/webhooks`, `DELETE /api/webhooks/{id}` | `full` |

Contact writes need `send`, not `read`: a tag can start a tag-triggered flow or sequence, which sends messages. Webhook subscriptions need `full` because a subscription carries every message's content off the platform.

An API key restricted to specific numbers can only send from those numbers; with **From Number** left on *Workspace Default* it uses the first number on its list. It also only sees contacts in its numbers' audiences, and only manages webhook subscriptions limited to its own numbers.

### WhatsArab Webhook API (WhatsArab Trigger, Manual mode only)

This credential holds the **signing secret** of one webhook subscription you created in the dashboard. WhatsArab shows it once, when you create the subscription (it starts with `whsec_`). The credential test only checks the format: there is no API call that can confirm a signing secret.

## Operations

### Message

Both operations call `POST /api/messages`.

| Operation | What it does |
| --- | --- |
| Send Text | Free-form text, up to 4096 characters. WhatsApp only delivers it inside the customer's 24-hour window (opened by their last message to the sending number). Outside it the API answers `OUTSIDE_CSW` and you need a template. |
| Send Template | An approved template, with body parameters in order (`{{1}}`, `{{2}}` ...) or a full **Components (JSON)** array for header, body and button parameters. Works outside the 24-hour window. Templates count against your WhatsArab plan's monthly quota. |

Common fields:

- **From Number**: which of your WhatsArab numbers sends. The list comes from `GET /api/numbers`; *Workspace Default* lets WhatsArab choose.
- **Recipient Type**: a phone number (international format; spaces, dashes, `+`, `00` and Arabic digits are cleaned), or a **WhatsApp User ID** for a customer who wrote with a WhatsApp username and no phone (the `fromUserId` of a *Message Received* event).
- **Template Name**: approved templates of the sending number's WhatsApp Business Account, from `GET /api/templates`.
- **Dry Run**: validate without sending. Nothing reaches Meta and no quota is used.

The node outputs the API's `data` object: `message_id` (the WhatsApp message id, to match delivery events), the recipient echoed back masked, `kind`, `status` (`sent`, or `dry_run` on a dry run, which also returns `quota_remaining` and, for text, `window_open`) and `from` (the number that sent). API errors (opted-out contact, closed window, invalid number...) surface as n8n errors carrying WhatsArab's error code; enable **Continue On Fail** to keep going per item.

### Contact

Every operation takes the contact's **Phone Number** (cleaned like the Message phone).

| Operation | Endpoint | What it does |
| --- | --- | --- |
| Create or Update | `POST /api/contacts` | Creates the contact if the phone is new, otherwise updates it. Safe to run on every sync. |
| Get | `GET /api/contacts/{phone}` | Reads one contact: name, tags, custom fields, opt-out state, audiences. A phone that does not exist (or that a restricted key cannot see) is a `NOT_FOUND` error. |
| Add Tag | `POST /api/contacts/{phone}/tags` | Tags the contact exactly as an agent would in the inbox. |
| Remove Tag | `DELETE /api/contacts/{phone}/tags/{tag}` | Removes the tag from the contact and from every one of its conversations that carries it. |

**Create or Update follows the API's merge rules exactly:**

- A field you leave out keeps its value. An empty **Name** is left out, so it never blanks a name.
- **Custom Fields** merge key by key (up to 50 keys per call). Keys you do not list keep their value. A row with Type **Remove Field** sends `null`, which deletes that key. Types **Text**, **Number** and **Boolean** send a string (up to 1000 characters), a number, or `true`/`false`.
- **Tags** (comma-separated, up to 20) are **added** to the tags the contact already has, never replacing them. Use **Remove Tag** to take one off.
- **Consent**: *Opt Out* sends `opted_in: false` and opts the contact out. *Opt In (Record Consent)* sends `opted_in: true`, which records consent only on a contact that is not opted out and **never lifts an opt-out**: a customer who opted out, or a block your team set, stays opted out (the output's `opted_out` says so). Lifting an opt-out is only possible deliberately in the WhatsArab dashboard. *Leave Unchanged* (the default) sends nothing.
- **Number**: the number whose audience the contact joins (*Workspace Default*: the default number). Audiences are only added, never removed.

The output is the contact, with `created: true` when it was new.

**Add Tag** lands the tag on the contact and on the customer's conversation (the one on the chosen **Number**, else their most recent one). On that conversation it does everything a tag added in the inbox does: tag rules (including the tag → ad-event rule of Ad signals), the `tag.added` webhook event, and tag-triggered sequences and flows. A contact with no conversation yet gets the tag on the contact only, and no automation runs. Adding a tag the contact already has succeeds with `added_to_contact: false`.

**Remove Tag** is idempotent: removing a tag the contact does not have succeeds with `removed_from_contact: false`. Each conversation it is removed from emits `tag.removed`.

## Trigger setup

The **WhatsArab Trigger** starts a workflow for each webhook delivery. Its **Subscription** field picks how the WhatsArab side is set up.

### Automatic (API Key), the default

Needs a **WhatsArab API** credential whose key has the `full` scope.

- **On activation** (and while n8n listens for a test event) the node calls `POST /api/webhooks` with the node's webhook URL, the events from the **Events** filter (empty = every event) and the label `n8n: <workflow name>`. WhatsArab returns the subscription id and its signing secret **once**; the node keeps both in the workflow's static data and verifies every delivery with that secret.
- **On deactivation** it calls `DELETE /api/webhooks/{id}` and forgets the secret. A subscription already deleted in the dashboard counts as removed.
- **Listening for a test event** creates a separate subscription for the Test URL and deletes it when n8n stops listening. The production subscription of an active workflow is left untouched.
- **On re-activation** (or an n8n restart) it checks `GET /api/webhooks`. It keeps the subscription when the URL and events are unchanged and the subscription is switched on; otherwise it deletes it and subscribes again. WhatsArab switches a subscription off after repeated failed deliveries (an n8n that was down, for example), so re-activating the workflow brings deliveries back.

WhatsArab only delivers to a **public `https://` URL**: private, loopback and cloud-metadata addresses are refused. An n8n on `localhost` cannot receive WhatsArab webhooks, so set n8n's `WEBHOOK_URL` to a public HTTPS address (for example through a tunnel). Your plan's subscription limit applies.

If the key does not have the `full` scope, activation fails with *This WhatsArab API key cannot manage webhooks: automatic subscription needs the "full" scope*. Use a `full` key, or switch to Manual mode.

### Manual (Signing Secret)

For keys without the `full` scope, or when you prefer to manage the subscription yourself:

1. Add the **WhatsArab Trigger** node, set **Subscription** to *Manual (Signing Secret)* and copy its **Production URL**. (The Test URL only works while n8n is listening for a test event.)
2. In WhatsArab, open **Developers → Webhooks** and add a subscription: paste the URL, pick the events, and optionally restrict it to some numbers.
3. Copy the signing secret WhatsArab shows (only once) into a **WhatsArab Webhook API** credential and select it in the trigger.
4. Activate the workflow.

In this mode the node creates and deletes nothing in WhatsArab; its **Events** filter only decides which deliveries start the workflow.

### Every delivery is checked

Before the workflow starts:

- `X-Whatsarab-Signature` must equal `sha256=` + HMAC-SHA256 of `` `${X-Whatsarab-Timestamp}.${raw body}` `` with the signing secret (the stored one in Automatic mode, the credential's in Manual mode), compared in constant time.
- `X-Whatsarab-Timestamp` must be within the **Replay Window** (default 300 seconds).

A delivery that fails either check gets `401` and does not start the workflow. A correctly signed body that is not a JSON object with a string `event` gets `400`, also without starting it. The node's **Events** filter (empty = all) acknowledges other events with `200` without starting the workflow.

Each item has the shape WhatsArab sends:

```json
{
  "event": "message.received",
  "deliveryId": "…",
  "webhookId": "…",
  "timestamp": 1800000000,
  "data": { "...": "event payload" }
}
```

WhatsArab retries failed deliveries, so the same `deliveryId` can arrive more than once; de-duplicate on it if a double run would matter.

Events: `message.sent`, `message.delivered`, `message.read`, `message.failed`, `message.received`, `conversation.opened`, `conversation.closed`, `tag.added`, `tag.removed`, `contact.created`, `broadcast.finished`, `template.status_changed`.

## Development

This repository is a mirror: changes are made upstream and synced here, so pull requests opened here cannot be merged directly. Issues and bug reports are welcome here.

Requires Node.js 22.

```bash
npm ci --ignore-scripts
npm run lint       # n8n's community-node linter (@n8n/node-cli, strict mode)
npm run build      # compiles to dist/ and copies the icons
npm test           # builds, then runs node:test against dist/
npm run dev        # starts a local n8n with these nodes loaded
```

No runtime dependencies: every request goes through `this.helpers.httpRequestWithAuthentication`, and signature checks use Node's built-in `crypto`.

## Publishing

Releases are published from this repository by the **Publish** workflow (`.github/workflows/publish.yml`), which a maintainer runs by hand from the Actions tab. It lints, builds and tests the package, refuses a version that is already on npm, then publishes through npm trusted publishing with a provenance statement, as n8n requires for verified community nodes, and tags the commit `v<version>`.

## License

[MIT](LICENSE)
