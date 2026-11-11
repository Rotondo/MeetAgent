import { KINDS } from './meeting-ledger.js';
export function observerSchema(ledger) {
  const nullable = { type: ['string', 'null'] };
  return { type: 'object', additionalProperties: false, required: ['operations', 'phase'], properties: {
    phase: { type: 'string', enum: ['exploring', 'closing'] },
    operations: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'kind', 'text', 'status', 'turnId', 'quote', 'owner', 'ownerQuote', 'due'], properties: {
        id: { type: ['string', 'null'], enum: [null, ...ledger.items.map(i => i.id)] },
        kind: { type: 'string', enum: KINDS }, text: { type: 'string' },
        status: { type: 'string', enum: ['open', 'confirmed', 'resolved', 'retracted'] },
        turnId: { type: 'string' }, quote: { type: 'string' }, owner: nullable, ownerQuote: nullable, due: nullable
      } }
    }
  } };
}
