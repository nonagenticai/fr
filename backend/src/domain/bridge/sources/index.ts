import { bridgeRegistry } from '../registry';
import { kagOutputSource } from './kag';
import { artifactsOutputSource } from './artifacts';
import { codingOutputSource } from './coding';

export function registerBridgeSources(): void {
  bridgeRegistry.register(kagOutputSource);
  bridgeRegistry.register(artifactsOutputSource);
  bridgeRegistry.register(codingOutputSource);
}
