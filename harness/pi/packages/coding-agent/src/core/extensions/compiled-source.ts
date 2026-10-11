import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as TypeScript from "typescript";
import type { ExtensionFactory } from "./types.ts";

const maxSourceBytes = 2 * 1024 * 1024;
const cacheDir = path.join(tmpdir(), "pi-extension-provenance-v1");
const require = createRequire(import.meta.url);
const policy = `v3:${require("typescript/package.json").version}:esbuild=0.28.1:node22:treeShaking=false:ignoreAnnotations:keepNames:splitting=false:node/import:main`;
const globals = new Set(["__dirname", "__filename", "require", "module", "exports"]);

/** Pure code only: no factories, graph, discovery or sourceInfo survives a pass. */
export async function rewriteCompiledSource(filename: string, sourceBytes: Buffer): Promise<string | undefined> {
	if (sourceBytes.byteLength > maxSourceBytes) return undefined;
	const key = createHash("sha256")
		.update(policy)
		.update("\0")
		.update(filename)
		.update("\0")
		.update(sourceBytes)
		.digest("hex");
	const cachePath = path.join(cacheDir, `${key}.json`);
	try {
		if ((await stat(cachePath)).size <= maxSourceBytes * 2) {
			const cached: unknown = JSON.parse(await readFile(cachePath, "utf8"));
			if (
				cached &&
				typeof cached === "object" &&
				"key" in cached &&
				cached.key === key &&
				"code" in cached &&
				"hash" in cached
			) {
				const code = cached.code;
				if (
					(typeof code === "string" || code === null) &&
					cached.hash === createHash("sha256").update(JSON.stringify(code)).digest("hex")
				) {
					return code === null ? undefined : code;
				}
			}
		}
	} catch {
		/* Unavailable/malformed cache is a miss, never a discovery failure. */
	}
	const source = sourceBytes.toString("utf8");
	const ts: typeof TypeScript = require("typescript");
	const kind = /\.[cm]?tsx$/.test(filename)
		? ts.ScriptKind.TSX
		: /\.[cm]?ts$/.test(filename)
			? ts.ScriptKind.TS
			: ts.ScriptKind.JS;
	const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind);
	const edits: { start: number; end: number; text: string }[] = [];
	let unsupported = false;
	const normalized = filename.replace(/\\/g, "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase());
	const literals: Record<string, string> = {
		url: pathToFileURL(filename).href,
		dirname: path.posix.dirname(normalized),
		filename: normalized,
	};
	function binding(name: TypeScript.Node): void {
		if (ts.isIdentifier(name) && globals.has(name.text)) unsupported = true;
		else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
			for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name);
		}
	}
	function assignmentTarget(node: TypeScript.Node): boolean {
		const parent = node.parent;
		if (
			ts.isBinaryExpression(parent) &&
			parent.left === node &&
			parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		)
			return true;
		// Follow only the target side of destructuring; keys and default values are reads.
		if (
			(ts.isParenthesizedExpression(parent) && parent.expression === node) ||
			(ts.isPropertyAssignment(parent) && parent.initializer === node) ||
			(ts.isShorthandPropertyAssignment(parent) && parent.name === node) ||
			(ts.isSpreadAssignment(parent) && parent.expression === node) ||
			(ts.isSpreadElement(parent) && parent.expression === node) ||
			ts.isArrayLiteralExpression(parent) ||
			ts.isObjectLiteralExpression(parent)
		)
			return assignmentTarget(parent);
		return false;
	}
	function replace(node: TypeScript.Node, text: string): void {
		edits.push({ start: node.getStart(file), end: node.end, text });
	}
	function visit(node: TypeScript.Node): void {
		if (
			ts.isVariableDeclaration(node) ||
			ts.isParameter(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isClassDeclaration(node) ||
			ts.isClassExpression(node) ||
			ts.isImportClause(node) ||
			ts.isImportSpecifier(node) ||
			ts.isNamespaceImport(node) ||
			ts.isImportEqualsDeclaration(node)
		) {
			if (node.name) binding(node.name);
		}
		if (ts.isDecorator(node)) unsupported = true;
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isMetaProperty(node.expression) &&
			node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
		) {
			if (!Object.hasOwn(literals, node.name.text)) unsupported = true;
			else replace(node, JSON.stringify(literals[node.name.text]));
			return;
		}
		if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) unsupported = true;
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require"))
		) {
			if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) unsupported = true;
		}
		if (ts.isIdentifier(node) && globals.has(node.text)) {
			const parent = node.parent;
			const propertyName =
				(ts.isPropertyAccessExpression(parent) ||
					ts.isPropertyAssignment(parent) ||
					ts.isMethodDeclaration(parent) ||
					ts.isPropertyDeclaration(parent) ||
					ts.isPropertySignature(parent) ||
					ts.isMethodSignature(parent)) &&
				parent.name === node;
			if (
				propertyName ||
				(ts.isBindingElement(parent) && parent.propertyName === node) ||
				(ts.isImportSpecifier(parent) && parent.propertyName === node)
			)
				return;
			if (node.text === "module") {
				// esbuild's CJS wrapper preserves exports, not Jiti's original Module metadata.
				if (
					!(
						(ts.isPropertyAccessExpression(parent) &&
							parent.expression === node &&
							parent.name.text === "exports") ||
						(ts.isElementAccessExpression(parent) &&
							parent.expression === node &&
							ts.isStringLiteral(parent.argumentExpression) &&
							parent.argumentExpression.text === "exports")
					)
				)
					unsupported = true;
			} else if (node.text === "require") {
				if (!ts.isCallExpression(parent) || parent.expression !== node) unsupported = true;
			} else if (node.text !== "exports") {
				// Assignment/update/delete of provenance globals is not equivalent to a literal.
				if (
					assignmentTarget(node) ||
					ts.isPrefixUnaryExpression(parent) ||
					ts.isPostfixUnaryExpression(parent) ||
					ts.isDeleteExpression(parent)
				)
					unsupported = true;
				const literal = JSON.stringify(literals[node.text === "__dirname" ? "dirname" : "filename"]);
				replace(node, ts.isShorthandPropertyAssignment(parent) ? `${node.text}: ${literal}` : literal);
				return;
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	let code: string | null = unsupported ? null : source;
	if (code !== null)
		for (const edit of edits.sort((a, b) => b.start - a.start))
			code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
	try {
		await mkdir(cacheDir, { recursive: true });
		await writeFile(
			cachePath,
			JSON.stringify({ key, code, hash: createHash("sha256").update(JSON.stringify(code)).digest("hex") }),
			{ mode: 0o600 },
		);
	} catch {
		/* Cache is optional; never sweep or delete other invocations' files. */
	}
	return code === null ? undefined : code;
}

/** Approved sole native dynamic-import seam. Unique URLs are for one-use callers only. */
export async function importCompiledFactory(url: string, commonJS: boolean): Promise<ExtensionFactory> {
	const module: unknown = await import(url);
	let factory: unknown = module;
	if (factory && typeof factory === "object" && "default" in factory) {
		const value = factory.default;
		factory =
			"__esModule" in factory &&
			factory.__esModule &&
			value &&
			(typeof value === "object" || typeof value === "function") &&
			"default" in value &&
			typeof value.default === "function"
				? value.default
				: value;
		// esbuild exposes CJS module.exports as the ESM default. Match Jiti default:true.
		if (commonJS && factory && typeof factory === "object" && "default" in factory) {
			const value = factory.default;
			factory =
				"__esModule" in factory &&
				factory.__esModule &&
				value &&
				(typeof value === "object" || typeof value === "function") &&
				"default" in value &&
				typeof value.default === "function"
					? value.default
					: value;
		}
	}
	if (typeof factory !== "function") throw new Error("Extension does not export a valid factory function");
	return factory as ExtensionFactory;
}
