/**
 * Shared config-store test fixture.
 *
 * Consolidates the setup block duplicated between config-store-env-override.test.ts
 * and config-store-no-global.test.ts: isolated agent dir, dynamic import, and
 * project config writer.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// config-store resolves its global config path once at module load, from
// PI_CODING_AGENT_DIR. Point it at a throwaway, empty dir *before* importing so
// that no global config exists and the real user global config is never touched.
// The dynamic import below runs after this assignment (static imports would be
// hoisted ahead of it).
export const agentDir = mkdtempSync(join(tmpdir(), "svn-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

export const { readConfigFromDisk, resolveProjectConfigPath, CONFIG_PATH } = await import(
	"../src/config-store.ts"
);

export function writeProjectConfig(projectRoot: string, record: Record<string, unknown>): string {
	const projectConfigPath = resolveProjectConfigPath(projectRoot);
	mkdirSync(dirname(projectConfigPath), { recursive: true });
	writeFileSync(projectConfigPath, JSON.stringify(record), "utf-8");
	return projectConfigPath;
}

/**
 * Guard that this process resolved the isolated, empty agent dir and that no
 * global config file exists. Shared by config-store-no-global and
 * config-store-env-override to avoid duplicating the assertion block.
 */
export function assertIsolatedAgentDir(): void {
	assert.ok(CONFIG_PATH.startsWith(agentDir), `expected isolated CONFIG_PATH, got ${CONFIG_PATH}`);
	assert.equal(existsSync(CONFIG_PATH), false, "global config must be absent at the start");
}
