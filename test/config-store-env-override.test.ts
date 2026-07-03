import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Reuse the shared config-store test fixture so the agent-dir isolation,
// dynamic import, and writeProjectConfig helper are defined in one place.
// config-store-env-override needs the same isolation as config-store-no-global;
// the fixture's dynamic import runs in this process after the env assignment.
const { readConfigFromDisk, writeProjectConfig, assertIsolatedAgentDir } = await import(
	"./config-store-fixture.ts"
);

// aiMessages.endpoint is the canonical nested key for the AI endpoint
// (normalizeConfig reads aiMessagesRecord.endpoint ?? record.aiEndpoint). Using
// the nested form also exercises the deep-merge of a nested object over the
// global default, while PI_SMART_NOTIFY_AI_ENDPOINT is the matching env override.
const PROJECT_ENDPOINT = "https://from-project.example/v1";
const ENV_ENDPOINT = "https://from-env.example/v1";

test("project-level nested config wins over defaults when no env override is set (project > default)", () => {
	assertIsolatedAgentDir();

	const projectRoot = mkdtempSync(join(tmpdir(), "svn-repo-noenv-"));
	writeProjectConfig(projectRoot, { aiMessages: { endpoint: PROJECT_ENDPOINT } });

	assert.equal(
		process.env.PI_SMART_NOTIFY_AI_ENDPOINT,
		undefined,
		"env must be unset for this precedence case",
	);
	const config = readConfigFromDisk(projectRoot);
	// No env override => the nested project value must win over the built-in default.
	assert.equal(config.aiMessages.endpoint, PROJECT_ENDPOINT);
	assert.equal(config.aiEndpoint, PROJECT_ENDPOINT);
});

test("environment override wins over a project-level config value (env > project > default)", () => {
	const projectRoot = mkdtempSync(join(tmpdir(), "svn-repo-env-"));
	writeProjectConfig(projectRoot, { aiMessages: { endpoint: PROJECT_ENDPOINT } });

	// Project value is in place; now provide a competing environment override.
	process.env.PI_SMART_NOTIFY_AI_ENDPOINT = ENV_ENDPOINT;
	try {
		const config = readConfigFromDisk(projectRoot);
		// Env overrides are applied AFTER the project merge, so they must win.
		assert.equal(
			config.aiMessages.endpoint,
			ENV_ENDPOINT,
			"env PI_SMART_NOTIFY_AI_ENDPOINT must override the project config value",
		);
		assert.equal(config.aiEndpoint, ENV_ENDPOINT);
	} finally {
		delete process.env.PI_SMART_NOTIFY_AI_ENDPOINT;
	}
});
