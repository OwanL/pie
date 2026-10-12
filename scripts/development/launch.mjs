#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { withoutGitRepositoryEnv } from '../lib/git-environment.mjs';
import { developmentOutput } from '../build/build-development.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hostRoot = path.join(root, 'application/hosts/vscode');

export async function prepareDevelopment({ repositoryRoot = root, profileRoot, sourceEnvironment = process.env } = {}) {
  const identity = createHash('sha256').update(path.resolve(repositoryRoot).toLowerCase()).digest('hex').slice(0, 12);
  const base = sourceEnvironment.LOCALAPPDATA || path.join(os.homedir(), '.local/share');
  const profile = profileRoot ?? path.join(base, 'Pie', 'development', identity);
  const dirs = { providers: 'providers', agent: 'agent', auth: 'auth', data: 'data', sessions: 'data/sessions', sessionSettings: 'data/state/session-settings', legacySessionSettings: 'agent/data/outcomes/session-reviews', home: 'home', temp: 'temp', vscode: 'vscode-user', extensions: 'vscode-extensions' };
  for (const value of Object.values(dirs)) await mkdir(path.join(profile, value), { recursive: true });
  const env = withoutPiHarnessEnv(withoutGitRepositoryEnv(sourceEnvironment));
  const productionPort = Number(sourceEnvironment.PIE_HOST_COORDINATOR_PORT) || 1996;
  let coordinatorPort = 24000 + parseInt(identity.slice(0, 4), 16) % 20000;
  if (coordinatorPort === productionPort) coordinatorPort += 2;
  const browserPort = coordinatorPort + 1;
  Object.assign(env, {
    PIE_DEVELOPMENT_PI_WORKSPACE: path.join(repositoryRoot, 'harness/pi'),
    PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK: '1',
    PIE_DEVELOPMENT_PROFILE_DIR: profile,
    PIE_HOST_PROFILE: `development-${identity}`,
    PIE_HOST_COORDINATOR_PORT: String(coordinatorPort),
    PI_CODING_AGENT_DIR: path.join(profile, dirs.agent),
    PI_CODING_AGENT_AUTH_DIR: path.join(profile, dirs.auth),
    PI_CODING_AGENT_SESSION_DIR: path.join(profile, dirs.sessions),
    PIE_DATA_DIR: path.join(profile, dirs.data),
    PIE_PROVIDER_CONFIG_DIR: path.join(profile, dirs.providers),
    // Match the neutral settings authority and keep migration fallback private
    // and initially empty; never read or scrub installed-host sidecars.
    PIE_SESSION_SETTINGS_DIR: path.join(profile, dirs.sessionSettings),
    PIE_LEGACY_SESSION_SETTINGS_DIR: path.join(profile, dirs.legacySessionSettings),
    HOME: path.join(profile, dirs.home), USERPROFILE: path.join(profile, dirs.home),
    TEMP: path.join(profile, dirs.temp), TMP: path.join(profile, dirs.temp), TMPDIR: path.join(profile, dirs.temp),
  });
  const settingsPath = path.join(profile, dirs.agent, 'settings.json');
  // Seed public checked-in defaults only, never production settings/auth/history.
  try { await readFile(settingsPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const defaults = JSON.parse(await readFile(path.join(repositoryRoot, 'settings.defaults.json'), 'utf8'));
    defaults.sessionDir = path.join(profile, dirs.sessions);
    defaults.skills = [path.join(repositoryRoot, 'harness/agent-instructions/skills')];
    // Remote optional packages are installed explicitly by a developer, not
    // silently acquired as a consequence of launching an empty profile.
    defaults.packages = [];
    await writeFile(settingsPath, `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx' });
    await copyFile(path.join(repositoryRoot, 'models.json'), path.join(profile, dirs.agent, 'models.json'));
  }
  const vscodeSettings = path.join(profile, dirs.vscode, 'User');
  await mkdir(vscodeSettings, { recursive: true });
  try { await writeFile(path.join(vscodeSettings, 'settings.json'), `${JSON.stringify({ 'pie.nodePath': process.execPath, 'pie.browserServer.port': browserPort })}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const extension = path.join(repositoryRoot, 'application/hosts/vscode/.cache/development-extension');
  await mkdir(path.join(extension, 'media'), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'application/hosts/vscode/package.json'), 'utf8'));
  manifest.main = './development.cjs';
  delete manifest.pieRuntimeBootstrap;
  delete manifest.scripts;
  delete manifest.dependencies;
  delete manifest.devDependencies;
  const output = path.join(repositoryRoot, 'application/hosts/vscode/out-dev');
  await writeFile(path.join(extension, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(path.join(repositoryRoot, 'application/hosts/vscode/media/icon.svg'), path.join(extension, 'media/icon.svg'));
  await writeFile(path.join(extension, 'development.cjs'), `'use strict';\nconst runtime=require(${JSON.stringify(path.join(output, 'extension.js'))});\nexports.activate=context=>runtime.activate(context,{runtimeOutDir:${JSON.stringify(output)},generation:null,publishedAt:0});\nexports.deactivate=()=>runtime.deactivate();\n`);
  await writeFile(path.join(extension, 'standalone.cjs'), `'use strict';\nconst runtime=require(${JSON.stringify(path.join(output, 'standalone.js'))});\nlet stopping=false;\nconst application=runtime.main(['--cwd',${JSON.stringify(repositoryRoot)}],{extensionPath:${JSON.stringify(path.join(repositoryRoot, 'application/hosts/vscode'))},runtimeOutputDirectory:${JSON.stringify(output)},dataRoot:${JSON.stringify(env.PIE_DATA_DIR)},browserServerSettings:{port:${browserPort},allowLan:false},installSignalHandlers:false});\nprocess.on('message',async message=>{if(message==='development:stop'&&!stopping){stopping=true;try{const app=await application;await app?.shutdown();process.disconnect();}catch(error){console.error(error);process.exitCode=1;}}});\napplication.catch(error=>{console.error(error);process.exitCode=1;process.disconnect?.();});\n`);
  return { env, profile, coordinatorPort, browserPort, extension, output };
}

export async function launchDevelopment(adapter, options = {}) {
  if (!['standalone', 'vscode'].includes(adapter)) throw new Error('Development adapter must be standalone or vscode.');
  const prepared = await prepareDevelopment(options);
  if (options.prepareOnly) return prepared;
  const executable = adapter === 'standalone' ? process.execPath : (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'code');
  const args = adapter === 'standalone'
    ? [path.join(prepared.extension, 'standalone.cjs')]
    : [...(process.platform === 'win32' ? ['/d', '/s', '/c', 'code'] : []), '--new-window', '--wait', '--user-data-dir', path.join(prepared.profile, 'vscode-user'), '--extensions-dir', path.join(prepared.profile, 'vscode-extensions'), `--extensionDevelopmentPath=${prepared.extension}`, root];
  console.log(`[development] ${adapter}; profile ${prepared.profile}. Installed Pie is not selected or changed.`);
  const child = spawn(executable, args, { cwd: root, env: prepared.env, stdio: adapter === 'standalone' ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', windowsHide: true });
  const stop = () => { if (adapter === 'standalone' && child.connected) child.send('development:stop'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Development ${adapter} exited ${code}. Reader gates are retained if teardown is uncertain.`)));
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const adapter = process.argv[2] || 'standalone';
  await launchDevelopment(adapter, { prepareOnly: process.argv.includes('--prepare') });
}
