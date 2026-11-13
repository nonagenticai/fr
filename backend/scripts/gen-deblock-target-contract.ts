#!/usr/bin/env bun
// Rewrites src/domain/engagement/spec/deblock-target-contract.json from plannedCardMove.
import { serializeDeblockTargetContract } from '../src/domain/engagement/deblock-target-contract';

const path = new URL('../src/domain/engagement/spec/deblock-target-contract.json', import.meta.url).pathname;
await Bun.write(path, serializeDeblockTargetContract());
console.log(`[gen-deblock-target-contract] wrote ${path}`);
