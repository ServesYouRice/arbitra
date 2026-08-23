export const CONTROL_PLANE_ASSETS = [
  {
    id: "audit_protocol",
    repositoryPath: ".arbitra/protocol.yaml",
    defaultContent: "version: 1\n",
  },
  {
    id: "workflow_definition",
    repositoryPath: ".arbitra/workflow.yaml",
    defaultContent: "version: 1\nnodes: []\n",
  },
  {
    id: "ignore_exclusion_policy",
    repositoryPath: ".llmorchestratorignore",
    defaultContent: "",
  },
  {
    id: "tool_permissions",
    repositoryPath: ".arbitra/tool-permissions.yaml",
    defaultContent: "version: 1\nallow: []\n",
  },
  {
    id: "scope_policy",
    repositoryPath: ".arbitra/scope-policy.yaml",
    defaultContent: "version: 1\n",
  },
  {
    id: "security_policy",
    repositoryPath: ".arbitra/security-policy.yaml",
    defaultContent: "version: 1\n",
  },
  {
    id: "model_harness_policy",
    repositoryPath: ".arbitra/model-policy.yaml",
    defaultContent: "version: 1\nmodels: []\n",
  },
  {
    id: "verification_policy",
    repositoryPath: ".arbitra/verification-policy.yaml",
    defaultContent: "version: 1\n",
  },
] as const;

export type ControlPlaneAsset = (typeof CONTROL_PLANE_ASSETS)[number];
export type ControlPlaneAssetId = ControlPlaneAsset["id"];
export type ControlPlaneSource = "trusted_base" | "external_config" | "default";

export const CONTROL_PLANE_PATHS: ReadonlySet<string> = new Set(
  CONTROL_PLANE_ASSETS.map((asset) => asset.repositoryPath),
);
