"""Load Angel configuration and resolve provider settings without exposing credentials."""

from dataclasses import dataclass
import json
import os
from pathlib import Path


ANGEL_HOME = Path.home() / ".angel"

DEFAULT_CONFIG = {
    "provider": "deepseek",
    "model": "deepseek-flash",
    "mode": "auto",
    "max_turns": 20,
    "context_window_tokens": None,  # Set only to verified model input limit.
    "auto_compact_enabled": False,  # Opt-in: summarizing makes an extra paid call.
    "auto_compact_threshold": 0.80,
    "profiles": {},
    "mcp_servers": {},
    "mcp_enabled": False,
    "fallback_enabled": True,  # 主模型可恢复失败时自动切换备用模型。
    "fallback_providers": ["deepseek", "xai", "ollama"],
    # 自定义 provider：名字 -> {base_url, default_model, env_key?, models?, allowed_hosts?}。
    # 任意走 OpenAI /v1/chat/completions 协议的模型都能接；Key 只从环境变量读。
    "custom_providers": {},
    "sandbox": "local",
    "e2b_template": "base",
    "e2b_timeout": 3600,
    "e2b_sandbox_id": None,
}

VALID_MODES = ("readonly", "auto", "full")
VALID_SANDBOXES = ("local", "e2b")

PROVIDERS = {
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "default_model": "deepseek-flash",
        "env_key": "DEEPSEEK_API_KEY",
        "connector": "custom.deepseek",
        "allowed_hosts": ["api.deepseek.com"],
        "models": ["deepseek-flash", "deepseek-v4-pro"],
    },
    "xai": {
        "base_url": "https://api.x.ai/v1",
        "default_model": "grok-4.3",
        "env_key": "XAI_API_KEY",
        "connector": "custom.xai",
        "allowed_hosts": ["api.x.ai"],
        "models": ["grok-4.3", "grok-4.5"],
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "nousresearch/hermes-4-14b",
        "env_key": "OPENROUTER_API_KEY",
        "connector": None,
        "allowed_hosts": [],
        "models": [
            "nousresearch/hermes-4-14b",
            "nousresearch/hermes-4-70b",
        ],
    },
    "ollama": {
        "base_url": "http://localhost:11434/v1",
        "default_model": "qwen2.5:7b",
        "env_key": None,
        "connector": None,
        "allowed_hosts": [],
        "models": ["qwen2.5:7b"],
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "env_key": "OPENAI_API_KEY",
        "connector": None,
        "allowed_hosts": [],
        "models": ["gpt-4o-mini"],
    },
    # 以下预设只写公开的官方 endpoint 与默认模型，不写任何 Key。
    # 模型名会随厂商更新而变化，可用 --model 或 --list-models 覆盖/查询。
    "qwen": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "default_model": "qwen-plus",
        "env_key": "DASHSCOPE_API_KEY",
        "connector": None,
        "allowed_hosts": ["dashscope.aliyuncs.com"],
        "models": ["qwen-plus", "qwen-turbo", "qwen3-max"],
    },
    "kimi": {
        "base_url": "https://api.moonshot.cn/v1",
        "default_model": "kimi-k3",
        "env_key": "MOONSHOT_API_KEY",
        "connector": None,
        "allowed_hosts": ["api.moonshot.cn", "api.moonshot.ai"],
        "models": ["kimi-k3", "kimi-k2.6", "kimi-k2.5"],
    },
    "glm": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "default_model": "glm-5.3",
        "env_key": "ZHIPU_API_KEY",
        "connector": None,
        "allowed_hosts": ["open.bigmodel.cn", "api.z.ai"],
        "models": ["glm-5.3", "glm-5.2", "glm-4.7-flash", "glm-4.5-flash"],
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "default_model": "gemini-2.5-flash",
        "env_key": "GEMINI_API_KEY",
        "connector": None,
        "allowed_hosts": ["generativelanguage.googleapis.com"],
        "models": ["gemini-2.5-flash", "gemini-2.5-pro"],
    },
    "mistral": {
        "base_url": "https://api.mistral.ai/v1",
        "default_model": "mistral-small-latest",
        "env_key": "MISTRAL_API_KEY",
        "connector": None,
        "allowed_hosts": ["api.mistral.ai"],
        "models": [
            "mistral-small-latest",
            "mistral-medium-latest",
            "mistral-large-latest",
            "codestral-latest",
        ],
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "default_model": "llama-3.3-70b-versatile",
        "env_key": "GROQ_API_KEY",
        "connector": None,
        "allowed_hosts": ["api.groq.com"],
        "models": [
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "openai/gpt-oss-120b",
        ],
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "default_model": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "env_key": "TOGETHER_API_KEY",
        "connector": None,
        "allowed_hosts": ["api.together.xyz"],
        "models": [
            "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
            "Qwen/Qwen2.5-72B-Instruct-Turbo",
        ],
    },
    "custom": {
        "base_url": None,
        "default_model": None,
        "env_key": "ANGEL_API_KEY",
        "connector": None,
        "allowed_hosts": [],
        "models": [],
    },
}


