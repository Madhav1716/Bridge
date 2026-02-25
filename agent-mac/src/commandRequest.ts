import { CommandRunRequest } from '@bridge/shared';

function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: 'single' | 'double' | null = null;

  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index];

    if (character === '\\' && index + 1 < commandLine.length) {
      const nextCharacter = commandLine[index + 1];
      if (nextCharacter === '"' || nextCharacter === "'" || nextCharacter === '\\') {
        current += nextCharacter;
        index += 1;
        continue;
      }
    }

    if (character === '"' && inQuote !== 'single') {
      inQuote = inQuote === 'double' ? null : 'double';
      continue;
    }

    if (character === "'" && inQuote !== 'double') {
      inQuote = inQuote === 'single' ? null : 'single';
      continue;
    }

    if (/\s/.test(character) && !inQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function createCommandRunRequest(
  commandLine: string,
  requestId: string,
  cwd?: string,
): CommandRunRequest | null {
  const tokens = tokenizeCommandLine(commandLine.trim());
  if (tokens.length === 0) {
    return null;
  }

  const [command, ...args] = tokens;
  return {
    requestId,
    command,
    args,
    cwd,
  };
}
