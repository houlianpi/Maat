/** Shared internal state vocabulary for legacy supervision and the replacement port contract. */
export type ConnectionJobState =
  | 'queued'
  | 'running'
  | 'creation-uncertain'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
