import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, badRequest } from '../lib/errors.js';

/** Parse & validate a request body with a zod schema, mapping errors to 400s. */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  req: FastifyRequest,
): z.output<S> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const param = first?.path.join('.') || undefined;
    throw badRequest(first?.message ?? 'Invalid request body.', { code: 'parameter_invalid', param });
  }
  return result.data;
}

/** The merchant id set by the auth hook; throws if somehow missing. */
export function merchantId(req: FastifyRequest): string {
  const id = req.merchantId;
  if (!id) throw new ApiError(500, 'api_error', 'Authentication context missing.');
  return id;
}
