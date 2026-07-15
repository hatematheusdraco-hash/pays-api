/**
 * Hand-authored OpenAPI 3.0 description of the PayS API, served as interactive
 * docs at /docs and as raw JSON at /openapi.json. Kept deliberately close to
 * the actual routes so it doubles as the API reference.
 */
export const openapiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'PayS — Any-to-Any Payment API',
    version: '0.1.0',
    description:
      'Stripe-like payment gateway: the payer sends any crypto, the merchant ' +
      'receives fiat or stablecoin. Authenticate with `Authorization: Bearer sk_...`.',
  },
  servers: [{ url: 'http://localhost:3000', description: 'Local' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Merchants' },
    { name: 'Payments' },
    { name: 'Refunds' },
    { name: 'Webhooks' },
    { name: 'System' },
  ],
  paths: {
    '/v1/merchants': {
      post: {
        tags: ['Merchants'],
        summary: 'Onboard a merchant and mint the first API key',
        security: [],
        requestBody: { $ref: '#/components/requestBodies/CreateMerchant' },
        responses: {
          '201': {
            description: 'Merchant created; the API key secret is shown once.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    merchant: { $ref: '#/components/schemas/Merchant' },
                    api_key: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        secret: { type: 'string', example: 'sk_test_...' },
                        livemode: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/v1/merchants/me': {
      get: {
        tags: ['Merchants'],
        summary: 'Retrieve the authenticated merchant',
        responses: {
          '200': {
            description: 'The merchant',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Merchant' } },
            },
          },
          '401': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/v1/payments': {
      post: {
        tags: ['Payments'],
        summary: 'Create a payment',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: { $ref: '#/components/requestBodies/CreatePayment' },
        responses: {
          '201': { $ref: '#/components/responses/Payment' },
          '400': { $ref: '#/components/responses/Error' },
        },
      },
      get: {
        tags: ['Payments'],
        summary: 'List payments',
        responses: {
          '200': {
            description: 'A list of payments',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Payment' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/payments/{id}': {
      get: {
        tags: ['Payments'],
        summary: 'Retrieve a payment',
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        responses: {
          '200': { $ref: '#/components/responses/Payment' },
          '404': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/v1/payments/{id}/quote': {
      post: {
        tags: ['Payments'],
        summary: 'Lock a quote (payer chooses the crypto to pay with)',
        description:
          'Transitions the payment CREATED → QUOTE_LOCKED and returns a ' +
          'deposit address plus the crypto amount, valid for 30 seconds.',
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        requestBody: { $ref: '#/components/requestBodies/CreateQuote' },
        responses: {
          '200': { $ref: '#/components/responses/Payment' },
          '409': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/v1/payments/{id}/simulate_payment': {
      post: {
        tags: ['Payments'],
        summary: 'Simulate an on-chain deposit (test-mode keys only)',
        description:
          'Drives QUOTE_LOCKED → PAYMENT_DETECTED. In production this is ' +
          'triggered by an Alchemy webhook when the deposit is observed.',
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        responses: {
          '200': { $ref: '#/components/responses/Payment' },
          '409': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/v1/payments/{id}/cancel': {
      post: {
        tags: ['Payments'],
        summary: 'Cancel a payment before funds are on-chain',
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        responses: {
          '200': { $ref: '#/components/responses/Payment' },
          '409': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/v1/payments/{id}/refund': {
      post: {
        tags: ['Refunds'],
        summary: 'Refund a completed payment (full or partial)',
        parameters: [
          { $ref: '#/components/parameters/PaymentId' },
          { $ref: '#/components/parameters/IdempotencyKey' },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  amount: {
                    type: 'number',
                    description: 'Omit for a full refund of the remaining balance.',
                  },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': { $ref: '#/components/responses/Refund' },
          '400': { $ref: '#/components/responses/Error' },
          '409': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/v1/payments/{id}/refunds': {
      get: {
        tags: ['Refunds'],
        summary: 'List refunds for a payment',
        parameters: [{ $ref: '#/components/parameters/PaymentId' }],
        responses: {
          '200': {
            description: 'A list of refunds',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Refund' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/refunds/{id}': {
      get: {
        tags: ['Refunds'],
        summary: 'Retrieve a refund',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { $ref: '#/components/responses/Refund' },
          '404': { $ref: '#/components/responses/Error' },
        },
      },
    },
    '/v1/webhook_endpoints': {
      post: {
        tags: ['Webhooks'],
        summary: 'Register a webhook endpoint',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  enabled_events: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['*'],
                  },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Endpoint created; secret shown once.' } },
      },
      get: {
        tags: ['Webhooks'],
        summary: 'List webhook endpoints',
        responses: { '200': { description: 'A list of endpoints' } },
      },
    },
    '/healthz': {
      get: {
        tags: ['System'],
        summary: 'Liveness + database check',
        security: [],
        responses: { '200': { description: 'OK' }, '503': { description: 'Degraded' } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API key' },
    },
    parameters: {
      PaymentId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', example: 'pay_...' },
      },
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Safely retry a POST without performing it twice.',
      },
    },
    requestBodies: {
      CreateMerchant: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'email'],
              properties: {
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
                settlement_method: {
                  type: 'string',
                  enum: ['sepa', 'usdc', 'payoneer'],
                },
                settlement_destination: { type: 'object' },
              },
            },
          },
        },
      },
      CreatePayment: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['amount', 'currency'],
              properties: {
                amount: { type: 'number', example: 49.99 },
                currency: { type: 'string', enum: ['EUR', 'USD', 'USDC'] },
                settlement_method: {
                  type: 'string',
                  enum: ['sepa', 'usdc', 'payoneer'],
                },
                description: { type: 'string' },
                metadata: { type: 'object' },
              },
            },
          },
        },
      },
      CreateQuote: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['pay_currency', 'pay_network'],
              properties: {
                pay_currency: {
                  type: 'string',
                  enum: ['BTC', 'ETH', 'USDC', 'USDT', 'SOL', 'MATIC'],
                },
                pay_network: {
                  type: 'string',
                  enum: ['bitcoin', 'ethereum', 'solana', 'polygon', 'tron', 'base'],
                },
              },
            },
          },
        },
      },
    },
    responses: {
      Payment: {
        description: 'A payment object',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
        },
      },
      Refund: {
        description: 'A refund object',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Refund' } },
        },
      },
      Error: {
        description: 'Error',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Error' } },
        },
      },
    },
    schemas: {
      Merchant: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'mch_...' },
          object: { type: 'string', example: 'merchant' },
          name: { type: 'string' },
          email: { type: 'string' },
          settlement_method: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Payment: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'pay_...' },
          object: { type: 'string', example: 'payment' },
          status: {
            type: 'string',
            enum: [
              'CREATED', 'QUOTE_LOCKED', 'PAYMENT_DETECTED', 'CONFIRMING',
              'CONVERTING', 'SETTLING', 'COMPLETED', 'FAILED', 'CANCELED',
            ],
          },
          amount: { type: 'number' },
          currency: { type: 'string' },
          amount_refunded: { type: 'number' },
          crypto: {
            type: 'object',
            nullable: true,
            properties: {
              currency: { type: 'string' },
              network: { type: 'string' },
              amount: { type: 'string' },
              deposit_address: { type: 'string' },
              confirmations: { type: 'integer' },
              required_confirmations: { type: 'integer' },
              tx_hash: { type: 'string' },
            },
          },
          fees: {
            type: 'object',
            properties: { pays_fee: { type: 'number', nullable: true } },
          },
          description: { type: 'string', nullable: true },
          metadata: { type: 'object' },
          created_at: { type: 'string', format: 'date-time' },
          completed_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Refund: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'rfnd_...' },
          object: { type: 'string', example: 'refund' },
          payment_id: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'processing', 'succeeded', 'failed'],
          },
          reason: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              code: { type: 'string', nullable: true },
              param: { type: 'string', nullable: true },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;
