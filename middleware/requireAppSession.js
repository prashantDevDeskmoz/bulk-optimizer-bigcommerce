const { verifyAppSessionToken } = require("../utils/sessionJwt");

/**
 * Expects Authorization: Bearer <app session JWT>.
 * Sets req.storeHash from token payload.
 */
function requireAppSession(req, res, next) {
  const header = req.headers.authorization;
  const token =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : null;

  if (!token) {
    return res.status(401).json({
      status: false,
      message: "Missing Authorization Bearer token",
    });
  }

  try {
    const payload = verifyAppSessionToken(token);
    if (!payload.storeHash) {
      return res.status(401).json({
        status: false,
        message: "Invalid session token",
      });
    }
    req.storeHash = payload.storeHash;
    next();
  } catch {
    return res.status(401).json({
      status: false,
      message: "Invalid or expired session token",
    });
  }
}

module.exports = { requireAppSession };
