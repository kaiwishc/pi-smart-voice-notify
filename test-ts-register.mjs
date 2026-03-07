import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks, stripTypeScriptTypes } from "node:module";

function maybeResolveTypeScript(specifier, parentURL) {
	if (!specifier.endsWith(".js")) {
		return null;
	}
	if (!(specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/"))) {
		return null;
	}

	const parentPath = parentURL ? dirname(fileURLToPath(parentURL)) : process.cwd();
	const tsPath = resolvePath(parentPath, specifier.replace(/\.js$/, ".ts"));
	if (!existsSync(tsPath)) {
		return null;
	}
	return pathToFileURL(tsPath).href;
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolvedTsUrl = maybeResolveTypeScript(specifier, context.parentURL);
		if (resolvedTsUrl) {
			return {
				shortCircuit: true,
				url: resolvedTsUrl,
			};
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (!url.endsWith(".ts")) {
			return nextLoad(url, context);
		}

		const source = readFileSync(new URL(url), "utf8");
		return {
			format: "module",
			shortCircuit: true,
			source: stripTypeScriptTypes(source, {
				mode: "transform",
				sourceUrl: url,
			}),
		};
	},
});
