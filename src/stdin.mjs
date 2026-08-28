/** Reads a whole stdin stream as UTF-8, resolving to '' on any error. */
export async function readStdin(stream) {
  try {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } catch {
    return '';
  }
}
