FROM node:22 AS builder

WORKDIR /usr/src/app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY --from=builder /usr/src/app/dist ./dist

RUN chown -R node:node /usr/src/app

USER node

ENV PORT=3000
EXPOSE $PORT

CMD [ "node", "dist/index.js" ]
