import { customType } from 'drizzle-orm/pg-core';

/**
 * Custom bytea column type for PostgreSQL binary data
 *
 * PostgreSQL's bytea type stores binary data as byte arrays.
 * This custom type handles conversion between JavaScript Buffers and PostgreSQL bytea.
 */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Buffer): Buffer {
    return value;
  },
  fromDriver(value: unknown): Buffer {
    if (value instanceof Buffer) {
      return value;
    }
    // Handle hex-encoded strings (PostgreSQL sometimes returns bytea as hex)
    if (typeof value === 'string') {
      return Buffer.from(value, 'hex');
    }
    throw new Error(`Unexpected bytea value type: ${typeof value}`);
  },
});
