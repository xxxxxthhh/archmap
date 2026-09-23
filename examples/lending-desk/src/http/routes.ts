/** HTTP handlers for the lending desk, registered on a minimal router. */

import type { Inventory } from '../catalog/inventory.js';
import type { LoanService } from '../loans/service.js';

export interface Request {
  params: Record<string, string>;
  body: Record<string, string>;
}

export type Handler = (req: Request) => { status: number; body: unknown };

export interface Router {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
}

export function registerRoutes(router: Router, inventory: Inventory, loans: LoanService): void {
  router.get('/tools', () => ({ status: 200, body: inventory.list() }));

  router.post('/loans', (req) => {
    const loan = loans.checkout(req.body.toolId ?? '', req.body.memberId ?? '', new Date());
    return { status: 201, body: loan };
  });

  router.post('/returns/:toolId', (req) => {
    const loan = loans.giveBack(req.params.toolId ?? '', new Date());
    return { status: 200, body: loan };
  });
}
