import { register } from 'node:module';
import { writeCoverage } from './instrumentation.mjs';
register('./node-loader.mjs', import.meta.url);
process.once('exit', () => writeCoverage(globalThis.__coverage__, 'node'));
