// Imported first by every entrypoint (API, worker, seed, tests) so env vars exist before any
// decorator or client reads them. Real environment variables (Docker / cloud) always win over .env.
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { parseEnv } from 'util';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, 'utf8')))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Prisma returns BIGINT columns as JS bigint, which JSON.stringify cannot serialise.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

export {};
