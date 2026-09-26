import * as path from 'node:path';

export interface CliOptions {
  exportPath?: string;
  storageDir?: string;
  dbPath?: string;
  exportsDir?: string;
  name?: string;
  help: boolean;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function resolvePathArg(value: string): string {
  return path.resolve(process.cwd(), value);
}

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--export':
        options.exportPath = resolvePathArg(requireValue('--export', argv[index + 1]));
        index += 1;
        break;
      case '--storage-dir':
        options.storageDir = resolvePathArg(requireValue('--storage-dir', argv[index + 1]));
        index += 1;
        break;
      case '--db':
        options.dbPath = resolvePathArg(requireValue('--db', argv[index + 1]));
        index += 1;
        break;
      case '--exports-dir':
        options.exportsDir = resolvePathArg(requireValue('--exports-dir', argv[index + 1]));
        index += 1;
        break;
      case '--name':
        options.name = requireValue('--name', argv[index + 1]);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.exportPath && options.storageDir) {
    throw new Error('Use either --export or --storage-dir, not both.');
  }

  return options;
}

export function formatUsage(command: string, summary: string, extraLines: string[] = []): string {
  const lines = [
    summary,
    '',
    `Usage: ${command} [options]`,
    '',
    'Source options:',
    '  --export <path>       Read an explicit private run-analytics export JSON.',
    '  --storage-dir <path>  Read analytics directly from a run store directory.',
    '',
    'Common options:',
    '  --db <path>           DuckDB database path.',
    '  --exports-dir <path>  Directory for generated staging exports.',
    '  --name <query>        Named SQL query to run.',
    '  --help                Show this help message.',
  ];

  if (extraLines.length > 0) {
    lines.push('', ...extraLines);
  }

  return lines.join('\n');
}
