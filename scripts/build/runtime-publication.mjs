import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from '../../application/hosts/vscode/runtime/runtime-generations.cjs';
import ts from 'typescript';

export const { publishRuntimeGeneration, resolveRuntimeGeneration } = runtime;
// The runtime bootstrap assets moved with the host package owner (planned
// distribution root application/hosts/vscode).
const bootstrapSource = fileURLToPath(new URL('../../application/hosts/vscode/runtime/', import.meta.url));
const bootstrapFiles = ['bootstrap.cjs', 'runtime-generations.cjs', 'windows-runtime-lock.cjs'];
function loaderHash(files, contents) {
  const hash = createHash('sha256');
  files.forEach((name, index) => hash.update(name).update('\0').update(contents[index]).update('\0'));
  return hash.digest('hex');
}

// Capabilities are data, not a reason to execute installed JavaScript. Unknown
// declarations fail closed; legacy loaders have no v2 namespace/lock contract.
function readCapabilities(source) {
  const file = ts.createSourceFile('installed.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fail = () => { throw new Error('Installed startup loader capability declarations are unsupported or ambiguous.'); };
  if (file.parseDiagnostics.length) fail();
  const names = ['RUNTIME_DIRECTORY', 'RUNTIME_LOCK_PROTOCOL'];
  const values = new Map();
  let exported;
  const isExports = node => ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'module' && node.name.text === 'exports';
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !names.includes(declaration.name.text)) continue;
        if (!(statement.declarationList.flags & ts.NodeFlags.Const) || values.has(declaration.name.text)
          || !declaration.initializer || !ts.isStringLiteral(declaration.initializer)) fail();
        values.set(declaration.name.text, declaration.initializer.text);
      }
    }
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && isExports(statement.expression.left)) {
      const assignment = statement.expression;
      if (exported || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        || !ts.isObjectLiteralExpression(assignment.right)) fail();
      exported = assignment;
    }
  }
  // Refuse alternate exports writes (including nested/computed access), aliases,
  // and assignments to capability names rather than attempting JS evaluation.
  const visit = node => {
    if (ts.isIdentifier(node) && ['module', 'exports'].includes(node.text)) {
      if (!(isExports(node.parent) && node.parent === exported?.left)) fail();
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && ts.isIdentifier(node.left) && names.includes(node.left.text)) fail();
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!exported) fail();
  const properties = new Map();
  for (const property of exported.right.properties) {
    if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      || !ts.isIdentifier(property.name) || properties.has(property.name.text)) fail();
    properties.set(property.name.text, property);
  }
  for (const name of names) {
    const property = properties.get(name);
    if (!values.has(name) || !property || !(ts.isShorthandPropertyAssignment(property)
      || (ts.isIdentifier(property.initializer) && property.initializer.text === name))) fail();
  }
  const property = properties.get('SUPPORTED_MANIFEST_SCHEMAS');
  const call = property && ts.isPropertyAssignment(property) && property.initializer;
  if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1
    || !ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression)
    || call.expression.expression.text !== 'Object' || call.expression.name.text !== 'freeze'
    || !ts.isArrayLiteralExpression(call.arguments[0])) fail();
  const schemas = call.arguments[0].elements.map(element => {
    if (!ts.isNumericLiteral(element) || !Number.isSafeInteger(Number(element.text)) || Number(element.text) < 1) fail();
    return Number(element.text);
  });
  if (!schemas.length || new Set(schemas).size !== schemas.length) fail();
  return { directory: values.get(names[0]), protocol: values.get(names[1]), schemas };
}

/** Read capabilities only from the selected, content-bound installed helper.
 * Never execute bootstrap.cjs: it is the activation entrypoint. */
