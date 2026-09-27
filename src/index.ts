export {
  leadAttribution,
  type LeadAttributionOptions,
  type VisitorRow,
} from "./plugins/lead-attribution.js";
export { leadAttributionClient } from "./plugins/lead-attribution-client.js";
export {
  behaviorTracker,
  DEFAULT_EVENT_PATHS,
  matchEventPath,
  type BehaviorTrackerOptions,
} from "./plugins/behavior-tracker.js";
export { behaviorTrackerClient } from "./plugins/behavior-tracker-client.js";
export {
  recordConversion,
  type ConversionDeps,
  type ConversionEventRow,
  type ConversionInput,
  type UserLeadAttribution,
} from "./conversion.js";
export { trackVisit, type TrackVisitDeps, type UpsertVisitorInput } from "./routes/track-visit.js";
export {
  captureVisitorContext,
  type CaptureVisitorContextOptions,
} from "./utils/lead-tracker.client.js";
export {
  isLeadContext,
  isVisitorId,
  LEAD_COOKIE,
  LEAD_COOKIE_MAX_AGE,
  MAX_FIELD_LENGTH,
  MAX_TRACK_BODY_BYTES,
  MAX_VISITOR_ID_LENGTH,
  normalizeLeadContext,
  optionalString,
  parseLeadCookieValue,
  serializeLeadCookie,
  type LeadContext,
  type SerializeLeadCookieOptions,
} from "./utils/lead-context.js";
