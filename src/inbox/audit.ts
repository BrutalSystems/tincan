import { createHash } from 'node:crypto';
import type { Envelope } from '../envelope.js';
export const OMITTED_BODY = '[body omitted: strict inbox]';
export function strictAuditEnvelope(envelope: Envelope): Envelope {
  return { ...envelope, text: OMITTED_BODY, body_omitted: true };
}
export function requestFingerprint(args: {
  message: string;
  in_reply_to?: string;
  answers?: boolean;
  expect_reply?: boolean;
  urgent?: boolean;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        message: args.message,
        in_reply_to: args.in_reply_to,
        answers: args.answers ?? false,
        expect_reply: args.expect_reply ?? false,
        urgent: args.urgent ?? false,
      }),
    )
    .digest('hex');
}
