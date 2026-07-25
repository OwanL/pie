import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const askModuleUrl = pathToFileURL(path.resolve(__dirname, '../src/ask.ts')).href;
const typesModuleUrl = pathToFileURL(path.resolve(__dirname, '../src/types.ts')).href;

type AskResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: { answer: string; source: 'option' | 'custom' | 'cancelled'; cancelled: boolean; targetSessionId?: string };
  isError: false;
};

type AskModule = {
  runAsk: (input: any, port: any) => Promise<AskResult>;
};

type TypesModule = {
  CUSTOM_SENTINEL: string;
};

async function loadAsk(): Promise<AskModule & TypesModule> {
  const [ask, types] = await Promise.all([
    import(askModuleUrl) as Promise<AskModule>,
    import(typesModuleUrl) as Promise<TypesModule>,
  ]);
  return { ...ask, ...types };
}

function makePort(opts: { selectResult?: string; inputResult?: string; toolCallId?: string } = {}) {
  const calls: Array<{ method: 'select' | 'input'; args: unknown[] }> = [];
  const signal = new AbortController().signal;
  const port = {
    signal,
    toolCallId: opts.toolCallId,
    ui: {
      select: async (...args: unknown[]) => {
        calls.push({ method: 'select', args });
        return opts.selectResult;
      },
      input: async (...args: unknown[]) => {
        calls.push({ method: 'input', args });
        return opts.inputResult;
      },
    },
  };
  return { port, calls, signal };
}

