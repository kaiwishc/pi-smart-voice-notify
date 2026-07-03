import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Reuse the shared config-store test fixture so the agent-dir isolation and
// dynamic import are defined in one place. The fixture sets
// PI_CODING_AGENT_DIR and imports config-store in this process.
const { readConfigFromDisk, CONFIG_PATH, assertIsolatedAgentDir, writeProjectConfig } = await import(
	"./config-store-fixture.ts"
);

test("a project config applies over defaults when no global config exists", () => {
	assertIsolatedAgentDir();

	const projectRoot = mkdtempSync(join(tmpdir(), "svn-repo-"));
	writeProjectConfig(projectRoot, { windowsOptimized: false, notificationMode: "tts-first" });

	// Must not throw even though the global config file does not exist.
	const config = readConfigFromDisk(projectRoot);

	// Project values win over the defaults base.
	assert.equal(config.windowsOptimized, false);
	assert.equal(config.notificationMode, "tts-first");
	// Keys the project file omits fall back to defaults, never undefined.
	assert.equal(config.enabled, true);
	// The absent global config is created with defaults as a side effect.
	assert.equal(existsSync(CONFIG_PATH), true);
});
