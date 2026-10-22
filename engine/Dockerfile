FROM node:22.23.4-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JavaScript. dist/ also carries dist/discord.house.json (the House config,
# copied in by `npm run build` -> scripts/bundle-house-config.mjs), which is how the image
# finds it: this build context is bot/ alone, so ../house is not available here.
COPY dist/ ./dist/

# Copy persona file if it exists (for auto-responses)
COPY persona*.md ./

# Create memory ledger file
RUN touch memory-ledger.json && echo '{"channels":{}}' > memory-ledger.json

EXPOSE 3000

# Run the cloud entry point (Discord + HTTP, no MCP stdio)
CMD ["node", "dist/cloud-server.js"]
