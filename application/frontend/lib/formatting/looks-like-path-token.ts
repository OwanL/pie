export function splitQuotedToken(value: string): { text: string; leadingQuote?: string; trailingQuote?: string } {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return {
      text: trimmed.slice(1, -1),
      leadingQuote: trimmed[0],
      trailingQuote: trimmed[trimmed.length - 1],
    };
  }

  return { text: trimmed };
}

export function unwrapQuotedToken(value: string): string {
  return splitQuotedToken(value).text;
}

export function looksLikePathToken(value: string): boolean {
  const token = unwrapQuotedToken(value);
  if (!token || token === '|' || token === '||' || token === '&&' || token === ';' || token.startsWith('-')) {
    return false;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) && !/^file:\/\//i.test(token)) {
    return false;
  }

  return token.includes('/')
    || token.includes('\\')
    || /^\.{1,2}$/.test(token)
    || /^\.{1,2}[\\/]/.test(token)
    || /^~(?:[\\/]|$)/.test(token)
    || /^[A-Za-z]:[\\/]/.test(token)
    || /^file:\/\//i.test(token)
    || /^\\\\/.test(token)
    || /^\.[A-Za-z0-9._-]+$/.test(token)
    || /^[A-Za-z0-9._-]*[A-Za-z_][A-Za-z0-9._-]*\.[A-Za-z0-9_-]{1,8}$/.test(token);
}