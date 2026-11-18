import * as fs from 'fs';
import * as path from 'path';
import { buildOcrStudyOpenApi } from '../src/validation/study/openapi';
fs.writeFileSync(path.resolve(__dirname, '../docs/openapi-ocr-study.json'), JSON.stringify(buildOcrStudyOpenApi(), null, 2) + '\n');
console.log('wrote docs/openapi-ocr-study.json');
