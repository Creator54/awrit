import { resolvePresentationTarget } from './target';

export function isVerifiedOwner(owner: unknown): boolean {
  if (typeof owner === 'number') {
    return Number.isSafeInteger(owner) && owner > 0;
  }
  if (typeof owner === 'string') {
    return /^[1-9]\d*$/.test(owner.trim());
  }
  return false;
}

export function normalizeTargetUrl(target: string, cwd?: string): string {
  const trimmed = target.trim();
  try {
    return resolvePresentationTarget(trimmed, cwd).url;
  } catch {
    try {
      return new URL(trimmed).href;
    } catch {
      return trimmed;
    }
  }
}

export interface ViewerReuseParams {
  currentOwner?: string | null;
  requesterOwner?: string | null | number;
  currentState?: 'unattached' | 'bound' | 'orphaned' | string;
  designMode?: boolean;
}

export interface ViewerReuseResult {
  ok: boolean;
  reason?: 'design-mode-active' | 'owner-conflict' | 'unverified-requester';
}

export function canReuseViewer(params: ViewerReuseParams): ViewerReuseResult {
  if (params.designMode) {
    return { ok: false, reason: 'design-mode-active' };
  }

  const reqVerified = isVerifiedOwner(params.requesterOwner);
  if (!reqVerified) {
    return { ok: false, reason: 'unverified-requester' };
  }

  const requesterStr = String(params.requesterOwner).trim();
  const currentStr = params.currentOwner ? String(params.currentOwner).trim() : '';

  // If current view has an owner assigned
  if (currentStr && isVerifiedOwner(currentStr)) {
    if (requesterStr === currentStr) {
      return { ok: true };
    }
    return { ok: false, reason: 'owner-conflict' };
  }

  // Truly unbound viewer: no verified owner assigned, and unattached/orphaned state
  const isUnbound =
    !currentStr ||
    params.currentState === 'unattached' ||
    params.currentState === 'orphaned';

  if (isUnbound) {
    return { ok: true };
  }

  return { ok: false, reason: 'owner-conflict' };
}

export interface LiveCaptureValidationParams {
  currentOwner?: string | null;
  requesterOwner?: string | null | number;
  currentUrl?: string;
  requestedTarget?: string;
  isDestroyed?: boolean;
}

export interface LiveCaptureValidationResult {
  ok: boolean;
  reason?: 'no-active-window' | 'owner-mismatch' | 'unverified-requester' | 'target-mismatch' | 'missing-target';
}

export function validateLiveCapture(params: LiveCaptureValidationParams): LiveCaptureValidationResult {
  if (params.isDestroyed || !params.currentUrl) {
    return { ok: false, reason: 'no-active-window' };
  }

  if (!params.requestedTarget || !params.requestedTarget.trim()) {
    return { ok: false, reason: 'missing-target' };
  }

  // Verify requester owner
  const reqVerified = isVerifiedOwner(params.requesterOwner);
  const currentStr = params.currentOwner ? String(params.currentOwner).trim() : '';

  if (currentStr && isVerifiedOwner(currentStr)) {
    if (!reqVerified || String(params.requesterOwner).trim() !== currentStr) {
      return { ok: false, reason: 'owner-mismatch' };
    }
  } else if (!reqVerified) {
    return { ok: false, reason: 'unverified-requester' };
  }

  // Exact normalized requested target check
  const normalizedRequested = normalizeTargetUrl(params.requestedTarget);
  const normalizedCurrent = normalizeTargetUrl(params.currentUrl);

  if (normalizedRequested !== normalizedCurrent) {
    return { ok: false, reason: 'target-mismatch' };
  }

  return { ok: true };
}
