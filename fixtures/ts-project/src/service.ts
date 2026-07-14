import { fmt } from './util/format.js';

export class Service {}

export const greet = (name: string): string => fmt(`hello ${name}`);

async function ping(): Promise<void> {
  await fetch('https://api.example.com/ping');
}

void ping;
