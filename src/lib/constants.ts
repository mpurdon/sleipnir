import type { Account, Env, Mode } from "./types";

/** Human name for a service, falling back to the slug for old configs. */
export function accountName(a: Account): string {
  return a.displayName || a.alias;
}

/** Selectable environments — `global` is deliberately absent: it's the
 * implicit single env of standalone accounts, never a user choice among
 * others. */
export const ENVS: Env[] = ["sbx", "dev", "stg", "prd"];

/** Lifecycle display order (promotion path), never alphabetical. */
export const ENV_ORDER: Env[] = ["sbx", "dev", "stg", "prd", "global"];
export const envRank = (e: Env) => ENV_ORDER.indexOf(e);
export const sortEnvs = (envs: Env[]) => [...envs].sort((a, b) => envRank(a) - envRank(b));

export const ENV_LABELS: Record<Env, string> = {
  sbx: "SBX",
  dev: "DEV",
  stg: "STG",
  prd: "PRD",
  global: "GLOBAL",
};

/** Mirror of src-tauri/src/discovery.rs `classify_role` — keep in sync.
 * A role whose mode keyword is prefixed by an AWS service name
 * (CognitoReadOnly, IAMPowerUserAccess) is a dedicated special role,
 * shown under OTHER — never a general mode candidate. */
const AWS_SERVICE_PREFIXES = new Set([
  "cognito", "iam", "s3", "ec2", "rds", "vpc", "lambda", "dynamodb", "cloudwatch", "cloudfront",
  "secretsmanager", "secrets", "bedrock", "sagemaker", "glue", "athena", "kinesis", "sns", "sqs",
  "route53", "eks", "ecs", "ecr", "billing", "cloudtrail", "kms", "ses",
]);

export function classifyRole(role: string): Mode | null {
  const l = role.toLowerCase();
  let mode: Mode;
  let pos: number;
  if ((pos = l.indexOf("admin")) >= 0) mode = "admin";
  else if ((pos = l.indexOf("power")) >= 0) mode = "powerUser";
  else if ((pos = l.indexOf("readonly")) >= 0 || (pos = l.indexOf("viewonly")) >= 0 || (pos = l.indexOf("view_only")) >= 0)
    mode = "readOnly";
  else return null;

  const prefix = l.slice(0, pos).replace(/[^a-z0-9]/g, "");
  if (AWS_SERVICE_PREFIXES.has(prefix)) return null;
  return mode;
}

export const MODES: { key: Mode; label: string; color: string }[] = [
  { key: "readOnly", label: "READONLY", color: "var(--c-cyan)" },
  { key: "powerUser", label: "POWERUSER", color: "var(--c-yellow)" },
  { key: "admin", label: "ADMIN", color: "var(--c-magenta)" },
];
