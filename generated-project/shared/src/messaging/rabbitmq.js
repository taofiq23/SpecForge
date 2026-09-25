'use strict';

const amqp = require('amqplib');
const config = require('../config');

/**
 * RabbitMQ publisher/consumer (spec section D: "Messaging: RabbitMQ 3-4").
 *
 * The spec never states what messages flow through the broker - only that one
 * exists and that it is justified by ASR-2 (security). We therefore define a
 * small, explicit event catalogue in config.rabbitmq.events and publish those.
 * See README -> "Underspecified areas".
 *
 * Design note: publishing is fire-and-forget and failure-tolerant. If RabbitMQ
 * is down the game still plays; we log and drop. Durability is PostgreSQL's job
 * (ASR-1), not the broker's.
 */
function createMessaging(logger, options = {}) {
  const exchange = options.exchange || config.rabbitmq.exchange;
  let connection = null;
  let channel = null;
  let connecting = null;

  async function connect() {
    if (channel) return channel;
    if (connecting) return connecting;

    connecting = (async () => {
      try {
        connection = await amqp.connect(config.rabbitmq.url);
        connection.on('error', (err) => {
          logger && logger.warn({ err: err.message }, 'rabbitmq connection error');
          channel = null;
        });
        connection.on('close', () => {
          channel = null;
        });
        channel = await connection.createChannel();
        await channel.assertExchange(exchange, 'topic', { durable: true });
        logger && logger.info({ exchange }, 'rabbitmq connected');
        return channel;
      } catch (err) {
        logger && logger.warn({ err: err.message }, 'rabbitmq unavailable; events will be dropped');
        channel = null;
        return null;
      } finally {
        connecting = null;
      }
    })();

    return connecting;
  }

  return {
    async publish(routingKey, payload) {
      const ch = await connect();
      if (!ch) return false;
      try {
        const body = Buffer.from(JSON.stringify({ ...payload, publishedAt: new Date().toISOString() }));
        ch.publish(exchange, routingKey, body, {
          persistent: true,
          contentType: 'application/json',
          // ASR-2 (security): avoid logging payloads with student PII.
          headers: { 'x-spacefractions-component': options.component || 'unknown' },
        });
        logger && logger.debug({ routingKey }, 'event published');
        return true;
      } catch (err) {
        logger && logger.warn({ err: err.message, routingKey }, 'event publish failed');
        return false;
      }
    },

    /**
     * Subscribe a durable queue to the topic exchange. Queue name is derived
     * from the component plus the binding patterns so redeploys are idempotent.
     */
    async subscribe(queueName, bindings, handler) {
      const ch = await connect();
      if (!ch) return false;
      try {
        await ch.assertQueue(queueName, { durable: true });
        for (const pattern of bindings) {
          await ch.bindQueue(queueName, exchange, pattern);
        }
        await ch.consume(queueName, async (msg) => {
          if (!msg) return;
          try {
            await handler(JSON.parse(msg.content.toString()), msg.fields.routingKey);
            ch.ack(msg);
          } catch (err) {
            logger && logger.error({ err: err.message }, 'event handler failed');
            ch.nack(msg, false, false);
          }
        });
        logger && logger.info({ queueName, bindings }, 'subscribed to events');
        return true;
      } catch (err) {
        logger && logger.warn({ err: err.message, queueName }, 'subscribe failed');
        return false;
      }
    },

    async close() {
      try {
        if (channel) await channel.close();
        if (connection) await connection.close();
      } catch (_) {
        /* shutting down anyway */
      }
      channel = null;
      connection = null;
      connecting = null;
    },

    isConnected() {
      return Boolean(channel);
    },
  };
}

module.exports = { createMessaging };
