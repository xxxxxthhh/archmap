import { greet } from './service.js';
import { fmt } from './util/format.js';

export function main(): string {
  return greet(fmt('world'));
}
