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
    "model_pricing": {},  # Explicit USD / million-token prices, keyed by provider/model.
    "cost_budget_usd": None,  # Stops later model calls after this per-Agent spend threshold.
    "fallback_providers": [],  # Explicit ordered failover only; no hidden provider spend.
    "profiles": {},
    "mcp_servers": {},
    "mcp_enabled": False,
    "sandbox": "local",
    "e2b_template": "base",
    "e2b_timeout": 3600,
    "e2b_sandbox_id": None,
}

VALID_MODES = ("readonly", "auto", "full")
VALID_SANDBOXES = ("local", "e2b", "bwrap")

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
    "custom": {
        "base_url": None,
        "default_model": None,
        "env_key": "ANGEL_API_KEY",
        "connector": None,
        "allowed_hosts": [],
        "models": [],
    },
}


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
    if name not in PROVIDERS:
        available = ", ".join(PROVIDERS)
        raise ValueError(f"Unknown provider: {name}. Available: {available}")

    preset = PROVIDERS[name]

    if name == "custom":
        base_url = os.environ.get("ANGEL_BASE_URL")
        if not base_url:
            raise ValueError("Custom provider needs ANGEL_BASE_URL")
    else:
        base_url = preset["base_url"]

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


def resolve_provider_chain(
    provider_name: str | None = None,
    model: str | None = None,
    fallback_providers: list[dict] | None = None,
) -> list[ProviderConfig]:
    """Resolve a primary provider and up to three explicitly configured backups."""
    primary = resolve_provider(provider_name, model)
    if fallback_providers is None:
        fallback_providers = load_config().get("fallback_providers", [])
    if not isinstance(fallback_providers, list):
        raise ValueError("fallback_providers 必须是有序列表")
    if len(fallback_providers) > 3:
        raise ValueError("最多配置 3 个模型备用项")

    chain = [primary]
    seen = {(primary.name, primary.model)}
    for index, item in enumerate(fallback_providers, 1):
        if not isinstance(item, dict) or set(item) != {"provider", "model"}:
            raise ValueError(
                f"第 {index} 个备用模型必须只包含 provider 和 model"
            )
        name, backup_model = item.get("provider"), item.get("model")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"第 {index} 个备用模型缺少 provider")
        if not isinstance(backup_model, str) or not backup_model.strip():
            raise ValueError(f"第 {index} 个备用模型缺少 model")
        resolved = resolve_provider(name, backup_model)
        key = (resolved.name, resolved.model)
        if key in seen:
            raise ValueError(f"备用模型重复：{resolved.name} / {resolved.model}")
        seen.add(key)
        chain.append(resolved)
    return chain


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
        "fallback_providers": cfg.get("fallback_providers", []),
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
    if "fallback_providers" in prof:
        merged["fallback_providers"] = prof["fallback_providers"]
    return merged


@dataclass
class SandboxSettings:
    """Select local execution, a Linux Bubblewrap shell, or a remote E2B sandbox."""

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
    Raises ValueError for an unknown backend or E2B-only options with bwrap.
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
    if chosen == "bwrap" and any(
        value is not None for value in (sandbox_id, template, timeout)
    ):
        raise ValueError("--sandbox-id/template/timeout 只适用于 E2B")
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
