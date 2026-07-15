/**
 * Redact common credential forms from diagnostic text while preserving the
 * surrounding error context. Pure so log and host-to-webview boundaries can
 * share one policy.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[private key redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(["']?\b(?:api[_-]?key|authorization|password|passwd|secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|credential)\b["']?\s*[:=]\s*)(["']?)([^"'&\s,;}]+)/gi, '$1$2[redacted]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[credential redacted]')
    .replace(/\[redacted\](?:\s+\[redacted\])+/g, '[redacted]');
}
