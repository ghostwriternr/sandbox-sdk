import type { SandboxCommand } from '@repo/shared';

const BASH_PATH = '/bin/bash';

export function normalizeSandboxCommand(command: SandboxCommand): string[] {
  if (typeof command === 'string') {
    if (command.trim().length === 0) {
      throw new TypeError('exec command must not be empty');
    }
    return [BASH_PATH, '-lc', command];
  }

  if (command.length === 0) {
    throw new TypeError('exec argv must contain at least one item');
  }

  command.forEach((item, index) => {
    if (item.length === 0) {
      throw new TypeError(`exec argv item at index ${index} must not be empty`);
    }
  });

  return [...command];
}

export function commandToLogString(command: SandboxCommand): string {
  return typeof command === 'string' ? command : command.join(' ');
}
