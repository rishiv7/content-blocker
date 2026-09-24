// Live smoke test: one real compile against the OpenAI Responses API.
// Usage: OPENAI_API_KEY=sk-... npm run test:openai
// The key is read from the environment only — never passed on a command line or written to disk.
import {compileInstruction} from '../extension/rule-compiler.js';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey?.trim()) {
  console.error('Set OPENAI_API_KEY in the environment to run this smoke test.');
  process.exit(1);
}

const startedAt = Date.now();
const rule = await compileInstruction('No travel-related content, but allow local news.', apiKey);
console.log(`Compiled in ${Date.now() - startedAt} ms. Parsed blocking rule:`);
console.log(JSON.stringify(rule, null, 2));
