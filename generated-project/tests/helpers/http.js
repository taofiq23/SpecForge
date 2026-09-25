'use strict';

/**
 * Minimal HTTP test client for the generated Express apps.
 *
 * Deliberately dependency-free (node's http module) rather than adding
 * supertest: the point of these tests is that the components really serve the
 * routes in openapi.yaml, and an ephemeral listener proves that more directly
 * than an in-process shim.
 */
const http = require('http');

/**
 * Start `app` on an ephemeral port and return a request helper plus a close().
 *
 * @param {import('express').Express} app
 */
async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [opts]
   * @param {object} [opts.body]        JSON body
   * @param {object} [opts.headers]
   * @param {string} [opts.form]        application/x-www-form-urlencoded body
   */
  async function request(method, path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    let payload = null;

    if (opts.form !== undefined) {
      payload = new URLSearchParams(opts.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(payload);
    } else if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch (_) {
              json = null;
            }
            resolve({ status: res.statusCode, headers: res.headers, text, body: json });
          });
        },
      );
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  return {
    port,
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    put: (p, o) => request('PUT', p, o),
    del: (p, o) => request('DELETE', p, o),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Silent logger so tests do not spam stdout. */
const silentLogger = { info() {}, debug() {}, warn() {}, error() {} };

module.exports = { startServer, silentLogger };
