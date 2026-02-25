FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm prune --production

FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl postgresql-client

WORKDIR /app

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY start.sh ./start.sh

RUN mkdir -p /app/data /app/uploads /app/backups && chown -R nodejs:nodejs /app/data /app/uploads /app/backups

# Generate placeholder default images (originals are in .gitignore)
RUN printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > /app/uploads/default_icon.png \
    && cp /app/uploads/default_icon.png /app/uploads/default_favicon.png

RUN chmod +x start.sh && chown nodejs:nodejs start.sh
RUN chown -R nodejs:nodejs /app/node_modules/@prisma || true
RUN chmod -R 755 /app/node_modules/@prisma || true

USER nodejs

EXPOSE 3001

CMD ["./start.sh"]
