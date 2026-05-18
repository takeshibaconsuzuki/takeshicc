// Reassembles a byte stream into whole text lines, so a line split across
// chunks (or a multi-byte UTF-8 char split across them) is delivered intact.
// Empty lines are skipped; flush() emits any trailing partial line on close.
// Dependency-free (only `string_decoder`) so it bundles into both the server
// process and the extension client.

import { StringDecoder } from 'string_decoder';

export function lineSplitter(onLine: (line: string) => void): {
  write(chunk: Buffer): void;
  flush(): void;
} {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const emit = (line: string): void => {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.length > 0) {
      onLine(trimmed);
    }
  };
  return {
    write(chunk: Buffer): void {
      buffer += decoder.write(chunk);
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    },
    flush(): void {
      buffer += decoder.end();
      emit(buffer);
      buffer = '';
    },
  };
}