describe('runAsk', () => {
  test('returns a preset option answer without opening the custom input prompt', async () => {
    const { runAsk, CUSTOM_SENTINEL } = await loadAsk();
    const { port, calls, signal } = makePort({ selectResult: 'camelCase' });

    const result = await runAsk({ question: 'Which style?', options: ['camelCase', 'snake_case'] }, port);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'camelCase' }],
      details: { answer: 'camelCase', source: 'option', cancelled: false },
      isError: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'select');
    assert.deepEqual(calls[0].args, ['Which style?', ['camelCase', 'snake_case', CUSTOM_SENTINEL], { signal, allowCustom: true }]);
  });

  test('treats a value returned outside the preset options as an inline custom answer', async () => {
    const { runAsk } = await loadAsk();
    const { port, calls } = makePort({ selectResult: 'kebab-case' });

    const result = await runAsk({ question: 'Which style?', options: ['camelCase', 'snake_case'] }, port);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'kebab-case' }],
      details: { answer: 'kebab-case', source: 'custom', cancelled: false },
      isError: false,
    });
    assert.equal(calls.length, 1);
  });

  test('opens a custom input prompt when the user picks the sentinel option', async () => {
    const { runAsk, CUSTOM_SENTINEL } = await loadAsk();
    const { port, calls, signal } = makePort({ selectResult: CUSTOM_SENTINEL, inputResult: '  kebab-case  ' });

    const result = await runAsk({ question: 'Which style?', options: ['camelCase'] }, port);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'kebab-case' }],
      details: { answer: 'kebab-case', source: 'custom', cancelled: false },
      isError: false,
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ['Your answer', undefined, { signal }]);
  });

  test('treats cancelling the custom input prompt as a non-error cancellation result', async () => {
    const { runAsk, CUSTOM_SENTINEL } = await loadAsk();
    const { port } = makePort({ selectResult: CUSTOM_SENTINEL, inputResult: '   ' });

    const result = await runAsk({ question: 'Which style?', options: ['camelCase'] }, port);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: '[user cancelled the question]' }],
      details: { answer: '', source: 'cancelled', cancelled: true },
      isError: false,
    });
  });

  test('treats cancelling the select prompt as a non-error cancellation result', async () => {
    const { runAsk } = await loadAsk();
    const { port } = makePort({ selectResult: undefined });

    const result = await runAsk({ question: 'Which style?', options: ['camelCase'] }, port);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: '[user cancelled the question]' }],
      details: { answer: '', source: 'cancelled', cancelled: true },
      isError: false,
    });
  });

  test('retains review provenance when the reviewer cancels verification', async () => {
    const { runAsk } = await loadAsk();
    const { port } = makePort({ selectResult: undefined });
    const reviewMeta = {
      purpose: 'review_human_verification' as const,
      targetSessionId: 'reviewed-session-id',
      targetSessionPath: '/sessions/reviewed.jsonl',
      criterionId: 'criterion-visual',
      domain: 'visual appearance',
      expectedObservation: 'The dialog is usable.',
    };

    const result = await runAsk({ question: 'Did it work?', options: ['Yes'], reviewMeta }, port);

    assert.deepEqual(result.details, {
      answer: '', source: 'cancelled', cancelled: true, targetSessionId: 'reviewed-session-id',
    });
  });

  test('filters a sentinel-shaped preset option so it cannot collide with custom input metadata', async () => {
    const { runAsk, CUSTOM_SENTINEL } = await loadAsk();
    const { port, calls } = makePort({ selectResult: 'camelCase' });

    const result = await runAsk({ question: 'Which style?', options: [CUSTOM_SENTINEL, 'camelCase'], allowCustom: false }, port);

    assert.equal(result.content[0].text, 'camelCase');
    assert.deepEqual(calls[0].args[1], ['camelCase']);
  });

  test('still offers a custom answer when no preset options are available', async () => {
    const { runAsk, CUSTOM_SENTINEL } = await loadAsk();
    const { port, calls } = makePort({ selectResult: CUSTOM_SENTINEL, inputResult: 'custom answer' });

    const result = await runAsk({ question: 'What should I do?', options: [], allowCustom: false }, port);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'custom answer' }],
      details: { answer: 'custom answer', source: 'custom', cancelled: false },
      isError: false,
    });
    assert.deepEqual(calls[0].args[1], [CUSTOM_SENTINEL]);
  });

  test('passes the question as the select title and renders context separately', async () => {
    const { runAsk, CUSTOM_SENTINEL } = await loadAsk();
    const { port, calls, signal } = makePort({ selectResult: 'snake_case' });

    const result = await runAsk({
      question: 'Which style?',
      context: 'This affects generated file names.',
      options: ['camelCase', 'snake_case'],
      allowCustom: false,
    }, port);

    assert.equal(result.content[0].text, 'snake_case');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args[0], 'Which style?');
    assert.deepEqual(calls[0].args[1], ['camelCase', 'snake_case']);
    assert.equal((calls[0].args[1] as string[]).includes(CUSTOM_SENTINEL), false);
    assert.deepEqual(calls[0].args[2], { signal, allowCustom: false });
  });

  test('forwards toolCallId to select and input prompts', async () => {
    const { runAsk, CUSTOM_SENTINEL } = await loadAsk();
    const { port, calls, signal } = makePort({ selectResult: CUSTOM_SENTINEL, inputResult: 'custom', toolCallId: 'tc-123' });

    await runAsk({ question: 'Which style?', options: ['camelCase'] }, port);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['Which style?', ['camelCase', CUSTOM_SENTINEL], { signal, allowCustom: true, toolCallId: 'tc-123' }]);
    assert.deepEqual(calls[1].args, ['Your answer', undefined, { signal, toolCallId: 'tc-123' }]);
  });

  test('forwards review metadata through select and custom input without changing tool ownership', async () => {
    const { runAsk, CUSTOM_SENTINEL } = await loadAsk();
    const { port, calls, signal } = makePort({ selectResult: CUSTOM_SENTINEL, inputResult: 'Observed failure', toolCallId: 'reviewer-tool' });
    const reviewMeta = {
      purpose: 'review_human_verification' as const,
      targetSessionId: 'reviewed-session-id',
      targetSessionPath: '/sessions/reviewed.jsonl',
      criterionId: 'criterion-visual',
      domain: 'visual appearance',
      expectedObservation: 'The dialog is usable.',
    };

    const result = await runAsk({ question: 'Did the dialog work?', options: ['Yes'], reviewMeta }, port);

    assert.deepEqual(calls[0].args, ['Did the dialog work?', ['Yes', CUSTOM_SENTINEL], {
      signal, allowCustom: true, toolCallId: 'reviewer-tool', reviewMeta,
    }]);
    assert.deepEqual(calls[1].args, ['Your answer', undefined, {
      signal, toolCallId: 'reviewer-tool', reviewMeta,
    }]);
    assert.equal(result.details.targetSessionId, 'reviewed-session-id');
  });
});
