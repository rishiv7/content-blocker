import {TrueForge} from '@truefoundry/trueforge-sdk';
import {TRUEFORGE_URL, COMPILER_AGENT, DEFAULT_MODEL, compilerAgentSpec} from '../extension/compiler-agent.js';

const client = new TrueForge({baseUrl: TRUEFORGE_URL, maxRetries: 0, timeoutInSeconds: 10});
const model = process.env.TRUEFORGE_MODEL || DEFAULT_MODEL;
const {data: models} = await client.models.list();
if (!models.some(item => item.name === model)) {
  throw new Error(`Configure ${model} in TrueForge Settings → Models first, or set TRUEFORGE_MODEL to a configured model supporting reasoning effort "none".`);
}
const request = {
  name: COMPILER_AGENT,
  description: 'Compiles Content Blocker preferences into concise, structured Jev rules.',
  manifest: compilerAgentSpec(model)
};
let existing;
for await (const agent of await client.agents.list({agentName: COMPILER_AGENT})) {
  if (agent.name === COMPILER_AGENT) existing = agent;
}
const {data: agent} = existing
  ? await client.agents.update(existing.id, {description: request.description, manifest: request.manifest})
  : await client.agents.create(request);
console.log(`Ready: ${agent.name} (${model}) at ${TRUEFORGE_URL}`);
