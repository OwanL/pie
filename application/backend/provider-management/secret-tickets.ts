import { randomUUID } from 'node:crypto';
// Opaque execution resources only. Values never enter reducer state or event payloads.
const tickets = new Map<string, { value: string; generation: number; operationId: string }>();
export function createProviderSecretTicket(value: string, generation: number, operationId: string): string {
  const ticket = randomUUID();
  if (tickets.size >= 128) { const oldest = tickets.keys().next().value; if (oldest) tickets.delete(oldest); }
  tickets.set(ticket, { value, generation, operationId });
  return ticket;
}
export function consumeProviderSecretTicket(ticket: string, generation: number, operationId: string): string | undefined {
  const resource = tickets.get(ticket);
  tickets.delete(ticket);
  return resource?.generation === generation && resource.operationId === operationId ? resource.value : undefined;
}
export function discardProviderSecretTicket(ticket: string): void { tickets.delete(ticket); }
