# lending-desk (synthetic sample)

A deliberately small, invented TypeScript service used to demonstrate ArchMap. It models a
neighbourhood tool library: members borrow drills and ladders, the desk computes due dates and
late fees, and a reminder job posts to a webhook. None of it is production code, and it has no
dependencies to install.

- `src/loans/policy.ts` — loan length and late-fee rules (the file the demo edits)
- `src/loans/service.ts` — checkout and return, built on the policy and inventory
- `src/catalog/inventory.ts` — in-memory tool inventory
- `src/http/routes.ts` — HTTP handlers registered on a minimal router
- `src/notify/reminders.ts` — overdue reminders sent with `fetch`
- `src/plugins/load.ts` — optional extensions loaded by a computed module name
- `bin/lending-desk.ts` — command-line entry point

See [docs/architecture.md](docs/architecture.md) for the intended design. ArchMap's demo copies
this directory into a fresh temporary Git repository before scanning it; the files here are never
modified.
