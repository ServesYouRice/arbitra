export const ROUTE_INVENTORY = [
  ["GET", "/configurations"], ["POST", "/configurations"], ["GET", "/configurations/:id"], ["PUT", "/configurations/:id"],
  ["POST", "/configurations/:id/duplicate"], ["POST", "/configurations/validate"], ["GET", "/configurations/:id/export"],
  ["POST", "/repositories/select"], ["POST", "/estimate"], ["POST", "/runs"], ["GET", "/runs/:id"], ["POST", "/runs/:id/resume"],
  ["GET", "/runs/:id/events"], ["POST", "/runs/:id/cancel"], ["POST", "/runs/:id/checkpoints/:checkpointId"],
  ["GET", "/runs/:id/artifacts"], ["GET", "/runs/:id/artifacts/:artifactId"],
] as const;
export type RouteKey = `${typeof ROUTE_INVENTORY[number][0]} ${typeof ROUTE_INVENTORY[number][1]}`;

