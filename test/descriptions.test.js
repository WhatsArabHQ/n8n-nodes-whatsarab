'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { WhatsArab } = require('../dist/nodes/WhatsArab/WhatsArab.node');
const { WhatsArabTrigger } = require('../dist/nodes/WhatsArabTrigger/WhatsArabTrigger.node');
const { WhatsArabApi } = require('../dist/credentials/WhatsArabApi.credentials');
const { WhatsArabWebhookApi } = require('../dist/credentials/WhatsArabWebhookApi.credentials');

const DIST = path.join(__dirname, '..', 'dist');
const node = new WhatsArab().description;
const trigger = new WhatsArabTrigger().description;

describe('node search entry', () => {
	// n8n merges a trigger into the regular node whose name matches without "Trigger",
	// and the merged search entry ALWAYS shows the trigger's description
	// (editor-ui useActionsGeneration: `app.description = trigger.description`).
	it('the trigger merges into the WhatsArab node (same name minus "Trigger")', () => {
		assert.equal(trigger.name.replace('Trigger', ''), node.name);
	});

	it('the trigger description, shown for the pair, covers the whole integration', () => {
		for (const part of [
			'Send WhatsApp messages',
			'templates',
			'contacts',
			'tags',
			'start workflows',
		]) {
			assert.ok(trigger.description.includes(part), `missing «${part}»: ${trigger.description}`);
		}
	});

	it('the regular node describes its own actions, not the webhook trigger', () => {
		for (const part of ['Send WhatsApp messages', 'templates', 'contacts', 'tags']) {
			assert.ok(node.description.includes(part), `missing «${part}»: ${node.description}`);
		}
		assert.doesNotMatch(node.description, /webhook|starts? the workflow/i);
	});
});

describe('codex (search categories and aliases)', () => {
	for (const file of [
		'nodes/WhatsArab/WhatsArab.node.json',
		'nodes/WhatsArabTrigger/WhatsArabTrigger.node.json',
	]) {
		it(`${file} ships in dist with categories and aliases`, () => {
			const codex = JSON.parse(fs.readFileSync(path.join(DIST, file), 'utf8'));
			assert.deepEqual(codex.categories, ['Communication', 'Marketing & Content']);
			for (const alias of ['WhatsApp', 'WhatsApp Business', 'Arabic']) {
				assert.ok(codex.alias.includes(alias), `missing alias ${alias}`);
			}
		});
	}
});

describe('icons', () => {
	const owners = [
		['WhatsArab node', node.icon, 'nodes/WhatsArab'],
		['WhatsArab Trigger node', trigger.icon, 'nodes/WhatsArabTrigger'],
		['WhatsArab API credential', new WhatsArabApi().icon, 'credentials'],
		['WhatsArab Webhook API credential', new WhatsArabWebhookApi().icon, 'credentials'],
	];

	for (const [label, icon, dir] of owners) {
		it(`${label} has distinct light and dark files that exist in dist`, () => {
			assert.equal(typeof icon, 'object');
			const files = ['light', 'dark'].map((theme) => {
				assert.match(icon[theme], /^file:/);
				const file = path.join(DIST, dir, icon[theme].slice('file:'.length));
				assert.ok(fs.existsSync(file), `${theme} icon not in dist: ${file}`);
				return file;
			});
			assert.notEqual(files[0], files[1]);
		});
	}

	for (const name of ['whatsarab.svg', 'whatsarab.dark.svg']) {
		it(`${name} is a square, self-contained vector`, () => {
			const svg = fs.readFileSync(path.join(DIST, 'icons', name), 'utf8');
			assert.match(svg, /viewBox="0 0 60 60"/);
			assert.doesNotMatch(svg, /<image|<text|href=|url\(|<style|base64/i);
			assert.match(svg, /#00d579/i, 'brand green missing');
		});
	}

	it('the dark variant swaps the ink so the dot and arrow stay visible on a dark canvas', () => {
		const light = fs.readFileSync(path.join(DIST, 'icons', 'whatsarab.svg'), 'utf8');
		const dark = fs.readFileSync(path.join(DIST, 'icons', 'whatsarab.dark.svg'), 'utf8');
		assert.match(light, /fill="#0c0c0c"/);
		assert.doesNotMatch(dark, /#0c0c0c/);
		assert.match(dark, /fill="#fff"/);
	});
});
