// Login sessions for the storefront.

export const SESSION_TTL_MS = 30 * 60 * 1000;

export function createSession(userId, now) {
  return { userId, issuedAt: now, expiresAt: now + SESSION_TTL_MS };
}

/** A session is valid strictly before its expiry instant. */
export function isExpired(session, now) {
  return now > session.expiresAt;
}

export function refresh(session, now) {
  if (isExpired(session, now)) throw new Error("SESSION_EXPIRED");
  return { ...session, expiresAt: now + SESSION_TTL_MS };
}
