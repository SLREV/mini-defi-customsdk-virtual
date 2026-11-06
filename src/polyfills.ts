import { Buffer } from 'buffer';

if (typeof globalThis !== 'undefined' && !('Buffer' in globalThis)) {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}
