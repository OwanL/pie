export { CUSTOM_SENTINEL } from '../../../extension/src/shared/ask-user-sentinel.js';

export const askUserSchema = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The question to present to the user. One sentence, focused; never empty.',
    },
    options: {
      type: 'array',
      minItems: 0,
      maxItems: 6,
      description: 'Preset answers the user can pick in one click. Pass [] for a free-form question: with no preset options the user always gets a free-form input, even when allowCustom is false.',
      items: {
        type: 'string',
        description: 'A suggested short answer (~1–6 words).',
      },
    },
    allowCustom: {
      type: 'boolean',
      default: true,
      description: 'Whether the user may type a free-form answer instead of picking an option.',
    },
    context: {
      type: 'string',
      description: 'Optional one-paragraph rationale shown under the question.',
    },
  },
  required: ['question', 'options'],
  additionalProperties: false,
} as const;

export interface AskUserInput {
  question: string;
  options: string[];
  allowCustom?: boolean;
  context?: string;
}
