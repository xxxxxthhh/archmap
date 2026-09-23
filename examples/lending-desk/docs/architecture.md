# lending-desk architecture

The desk has one rule source: `src/loans/policy.ts`. Every due date and late fee is derived
from it, so a policy change should be reviewed together with the checkout service, the HTTP
handlers that expose loans, and the overdue reminder job.

## Flow

1. `bin/lending-desk.ts` wires the inventory, loan service, and router.
2. `src/http/routes.ts` translates requests into `LoanService` calls.
3. `src/loans/service.ts` asks the policy for due dates and fees.
4. `src/notify/reminders.ts` finds overdue loans and posts a reminder to the configured webhook.

## Extension point

`src/plugins/load.ts` imports extensions by a name read from configuration. The module name is
only known at runtime.
