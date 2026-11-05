// Service kinds. Gateway and service-discoverer are not part of it.
export const Kind = {
  CERTIFICATES: "certificates",
  EVENTS: "events",
  SUBSCRIPTION: "subscription",
  PAYMENTS: "payments",
  USER: "user",
  NOTIFICATIONS: "notifications",
  REPORTS: "reports",
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];
