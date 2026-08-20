'use strict';

function createOriginPolicy({ port, host }) {
  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
    `http://${host}:${port}`,
  ]);

  function allows(origin, hostHeader, { allowMissing = false } = {}) {
    if (!origin) return allowMissing;
    try {
      const originUrl = new URL(origin);
      if (originUrl.host === hostHeader) return true;
      return allowedOrigins.has(origin);
    } catch {
      return false;
    }
  }

  return { allows };
}

module.exports = { createOriginPolicy };
