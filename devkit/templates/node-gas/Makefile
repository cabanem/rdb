.PHONY: setup push pull open lint clean

setup:
	npm install
	@test -f .clasp.json || echo "next: npx clasp login && npx clasp clone <scriptId> --rootDir src"

push:
	npm run push

pull:
	npm run pull

open:
	npm run open

lint:
	npm run lint

clean:
	rm -rf node_modules
