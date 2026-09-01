# syntax=docker/dockerfile:1

# Single-stage — свідомо. Тема цього ДЗ не «зробити образ меншим» (це було на
# ДЗ#5 і повернеться на #28), а «показати, що саме потрапляє в шари». Одна
# стадія робить це чесніше: усе, що видно в `docker history`, — оце нижче.
FROM node:24-slim

WORKDIR /app

# Corepack піднімає pnpm, яким зібраний pnpm-lock.yaml.
RUN corepack enable

# Маніфести окремим шаром і раніше за код: доки залежності не змінились,
# наступний RUN береться з кешу. pnpm-workspace.yaml тут обов'язковий —
# уся конфігурація pnpm (карантин на свіжі версії, контроль install-скриптів)
# живе саме в ньому, і без нього install поводився б інакше, ніж локально.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# І аж тепер решта. COPY . . тут безпечний рівно настільки, наскільки повний
# .dockerignore: .env і secrets/ до build-контексту не доїжджають узагалі,
# а .env.example доїжджає — він контракт, не секрет.
COPY . .

# Збірка й прибирання dev-залежностей — ОДНІЄЮ інструкцією. Окремим RUN місця
# не повернути: шари незмінні, і видалене в наступному шарі далі лежить у
# попередньому, разом з усім, що в ньому було.
RUN pnpm run build && pnpm prune --prod

# Образ node:* уже містить користувача node з uid 1000.
USER node

# Тут НЕМАЄ жодного ENV, і це не недогляд. ENV — другий канал витоку секретів,
# якого .dockerignore не закриває: він живе не у файловій системі, а в конфігу
# образу, тож `docker inspect` і `docker history` віддають його будь-кому, хто
# зробив pull. Конфіг приходить у рантаймі: `docker run -e`, `env_file:` у
# compose або секрет-волюм від оркестратора.
EXPOSE 3000

# curl і wget у slim-образі відсутні — б'ємо власним node.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const p = process.env.PORT || 3000; fetch('http://127.0.0.1:' + p + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec-форма: node стає PID 1 і отримує SIGTERM напряму. Shell-форма підсунула
# б туди /bin/sh, який сигнал не передає, і кожен `docker stop` коштував би
# 10 секунд очікування перед SIGKILL.
CMD ["node", "dist/main.js"]
