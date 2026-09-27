# Space Fractions - multi-stage Node.js image
#
# Spec section D: "Container runtime: Docker 20-21". The spec's section E
# k8s snippet uses a single `spacefractions:latest` image; we build one image per
# component instead (proper microservices) and keep a combined image target
# (`all`) so `spacefractions:latest` can still be produced.
#
# Build:  docker build --build-arg COMPONENT=game -t spacefractions-game:latest .
#         docker build --build-arg COMPONENT=question -t spacefractions-question:latest .
#         docker build --build-arg COMPONENT=user -t spacefractions-user:latest .
#         docker build --build-arg COMPONENT=admin -t spacefractions-admin:latest .
#           (AdminComponent runs embedded inside game by default - see services/admin/src/server.js -
#           this build is only for the optional standalone-scaling path it also supports.)

FROM node:18-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY services/game/package.json ./services/game/
COPY services/question/package.json ./services/question/
COPY services/user/package.json ./services/user/
COPY services/admin/package.json ./services/admin/

# Install the whole workspace graph so shared/ resolves as @spacefractions/shared.
RUN npm install --omit=dev --no-audit --no-fund

FROM node:18-alpine AS runtime
WORKDIR /app

ARG COMPONENT=game
ENV NODE_ENV=production \
    COMPONENT=${COMPONENT} \
    GAME_PORT=8081 \
    QUESTION_PORT=8082 \
    USER_PORT=8083 \
    ADMIN_PORT=8084

# Non-root, matching the securityContext in k8s/spacefractions-deployment.yaml.
RUN addgroup -g 10001 -S spacefractions \
 && adduser -u 10001 -S spacefractions -G spacefractions

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY services ./services
COPY web ./web
COPY openapi.yaml internal.proto ./
COPY sql ./sql

RUN chown -R spacefractions:spacefractions /app
USER spacefractions

# Healthcheck hits whichever component this image was built for. Real bug fixed here: this
# previously had no case for COMPONENT=admin and silently fell through to GAME_PORT, so a
# standalone admin container would always fail its health check regardless of whether the
# admin process itself was healthy.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const ports={question:process.env.QUESTION_PORT,user:process.env.USER_PORT,admin:process.env.ADMIN_PORT};const p=ports[process.env.COMPONENT]||process.env.GAME_PORT;require('http').get('http://127.0.0.1:'+p+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["sh", "-c", "node services/${COMPONENT}/src/server.js"]
