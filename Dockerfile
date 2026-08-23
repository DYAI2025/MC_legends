# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=24.18.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Next.js"

# Next.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY .npmrc package-lock.json package.json ./
RUN npm ci --include=dev

# Copy application code
COPY . .

# Build application
RUN npx next build --experimental-build-mode compile

# Remove development dependencies
RUN npm prune --omit=dev


# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app /app

# Entrypoint sets up the container.
ENTRYPOINT [ "/app/docker-entrypoint.js" ]

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000

# Liveness for whatever orchestrates this image (MCL-64).
#
# Written in node, not curl: this image is `node:24-slim`, which ships NEITHER curl NOR
# wget. Measured 2026-08-23 on the VPS - Coolify injects
# `curl ... || wget ... || exit 1` when the Dockerfile declares no HEALTHCHECK of its
# own, and every probe failed with `curl: not found` / `wget: not found` while the app
# was serving 200s. The container is then "unhealthy" forever, the deployment never
# completes, and a rolling update has no way to tell a working release from a broken one.
#
# Coolify defers to this instruction when it is present, so declaring it here is what
# makes the health gate real rather than a permanent false negative.
#
# /api/health is liveness on purpose and must stay 200 with the database down; readiness
# lives at /api/health/ready and is deliberately NOT what an orchestrator restarts on.
#
# The start period covers `next build --experimental-build-mode generate`, which the
# entrypoint runs before the server begins listening.
HEALTHCHECK --interval=15s --timeout=10s --start-period=90s --retries=20 \
  CMD [ "node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" ]

CMD [ "npm", "run", "start" ]