def get_provider_presets(config: dict | None = None) -> dict:
    """Return built-in presets merged with config["custom_providers"].

    A custom provider entry must be an object with `base_url` and
    `default_model` (both required, non-empty strings). Optional keys:
    `env_key` (env var holding the API key), `models` (known model ids),
    `allowed_hosts`, `connector`. Unknown fields are ignored. A custom
    entry with the same name as a built-in preset overrides it.
    Entries that are not objects, or miss base_url / default_model,
    raise ValueError naming the provider. base_url must be http/https.
    """
    presets = {name: dict(preset) for name, preset in PROVIDERS.items()}
    cfg = config if config is not None else {}
    custom = cfg.get("custom_providers") or {}
    if not isinstance(custom, dict):
        raise ValueError("custom_providers must be an object")
    for name, entry in custom.items():
        if not isinstance(entry, dict):
            raise ValueError(f"Custom provider {name} must be an object")
        base_url = entry.get("base_url")
        default_model = entry.get("default_model")
        if not base_url or not isinstance(base_url, str):
            raise ValueError(f"Custom provider {name} needs base_url")
        if not default_model or not isinstance(default_model, str):
            raise ValueError(f"Custom provider {name} needs default_model")
        scheme = base_url.strip().lower().split("://", 1)[0]
        if "://" not in base_url or scheme not in ("http", "https"):
            raise ValueError(
                f"Custom provider {name} base_url must start with http:// or https://"
            )
        merged = {
            "base_url": base_url,
            "default_model": default_model,
            "env_key": entry.get("env_key"),
            "connector": entry.get("connector"),
            "allowed_hosts": list(entry.get("allowed_hosts") or []),
            "models": list(entry.get("models") or []),
        }
        presets[name] = merged
    return presets


def known_provider_names(config: dict | None = None) -> set:
    """Return every provider name Angel can resolve (built-in + custom)."""
    return set(get_provider_presets(config))


@dataclass
class ProviderConfig:
    """Resolved provider settings, including the selected authentication method."""

    name: str
    base_url: str
    model: str
    api_key: str | None
    auth: str
    connector_name: str | None
    allowed_hosts: list[str]


def load_config() -> dict:
    """Load persisted settings over defaults, creating the default file if absent."""
    config_path = ANGEL_HOME / "config.json"
    config = DEFAULT_CONFIG.copy()

    if not config_path.exists():
        ANGEL_HOME.mkdir(parents=True, exist_ok=True)
        with config_path.open("w", encoding="utf-8") as file:
            json.dump(DEFAULT_CONFIG, file, indent=2)
        return config

    try:
        with config_path.open("r", encoding="utf-8") as file:
            saved_config = json.load(file)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return config

    if isinstance(saved_config, dict):
        config.update(saved_config)

    return config


