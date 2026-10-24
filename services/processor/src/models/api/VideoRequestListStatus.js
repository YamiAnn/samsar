import mongoose from 'mongoose';

import {
  buildNormalizedBranchingStatus,
  normalizeResponseAssetUrl,
} from './StatusAPI.js';

const RECONCILABLE_STATUSES = new Set(['PENDING', 'PROCESSING']);

function normalizeStatus(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizeRenderedVideoLink(value, req) {
  const link = typeof value === 'string' ? value.trim().replace(/^\/+/, '') : '';
  if (!link.startsWith('assets_v2/') || link.split('/').includes('..') || /[?#]/.test(link)) {
    return null;
  }
  return normalizeResponseAssetUrl(link, req);
}

function isReconciliationCandidate(session) {
  return session?.sessionType === 'video' &&
    RECONCILABLE_STATUSES.has(normalizeStatus(session.status || 'PENDING')) &&
    mongoose.Types.ObjectId.isValid(session.sessionId);
}

export function getVideoRequestListSessionIds(sessions = []) {
  return [...new Set(sessions
    .filter(isReconciliationCandidate)
    .map((session) => session.sessionId.toString()))];
}

export function resolveVideoRequestListResult(globalSession, videoSession, req = null) {
  if (!isReconciliationCandidate(globalSession) || !videoSession ||
    globalSession.sessionId.toString() !== videoSession._id?.toString() ||
    !globalSession.userId || !videoSession.userId ||
    globalSession.userId?.toString() !== videoSession.userId?.toString()) {
    return null;
  }

  const aggregateStatus = normalizeStatus(videoSession.expressGenerationStatus?.status);
  const videoStatus = normalizeStatus(videoSession.expressGenerationStatus?.video_generation);
  const isBranched = [videoSession.narrativeType, videoSession.sourceNarrativeType]
    .some((value) => normalizeStatus(value) === 'BRANCHED');
  const branching = isBranched ? buildNormalizedBranchingStatus(videoSession, req) : null;
  if (videoSession.expressGenerationCancelled === true || branching?.status === 'CANCELLED') {
    return { status: 'CANCELLED' };
  }
  if (videoSession.expressGenerationFailed === true || branching?.status === 'FAILED') {
    return { status: 'FAILED' };
  }
  if ((videoSession.expressGenerationCancelled === undefined && aggregateStatus === 'CANCELLED') ||
    (videoSession.expressGenerationFailed === undefined && aggregateStatus === 'FAILED')) {
    return { status: aggregateStatus };
  }
  if (videoSession.videoGenerationPending === true ||
    videoSession.expressGenerationPending === true ||
    videoSession.frameGenerationPending === true ||
    videoSession.expressGenerationPaused === true ||
    videoSession.generationError) {
    return null;
  }
  if (aggregateStatus !== 'COMPLETED' || videoStatus !== 'COMPLETED') {
    return null;
  }

  if (isBranched) {
    if (branching?.outputs?.ready !== true || !branching.outputs.default_url) {
      return null;
    }
    const branchRenderPaths = Array.isArray(videoSession.branchRenderPaths)
      ? videoSession.branchRenderPaths
      : [];
    const localUrlsByPathId = new Map(branchRenderPaths.map((path) => [
      path?.pathId?.toString(), normalizeRenderedVideoLink(path?.videoLink, req),
    ]));
    const results = branching.paths.map((path) => ({
      isDefault: path.is_default,
      url: localUrlsByPathId.get(path.path_id),
    }));
    if (results.some((result) => !result.url)) {
      return null;
    }
    return {
      status: 'COMPLETED',
      resultUrl: results.find((result) => result.isDefault)?.url || results[0].url,
      resultUrls: results.map((result) => result.url),
    };
  }

  // VideoSession.videoLink is the renderer's own asset path. Normalize it through
  // the same media-delivery policy as /status, never return a stored signed URL.
  const resultUrl = normalizeRenderedVideoLink(videoSession.videoLink, req);
  if (!resultUrl) {
    return null;
  }
  return { status: 'COMPLETED', resultUrl, resultUrls: [resultUrl] };
}
