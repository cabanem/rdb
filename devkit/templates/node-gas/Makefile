.PHONY: setup upgrade audit push pull open logs lint clean

# setup: lockfile-exact install (npm ci) when package-lock.json is committed,
# otherwise a first resolve that creates it. .npmrc handles the rest
# (no lifecycle scripts, 7-day quarantine, engine-strict).
setup:
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi
	npm audit --audit-level=high
	@test -f .clasp.json || echo "next: npx clasp login && npx clasp clone <scriptId> --rootDir src"

# upgrade: move within package.json ranges (still subject to min-release-age), re-lock, re-audit.
upgrade:
	npm update
	npm audit --audit-level=high

audit:
	npm audit --audit-level=high

push:
	npm run push

pull:
	npm run pull

open:
	npm run open

logs:
	npm run logs

lint:
	npm run lint

clean:
	rm -rf node_modules
