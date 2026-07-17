export const ALLOWED_MODELS = ["umans-glm-5.2", "umans-kimi-k2.7"];

export function redact(value,secrets=[]) {
  let text=typeof value==="string"?value:JSON.stringify(value);
  for(const secret of secrets) if(secret) text=text.replaceAll(secret,"[REDACTED]");
  return text.replace(/(authorization|api[-_]?key|token|secret)(["'\s:=]+)[^\s,"'}]+/gi,"$1$2[REDACTED]");
}
