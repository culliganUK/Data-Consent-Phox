FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli

COPY . .

RUN apk add --no-cache curl tar


ARG MAXMIND_LICENSE_KEY
ENV MAXMIND_LICENSE_KEY=${MAXMIND_LICENSE_KEY}
RUN node scripts/fetch-geolite.mjs && ls -l geoipdb

RUN npm run build

CMD ["npm", "run", "docker-start"]
