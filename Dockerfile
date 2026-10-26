
# Stage 1: Install production dependencies
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: Run the application
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js app.js index.html ./

EXPOSE 3000

CMD ["npm", "start"]
