import * as fs from 'fs';
import * as path from 'path';
import { buildAikoshOpenApi } from '../src/aikosh/openapi';
fs.writeFileSync(path.resolve(__dirname, '../docs/openapi-aikosh.json'), JSON.stringify(buildAikoshOpenApi(), null, 2) + '\n');
console.log('wrote docs/openapi-aikosh.json');
