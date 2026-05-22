import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { SoundThemeService } from "../src/sound-theme.ts";

test("default assets/ sound references keep completion soft and attention events alerting", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-smart-voice-sounds-"));
	const assetsDirectory = join(root, "assets");
	const softSound = join(assetsDirectory, "soft-notification.mp3");
	const alertSound = join(assetsDirectory, "attention-alert.mp3");

	try {
		mkdirSync(assetsDirectory, { recursive: true });
		writeFileSync(softSound, "soft");
		writeFileSync(alertSound, "alert");

		const service = new SoundThemeService({ assetsDirectory });
		const config = {
			randomizeSounds: false,
			soundFiles: {
				notification: "assets/attention-alert.mp3",
				alert: "assets/attention-alert.mp3",
				success: "assets/soft-notification.mp3",
				error: "assets/attention-alert.mp3",
			},
		};

		const completion = await service.resolveEventSound("idle", config);
		const permission = await service.resolveEventSound("permission", config);
		const question = await service.resolveEventSound("question", config);
		const error = await service.resolveEventSound("error", config);

		assert.equal(completion?.category, "success");
		assert.equal(completion?.candidates[0], resolve(softSound));
		assert.equal(permission?.category, "alert");
		assert.equal(permission?.candidates[0], resolve(alertSound));
		assert.equal(question?.category, "notification");
		assert.equal(question?.candidates[0], resolve(alertSound));
		assert.equal(error?.category, "error");
		assert.equal(error?.candidates[0], resolve(alertSound));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("completion event aliases resolve to the success sound category", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-smart-voice-completion-"));
	const assetsDirectory = join(root, "assets");
	const softSound = join(assetsDirectory, "soft-notification.mp3");

	try {
		mkdirSync(assetsDirectory, { recursive: true });
		writeFileSync(softSound, "soft");

		const service = new SoundThemeService({ assetsDirectory });
		const config = {
			randomizeSounds: false,
			soundFiles: {
				success: "assets/soft-notification.mp3",
			},
		};

		for (const eventType of ["completion", "complete", "agent_complete", "agent_completed"]) {
			const selection = await service.resolveEventSound(eventType, config);
			assert.equal(selection?.category, "success", eventType);
			assert.equal(selection?.candidates[0], resolve(softSound), eventType);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
