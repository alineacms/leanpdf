import { beforeAll, describe, expect, test } from 'bun:test';
import { SharpImageCodec } from '../../src/sharp.ts';
import { CASES, runCase, SHARP_CAPABILITIES, type ContractEnv } from './contract.ts';
import { makeJpegFixtures, sharpDecode } from './node-helpers.ts';

let env: ContractEnv;

beforeAll(async () => {
  env = { codec: new SharpImageCodec(), capabilities: SHARP_CAPABILITIES, decode: sharpDecode, jpegFixtures: await makeJpegFixtures() };
});

describe('ImageCodec contract: SharpImageCodec', () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const r = await runCase(env, c);
      expect(r.failures).toEqual([]);
    });
  }
});
