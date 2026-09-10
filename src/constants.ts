import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { FALLBACK_CONTEXT_WINDOW } from "./models";

export { CURSOR_BASE_URL, resolveCursorApiBaseUrl } from "./api-url";

export const name = "cursor-agent";
/** `connection.rpc.handle` mounts the loopback channel on the owner `webServer`. */
export const inject = ["llm", "credentials", "connection", "webServer"];

export const PROVIDER = "cursor-agent";
export const CREDENTIAL_REF = credentialRef("CURSOR_SUBSCRIPTION_OAUTH");
export const CHANNEL = "/cursor-agent";

/** Set to `1` / `true` / `yes` / `on` to write `[cursor-agent]` diagnostics to stderr. */
export const CURSOR_AGENT_DEBUG_ENV = "CURSOR_AGENT_DEBUG";

export function isCursorAgentDebugEnabled(env: NodeJS.ProcessEnv = process.env) {
	const raw = env[CURSOR_AGENT_DEBUG_ENV];
	if (typeof raw !== "string") return false;
	return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function cursorAgentDebug(message: string) {
	if (!isCursorAgentDebugEnabled()) return;
	process.stderr.write(`[cursor-agent] ${message}\n`);
}

export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
export const CURSOR_AUTH_ORIGIN = "https://cursor.com";
export const CURSOR_POLL_PATH = "/auth/poll";
export const CURSOR_REFRESH_PATH = "/auth/exchange_user_api_key";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
export const CURSOR_NAME_AGENT_PATH = "/agent.v1.AgentService/NameAgent";
export const CURSOR_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
/**
 * Prefix `dsh-session-title-llm` puts in front of the JSON-framed user prompt.
 * The adapter unwraps this so NameAgent sees the raw first human message,
 * matching cursor-agent's `nameAgent({ userMessage })`.
 */
export const DSH_SESSION_TITLE_FRAME_PREFIX = "Generate the session title from this JSON array of human messages:";

/** Cursor dashboard usage RPCs on the Agent API base (Connect unary). */
export const CURSOR_DASHBOARD_SERVICE = "aiserver.v1.DashboardService";
export const CURSOR_DASHBOARD_RPC = (method) => `/${CURSOR_DASHBOARD_SERVICE}/${method}`;
export const CURSOR_GET_ME_PATH = CURSOR_DASHBOARD_RPC("GetMe");
export const CURSOR_GET_PLAN_INFO_PATH = CURSOR_DASHBOARD_RPC("GetPlanInfo");
export const CURSOR_GET_CURRENT_PERIOD_USAGE_PATH = CURSOR_DASHBOARD_RPC("GetCurrentPeriodUsage");
export const CURSOR_GET_SAND_USAGE_STATUS_PATH = CURSOR_DASHBOARD_RPC("GetSandUsageStatus");
export const USAGE_TTL_MS = 60 * 1000;

/** Client version reported to the Agent service; bump when Cursor requires it. */
export const CURSOR_CLIENT_VERSION = "cli-2026.02.13-41ac335";
/** Keep-alive heartbeats while an agent run is streaming. */
export const HEARTBEAT_INTERVAL_MS = 5000;
/** How long an agent run may stay completely silent before we abort. */
export const STREAM_IDLE_TIMEOUT_MS = 120 * 1000;
/** How long a run may keep sending heartbeats without any real content. */
export const STREAM_PROGRESS_TIMEOUT_MS = 60 * 1000;
/** Retain checkpoints/live tool bridges for inactive DSH sessions. */
export const SESSION_STATE_TTL_MS = 30 * 60 * 1000;
/** Stop one Cursor Run before an unconstrained agent can loop forever. */
export const MAX_TOOL_ROUNDS = 1000;
export const DEFAULT_RETRY_COUNT = 0;
export const DEFAULT_RETRY_INTERVAL_MS = 1000;
export const DEFAULT_RETRY_HTTP_STATUS_CODES = Object.freeze([408, 425, 429, 500, 502, 503, 504]);
/** Hard cap on a parked exec bridge (MCP tool execution only); questions never park. */
export const PARKED_BRIDGE_TIMEOUT_MS = 10 * 60 * 1000;
export const SETTINGS_NAMESPACE = "cursor-agent";
/**
 * The agent preset a session must run for `cursor-agent` calls to be
 * accepted. The provider stays globally registered (the model catalog is one
 * Host-level object shared by every session), so the picker shows it
 * everywhere; the preset check happens in `stream()` before any network I/O.
 */
export const CURSOR_PRESET_ID = "cursor-agent";
export const DEFAULT_REQUIRE_CURSOR_PRESET = true;
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** Default access-token lifetime when the JWT has no usable exp claim. */
export const DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CONTEXT_WINDOW = FALLBACK_CONTEXT_WINDOW;
export const DEFAULT_MAX_TOKENS = 64000;

/**
 * Tools excluded from the injected request-context catalog. Besides exact
 * Cursor-native names, this covers DSH tools bridged through other channels:
 * `ask_user_question` (answered via the AskQuestion interaction bridge) and
 * the subagent family (mapped to Cursor's Task later; excluded until then so
 * Cursor never sees a conflicting duplicate).
 */
export const CURSOR_NATIVE_TOOL_NAMES = Object.freeze(new Set([
	"read", "write", "edit", "apply_patch", "edit_notebook", "generate_image",
	"grep", "glob", "ls", "delete", "read_lints", "shell", "task",
	"call_mcp_tool", "todo_write", "read_todos", "update_current_step",
	"semantic_search", "get_dynamic_tools", "await", "ask_question",
	"web_fetch", "web_search", "switch_mode", "create_plan", "mcp_auth",
	"connect_scm", "setup_vm_environment", "pr_management", "replace_env",
	"computer_use", "record_screen", "write_shell_stdin", "background_shell",
	"ask_user_question", "subagent", "subagent_cursor", "subagent_fork",
	// The bridge's execution backends reuse the official read/write/delete/
	// grep/glob/bash names (the cursor preset mounts no official fs tools, so
	// the names are free). They are already excluded above as Cursor-native
	// names except `bash`, which the Cursor model must never see as a DSH tool.
	"bash",
]));

/** `true` when a DSH tool name collides with a Cursor-native tool name. */
export function isCursorNativeTool(name) {
	if (typeof name !== "string" || name.length === 0) return false;
	return CURSOR_NATIVE_TOOL_NAMES.has(name.toLowerCase().replace(/-/g, "_"));
}

export const FALLBACK_MODELS = Object.freeze([
	{ id: "composer-2", name: "Composer 2", contextWindow: 200000 },
	{ id: "claude-4-sonnet", name: "Claude 4 Sonnet", contextWindow: 200000 },
	{ id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet", contextWindow: 200000 },
	{ id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200000 },
	{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 },
	{ id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1000000 },
	{ id: "o3", name: "o3", contextWindow: 200000 },
	{ id: "o4-mini", name: "o4-mini", contextWindow: 200000 },
	{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1000000 },
	{ id: "cursor-small", name: "Cursor Small", contextWindow: 200000 },
]);
