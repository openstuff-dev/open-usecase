import type { ApprovalMethod, Health, UseCaseStatus } from '@open-usecase/contracts';

export const STATUS_LABELS: Record<UseCaseStatus, string> = {
  proposed: 'Proposed',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
  done: 'Done',
  retired: 'Retired',
};

export const HEALTH_LABELS: Record<Health, string> = {
  passing: 'Passing',
  failing: 'Failing',
  no_evidence: 'No evidence',
};

export const APPROVAL_LABELS: Record<ApprovalMethod, string> = {
  human: 'A person',
  agent_review: 'A reviewer agent',
  auto_approve: 'Nobody: approved on arrival',
};

export const HEALTH_TONES: Record<Health, 'success' | 'danger' | 'neutral'> = {
  passing: 'success',
  failing: 'danger',
  no_evidence: 'neutral',
};

export const STATUS_TONES: Record<UseCaseStatus, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  proposed: 'warning',
  changes_requested: 'warning',
  approved: 'info',
  rejected: 'danger',
  done: 'success',
  retired: 'neutral',
};
