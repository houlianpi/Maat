// Shared native fixture; wdio.conf.ts owns automatic final/failure Evidence.
export { browser as driver, browser, expect } from '@wdio/globals';
export { describe, it } from 'mocha';
export { display, evidence } from '../../../src/native/execution/evidence.ts';
