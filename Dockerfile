FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY .env.example .env.example

RUN mkdir -p output/screenshots playwright/.auth

CMD ["node", "src/collect-tiktok-live.js"]
