export interface CriticRequirementContext {
  readonly hasCriticalIssue?: boolean;
  readonly hasHighSecurityIssue?: boolean;
  readonly schemaOrDatabaseMigration?: boolean;
  readonly deploymentArchitectureChange?: boolean;
  readonly authenticationRedesign?: boolean;
  readonly majorCrossServiceChange?: boolean;
  readonly largeTaskGraph?: boolean;
  readonly deepMode?: boolean;
}

const conditions = [
  ["critical_issue", "hasCriticalIssue"],
  ["high_security_issue", "hasHighSecurityIssue"],
  ["schema_or_database_migration", "schemaOrDatabaseMigration"],
  ["deployment_architecture_change", "deploymentArchitectureChange"],
  ["authentication_redesign", "authenticationRedesign"],
  ["major_cross_service_change", "majorCrossServiceChange"],
  ["large_task_graph", "largeTaskGraph"],
  ["deep_mode", "deepMode"],
] as const;

export function criticRequired(context: CriticRequirementContext): { readonly required: boolean; readonly reasons: readonly string[] } {
  const reasons = conditions.filter(([, field]) => context[field] === true).map(([reason]) => reason);
  return Object.freeze({ required: reasons.length > 0, reasons: Object.freeze(reasons) });
}
