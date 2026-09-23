/** Overdue reminders, posted as JSON to a configured webhook. */

import type { LoanService } from '../loans/service.js';

export async function sendOverdueReminders(
  loans: LoanService,
  webhookUrl: string,
  now: Date,
): Promise<number> {
  const overdue = loans.overdue(now);
  for (const loan of overdue) {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: loan.memberId, toolId: loan.toolId, due: loan.due }),
    });
  }
  return overdue.length;
}
