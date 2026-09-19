export interface ContactCandidate { id: string; enabled: boolean; identifiers?: string[]; }
export interface ContactHints { explicitContactId?: string; assigneeId?: string; reporterId?: string; defaultContactId?: string; }
export function selectTrustedContact(contacts: readonly ContactCandidate[], hints: ContactHints): string | null {
  const enabled = contacts.filter(contact => contact.enabled);
  const byId = (id?: string) => id && enabled.some(contact => contact.id === id) ? id : null;
  const byIdentifier = (identifier?: string) => identifier ? enabled.find(contact => contact.identifiers?.some(value => value.toLowerCase() === identifier.toLowerCase()))?.id ?? null : null;
  return byId(hints.explicitContactId) ?? byIdentifier(hints.assigneeId) ?? byIdentifier(hints.reporterId) ?? byId(hints.defaultContactId) ?? null;
}
