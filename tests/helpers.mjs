/** In-memory stand-ins for the filesystem, so tests never touch a real disk. */

export function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const fail = new Set();
  return {
    files,
    fail,
    appendFileSync(path, data) {
      if (fail.has('append')) throw new Error('append denied');
      files.set(path, (files.get(path) || '') + data);
    },
    mkdirSync() {
      if (fail.has('mkdir')) throw new Error('mkdir denied');
    },
    readFileSync(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path);
    },
    statSync(path) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return { size: files.get(path).length };
    },
    writeFileSync(path, data) {
      if (fail.has('write')) throw new Error('write denied');
      files.set(path, data);
    },
  };
}

/** A `readFile(path, 'utf8')` function backed by a plain object. */
export function fakeReader(files = {}) {
  return (path) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  };
}

export const HOME = '/fake-home';
export const CONFIG = `${HOME}/claude-usage.json`;
export const STATE = `${HOME}/claude-usage-state.json`;
export const QUEUE = `${HOME}/claude-usage-queue.jsonl`;
export const LOG = `${HOME}/claude-usage.log`;

export function env(extra = {}) {
  return { CLAUDE_USAGE_HOME: HOME, ...extra };
}

/** Builds a transcript entry list for one prompt plus N assistant replies. */
export function transcript({ prompt = 'hi', promptId = 'p1', sessionId = 's1', usages = [], model = 'claude-sonnet-5' } = {}) {
  const entries = [
    {
      type: 'user',
      promptSource: 'typed',
      promptId,
      sessionId,
      cwd: '/repo',
      message: { content: prompt },
    },
  ];
  usages.forEach((usage, i) => {
    entries.push({
      type: 'assistant',
      promptId,
      requestId: `req-${promptId}-${i}`,
      sessionId,
      message: { model, usage },
    });
  });
  return entries;
}

export const USAGE_A = {
  input_tokens: 100,
  cache_read_input_tokens: 800,
  cache_creation_input_tokens: 200,
  output_tokens: 50,
};
