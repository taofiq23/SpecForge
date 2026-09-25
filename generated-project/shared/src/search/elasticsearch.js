'use strict';

const { Client } = require('@elastic/elasticsearch');
const config = require('../config');

/**
 * Elasticsearch client (spec section D: "Search: Elasticsearch 7-8").
 *
 * The spec only justifies Elasticsearch with NFR-1 (performance) and never says
 * what is searched. The QuestionComponent owns question data, so we index
 * questions there and expose a free-text question search endpoint. Documented in
 * README -> "Underspecified areas".
 *
 * Like Redis, Elasticsearch is a derived store: PostgreSQL holds the truth
 * (ASR-1), the index is rebuildable from it.
 */
function createSearchClient(logger, indexName) {
  const index = indexName || config.elasticsearch.index;

  const client = new Client({
    node: config.elasticsearch.node,
    requestTimeout: config.elasticsearch.requestTimeout,
    maxRetries: 1,
  });

  return {
    indexName: index,

    async ping() {
      try {
        return await client.ping();
      } catch (err) {
        logger && logger.warn({ err: err.message }, 'elasticsearch ping failed');
        return false;
      }
    },

    async ensureIndex(mappings) {
      try {
        const exists = await client.indices.exists({ index });
        if (!exists) {
          await client.indices.create({
            index,
            mappings: mappings || {
              properties: {
                id: { type: 'keyword' },
                prompt: { type: 'text' },
                options: { type: 'text' },
                correctOption: { type: 'keyword' },
                difficulty: { type: 'keyword' },
                tags: { type: 'keyword' },
              },
            },
          });
          logger && logger.info({ index }, 'elasticsearch index created');
        }
        return true;
      } catch (err) {
        logger && logger.warn({ err: err.message, index }, 'elasticsearch ensureIndex failed');
        return false;
      }
    },

    async indexDocument(id, document) {
      try {
        await client.index({ index, id: String(id), document, refresh: 'wait_for' });
        return true;
      } catch (err) {
        logger && logger.warn({ err: err.message, id }, 'elasticsearch indexDocument failed');
        return false;
      }
    },

    async search(query, size = 20) {
      try {
        const result = await client.search({
          index,
          size,
          query: {
            multi_match: {
              query,
              fields: ['prompt^3', 'options', 'tags'],
              fuzziness: 'AUTO',
            },
          },
        });
        return (result.hits?.hits || []).map((h) => ({ ...h._source, _score: h._score }));
      } catch (err) {
        logger && logger.warn({ err: err.message, query }, 'elasticsearch search failed');
        return [];
      }
    },

    async delete(id) {
      try {
        await client.delete({ index, id: String(id), refresh: 'wait_for' });
        return true;
      } catch (err) {
        if (err.meta && err.meta.statusCode === 404) return true;
        logger && logger.warn({ err: err.message, id }, 'elasticsearch delete failed');
        return false;
      }
    },

    raw: client,
  };
}

module.exports = { createSearchClient };
