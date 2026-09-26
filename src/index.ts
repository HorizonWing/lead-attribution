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
export {
  recordConversion,
  type ConversionDeps,
  type ConversionEventRow,
  type ConversionInput,
  type UserLeadAttribution,
} from "./conversion";
export { trackVisit, type TrackVisitDeps, type UpsertVisitorInput } from "./routes/track-visit";
export {
  captureVisitorContext,
  type CaptureVisitorContextOptions,
} from "./utils/lead-tracker.client";
export {
  isLeadContext,
  isVisitorId,
  LEAD_COOKIE,
  LEAD_COOKIE_MAX_AGE,
  MAX_FIELD_LENGTH,
  MAX_VISITOR_ID_LENGTH,
  normalizeLeadContext,
  optionalString,
  parseLeadCookieValue,
  serializeLeadCookie,
  type LeadContext,
  type SerializeLeadCookieOptions,
} from "./utils/lead-context";
