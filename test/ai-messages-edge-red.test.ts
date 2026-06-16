import assert from "node:assert/strict";
import test from "node:test";

import { createAIMessageService } from "../src/ai-messages.ts";

test("AIMessageService falls back to default templates when custom event templates are blank", () => {
	const service = createAIMessageService({
		config: {
			templates: {
				permission: ["   \n\t  "],
			},
		},
	});

	const message = service.generateTemplateMessage("permission", {
		projectName: "Checkout",
		time: "09:30",
	});

	assert.notEqual(message, "");
	assert.match(message, /permission|approval|approve/i);
});

test("AIMessageService uses the generic template for unknown event types", () => {
	const service = createAIMessageService();

	const message = service.generateTemplateMessage("custom:deploy", {
		projectName: "Checkout",
		toolName: "status panel",
	});

	assert.equal(message, "Notification from Checkout. Please check status panel.");
});
