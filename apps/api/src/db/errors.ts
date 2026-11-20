/** True for MongoDB's duplicate-key error (E11000): a unique index refused the write. */
export const isDuplicateKey = (err: unknown): boolean => (err as { code?: number } | null)?.code === 11000;
