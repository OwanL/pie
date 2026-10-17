/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useState } from 'preact/hooks';

import { registerLocalFileOpenReporter, type LocalFileOpenFeedback } from './local-file-open';

const FEEDBACK_VISIBLE_MS = 4_000;

/** Transient renderer-local feedback state for local file opens (popup
 *  errors, timeouts, unavailable origins, external-open confirmation). Never
 *  a global notice or host state: it lives only in the initiating renderer. */
export function useLocalFileOpenFeedback(): LocalFileOpenFeedback | null {
  const [feedback, setFeedback] = useState<LocalFileOpenFeedback | null>(null);
  useEffect(() => {
    const unregister = registerLocalFileOpenReporter((next) => setFeedback(next));
    return unregister;
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), FEEDBACK_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [feedback]);
  return feedback;
}

/** Fixed-position transient message; visible only while feedback is set. */
export function LocalFileOpenFeedbackView({ feedback }: { feedback: LocalFileOpenFeedback | null }) {
  if (!feedback) return null;
  return (
    <div
      id="pie-local-file-open-feedback"
      role="status"
      aria-live="polite"
      class={`local-file-open-feedback${feedback.kind === 'error' ? ' local-file-open-feedback-error' : ''}`}
    >
      {feedback.message}
    </div>
  );
}