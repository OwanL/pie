import { useEffect, useRef } from 'preact/hooks';

export function useSessionRecovery(
  backendReady: boolean,
  needsSessionRecovery: boolean,
  recoverySessionPath: string | null,
  notice: unknown,
  postMessage: (msg: { type: 'openSession'; sessionPath: string }) => void,
) {
  const recoveryRequestRef = useRef<{ path: string | null; lastSentAt: number }>({
    path: null,
    lastSentAt: 0,
  });

  useEffect(() => {
    if (!backendReady || !needsSessionRecovery || !recoverySessionPath || notice) {
      recoveryRequestRef.current = {
        path: null,
        lastSentAt: 0,
      };
      return;
    }

    const sendRecoveryRequest = () => {
      const now = Date.now();
      const { path, lastSentAt } = recoveryRequestRef.current;
      if (path === recoverySessionPath && now - lastSentAt < 2500) {
        return;
      }

      recoveryRequestRef.current = {
        path: recoverySessionPath,
        lastSentAt: now,
      };
      postMessage({ type: 'openSession', sessionPath: recoverySessionPath });
    };

    sendRecoveryRequest();
    const retryId = window.setInterval(sendRecoveryRequest, 2500);
    return () => window.clearInterval(retryId);
  }, [backendReady, needsSessionRecovery, recoverySessionPath, notice, postMessage]);
}
