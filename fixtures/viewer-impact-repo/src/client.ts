import { runWorker } from './worker.js';

export function submit(): string {
  return runWorker({ id: 'job-1' });
}
