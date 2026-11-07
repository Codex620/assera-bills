FROM mcr.microsoft.com/playwright:v1.49.0-jammy
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install
COPY src ./src
CMD ["node", "src/start.js"]
