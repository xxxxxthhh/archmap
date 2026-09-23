/** Checkout and return, built on the loan policy and the inventory. */

import type { Inventory } from '../catalog/inventory.js';
import { dueDate, lateFeeCents } from './policy.js';

export interface Loan {
  toolId: string;
  memberId: string;
  borrowedAt: Date;
  due: Date;
  returnedAt?: Date;
  feeCents?: number;
}

export class LoanService {
  private readonly loans: Loan[] = [];

  constructor(private readonly inventory: Inventory) {}

  checkout(toolId: string, memberId: string, now: Date): Loan {
    const tool = this.inventory.get(toolId);
    if (!tool || !tool.available) throw new Error(`tool ${toolId} is not available`);
    this.inventory.setAvailable(toolId, false);
    const loan: Loan = { toolId, memberId, borrowedAt: now, due: dueDate(now) };
    this.loans.push(loan);
    return loan;
  }

  giveBack(toolId: string, now: Date): Loan {
    const loan = this.loans.find((l) => l.toolId === toolId && !l.returnedAt);
    if (!loan) throw new Error(`tool ${toolId} is not on loan`);
    loan.returnedAt = now;
    loan.feeCents = lateFeeCents(loan.due, now);
    this.inventory.setAvailable(toolId, true);
    return loan;
  }

  overdue(now: Date): Loan[] {
    return this.loans.filter((l) => !l.returnedAt && l.due.getTime() < now.getTime());
  }
}
