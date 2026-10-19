import { z, ZodError, type ZodTypeAny } from 'zod';
import { HttpError } from './errors';

/** Parses input with a Zod schema; unknown keys are rejected by using .strict() schemas. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  try {
    return schema.parse(input ?? {});
  } catch (e) {
    if (e instanceof ZodError) {
      const issues = e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      const err = new HttpError(400, 'invalid_input', 'Some fields are missing or invalid.');
      err.issues = issues;
      throw err;
    }
    throw e;
  }
}

export const uuidParam = <K extends string>(name: K) =>
  z.object({ [name]: z.string().uuid() } as { [P in K]: z.ZodString }).strict();

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Clamped rather than rejected, so bulk export via huge pages is impossible (INT-05).
  pageSize: z.coerce.number().int().min(1).default(25).transform((n) => Math.min(n, 100)),
});

export const reasonField = z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500);
