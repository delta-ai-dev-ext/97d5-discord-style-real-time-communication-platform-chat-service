SERVICE_NAME ?= chat_service

.PHONY: dev test build run lint typecheck migrate

dev:
	bun --watch src/index.ts

test:
	bun test --coverage

build:
	docker build -t $(SERVICE_NAME):latest .

run:
	bun run src/index.ts

lint:
	bun x eslint src/ tests/

typecheck:
	bun x tsc --noEmit

migrate:
	bun x drizzle-kit push
