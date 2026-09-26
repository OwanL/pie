import type { ComputerAction, ComputerSequence } from './types.js';

export declare function actionDurationMs(action: ComputerAction): number;
export declare function estimateSequenceDuration(sequence: ComputerSequence): number;
export declare function abortError(): Error;
export declare function abortableSleep(ms: number, signal?: AbortSignal): Promise<void>;
export declare function runTimedSequence(sequence: ComputerSequence, executeAction: (action: ComputerAction, context: unknown) => Promise<void>, options?: { clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }; signal?: AbortSignal }): Promise<unknown[]>;
