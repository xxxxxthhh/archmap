import { enqueue, type Job } from './api.js';

export function runWorker(job: Job): string {
  return enqueue(job);
}
