/** Request ids only need to be unique inside one window session. */
export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}
