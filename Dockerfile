# Use a lightweight Node.js base image
FROM node:22-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN npm ci --only=production || npm install --production

# Copy source
COPY . .

# Copy prompts
COPY prompts ./prompts

# Create errors directory
RUN mkdir -p errors

# Set environment defaults
ENV PORT=3000
# ENV DEBUG=false
# ENV OPENAI_BASE_URLS=https://api.openai.com,...
# ENV OPENAI_KEYS=sk-xxx,...
# ENV MODELS=gpt5,...
# ENV DEFAULT_MODEL=gpt5

# Expose server port
EXPOSE ${PORT:-3000}

# Start the server
CMD ["node", "server.js"]