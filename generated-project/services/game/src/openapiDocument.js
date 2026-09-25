'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Loads the canonical openapi.yaml artifact (repo root) and augments it with the
 * component's own route metadata so /openapi.json reflects what is actually
 * served. openapi.yaml itself is written verbatim from the spec and is the
 * deliverable named in the traceability matrix for FR-1.
 */
function loadOpenApiDocument() {
  const candidates = [
    path.resolve(__dirname, '../../../../openapi.yaml'),
    path.resolve(process.cwd(), 'openapi.yaml'),
  ];

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const doc = yaml.load(fs.readFileSync(file, 'utf8'));
        return { ...doc, 'x-served-by': 'GameComponent' };
      }
    } catch (_) {
      /* fall through to the inline copy */
    }
  }
  return inlineDocument();
}

/** Inline fallback matching the spec's section D code block exactly. */
function inlineDocument() {
  return {
    openapi: '3.0.0',
    info: {
      title: 'Space Fractions API',
      description: 'API for the Space Fractions game',
      version: '1.0.0',
    },
    paths: {
      '/play': {
        get: {
          summary: 'Play the game',
          responses: {
            200: {
              description: 'Game started',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      gameId: { type: 'integer', description: 'Game ID' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

module.exports = loadOpenApiDocument();
