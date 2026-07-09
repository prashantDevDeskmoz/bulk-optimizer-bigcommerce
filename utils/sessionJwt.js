const jwt = require("jsonwebtoken");

/** App session lifetime (1 day), in seconds */
const SESSION_TTL_SECONDS = 86400;

function storeHashFromSub(sub) {
  if (!sub || typeof sub !== "string") return null;
  const prefix = "stores/";
  return sub.startsWith(prefix) ? sub.slice(prefix.length) : null;
}

/**
 * Verifies BigCommerce load / callback JWT (signed_payload_jwt).
 * @see https://developer.bigcommerce.com/docs/integrations/apps/guide/callbacks
 */
function verifySignedPayloadJwt(token) {
  const secret = process.env.CLIENT_SECRET;
  const clientId = process.env.CLIENT_ID;
  if (!secret || !clientId) {
    throw new Error("CLIENT_SECRET and CLIENT_ID must be set");
  }
  // console.log("[verifySignedPayloadJwt] jwt.verify(token, secret):", jwt.verify(token, secret));
  return jwt.verify(token, secret, {
    clockTolerance : 60 // 60 seconds
  });                                             
}

function getSessionSigningSecret() {
  const secret = process.env.SESSION_JWT_SECRET || process.env.CLIENT_SECRET;
  if (!secret) {
    throw new Error("Set SESSION_JWT_SECRET (recommended) or CLIENT_SECRET");
  }
  return secret;
}

/**
 * Signs the app session JWT sent to the frontend after a valid load JWT.
 */
function createAppSessionToken({ storeHash, bcPayload }) {
  const secret = getSessionSigningSecret();
  return jwt.sign(
    {
      storeHash,
      bcUserId: bcPayload.user?.id ?? null,
    },
    secret,
    {
      expiresIn: SESSION_TTL_SECONDS,
    },
  );
}

/**
 * Build a session token for the frontend
 */
const buildSessionToken = (payload) => {
  try {
   const secret = getSessionSigningSecret();
   return jwt.sign(payload, secret, { expiresIn: SESSION_TTL_SECONDS });
  } catch (error) {
    console.error("buildSessionToken:", error.message);
    throw error;
  }
}

/**
 * Verifies app session JWT from Authorization header (after load / verify-jwt).
 * @returns {{ storeHash: string, bcUserId: number | null }}
 */
function verifyAppSessionToken(token) {
  const secret = getSessionSigningSecret();
  return jwt.verify(token, secret, { algorithms: ["HS256"] });
}

module.exports = {
  verifySignedPayloadJwt,
  verifyAppSessionToken,
  createAppSessionToken,
  storeHashFromSub,
  buildSessionToken,
  SESSION_TTL_SECONDS,
};
