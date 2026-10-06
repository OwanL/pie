export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
