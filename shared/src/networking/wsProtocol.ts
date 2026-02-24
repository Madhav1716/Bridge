import { MessageEnvelope } from '../types';

export function createEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
): MessageEnvelope<TType, TPayload> {
  return {
    type,
    payload,
    sentAt: new Date().toISOString(),
  };
}

export function parseEnvelope(raw: unknown): MessageEnvelope | null {
  if (typeof raw !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MessageEnvelope>;
    if (!parsed.type || typeof parsed.type !== 'string') {
      return null;
    }

    return {
      type: parsed.type,
      payload: parsed.payload,
      sentAt:
        typeof parsed.sentAt === 'string'
          ? parsed.sentAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
