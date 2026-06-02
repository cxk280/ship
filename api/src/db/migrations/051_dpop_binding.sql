-- Plugforge — DPoP sender-constrained access tokens (RFC 9449).
--
-- An access token may be bound to the public key the client proves possession of
-- at the token endpoint, via the JWK SHA-256 thumbprint (jkt, RFC 7638). When
-- bound, the token can only be used by presenting a fresh DPoP proof signed by
-- the matching private key — a captured token alone is useless.
--
-- This column is NULLABLE and additive: existing tokens and all plain
-- client_credentials / Bearer flows leave it NULL and behave exactly as before.

ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS dpop_jkt TEXT;

COMMENT ON COLUMN oauth_access_tokens.dpop_jkt IS
  'RFC 9449 DPoP binding: base64url JWK SHA-256 thumbprint (RFC 7638) of the proof key. NULL = plain Bearer token.';
