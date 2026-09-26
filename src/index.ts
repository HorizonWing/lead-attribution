export {
  leadAttribution,
  type LeadAttributionOptions,
  type VisitorRow,
} from "./plugins/lead-attribution";
export { leadAttributionClient } from "./plugins/lead-attribution-client";
export {
  behaviorTracker,
  DEFAULT_EVENT_PATHS,
  matchEventPath,
  type BehaviorTrackerOptions,
} from "./plugins/behavior-tracker";
export { behaviorTrackerClient } from "./plugins/behavior-tracker-client";
export { recordConversion, type ConversionDeps, type ConversionInput } from "./conversion";
export { trackVisit, type TrackVisitDeps, type UpsertVisitorInput } from "./routes/track-visit";
export {
  captureVisitorContext,
  type CaptureVisitorContextOptions,
} from "./utils/lead-tracker.client";
export {
  isLeadContext,
  LEAD_COOKIE,
  LEAD_COOKIE_MAX_AGE,
  normalizeLeadContext,
  optionalString,
  parseLeadCookieValue,
  serializeLeadCookie,
  type LeadContext,
} from "./utils/lead-context";
