/**
 * Write the static copy of the public OpenAPI 3.1 spec to docs/openapi.json
 * (PRD submission requirement). Run: pnpm --filter @ship/api openapi:v1
 *
 * Importing the v1 router first ensures every route's metadata + path is
 * registered before we generate.
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import './load-routes.js';
import { getV1OpenApiDocument } from './registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../../docs/openapi.json'); // -> repo-root/docs/openapi.json

writeFileSync(out, JSON.stringify(getV1OpenApiDocument(), null, 2) + '\n');
console.log('wrote', out);