def resolve_provider(
    provider_name: str | None = None,
    model: str | None = None,
) -> ProviderConfig:
    """Resolve provider settings and credentials from arguments and environment."""
    config: dict | None = None

    def get_config() -> dict:
        nonlocal config
        if config is None:
            config = load_config()
        return config

    name = (
        provider_name
        or os.environ.get("ANGEL_PROVIDER")
        or get_config().get("provider")
        or "deepseek"
    )
    presets = get_provider_presets(get_config())
    if name not in presets:
        available = ", ".join(sorted(presets))
        raise ValueError(f"Unknown provider: {name}. Available: {available}")

    preset = presets[name]

    if name == "custom":
        base_url = os.environ.get("ANGEL_BASE_URL")
        if not base_url:
            raise ValueError("Custom provider needs ANGEL_BASE_URL")
    else:
        base_url = preset["base_url"]

    scheme = (base_url or "").strip().lower().split("://", 1)[0]
    if "://" not in (base_url or "") or scheme not in ("http", "https"):
        raise ValueError(
            f"Provider {name} base_url must start with http:// or https://"
        )

    resolved_model = model
    if resolved_model is None:
        resolved_model = os.environ.get("ANGEL_MODEL")
    if resolved_model is None:
        settings = get_config()
        if settings.get("provider") == name:
            resolved_model = settings.get("model")
        else:
            resolved_model = preset["default_model"]

    if not resolved_model:
        raise ValueError("Custom provider needs ANGEL_MODEL")

    env_key = preset["env_key"]
    api_key = os.environ.get(env_key) if env_key is not None else None
    api_key = api_key or os.environ.get("ANGEL_API_KEY") or None

    connector_name = preset["connector"]
    if api_key is not None:
        auth = "env"
    elif connector_name is not None:
        auth = "connector"
    elif env_key is not None:
        # Key env var is configured but unset: keep auth "env" with no
        # key, so has_credentials() is False and chat() fails clearly
        # ("未设置 API Key") instead of silently sending an
        # unauthenticated request that only fails at the server.
        auth = "env"
    else:
        auth = "none"

    return ProviderConfig(
        name=name,
        base_url=base_url,
        model=resolved_model,
        api_key=api_key,
        auth=auth,
        connector_name=connector_name,
        allowed_hosts=list(preset["allowed_hosts"]),
    )


def resolve_fallback_chain(
    primary_name: str,
    config: dict | None = None,
    enabled: bool | None = None,
) -> list[str]:
    """Return the ordered provider names to try: primary first, then fallbacks.

    Returns [primary_name] when fallback is disabled. Precedence for the
    on/off switch: explicit `enabled` argument, ANGEL_FALLBACK env
    (0/false/no/off disables), config `fallback_enabled`, default True.
    Chain order: ANGEL_FALLBACK_PROVIDERS env (comma-separated),
    config `fallback_providers`, default ["deepseek", "xai", "ollama"].
    Unknown names are skipped; the primary is always first.
    """
    cfg = config if config is not None else load_config()

    if enabled is None:
        env_flag = os.environ.get("ANGEL_FALLBACK")
        if env_flag is not None:
            enabled = env_flag.strip().lower() not in ("0", "false", "no", "off")
        else:
            enabled = cfg.get("fallback_enabled", True)
            if isinstance(enabled, str):
                enabled = enabled.strip().lower() not in (
                    "0",
                    "false",
                    "no",
                    "off",
                )
    if not enabled:
        return [primary_name]

    chain_names = cfg.get("fallback_providers") or ["deepseek", "xai", "ollama"]
    env_chain = os.environ.get("ANGEL_FALLBACK_PROVIDERS")
    if env_chain is not None:
        chain_names = [p.strip() for p in env_chain.split(",") if p.strip()]

    known = known_provider_names(cfg)
    names = [primary_name]
    for name in chain_names:
        if name in known and name not in names:
            names.append(name)
    return names


