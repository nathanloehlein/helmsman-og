const DEFAULT_MAX_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1_024) : null;
}

function messageFromBody(body: string): string {
  try {
    const parsed = record(JSON.parse(body));
    const nestedError = record(parsed?.error);
    const direct = boundedText(parsed?.message) ?? boundedText(parsed?.error) ?? boundedText(nestedError?.message);
    if (direct) return direct;
    const errorMessages = Array.isArray(parsed?.errorMessages)
      ? parsed.errorMessages.map(boundedText).filter((value): value is string => value !== null)
      : [];
    if (errorMessages.length) return errorMessages.join('; ').slice(0, 1_024);
    const errors = record(parsed?.errors);
    const values = errors ? Object.values(errors).map(boundedText).filter((value): value is string => value !== null) : [];
    if (values.length) return values.join('; ').slice(0, 1_024);
  } catch {}
  return boundedText(body) ?? 'request failed';
}

async function readBody(response: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) return 'response body too large';
  if (!response.body) return 'request failed';
  const reader = response.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('response body timed out')), timeoutMs);
  });
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timer]);
      if (chunk.done) return body;
      size += chunk.value.byteLength;
      if (size > maxBytes) return 'response body too large';
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    void reader.cancel().catch(() => {});
  }
}

export async function readHttpFailure(response: Response, options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return 'request failed';
  try {
    return messageFromBody(await readBody(response, maxBytes, timeoutMs));
  } catch {
    return 'response body unavailable';
  }
}
