# --- build stage ---
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY sdk ./sdk
RUN npm run build

# --- runtime stage ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY supabase ./supabase
EXPOSE 3000
# DATABASE_URL is provided at runtime (e.g. Supabase pooler string).
CMD ["node", "dist/src/server.js"]
