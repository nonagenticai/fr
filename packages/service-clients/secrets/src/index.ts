// Re-export the Orval-generated client surface. Hand-written code does not
// belong in this package — when the upstream OpenAPI spec changes, run
// `bun run openapi:sync && bun run clients:generate` to refresh `generated/`.
export * from './generated/client';
export * from './generated/models';
export * from './generated/put-body-properties';
export * from './generated/operations';
