/** Loan length and late-fee rules for the tool library. */

export const LOAN_DAYS = 14;
export const DAILY_LATE_FEE_CENTS = 50;
export const MAX_LATE_FEE_CENTS = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function dueDate(borrowedAt: Date): Date {
  return new Date(borrowedAt.getTime() + LOAN_DAYS * DAY_MS);
}

export function lateFeeCents(due: Date, returnedAt: Date): number {
  const daysLate = Math.ceil((returnedAt.getTime() - due.getTime()) / DAY_MS);
  if (daysLate <= 0) return 0;
  return Math.min(daysLate * DAILY_LATE_FEE_CENTS, MAX_LATE_FEE_CENTS);
}