export async function assertRuntimeBootstrapSupportsSchema({ extensionDir, schema, directory = runtime.RUNTIME_DIRECTORY, protocol = runtime.RUNTIME_LOCK_PROTOCOL }) {
  try {
    const [pkg, sourcePkg] = await Promise.all([
      readFile(path.join(extensionDir, 'package.json'), 'utf8').then(JSON.parse),
      readFile(path.join(bootstrapSource, '..', 'package.json'), 'utf8').then(JSON.parse),
    ]);
    if (['publisher', 'name', 'version'].some(key => pkg[key] !== sourcePkg[key])) {
      throw new Error('Installed extension identity does not match the source package.');
    }
    if (pkg.pieRuntimeBootstrap !== 1 || typeof pkg.main !== 'string'
      || !/^\.\/(?:runtime|pie-bootstrap\/[0-9a-f]{64})\/bootstrap\.cjs$/u.test(pkg.main)) {
      throw new Error('Installed startup loader selection is not canonical.');
    }
    let capabilities = { directory: 'pie-runtime', protocol: undefined, schemas: [1] };
    if (pkg.main !== './runtime/bootstrap.cjs') {
      const directory = path.join(extensionDir, path.dirname(pkg.main));
      const files = bootstrapFiles.slice(0, 2);
      const contents = await Promise.all(files.map(name => readFile(path.join(directory, name))));
      let matches = loaderHash(files, contents) === path.basename(directory);
      if (!matches) {
        try {
          contents.push(await readFile(path.join(directory, bootstrapFiles[2])));
          matches = loaderHash(bootstrapFiles, contents) === path.basename(directory);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (!matches) throw new Error('Installed startup loader hash mismatch.');
      capabilities = readCapabilities(contents[1].toString('utf8'));
    }
    if (!capabilities.schemas.includes(schema)) {
      throw new Error(`Installed startup loader does not support runtime manifest schema ${schema}.`);
    }
    if (capabilities.directory !== directory || capabilities.protocol !== protocol) {
      throw new Error('Installed startup loader runtime directory or lock protocol is incompatible.');
    }
  } catch (error) {
    throw new Error(`${error.message} Use --activate to upgrade the startup loader before publication.`, { cause: error });
  }
}

export async function hasRuntimeBootstrap(extensionDir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
    return pkg.pieRuntimeBootstrap === 1
      && typeof pkg.main === 'string'
      && /^\.\/(?:runtime|pie-bootstrap\/[0-9a-f]{64})\/bootstrap\.cjs$/u.test(pkg.main)
      && (await readFile(path.join(extensionDir, pkg.main))).length > 0
      && (await readFile(path.join(extensionDir, path.dirname(pkg.main), 'runtime-generations.cjs'))).length > 0;
  } catch {
    return false;
  }
}

/** One-time loader migration, also used for explicit loader upgrades. Never
 * replace out/ or a loaded bootstrap. Only a complete immutable loader is
 * selected by the manifest that VS Code will read at its next startup. */
export async function installRuntimeBootstrap({ extensionDir, pkg, beforeSwitch }) {
  const contents = await Promise.all(bootstrapFiles.map(name => readFile(path.join(bootstrapSource, name))));
  const hash = createHash('sha256');
  bootstrapFiles.forEach((name, index) => hash.update(name).update('\0').update(contents[index]).update('\0'));
  const generation = hash.digest('hex');
  const relativeDir = `pie-bootstrap/${generation}`;
  const destination = path.join(extensionDir, relativeDir);
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
    await Promise.all(bootstrapFiles.map((name, index) => writeFile(path.join(staging, name), contents[index])));
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      for (let index = 0; index < bootstrapFiles.length; index++) {
        if (!(await readFile(path.join(destination, bootstrapFiles[index]))).equals(contents[index])) throw error;
      }
    }
    // Publication and verified selection must complete before changing main.
    if (beforeSwitch) await beforeSwitch();
    const installed = JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
    if (['publisher', 'name', 'version'].some(key => installed[key] !== pkg[key])) {
      throw new Error('Installed extension identity changed during bootstrap installation.');
    }
    const manifest = JSON.stringify({ ...pkg, main: `./${relativeDir}/bootstrap.cjs`, pieRuntimeBootstrap: 1 }, null, 2) + '\n';
    const manifestStaging = path.join(extensionDir, `.package-${randomUUID()}.json`);
    let ownsManifestStaging = false;
    try {
      const manifestHandle = await open(manifestStaging, 'wx');
      ownsManifestStaging = true;
      try {
        await manifestHandle.writeFile(manifest);
      } finally {
        await manifestHandle.close();
      }
      const manifestPath = path.join(extensionDir, 'package.json');
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(manifestStaging, manifestPath);
          break;
        } catch (error) {
          if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
          // Windows can refuse replacement while another invocation reads or
          // selects the same manifest. An identical selection is already done.
          if (await readFile(manifestPath, 'utf8') === manifest) break;
          if (attempt === 9) throw error;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    } finally {
      if (ownsManifestStaging) await rm(manifestStaging, { force: true });
    }
    return generation;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
