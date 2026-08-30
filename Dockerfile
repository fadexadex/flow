# Production Dockerfile for Godot Web MCP
FROM node:20-alpine

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install dependencies (only production if applicable)
RUN npm install --production

# Copy application files
COPY server.mjs ./
COPY public ./public

# Expose default HTTP/WebSocket port
EXPOSE 8060

ENV PORT=8060
ENV NODE_ENV=production

# Start the WebMCP server
CMD ["node", "server.mjs"]
