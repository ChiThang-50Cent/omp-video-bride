"""Hermes native plugin manifest and registration for OMP direct executor."""

from __future__ import annotations

import json
import logging
from typing import Any

from .executor import TOOL_DEFINITIONS, registry

logger = logging.getLogger("hermes.plugin.omp_executor")


def _make_json_handler(fn: Any) -> Any:
    """Wrap tool handler to return a JSON string per Hermes native plugin contract."""
    def wrapper(args: dict, session_id: str = "", **kwargs: Any) -> str:
        res = fn(args, session_id=session_id, **kwargs)
        if isinstance(res, str):
            return res
        return json.dumps(res)
    return wrapper


def on_session_finalize(*, session_id: str = "", **kwargs: Any) -> None:
    if session_id:
        registry.close_hermes_session(session_id)


def on_session_reset(*, session_id: str = "", **kwargs: Any) -> None:
    if session_id:
        registry.close_hermes_session(session_id)


def register(ctx: Any) -> None:
    """Register tools and hooks. Fails if official omp_rpc client is missing."""
    try:
        import omp_rpc  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            f"omp-executor plugin requires official omp_rpc client: {exc}"
        ) from exc

    for name, schema, handler, emoji in TOOL_DEFINITIONS:
        ctx.register_tool(
            name=name,
            toolset="omp-executor",
            schema=schema,
            handler=_make_json_handler(handler),
            emoji=emoji,
        )

    ctx.register_hook("on_session_finalize", on_session_finalize)
    ctx.register_hook("on_session_reset", on_session_reset)

    if hasattr(ctx, "on_unload") and callable(ctx.on_unload):
        try:
            ctx.on_unload(registry.close_all)
        except Exception as e:
            logger.debug("on_unload registration failed: %s", e)
