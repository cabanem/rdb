.PHONY: setup test lint fmt run clean

setup:
	uv sync

test:
	uv run pytest -q

lint:
	uv run ruff check . && uv run ruff format --check .

fmt:
	uv run ruff format . && uv run ruff check --fix .

run:
	uv run python -m PROJECT_PKG

clean:
	rm -rf .venv .pytest_cache .ruff_cache
