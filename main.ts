// Entry point for the make.fun "Make Markdown rendering faster" bounty.
// Reads cases from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each with parse(), writes $MAKEFUN_OUTPUT_DIR/html.json
// (default /output) as a JSON array of HTML strings in case order.
// Node 22, standard library only.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const list = Array.isArray(cases) ? cases : cases.cases;
const out = new Array(list.length);
for (let i = 0; i < list.length; i++) {
  out[i] = parse(list[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
