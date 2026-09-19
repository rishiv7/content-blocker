export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';
export const MAX_TEXT = 4000;

export function normalizeQuestion(question) {
  const string = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  if (question?.type !== 'noul' || !string(question.instructions, 6000) ||
      !string(question.criteria?.true, 3000) || !string(question.criteria?.false, 3000)) {
    throw new Error('Save a valid blocking instruction in the extension popup first.');
  }
  return {type: 'noul', instructions: question.instructions,
    criteria: {true: question.criteria.true, false: question.criteria.false}};
}

export function normalizePassage(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('Invalid text passage.');
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized.length) throw new Error('Invalid text passage.');
  return normalized;
}

export function buildRequest(text, question) {
  return {model: MODEL, state: normalizePassage(text), questions: {should_block: normalizeQuestion(question)}};
}

export function parseResponse(body) {
  const answer = body?.answers?.should_block;
  if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error('Jev returned a missing or invalid score. Nothing was hidden.');
  }
  return answer.noul;
}

export async function detect(text, question, apiKey, signal, fetcher = fetch) {
  if (!apiKey) throw new Error('Add your TypeSafe API key in Settings.');
  const response = await fetcher(ENDPOINT, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`},
    body: JSON.stringify(buildRequest(text, question))
  });
  if (!response.ok) {
    const messages = {401: 'API key rejected. Update it in Settings.', 403: 'Your key does not have access to Jev.', 429: 'Jev rate limit reached. Wait a moment, then rescan.'};
    throw new Error(messages[response.status] || `Jev is unavailable (HTTP ${response.status}). Try again later.`);
  }
  return parseResponse(await response.json());
}
