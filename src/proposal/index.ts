export { computeModelHash } from './fingerprint.js';
export { loadProposalFile, ProposalLoadError } from './load.js';
export { previewProposal, validateProposal } from './evaluate.js';
export { validateProposalStructure } from './schema.js';
export { PROPOSAL_SCHEMA_VERSION } from './types.js';
export type {
  Proposal,
  ProposalConflict,
  ProposalError,
  ProposalEvaluation,
  ProposalMutation,
  ProposalNodeDiff,
  ProposalOperation,
  ProposalTarget,
  ProposalTargetClass,
  ProposalVerdict,
} from './types.js';
