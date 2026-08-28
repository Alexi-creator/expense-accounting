include .env
export

dev:
	-kill $$(lsof -ti:$(PORT)) 2>/dev/null
	docker compose up -d --build
	docker compose run --rm app npx prisma migrate deploy
	@trap 'docker compose down' EXIT; docker compose logs -f app

migrate:
	docker compose run --rm app npx prisma migrate dev

migrate-create:
	@if [ -z "$(name)" ]; then \
		echo "Error: provide a migration name, e.g.: make migrate-create name=add_user_settings"; \
		exit 1; \
	fi
	docker compose run --rm app npx prisma migrate dev --name $(name)

migrate-status:
	docker compose run --rm app npx prisma migrate status

migrate-deploy:
	docker compose run --rm app npx prisma migrate deploy

db-studio:
	docker compose run --rm -p 5555:5555 app npx prisma studio --port 5555 --browser none

set-webhook:
	curl -F "url=$(WEBHOOK_URL)/bot/webhook" \
		https://api.telegram.org/bot$(BOT_TOKEN)/setWebhook

build:
	npm run build

# Recreate the node_modules volume after package.json changes
refresh-deps:
	docker compose down
	docker volume rm -f limebalance_node_modules
	docker compose build app
