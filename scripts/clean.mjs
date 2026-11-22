import { rm } from 'node:fs/promises';
// Clean only this package's generated output, resolved independently of the caller's cwd.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
