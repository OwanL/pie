export { CUSTOM_SENTINEL } from '../../../extension/src/shared/ask-user-sentinel.js';

export interface ReviewHumanVerificationMetadata {
  purpose: 'review_human_verification';
  /** Identifies the reviewed session for display/audit only; never a routing key. */
  targetSessionId: string;
  targetSessionPath: string;
  criterionId: string;
  domain: string;
  expectedObservation: string;
}

export const askUserSchema = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The question to present to the user. One sentence, focused.',
    },
    options: {
      type: 'array',
      minItems: 0,
      maxItems: 6,
      description: 'Preset answers the user can pick in one click.',
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
    reviewMeta: {
      type: 'object',
      description: 'Optional review-only label for the reviewed session. It does not change prompt routing.',
      properties: {
        purpose: { enum: ['review_human_verification'] },
        targetSessionId: { type: 'string' },
        targetSessionPath: { type: 'string' },
        criterionId: { type: 'string' },
        domain: { type: 'string' },
        expectedObservation: { type: 'string' },
      },
      required: ['purpose', 'targetSessionId', 'targetSessionPath', 'criterionId', 'domain', 'expectedObservation'],
      additionalProperties: false,
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
  /** Review display/audit metadata; prompt routing remains with the caller. */
  reviewMeta?: ReviewHumanVerificationMetadata;
}
