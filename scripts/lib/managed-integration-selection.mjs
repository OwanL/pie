import path from 'node:path';

/** Explicit subordinate evidence only; never discovers, acquires or qualifies inputs. */
export function parseManagedIntegrationSelection(argv) {
  const result = {};
  for (const [flag, key] of [
    ['--managed-stage', 'stageRoot'],
    ['--managed-qualification-receipt', 'receiptPath'],
  ]) {
    const positions = argv.flatMap((arg, index) => arg === flag || arg.startsWith(`${flag}=`) ? [index] : []);
    if (positions.length > 1) throw new Error(`${flag} may only be supplied once.`);
    if (positions.length === 0) continue;
    const index = positions[0];
    const value = argv[index] === flag ? argv[index + 1] : argv[index].slice(flag.length + 1);
    if (!value || !path.isAbsolute(value)) throw new Error(`${flag} requires an absolute path.`);
    result[key] = path.resolve(value);
  }
  if (Object.keys(result).length === 0) return undefined;
  if (!result.stageRoot || !result.receiptPath) {
    throw new Error('--managed-stage and --managed-qualification-receipt must be supplied together.');
  }
  return result;
}
