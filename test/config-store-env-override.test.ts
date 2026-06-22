import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// config-store resolves its global config path once at module load, from
// PI_CODING_AGENT_DIR. Point it at a throwaway, empty dir *before* importing so
// that no global config exists and the real user global config is never touched.
// The dynamic import below runs after this assignment (static imports would be
// hoisted ahead of it). Mirrors the isolation technique in
// config-store-no-global.test.ts.
const agentDir = mkdtempSync(join(tmpdir(), "svn-agent-env-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { readConfigFromDisk, resolveProjectConfigPath, CONFIG_PATH } = await import(
	"../src/config-store.ts"
);

// aiMessages.endpoint is the canonical nested key for the AI endpoint
// (normalizeConfig reads aiMessagesRecord.endpoint ?? record.aiEndpoint). Using
// the nested form also exercises the deep-merge of a nested object over the
// global default, while PI_SMART_NOTIFY_AI_ENDPOINT is the matching env override.
const PROJECT_ENDPOINT = "https://from-project.example/v1";
const ENV_ENDPOINT = "https://from-env.example/v1";

function writeProjectConfig(projectRoot: string, record: Record<string, unknown>): string {
	const projectConfigPath = resolveProjectConfigPath(projectRoot);
	mkdirSync(dirname(projectConfigPath), { recursive: true });
	writeFileSync(projectConfigPath, JSON.stringify(record), "utf-8");
	return projectConfigPath;
}

test("project-level nested config wins over defaults when no env override is set (project > default)", () => {
	// Guard: confirm this process really resolved the isolated, empty agent dir.
	assert.ok(CONFIG_PATH.startsWith(agentDir), `expected isolated CONFIG_PATH, got ${CONFIG_PATH}`);
	assert.equal(existsSync(CONFIG_PATH), false, "global config must be absent at the start");

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
