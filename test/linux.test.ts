import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { detectLinuxSession } from "../src/linux.ts";

test("detectLinuxSession honors explicit XDG session type", () => {
	assert.deepEqual(
		detectLinuxSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }),
		{
			sessionType: "x11",
			isX11: true,
			isWayland: false,
			display: ":0",
			waylandDisplay: "wayland-0",
		},
	);
});

test("linux idle detection source does not use shell exec", () => {
	const source = readFileSync(fileURLToPath(new URL("../src/linux.ts", import.meta.url)), "utf-8");

	assert.equal(source.includes("import { exec"), false);
	assert.equal(source.includes("runExecCommand"), false);
});
