#!/usr/bin/env node
import { program } from 'commander';
import { main } from '../src/index.js';

program.command('start').action(() => {
  process.stdout.write(main());
});
