'use strict';

/**
 * Shared HTTP client for component-to-component REST calls.
 *
 * Section C: "each component communicating with others through APIs".
 * Section F: "Implement TLS encryption for all communication".
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

function request(url, { method = 'GET', body = null, headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;

    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (_) {
          parsed = { raw: text };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: parsed });
        } else {
          const err = new Error(
            (parsed && (parsed.error_description || parsed.error)) || `upstream ${res.statusCode}`,
          );
          err.status = res.statusCode;
          err.body = parsed;
          reject(err);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Static service registry derived from the deployment topology (section E). */
function createServiceRegistry(config) {
  return {
    game: process.env.GAME_BASE_URL || `http://localhost:${config.game.port}`,
    question: process.env.QUESTION_BASE_URL || `http://localhost:${config.question.port}`,
    user: process.env.USER_BASE_URL || `http://localhost:${config.user.port}`,
  };
}

module.exports = { request, createServiceRegistry };
