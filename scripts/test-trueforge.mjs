import {compileInstruction, checkCompiler} from '../extension/rule-compiler.js';
import {buildRequest} from '../extension/jev.js';
console.log(await checkCompiler());
const start = performance.now();
const rule = await compileInstruction('No travel-related content, but allow local news.');
const request = buildRequest('The city library is reopening on Monday.', rule.question);
console.log(JSON.stringify({elapsedMs: Math.round(performance.now() - start), rule, jevQuestion: request.questions.should_block}, null, 2));
