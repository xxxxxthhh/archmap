#!/usr/bin/env node
/** Command-line entry point: seeds a demo inventory and prints the routes it would serve. */

import { Inventory } from '../src/catalog/inventory.js';
import { registerRoutes, type Handler } from '../src/http/routes.js';
import { LoanService } from '../src/loans/service.js';
import { loadPlugins } from '../src/plugins/load.js';

const inventory = new Inventory();
inventory.add({ id: 'drill-1', name: 'Cordless drill', available: true });
inventory.add({ id: 'ladder-1', name: 'Step ladder', available: true });

const loans = new LoanService(inventory);
const routes: string[] = [];
registerRoutes(
  {
    get: (path: string, _handler: Handler) => routes.push(`GET ${path}`),
    post: (path: string, _handler: Handler) => routes.push(`POST ${path}`),
  },
  inventory,
  loans,
);

await loadPlugins((process.env.LENDING_DESK_PLUGINS ?? '').split(',').filter(Boolean));
console.log(routes.join('\n'));
