export function shortVoyageId(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) {
    return value.replaceAll('-', '').slice(0, 12);
  }
  const sourceId = /^(slack|github|created)-([a-f\d]{12,})$/i.exec(value);
  return sourceId ? `${sourceId[1]}-${sourceId[2]?.slice(0, 12)}` : value;
}
