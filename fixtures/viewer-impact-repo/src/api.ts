import type { Job } from './types.js';

export function enqueue(job: Job): string {
  return job.id;
}