def list_profiles(config: dict | None = None) -> list[str]:
    """Return the names of configured provider profiles."""
    cfg = config if config is not None else load_config()
    profiles = cfg.get("profiles") or {}
    if not isinstance(profiles, dict):
        return []
    return sorted(profiles)


def resolve_profile(
    profile_name: str | None = None,
    config: dict | None = None,
) -> dict:
    """Resolve a named provider profile (env_N style grouping).

    Returns {"provider": ..., "model": ..., "mode": ...}.
    Precedence: named profile in config["profiles"] overrides the
    top-level defaults. The profile name comes from the argument,
    the ANGEL_PROFILE environment variable, or config["profile"].
    Raises ValueError for an unknown profile name.
    """
    cfg = config if config is not None else load_config()
    base = {
        "provider": cfg.get("provider") or "deepseek",
        "model": cfg.get("model"),
        "mode": cfg.get("mode") or "auto",
    }
    name = (
        profile_name
        or os.environ.get("ANGEL_PROFILE")
        or cfg.get("profile")
    )
    if not name:
        return base
    profiles = cfg.get("profiles") or {}
    if not isinstance(profiles, dict) or name not in profiles:
        available = ", ".join(sorted(profiles)) if isinstance(profiles, dict) else ""
        hint = f" Available: {available}" if available else ""
        raise ValueError(f"Unknown profile: {name}.{hint}")
    prof = profiles[name]
    if not isinstance(prof, dict):
        raise ValueError(f"Profile {name} must be an object")
    merged = dict(base)
    for key in ("provider", "model", "mode"):
        if prof.get(key):
            merged[key] = prof[key]
    return merged


@dataclass
class SandboxSettings:
    """Where file and shell tools run: locally, or in an E2B sandbox."""

    backend: str = "local"
    sandbox_id: str | None = None
    template: str = "base"
    timeout: int = 3600


def resolve_sandbox(
    config: dict | None = None,
    backend: str | None = None,
    sandbox_id: str | None = None,
    template: str | None = None,
    timeout: int | None = None,
) -> SandboxSettings:
    """Resolve sandbox settings.

    Precedence: explicit arguments, then ANGEL_SANDBOX / ANGEL_E2B_*
    environment variables, then ~/.angel/config.json, then defaults.
    Raises ValueError for an unknown backend.
    """
    cfg = config if config is not None else load_config()
    chosen = (
        backend
        or os.environ.get("ANGEL_SANDBOX")
        or cfg.get("sandbox")
        or "local"
    )
    if chosen not in VALID_SANDBOXES:
        raise ValueError(
            f"Invalid sandbox backend: {chosen}. "
            f"Valid backends: {', '.join(VALID_SANDBOXES)}"
        )
    env_timeout = os.environ.get("ANGEL_E2B_TIMEOUT")
    resolved_timeout = timeout
    if resolved_timeout is None and env_timeout is not None:
        try:
            resolved_timeout = int(env_timeout)
        except ValueError:
            resolved_timeout = None
    if resolved_timeout is None:
        resolved_timeout = cfg.get("e2b_timeout") or 3600
    return SandboxSettings(
        backend=chosen,
        sandbox_id=(
            sandbox_id
            or os.environ.get("ANGEL_E2B_SANDBOX_ID")
            or cfg.get("e2b_sandbox_id")
            or None
        ),
        template=(
            template
            or os.environ.get("ANGEL_E2B_TEMPLATE")
            or cfg.get("e2b_template")
            or "base"
        ),
        timeout=resolved_timeout,
    )


def validate_mode(mode: str) -> str:
    """Return a supported mode or raise an error listing the valid modes."""
    if mode not in VALID_MODES:
        raise ValueError(
            f"Invalid mode: {mode}. Valid modes: {', '.join(VALID_MODES)}"
        )
    return mode


if __name__ == "__main__":
    provider = resolve_provider()
    print(f"Provider: {provider.name}")
    print(f"Base URL: {provider.base_url}")
    print(f"Model: {provider.model}")
