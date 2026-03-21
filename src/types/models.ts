export type KeyStatus = "active" | "invalid";
export type GroupType = "standard" | "aggregate";
export type ChannelType = "openai" | "openai-response" | "gemini" | "anthropic";

export interface UpstreamInfo {
  url: string;
  weight: number;
}

export interface HeaderRule {
  key: string;
  value: string;
  action: "set" | "remove";
}

export interface GroupModel {
  id: number;
  name: string;
  display_name: string;
  description: string;
  group_type: GroupType;
  channel_type: ChannelType;
  sort: number;
  test_model: string;
  validation_endpoint: string;
  upstreams: UpstreamInfo[];
  config: Record<string, unknown>;
  param_overrides: Record<string, unknown>;
  model_redirect_rules: Record<string, string>;
  model_redirect_strict: boolean;
  header_rules: HeaderRule[];
  proxy_keys: string;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyModel {
  id: number;
  group_id: number;
  key_value: string;
  key_hash: string;
  status: KeyStatus;
  notes: string;
  request_count: number;
  failure_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskStatus {
  task_type: "KEY_VALIDATION" | "KEY_IMPORT" | "KEY_DELETE";
  is_running: boolean;
  group_name?: string;
  processed: number;
  total: number;
  result?: unknown;
  error?: string;
  started_at: string;
  finished_at?: string;
  duration_seconds?: number;
}

export interface RequestLogModel {
  id: string;
  timestamp: string;
  group_id: number;
  group_name: string;
  parent_group_id: number | null;
  parent_group_name: string | null;
  key_value: string | null;
  key_hash: string | null;
  model: string | null;
  is_success: number;
  source_ip: string;
  status_code: number;
  request_path: string;
  duration_ms: number;
  error_message: string | null;
  user_agent: string | null;
  request_type: "retry" | "final";
  upstream_addr: string | null;
  is_stream: number;
  request_body: string | null;
}

