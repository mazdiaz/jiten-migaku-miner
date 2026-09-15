export function isOwner(identity: unknown, ownerId: string | undefined): boolean {
  return (
    typeof identity === "string" && /^\d+$/.test(identity) && !!ownerId && identity === ownerId
  );
}

export function isSameOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}
