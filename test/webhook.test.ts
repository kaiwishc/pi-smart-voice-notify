import assert from "node:assert/strict";
import test from "node:test";

import { createWebhookService, isWebhookUrlAllowed } from "../src/webhook.ts";

test("webhook URL validation blocks localhost, private, and link-local destinations", () => {
	for (const url of [
		"http://localhost/webhook",
		"http://127.0.0.1/webhook",
		"http://[::1]/webhook",
		"http://10.0.0.2/webhook",
		"http://172.16.0.1/webhook",
		"http://192.168.1.1/webhook",
		"http://169.254.1.10/webhook",
		"http://service.internal/webhook",
	]) {
		assert.equal(isWebhookUrlAllowed(url), false, url);
	}
});

test("webhook URL validation allows normal public http(s) webhook destinations", () => {
	assert.equal(isWebhookUrlAllowed("https://example.com/webhook"), true);
	assert.equal(isWebhookUrlAllowed("https://discord.com/api/webhooks/123/token"), true);
});

test("webhook service does not enable when configured only with blocked internal targets", () => {
	const service = createWebhookService({
		enabled: true,
		genericWebhookUrl: "http://127.0.0.1:8080/webhook",
	});

	assert.equal(service.isEnabled(), false);
	assert.deepEqual(
		service.dispatch({ type: "idle", title: "Idle", message: "Done" }),
		{ queued: 0, skipped: true },
	);
});

test("webhook dispatch pins validated DNS addresses into the fetch dispatcher", async () => {
	const fetchCalls = [];
	const service = createWebhookService({
		enabled: true,
		genericWebhookUrl: "https://example.com/webhook",
		minIntervalMs: 0,
		maxRetries: 0,
		dnsLookup: async (hostname) => {
			assert.equal(hostname, "example.com");
			return [{ address: "93.184.216.34", family: 4 }];
		},
		fetch: async (url, init) => {
			fetchCalls.push({ url, init });
			return new Response(null, { status: 204 });
		},
	});

	assert.deepEqual(service.dispatch({ type: "idle", title: "Idle", message: "Done" }), {
		queued: 1,
		skipped: false,
	});
	await service.flush();

	assert.equal(fetchCalls.length, 1);
	assert.equal(fetchCalls[0].url, "https://example.com/webhook");
	assert.equal(typeof fetchCalls[0].init.dispatcher?.dispatch, "function");
});

test("webhook dispatch blocks DNS rebinding to private addresses before fetch", async () => {
	let fetchCalled = false;
	const service = createWebhookService({
		enabled: true,
		genericWebhookUrl: "https://example.com/webhook",
		minIntervalMs: 0,
		maxRetries: 0,
		dnsLookup: async () => [{ address: "10.0.0.5", family: 4 }],
		fetch: async () => {
			fetchCalled = true;
			return new Response(null, { status: 204 });
		},
	});

	service.dispatch({ type: "idle", title: "Idle", message: "Done" });
	await service.flush();

	assert.equal(fetchCalled, false);
});
