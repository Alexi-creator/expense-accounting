include .env
export

dev:
	-kill $$(lsof -ti:$(PORT)) 2>/dev/null
	docker compose up -d --build
	@trap 'docker compose down' EXIT; ngrok http $(PORT)

migrate:
	docker compose run --rm app npx prisma migrate dev

migrate-create:
	@if [ -z "$(name)" ]; then \
		echo "Ошибка: укажи имя миграции, например: make migrate-create name=add_user_settings"; \
		exit 1; \
	fi
	docker compose run --rm app npx prisma migrate dev --name $(name)

migrate-status:
	docker compose run --rm app npx prisma migrate status

migrate-deploy:
	docker compose run --rm app npx prisma migrate deploy

db-studio:
	docker compose run --rm -p 5555:5555 app npx prisma studio

set-webhook:
	curl -F "url=$(WEBHOOK_URL)/bot/webhook" \
		https://api.telegram.org/bot$(BOT_TOKEN)/setWebhook

build:
	npm run build
